//! 配置：`<dataRoot>/config.json`（字段与 v1 `apps/kernel/src/config.ts` 逐字段一致）。
//!
//! 语义要点：
//! - **宽容清洗**：任何脏值（类型不对 / 越界 / 非法枚举）都回落默认，绝不把脏值写回去
//! - **浅合并 patch**：`{...cache, ...patch}`（与 v1 一致；调用方要整体替换某个键就把整个对象给全）
//! - **原子写**：临时文件 + rename（`util::fsx::write_json_atomic`）
//! - `sanitize_window_bounds` 是「什么算合法窗口几何记忆」的唯一定义处（UI 提交 / 落盘 / 广播都过它）

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::util::fsx::{read_json, write_json_atomic};

pub const CONFIG_VERSION: i64 = 1;

pub const MIN_WINDOW_WIDTH: i64 = 480;
pub const MIN_WINDOW_HEIGHT: i64 = 240;
pub const MAX_WINDOW_WIDTH: i64 = 2000;
pub const MAX_WINDOW_HEIGHT: i64 = 1400;
/// 窗口位置（屏幕物理坐标）的夹取范围：多屏时副屏在主屏左侧 / 上方 ⇒ 坐标可以是负数，
/// 但 ±5 万足够表达任何真实布局，更大的值一律当脏数据（防手改的 config 把窗口丢到屏幕外）
pub const MAX_WINDOW_POS: i64 = 50_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyConfig {
    pub accelerator: String,
}

/// 默认热键（分平台；必须与壳 `primitives/hotkey.rs::DEFAULT_ACCELERATOR` 一致）：
///  - macOS：`Alt+Space`（Spotlight / Raycast 一族的肌肉记忆）；
///  - Windows：`Alt+Space` 是**系统窗口菜单键**（永远抢不到），改用 `Ctrl+Shift+Space`。
pub fn default_accelerator() -> &'static str {
    if cfg!(target_os = "windows") {
        "Ctrl+Shift+Space"
    } else {
        "Alt+Space"
    }
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self { accelerator: default_accelerator().to_string() }
    }
}

/// 一个「窗口态」记下的几何：位置（屏幕物理坐标）+ 尺寸（逻辑像素，与壳 `window.setBounds` 同口径）。
///
/// 两半可各自缺省：只拖过窗口 ⇒ 只有位置；从没改过尺寸 ⇒ 没有尺寸（内容自适应）。
/// 位置成对（x、y）、尺寸也成对（width、height）—— 半个一定是脏数据。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub version: i64,
    pub hotkey: HotkeyConfig,
    pub autostart: bool,
    pub hide_on_blur: bool,
    /// 唤出时保留上次输入
    pub keep_query: bool,
    /// 应用（壳）更新**检查**：后台定期查索引，有新版本时在托盘与「关于」页提示（默认开）。
    /// **不会自动下载 / 替换 / 重启** —— 更新由用户从提示处确认后才执行。
    /// 只有 macOS 打包态会真的检查 —— 开发态与只读安装位置由壳侧的 `canSelfUpdate` 挡掉。
    pub auto_update_check: bool,
    pub language: String,
    /// `system` | `light` | `dark`
    pub theme: String,
    pub accent: String,
    /// `comfortable` | `compact`
    pub density: String,
    /// 历史上限 100–2000
    pub history_limit: i64,
    pub history_in_search: bool,
    /// 插件启用状态（缺省 = 启用）
    pub disabled: Vec<String>,
    /// 用户拒绝的高风险能力：pluginId → capability[]
    pub denied: HashMap<String, Vec<String>>,
    /// 开发模式插件：pluginId → devUrl
    pub dev_plugins: HashMap<String, String>,
    /// 用户调过的窗口几何（按窗口态：`host` / `plugin` / `plugin:<插件id>`；`plugin` 是兜底）
    pub window_bounds: HashMap<String, WindowBounds>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            hotkey: HotkeyConfig::default(),
            autostart: false,
            hide_on_blur: true,
            keep_query: false,
            auto_update_check: true,
            language: "zh-CN".to_string(),
            theme: "system".to_string(),
            accent: "#4f8cff".to_string(),
            density: "comfortable".to_string(),
            history_limit: 500,
            history_in_search: true,
            disabled: Vec::new(),
            denied: HashMap::new(),
            dev_plugins: HashMap::new(),
            window_bounds: HashMap::new(),
        }
    }
}

