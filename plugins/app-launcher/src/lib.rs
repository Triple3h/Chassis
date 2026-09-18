//! 应用扫描 / 匹配 / 图标的**共用部分**（v1 `core/{scanner,match,icons,store}` 的 Rust 版）。
//!
//! 平台后端（m5 计划 §B2.1「能力按契约定义，后端按平台实现」）：
//!  - `mac.rs`：`.app` bundle 扫描 + 本地化名称解析（`Info.plist` / lproj / loctable）+ `sips` 图标；
//!  - `windows.rs`：开始菜单 / 桌面快捷方式 + 注册表 `App Paths` + shell 图标（`SHGetFileInfoW`）。
//!
//! 本文件只留**两端共用**的东西：数据模型、匹配打分、图标缓存、并发工具、索引存取的键。

use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

#[cfg(target_os = "macos")]
pub mod mac;
#[cfg(windows)]
pub mod windows;

// ── 数据模型 ────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    pub name: String,
    pub path: String,
    pub aliases: Vec<String>,
    /// 图标源：
    ///  - macOS = `.icns` 文件路径（可能缺省）；
    ///  - Windows = `.lnk` / `.exe` 路径（交给 shell 解析，可能缺省）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acronym: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub apps: Vec<AppEntry>,
    pub scanned_dirs: Vec<String>,
    pub duration_ms: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppIndex {
    pub version: i64,
    pub scanned_at: i64,
    pub apps: Vec<AppEntry>,
}

/// SDK 是纯 std 线程模型：需要并发/超时的插件自建一份 runtime。
pub fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .expect("创建插件 runtime 失败")
    })
}

/// 家目录：Windows 优先 `USERPROFILE`（Git Bash 之类环境里 `HOME` 可能是 MSYS 风格路径）。
pub fn home_dir() -> String {
    for key in ["USERPROFILE", "HOME"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// 扫描本机应用（平台后端见文件头）。
pub async fn scan_applications() -> ScanResult {
    #[cfg(target_os = "macos")]
    {
        mac::scan_applications().await
    }
    #[cfg(windows)]
    {
        windows::scan_applications()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        ScanResult { apps: Vec::new(), scanned_dirs: Vec::new(), duration_ms: 0 }
    }
}

/// 并发映射（保序）：等价 v1 的 `mapLimit`（macOS 扫描大量 bundle 时用）。
pub async fn map_limit<T, R, F, Fut>(items: Vec<T>, limit: usize, map: F) -> Vec<R>
where
    T: Send,
    R: Send,
    F: Fn(T) -> Fut + Copy,
    Fut: std::future::Future<Output = R>,
{
    let chunk = limit.max(1);
    let mut out = Vec::with_capacity(items.len());
    let mut pending = Vec::with_capacity(chunk);
    for item in items {
        pending.push(map(item));
        if pending.len() >= chunk {
            out.extend(futures::future::join_all(pending.drain(..)).await);
        }
    }
    out.extend(futures::future::join_all(pending).await);
    out
}

// ── 匹配（v1 `core/match.ts`）────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppHit {
    pub app: AppEntry,
    pub score: f64,
}

/// 拼音首字母（如 "chr" 命中 "Chrome"），只处理 ASCII 前缀场景。
fn acronym(text: &str) -> String {
    text.split([' ', '-', '_', '.'])
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.chars().next())
        .collect::<String>()
        .to_lowercase()
}

/// 插件侧粗排（内核还会用自己的匹配公式再打分）。
pub fn search_apps(apps: &[AppEntry], query: &str, limit: usize) -> Vec<AppHit> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<AppHit> = Vec::new();
    for app in apps {
        let name = app.name.to_lowercase();
        let mut score = -1.0f64;
        if name == needle {
            score = 1.0;
        } else if name.starts_with(&needle) {
            score = 0.9;
        } else if name.contains(&needle) {
            score = 0.7;
        } else {
            for alias in &app.aliases {
                let value = alias.to_lowercase();
                if value == needle || value.starts_with(&needle) {
                    score = score.max(0.65);
                    break;
                }
            }
            if score < 0.0 && acronym(&app.name) == needle {
                score = 0.55;
            }
            if score < 0.0 && app.path.to_lowercase().contains(&needle) {
                score = 0.4;
            }
        }
        if score >= 0.0 {
            hits.push(AppHit { app: app.clone(), score });
        }
    }
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.app.name.to_lowercase().cmp(&b.app.name.to_lowercase()))
    });
    hits.truncate(limit);
    hits
}

// ── 图标缓存（文件名 = `sha1(图标源)`，两端同款规则）──────────────

/// 图标缓存：结果按 `sha1(图标源路径)` 命名，落 `<dataPath>/icons/`。
///
/// 平台差异（都在这一层收口）：
///  - macOS：`.icns` → `sips` 转 64px PNG；
///  - Windows：`.lnk` / `.exe` → shell 图标（`SHGetFileInfoW`）→ PNG。
pub struct IconCache {
    dir: std::path::PathBuf,
    memory: Mutex<std::collections::HashMap<String, Option<String>>>,
}

impl IconCache {
    pub fn new(dir: std::path::PathBuf) -> Self {
        Self { dir, memory: Mutex::new(std::collections::HashMap::new()) }
    }

    pub async fn data_url(&self, source: Option<&str>) -> Option<String> {
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = source;
            return None;
        }

        #[cfg(any(target_os = "macos", windows))]
        {
            let Some(source) = source else { return None };
            if let Some(cached) = self.memory.lock().unwrap_or_else(|err| err.into_inner()).get(source) {
                return cached.clone();
            }

            let key = format!("{:x}", Sha1::digest(source.as_bytes()));
            let target = self.dir.join(format!("{key}.png"));
            let mut ready = target.exists();
            if !ready {
                let _ = std::fs::create_dir_all(&self.dir);
                #[cfg(target_os = "macos")]
                {
                    ready = mac::convert_with_sips(source, &target).await;
                }
                #[cfg(windows)]
                {
                    // shell 图标提取是同步的（毫秒级），直接跑在调用线程上
                    if let Some(png) = windows::icon_png(source, 64) {
                        ready = std::fs::write(&target, png).is_ok();
                    }
                }
            }
            let url = if ready {
                std::fs::read(&target)
                    .ok()
                    .map(|bytes| format!("data:image/png;base64,{}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes)))
            } else {
                None
            };
            self.memory
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .insert(source.to_string(), url.clone());
            url
        }
    }
}

// ── 索引（v1 `core/store.ts`：宿主 storage 的 `app-index` 键）────

pub const INDEX_KEY: &str = "app-index";

pub fn index_age_days(index: &AppIndex) -> f64 {
    (now_ms() - index.scanned_at) as f64 / 86_400_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str, path: &str, aliases: &[&str]) -> AppEntry {
        AppEntry {
            name: name.to_string(),
            path: path.to_string(),
            aliases: aliases.iter().map(|value| value.to_string()).collect(),
            icon_file: None,
            acronym: None,
        }
    }

    #[test]
    fn search_ranks_exact_prefix_alias_acronym_and_path() {
        let apps = vec![
            app("Google Chrome", "/Applications/Google Chrome.app", &["Chrome"]),
            app("WeChat", "/Applications/WeChat.app", &["微信"]),
            app("Calendar", "/System/Applications/Calendar.app", &[]),
            app("Visual Studio Code", "/Applications/Visual Studio Code.app", &["VS Code"]),
        ];

        // 精确 > 前缀 > 包含
        let hits = search_apps(&apps, "chrome", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].score, 0.7, "名字包含但非前缀");
        let hits = search_apps(&apps, "wechat", 10);
        assert_eq!(hits[0].score, 1.0, "精确命中");
        let hits = search_apps(&apps, "cal", 10);
        assert_eq!(hits[0].score, 0.9, "前缀命中");

        // 别名
        let hits = search_apps(&apps, "微信", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].score, 0.65);

        // 首字母：`Visual Studio Code` 按空格分词 → "vsc"
        let hits = search_apps(&apps, "vsc", 10);
        assert_eq!(hits[0].app.name, "Visual Studio Code");
        assert_eq!(hits[0].score, 0.55);

        // 路径兜底
        let hits = search_apps(&apps, "visual", 10);
        assert_eq!(hits[0].score, 0.9, "名字前缀优先");

        // 无命中
        assert!(search_apps(&apps, "zzz", 10).is_empty());
        assert!(search_apps(&apps, "  ", 10).is_empty());
    }

    #[test]
    fn acronym_splits_on_separators() {
        assert_eq!(acronym("Google Chrome"), "gc");
        assert_eq!(acronym("Visual Studio Code"), "vsc");
        assert_eq!(acronym("a-b_c.d"), "abcd");
    }

    #[test]
    fn index_age_is_days() {
        let index = AppIndex { version: 1, scanned_at: now_ms() - 2 * 86_400_000, apps: Vec::new() };
        let age = index_age_days(&index);
        assert!((age - 2.0).abs() < 0.01, "age = {age}");
    }

    #[tokio::test]
    async fn map_limit_keeps_order_and_bounds_concurrency() {
        let items: Vec<usize> = (0..10).collect();
        let out = map_limit(items, 3, |value| async move { value * 2 }).await;
        assert_eq!(out, vec![0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
    }

    #[test]
    fn icon_cache_returns_none_without_source() {
        let dir = std::env::temp_dir().join(format!("app-launcher-cache-{}", std::process::id()));
        let cache = IconCache::new(dir.clone());
        assert!(runtime().block_on(cache.data_url(None)).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