/// 从任意 JSON 迁移到当前 Config：缺字段用默认、脏值回落、形状不对的容器整体丢弃。
pub fn migrate_config(raw: &Value) -> Config {
    let mut config = Config::default();
    config.version = CONFIG_VERSION;

    if let Some(accelerator) = raw.pointer("/hotkey/accelerator").and_then(Value::as_str) {
        if !accelerator.is_empty() {
            config.hotkey.accelerator = accelerator.to_string();
        }
    }
    if let Some(value) = raw.get("autostart").and_then(Value::as_bool) {
        config.autostart = value;
    }
    if let Some(value) = raw.get("hideOnBlur").and_then(Value::as_bool) {
        config.hide_on_blur = value;
    }
    // `autoUpdateCheck`（现名）与 `autoUpdateApp`（≤0.1.3 的旧键）都认：语义已收敛为
    // 「只检查、提示，不自动更新」，旧用户的取值沿用（默认开）。
    if let Some(value) = raw
        .get("autoUpdateCheck")
        .or_else(|| raw.get("autoUpdateApp"))
        .and_then(Value::as_bool)
    {
        config.auto_update_check = value;
    }
    if let Some(value) = raw.get("keepQuery").and_then(Value::as_bool) {
        config.keep_query = value;
    }
    if let Some(value) = raw.get("language").and_then(Value::as_str) {
        if !value.is_empty() {
            config.language = value.to_string();
        }
    }
    if let Some(value) = raw.get("theme").and_then(Value::as_str) {
        config.theme = value.to_string();
    }
    if let Some(value) = raw.get("accent").and_then(Value::as_str) {
        config.accent = value.to_string();
    }
    if let Some(value) = raw.get("density").and_then(Value::as_str) {
        config.density = value.to_string();
    }
    if let Some(value) = raw.get("historyLimit").and_then(number_like) {
        config.history_limit = value.round() as i64;
    }
    // v1：`cfg.historyInSearch !== false` —— 只有显式 false 才是 false
    if let Some(value) = raw.get("historyInSearch").and_then(Value::as_bool) {
        config.history_in_search = value;
    }
    config.disabled = raw
        .get("disabled")
        .and_then(Value::as_array)
        .map(|list| {
            let mut seen = HashSet::new();
            list.iter()
                .filter_map(Value::as_str)
                .filter(|id| seen.insert(id.to_string()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    config.denied = map_of_string_lists(raw.get("denied"));
    config.dev_plugins = raw
        .get("devPlugins")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| value.as_str().map(|url| (key.clone(), url.to_string())))
                .collect()
        })
        .unwrap_or_default();
    config.window_bounds = sanitize_window_bounds(raw.get("windowBounds"));
    if config.window_bounds.is_empty() {
        // ≤0.1.5 的旧键：只有尺寸、按 `host` / `plugin` 两档（`windowSizes.host` / `.plugin`）。
        // 形状兼容（缺位置照收），而且 `.plugin` 在新模型里正好是「所有插件页的兜底」—— 语义不变
        config.window_bounds = sanitize_window_bounds(raw.get("windowSizes"));
    }

    sanitize_config(config)
}

/// 值清洗（幂等；patch 与 migrate 都走这里）。
pub fn sanitize_config(config: Config) -> Config {
    let mut out = config;
    out.version = CONFIG_VERSION;
    out.history_limit = out.history_limit.clamp(100, 2000);
    if out.theme != "light" && out.theme != "dark" {
        out.theme = "system".to_string();
    }
    if out.density != "compact" {
        out.density = "comfortable".to_string();
    }
    if !is_valid_accent(&out.accent) {
        out.accent = Config::default().accent;
    }
    if out.hotkey.accelerator.is_empty() {
        out.hotkey = HotkeyConfig::default();
    }
    out
}

/// 窗口几何记忆清洗：键只认 `host` / `plugin` / `plugin:<插件id>`；
/// 位置（x、y）与尺寸（width、height）各自成对才有意义 —— 半个 / 非数一律丢掉那一半
/// （位置丢只影响「恢复到哪」，尺寸丢只影响「多大」，没有理由整项连坐）；
/// 尺寸小于最小值那一半丢弃、超过上限夹住；两半都丢光的项不落盘。
pub fn sanitize_window_bounds(raw: Option<&Value>) -> HashMap<String, WindowBounds> {
    let mut out = HashMap::new();
    let Some(Value::Object(map)) = raw else { return out };
    for (key, entry) in map {
        if !is_valid_bounds_key(key) {
            continue;
        }
        let Some(entry) = entry.as_object() else { continue };
        let mut bounds = WindowBounds::default();
        if let (Some(x), Some(y)) = (entry.get("x").and_then(number_like), entry.get("y").and_then(number_like)) {
            if x.is_finite() && y.is_finite() {
                bounds.x = Some((x.round() as i64).clamp(-MAX_WINDOW_POS, MAX_WINDOW_POS));
                bounds.y = Some((y.round() as i64).clamp(-MAX_WINDOW_POS, MAX_WINDOW_POS));
            }
        }
        if let (Some(width), Some(height)) = (
            entry.get("width").and_then(number_like),
            entry.get("height").and_then(number_like),
        ) {
            if width.is_finite() && height.is_finite() {
                let (width, height) = (width.round() as i64, height.round() as i64);
                if width >= MIN_WINDOW_WIDTH && height >= MIN_WINDOW_HEIGHT {
                    bounds.width = Some(width.min(MAX_WINDOW_WIDTH));
                    bounds.height = Some(height.min(MAX_WINDOW_HEIGHT));
                }
            }
        }
        if bounds.x.is_some() || bounds.width.is_some() {
            out.insert(key.clone(), bounds);
        }
    }
    out
}

/// 几何记忆的键：`host` = 搜索态、`plugin` = 所有插件页的兜底、`plugin:<id>` = 某个插件页。
fn is_valid_bounds_key(key: &str) -> bool {
    if key == "host" || key == "plugin" {
        return true;
    }
    let Some(id) = key.strip_prefix("plugin:") else { return false };
    !id.is_empty() && id.len() <= 64 && id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

/// 配置存储：内存缓存 + 原子落盘（与 v1 `ConfigStore` 等价；写是同步的，调用方在 async 里按需 spawn_blocking）。
pub struct ConfigStore {
    file: PathBuf,
    cache: Mutex<Config>,
}

impl ConfigStore {
    pub fn new(data_root: &Path) -> Self {
        Self { file: data_root.join("config.json"), cache: Mutex::new(Config::default()) }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    pub fn get(&self) -> Config {
        self.cache.lock().unwrap_or_else(|err| err.into_inner()).clone()
    }

    pub fn load(&self) -> Config {
        // 首次启动就把默认配置落到磁盘（v1 同款）：用户手改配置时有个现成的模板可参考
        let exists = self.file.exists();
        let raw = read_json::<Value>(&self.file, Value::Object(Default::default()));
        let config = migrate_config(&raw);
        if !exists {
            let _ = write_json_atomic(&self.file, &config);
        }
        *self.cache.lock().unwrap_or_else(|err| err.into_inner()) = config.clone();
        config
    }

    /// 浅合并 → 清洗 → 原子写 → 更新缓存。
    pub fn patch(&self, patch: &Value) -> io::Result<Config> {
        let current = serde_json::to_value(self.get()).unwrap_or_else(|_| Value::Object(Default::default()));
        let mut base = match current {
            Value::Object(map) => map,
            _ => Default::default(),
        };
        if let Value::Object(patch) = patch {
            for (key, value) in patch {
                base.insert(key.clone(), value.clone());
            }
        }
        let config = migrate_config(&Value::Object(base));
        write_json_atomic(&self.file, &config)?;
        *self.cache.lock().unwrap_or_else(|err| err.into_inner()) = config.clone();
        Ok(config)
    }

    pub fn init(&self) -> io::Result<()> {
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(())
    }
}

fn number_like(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn is_valid_accent(accent: &str) -> bool {
    let Some(hex) = accent.strip_prefix('#') else { return false };
    (3..=8).contains(&hex.len()) && hex.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn map_of_string_lists(raw: Option<&Value>) -> HashMap<String, Vec<String>> {
    let mut out = HashMap::new();
    if let Some(Value::Object(map)) = raw {
        for (key, value) in map {
            if let Some(list) = value.as_array() {
                out.insert(
                    key.clone(),
                    list.iter().filter_map(Value::as_str).map(str::to_string).collect(),
                );
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_matches_v1() {
        let config = Config::default();
        assert_eq!(config.version, 1);
        assert_eq!(config.hotkey.accelerator, default_accelerator(), "默认热键分平台（与壳一致）");
        assert!(!config.autostart);
        assert!(config.hide_on_blur);
        assert!(!config.keep_query);
        assert_eq!(config.language, "zh-CN");
        assert_eq!(config.theme, "system");
        assert_eq!(config.accent, "#4f8cff");
        assert_eq!(config.density, "comfortable");
        assert_eq!(config.history_limit, 500);
        assert!(config.history_in_search);
        assert!(config.disabled.is_empty() && config.window_bounds.is_empty());
        assert!(config.auto_update_check, "默认自动检查更新（只提示，不自动更新）");
    }

    /// 版本键迁移：`autoUpdateApp`（≤0.1.3）→ `autoUpdateCheck`（语义收敛为「只检查、提示」）。
    #[test]
    fn auto_update_check_migrates_from_legacy_key() {
        assert!(!migrate_config(&json!({ "autoUpdateApp": false })).auto_update_check, "旧键的关闭要沿用");
        assert!(migrate_config(&json!({ "autoUpdateApp": true })).auto_update_check);
        assert!(migrate_config(&json!({ "autoUpdateCheck": true })).auto_update_check);
        assert!(!migrate_config(&json!({ "autoUpdateCheck": false })).auto_update_check);
        assert!(
            migrate_config(&json!({ "autoUpdateApp": false, "autoUpdateCheck": true })).auto_update_check,
            "两个键都在时以新键为准"
        );
        assert!(migrate_config(&json!({})).auto_update_check, "都没给 = 默认开");
    }

    #[test]
    fn migrate_sanitizes_dirty_values() {
        let raw = json!({
            "theme": "neon",
            "accent": "not-a-color",
            "density": "spacious",
            "historyLimit": 99999,
            "historyInSearch": false,
            "hotkey": { "accelerator": "" },
            "disabled": ["a", "a", 42, "b"],
            "denied": { "p": ["clipboard.read", 7] },
            "devPlugins": { "p": "http://127.0.0.1:5173" }
        });
        let config = migrate_config(&raw);
        assert_eq!(config.theme, "system");
        assert_eq!(config.accent, "#4f8cff");
        assert_eq!(config.density, "comfortable");
        assert_eq!(config.history_limit, 2000);
        assert!(!config.history_in_search);
        assert_eq!(config.hotkey.accelerator, default_accelerator(), "空热键回落默认值");
        assert_eq!(config.disabled, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(config.denied.get("p").unwrap(), &vec!["clipboard.read".to_string()]);
        assert_eq!(config.dev_plugins.get("p").unwrap(), "http://127.0.0.1:5173");
    }

    #[test]
    fn window_bounds_drop_partial_and_clamp_out_of_range() {
        let raw = json!({
            "host": { "x": 120, "y": -40, "width": 900, "height": 620 },
            "plugin:demo": { "x": 10, "y": 20 },
            "plugin:half": { "x": 10, "width": 800, "height": 600 },
            "plugin:big": { "width": 3000, "height": 5000 },
            "plugin:tiny": { "width": 100, "height": 600 },
            "ghost": { "width": 800, "height": 600 }
        });
        let bounds = sanitize_window_bounds(Some(&raw));
        assert_eq!(bounds.get("host").unwrap().x, Some(120));
        assert_eq!(bounds.get("host").unwrap().y, Some(-40), "副屏坐标可以是负数");
        assert_eq!(bounds.get("host").unwrap().width, Some(900));
        assert_eq!(bounds.get("plugin:demo").unwrap().width, None, "只记位置（只拖过窗口）也合法");
        assert_eq!(bounds.get("plugin:half").unwrap().x, None, "半个位置必须整半丢掉");
        assert_eq!(bounds.get("plugin:half").unwrap().width, Some(800), "位置丢不该连坐尺寸");
        assert_eq!(bounds.get("plugin:big").unwrap().width, Some(MAX_WINDOW_WIDTH));
        assert_eq!(bounds.get("plugin:big").unwrap().height, Some(MAX_WINDOW_HEIGHT));
        assert!(!bounds.contains_key("plugin:tiny"), "尺寸不合法又没有位置 ⇒ 整项丢");
        assert!(!bounds.contains_key("ghost"), "只认 host / plugin / plugin:<id>");

        let clamped_pos = sanitize_window_bounds(Some(&json!({ "host": { "x": 999999, "y": -999999 } })));
        assert_eq!(clamped_pos.get("host").unwrap().x, Some(MAX_WINDOW_POS));
        assert_eq!(clamped_pos.get("host").unwrap().y, Some(-MAX_WINDOW_POS));
    }

    /// ≤0.1.5 的 `windowSizes`（只有尺寸）继续有效：`host` 沿用、`plugin` 成为插件页的兜底；
    /// 新键 `windowBounds` 一旦存在就以它为准（不合并，避免半新半旧两份记忆打架）。
    #[test]
    fn window_bounds_migrate_from_legacy_sizes_key() {
        let legacy = migrate_config(&json!({
            "windowSizes": { "host": { "width": 900, "height": 620 }, "plugin": { "width": 1000, "height": 800 } }
        }));
        assert_eq!(legacy.window_bounds.get("host").unwrap().width, Some(900));
        assert_eq!(legacy.window_bounds.get("plugin").unwrap().width, Some(1000), "旧 plugin = 新兜底");

        let both = migrate_config(&json!({
            "windowSizes": { "host": { "width": 500, "height": 500 } },
            "windowBounds": { "host": { "x": 12, "y": 34, "width": 900, "height": 620 } }
        }));
        assert_eq!(both.window_bounds.get("host").unwrap().width, Some(900), "新键优先");
        assert_eq!(both.window_bounds.get("host").unwrap().x, Some(12));
    }

    #[test]
    fn patch_merges_shallow_and_persists() {
        let dir = std::env::temp_dir().join(format!("config-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = ConfigStore::new(&dir);
        store.init().unwrap();
        store.load();

        let patched = store.patch(&json!({ "historyLimit": 800 })).unwrap();
        assert_eq!(patched.history_limit, 800);
        assert_eq!(patched.theme, "system", "未提到的键必须保持");

        let reloaded = ConfigStore::new(&dir);
        assert_eq!(reloaded.load().history_limit, 800, "落盘后重载必须读回新值");

        // 浅合并：patch 整个 windowBounds 必须给全（少一个键 = 别的窗口态的记忆丢）
        store.patch(&json!({ "windowBounds": { "host": { "width": 900, "height": 620 } } })).unwrap();
        let config = store.get();
        assert_eq!(config.window_bounds.get("host").unwrap().width, Some(900));
        assert!(!config.window_bounds.contains_key("plugin"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
