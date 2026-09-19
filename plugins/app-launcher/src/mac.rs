//! macOS 应用扫描后端：`.app` bundle 扫描 + 本地化名称解析 + icns 图标（m5 计划 §B2.1 的 mac 侧）。
//!
//! 扫描与本地化名称解析逻辑衍生自 ZTools `macScanner.ts`
//! （MIT License, Copyright (c) 2025 lzx8589561 —— 声明与许可原文见 `docs/THIRD-PARTY.md`），
//! 按本仓库的零 Electron 约束改造：语言列表走 `defaults read -g AppleLanguages`、
//! 图标输出 `.icns` 路径再用系统 `sips` 转 PNG。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::{home_dir, map_limit, AppEntry, ScanResult};
// 只有下面的测试用到 runtime（非测试目标下未使用 ⇒ 单独门一下，消掉 workspace 测试里的 warning）
#[cfg(test)]
use crate::runtime;

// ── 扫描面 ──────────────────────────────────────────────────────

pub fn mac_application_paths() -> Vec<String> {
    let home = home_dir();
    vec![
        "/Applications".to_string(),
        "/System/Applications".to_string(),
        "/System/Applications/Utilities".to_string(),
        // Finder / Dock 等系统常驻应用在这里
        "/System/Library/CoreServices".to_string(),
        format!("{home}/Applications"),
    ]
}

// ── 本地化名称（含 lproj / loctable 规则；衍生声明见本文件头）──

fn unique_non_empty<I: IntoIterator<Item = Option<String>>>(values: I) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for value in values.into_iter().flatten() {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() || !seen.insert(trimmed.clone()) {
            continue;
        }
        out.push(trimmed);
    }
    out
}

/// BCP 47 → macOS lproj 目录名候选。
pub fn bcp47_to_lproj_names(tag: &str) -> Vec<String> {
    let parts: Vec<&str> = tag.split('-').collect();
    let lang = parts.first().copied().unwrap_or("");
    let mut candidates: Vec<String> = Vec::new();
    let mut script: Option<String> = None;
    let mut region: Option<String> = None;

    for part in parts.iter().skip(1) {
        let chars: Vec<char> = part.chars().collect();
        let first_upper = chars.first().map(|ch| ch.is_ascii_uppercase()).unwrap_or(false);
        if chars.len() == 4 && first_upper {
            script = Some(part.to_string());
        } else if chars.len() == 2 && part.chars().all(|ch| ch.is_ascii_uppercase()) {
            region = Some(part.to_string());
        }
    }

    if lang == "zh" {
        if let Some(script) = script.as_deref() {
            candidates.push(format!("zh-{script}"));
            match region.as_deref() {
                Some(region) => {
                    candidates.push(format!("zh-{script}_{region}"));
                    candidates.push(format!("zh_{region}"));
                }
                None => match script {
                    "Hans" => {
                        candidates.push("zh_CN".to_string());
                        candidates.push("zh_SG".to_string());
                    }
                    "Hant" => {
                        candidates.push("zh_TW".to_string());
                        candidates.push("zh_HK".to_string());
                    }
                    _ => {}
                },
            }
        }
    }

    let legacy: [(&str, &str); 15] = [
        ("ja", "Japanese"),
        ("ko", "Korean"),
        ("fr", "French"),
        ("de", "German"),
        ("es", "Spanish"),
        ("it", "Italian"),
        ("pt", "Portuguese"),
        ("nl", "Dutch"),
        ("sv", "Swedish"),
        ("da", "Danish"),
        ("fi", "Finnish"),
        ("nb", "Norwegian"),
        ("pl", "Polish"),
        ("ru", "Russian"),
        ("en", "English"),
    ];

    if let Some(region) = region.as_deref() {
        candidates.push(format!("{lang}_{region}"));
    }
    candidates.push(lang.to_string());
    if let Some((_, name)) = legacy.iter().find(|(id, _)| *id == lang) {
        candidates.push(name.to_string());
    }
    candidates
}

pub fn bcp47_to_loctable_keys(tag: &str) -> Vec<String> {
    let parts: Vec<&str> = tag.split('-').collect();
    let lang = parts.first().copied().unwrap_or("");
    let mut candidates: Vec<String> = Vec::new();
    let mut script: Option<String> = None;
    let mut region: Option<String> = None;

    for part in parts.iter().skip(1) {
        let chars: Vec<char> = part.chars().collect();
        let first_upper = chars.first().map(|ch| ch.is_ascii_uppercase()).unwrap_or(false);
        if chars.len() == 4 && first_upper {
            script = Some(part.to_string());
        } else if chars.len() == 2 && part.chars().all(|ch| ch.is_ascii_uppercase()) {
            region = Some(part.to_string());
        }
    }

    if lang == "zh" && script.is_some() {
        if let Some(region) = region.as_deref() {
            candidates.push(format!("zh_{region}"));
        }
        match script.as_deref() {
            Some("Hans") => {
                candidates.push("zh_CN".to_string());
                candidates.push("zh_SG".to_string());
            }
            Some("Hant") => {
                candidates.push("zh_TW".to_string());
                candidates.push("zh_HK".to_string());
            }
            _ => {}
        }
    } else if let Some(region) = region.as_deref() {
        candidates.push(format!("{lang}_{region}"));
    }

    candidates.push(lang.to_string());
    let mut seen = HashSet::new();
    candidates.into_iter().filter(|item| seen.insert(item.clone())).collect()
}

/// 读取系统语言偏好（替代 Electron 的 `getPreferredSystemLanguages`）。
pub fn preferred_system_languages() -> Vec<String> {
    if let Ok(output) = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleLanguages"])
        .stdin(Stdio::null())
        .output()
    {
        let raw = String::from_utf8_lossy(&output.stdout).to_string();
        let mut found = Vec::new();
        let mut rest = raw.as_str();
        while let Some(start) = rest.find('"') {
            let after = &rest[start + 1..];
            let Some(end) = after.find('"') else { break };
            found.push(after[..end].to_string());
            rest = &after[end + 1..];
        }
        if !found.is_empty() {
            return found;
        }
    }
    // 回退到环境变量
    let from_env: Vec<String> = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .filter(|value| !value.is_empty())
        .filter_map(|value| value.split('.').next().map(|head| head.replace('_', "-")))
        .filter(|value| !value.is_empty())
        .collect();
    if from_env.is_empty() {
        vec!["en-US".to_string()]
    } else {
        from_env
    }
}

fn locale_lproj_names() -> Vec<String> {
    let mut seen = HashSet::new();
    preferred_system_languages()
        .iter()
        .flat_map(|tag| bcp47_to_lproj_names(tag))
        .filter(|item| seen.insert(item.clone()))
        .collect()
}

fn locale_loctable_keys() -> Vec<String> {
    let mut seen = HashSet::new();
    preferred_system_languages()
        .iter()
        .flat_map(|tag| bcp47_to_loctable_keys(tag))
        .filter(|item| seen.insert(item.clone()))
        .collect()
}

/// `APP_NAME_SYNONYM_*` 里的别名（与主名相同的不算）。
fn extract_localized_aliases(data: &[(String, String)], name: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    data.iter()
        .filter(|(key, _)| key.starts_with("APP_NAME_SYNONYM_"))
        .map(|(_, value)| value.trim().to_string())
        .filter(|alias| !alias.is_empty() && alias != name && seen.insert(alias.clone()))
        .collect()
}

/// `.strings` 文本格式：`"键" = "值";`（v1 用正则，这里手写扫描，语义等价）。
pub fn parse_strings_content(content: &str) -> Vec<(String, String)> {
    let chars: Vec<char> = content.chars().collect();
    let mut out = Vec::new();
    let mut index = 0usize;

    let read_quoted = |chars: &[char], start: usize| -> Option<(String, usize)> {
        if chars.get(start) != Some(&'"') {
            return None;
        }
        let mut value = String::new();
        let mut cursor = start + 1;
        while cursor < chars.len() {
            match chars[cursor] {
                '\\' => {
                    if let Some(next) = chars.get(cursor + 1) {
                        value.push(*next);
                        cursor += 2;
                        continue;
                    }
                    return None;
                }
                '"' => return Some((value, cursor + 1)),
                other => {
                    value.push(other);
                    cursor += 1;
                }
            }
        }
        None
    };

    while index < chars.len() {
        // 键：带引号或不带引号的标识符
        let (key, after_key) = if chars[index] == '"' {
            match read_quoted(&chars, index) {
                Some((value, next)) => (value, next),
                None => break,
            }
        } else if chars[index].is_ascii_alphabetic() || chars[index] == '_' {
            let mut cursor = index;
            while cursor < chars.len() && (chars[cursor].is_ascii_alphanumeric() || chars[cursor] == '_') {
                cursor += 1;
            }
            (chars[index..cursor].iter().collect(), cursor)
        } else {
            index += 1;
            continue;
        };

        // 等号
        let mut cursor = after_key;
        while cursor < chars.len() && chars[cursor].is_whitespace() {
            cursor += 1;
        }
        if chars.get(cursor) != Some(&'=') {
            index = after_key;
            continue;
        }
        cursor += 1;
        while cursor < chars.len() && chars[cursor].is_whitespace() {
            cursor += 1;
        }
        // 值
        let Some((value, after_value)) = read_quoted(&chars, cursor) else {
            index = after_key;
            continue;
        };
        let mut cursor = after_value;
        while cursor < chars.len() && chars[cursor].is_whitespace() {
            cursor += 1;
        }
        if chars.get(cursor) != Some(&';') {
            index = after_key;
            continue;
        }
        if !key.is_empty() {
            out.push((key, value));
        }
        index = cursor + 1;
    }
    out
}

fn read_plist_dictionary(file: &Path) -> Option<plist::Dictionary> {
    let value = plist::Value::from_file(file).ok()?;
    value.into_dictionary()
}

fn dictionary_to_pairs(dict: &plist::Dictionary) -> Vec<(String, String)> {
    dict.iter()
        .filter_map(|(key, value)| value.as_string().map(|text| (key.to_string(), text.to_string())))
        .filter(|(_, text)| !text.is_empty())
        .collect()
}

fn read_strings_file(file: &Path) -> Option<Vec<(String, String)>> {
    if let Some(dict) = read_plist_dictionary(file) {
        return Some(dictionary_to_pairs(&dict));
    }
    // 回退：UTF-16 / UTF-8 文本格式的 .strings
    let bytes = std::fs::read(file).ok()?;
    let content = if bytes.starts_with(&[0xFF, 0xFE]) {
        // UTF-16LE
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        String::from_utf16_lossy(&units)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|pair| u16::from_be_bytes([pair[0], pair[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(&bytes).to_string()
    };
    Some(parse_strings_content(&content))
}

fn pick_localized_name(pairs: &[(String, String)]) -> Option<String> {
    let get = |key: &str| pairs.iter().find(|(name, _)| name == key).map(|(_, value)| value.clone());
    get("CFBundleDisplayName").or_else(|| get("CFBundleName"))
}

fn localized_from_lproj(app_path: &Path) -> Option<(String, Vec<String>)> {
    for lproj in locale_lproj_names() {
        let strings = app_path.join("Contents").join("Resources").join(format!("{lproj}.lproj")).join("InfoPlist.strings");
        if !strings.exists() {
            continue;
        }
        let Some(pairs) = read_strings_file(&strings) else { continue };
        if let Some(name) = pick_localized_name(&pairs) {
            return Some((name.clone(), extract_localized_aliases(&pairs, &name)));
        }
    }
    None
}

fn localized_from_loctable(app_path: &Path) -> Option<(String, Vec<String>)> {
    let loctable = app_path.join("Contents").join("Resources").join("InfoPlist.loctable");
    if !loctable.exists() {
        return None;
    }
    let dict = read_plist_dictionary(&loctable)?;
    for key in locale_loctable_keys() {
        let Some(entry) = dict.get(&key).and_then(|value| value.as_dictionary()) else { continue };
        let pairs = dictionary_to_pairs(entry);
        if let Some(name) = pick_localized_name(&pairs) {
            return Some((name.clone(), extract_localized_aliases(&pairs, &name)));
        }
    }
    None
}

fn resolve_icon_file(app_path: &Path, info: Option<&plist::Dictionary>) -> Option<String> {
    let resources = app_path.join("Contents").join("Resources");
    let declared = info
        .and_then(|dict| dict.get("CFBundleIconFile"))
        .and_then(|value| value.as_string())
        .unwrap_or("");
    if !declared.is_empty() {
        for candidate in [resources.join(declared), resources.join(format!("{declared}.icns"))] {
            if candidate.exists() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    for fallback in ["AppIcon.icns", "app.icns", "Icon.icns"] {
        let candidate = resources.join(fallback);
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

fn bundle_names(app_path: &Path, info: Option<&plist::Dictionary>) -> Vec<String> {
    let stem = app_path
        .file_name()
        .map(|name| name.to_string_lossy().trim_end_matches(".app").to_string())
        .unwrap_or_default();
    let Some(dict) = info else { return unique_non_empty(vec![Some(stem)]) };
    unique_non_empty(vec![
        dict.get("CFBundleDisplayName").and_then(|value| value.as_string()).map(str::to_string),
        dict.get("CFBundleName").and_then(|value| value.as_string()).map(str::to_string),
        Some(stem),
    ])
}

fn app_display_info(app_path: &Path) -> AppEntry {
    let info = read_plist_dictionary(&app_path.join("Contents").join("Info.plist"));
    let names = bundle_names(app_path, info.as_ref());
    let icon_file = resolve_icon_file(app_path, info.as_ref());
    let localized = localized_from_lproj(app_path).or_else(|| localized_from_loctable(app_path));
    let path = app_path.to_string_lossy().to_string();

    if let Some((name, localized_aliases)) = localized {
        let mut candidates = names;
        candidates.extend(localized_aliases);
        let aliases = unique_non_empty(candidates.into_iter().map(Some)).into_iter().filter(|alias| alias != &name).collect();
        return AppEntry { name, path, aliases, icon_file, acronym: None };
    }
    let mut names = names;
    let name = if names.is_empty() {
        app_path.file_name().map(|value| value.to_string_lossy().trim_end_matches(".app").to_string()).unwrap_or_default()
    } else {
        names.remove(0)
    };
    AppEntry { name, path, aliases: names, icon_file, acronym: None }
}

/// 递归收集 `.app`：命中即收集并停止下钻（避免 helper 子 app）；普通目录下钻 `depth` 层；
/// 符号链接用 `metadata` 解析真实类型（否则 `/Applications/Safari.app` 这类链接会被漏扫）。
fn collect_app_bundles(dir: &Path, depth: u32, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let full = entry.path();
        let mut is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let is_link = entry.file_type().map(|kind| kind.is_symlink()).unwrap_or(false);
        if !is_dir && is_link {
            is_dir = std::fs::metadata(&full).map(|meta| meta.is_dir()).unwrap_or(false);
        }
        if !is_dir {
            continue;
        }
        if name.ends_with(".app") {
            out.push(full.to_string_lossy().to_string());
            continue;
        }
        if depth > 0 {
            collect_app_bundles(&full, depth - 1, out);
        }
    }
}

pub async fn scan_applications() -> ScanResult {
    let started = Instant::now();
    let search_paths: Vec<String> = mac_application_paths().into_iter().filter(|dir| Path::new(dir).exists()).collect();
    let mut collected: Vec<String> = Vec::new();
    for search_path in &search_paths {
        collect_app_bundles(Path::new(search_path), 1, &mut collected);
    }
    let mut seen = HashSet::new();
    let all_paths: Vec<String> = collected.into_iter().filter(|item| seen.insert(item.clone())).collect();

    let entries = map_limit(all_paths, 50, |app_path| async move {
        let path = PathBuf::from(&app_path);
        let stem = path.file_name().map(|name| name.to_string_lossy().trim_end_matches(".app").to_string()).unwrap_or_default();
        let entry = tokio::task::spawn_blocking(move || app_display_info(&path)).await.unwrap_or(AppEntry {
            name: stem,
            path: app_path.clone(),
            aliases: Vec::new(),
            icon_file: None,
            acronym: None,
        });
        entry
    })
    .await;

    let mut apps: Vec<AppEntry> = entries;
    // v1 用 `localeCompare(a, b, 'zh-Hans-CN')`（中文按拼音）；Rust 无内置 locale 排序，
    // 这里退化成大小写不敏感的码点序 —— 结果集相同、仅中文应用的相对顺序可能不同。
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.path.cmp(&b.path)));

    ScanResult { apps, scanned_dirs: search_paths, duration_ms: started.elapsed().as_millis() as i64 }
}

/// 用系统 `sips` 把 `.icns` 转成 64px PNG（不接受调用方传入的目标路径：
/// source 来自扫描结果，target 由 hash 生成）。
pub async fn convert_with_sips(source: &str, target: &Path) -> bool {
    let spawned = tokio::process::Command::new("sips")
        .args(["-s", "format", "png", "-Z", "64", source, "--out"])
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status();
    matches!(tokio::time::timeout(Duration::from_millis(5000), spawned).await, Ok(Ok(status)) if status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lproj_candidates_follow_bcp47_rules() {
        assert_eq!(bcp47_to_lproj_names("zh-Hans-CN")[0], "zh-Hans");
        assert!(bcp47_to_lproj_names("zh-Hans-CN").contains(&"zh_CN".to_string()));
        assert!(bcp47_to_lproj_names("zh-Hant-TW").contains(&"zh_TW".to_string()));
        assert!(bcp47_to_lproj_names("ja-JP").contains(&"ja_JP".to_string()));
        assert!(bcp47_to_lproj_names("ja-JP").contains(&"Japanese".to_string()));
        assert!(bcp47_to_lproj_names("en").contains(&"English".to_string()));
        assert_eq!(bcp47_to_loctable_keys("zh-Hans-CN"), vec!["zh_CN", "zh_SG", "zh"]);
        assert_eq!(bcp47_to_loctable_keys("fr-FR"), vec!["fr_FR", "fr"]);
    }

    #[test]
    fn strings_parser_handles_quoted_and_bare_keys() {
        let content = r#"
            /* 注释 */
            "CFBundleDisplayName" = "微信";
            CFBundleName = "WeChat";
            "APP_NAME_SYNONYM_1" = "WeChat";
            "ESCAPED" = "a \"b\" c";
        "#;
        let pairs = parse_strings_content(content);
        let get = |key: &str| pairs.iter().find(|(name, _)| name == key).map(|(_, value)| value.clone());
        assert_eq!(get("CFBundleDisplayName").as_deref(), Some("微信"));
        assert_eq!(get("CFBundleName").as_deref(), Some("WeChat"));
        assert_eq!(get("ESCAPED").as_deref(), Some("a \"b\" c"));
        assert_eq!(pairs.len(), 4);
    }

    #[test]
    fn localized_aliases_exclude_primary_name() {
        let pairs = vec![
            ("CFBundleDisplayName".to_string(), "微信".to_string()),
            ("APP_NAME_SYNONYM_1".to_string(), "WeChat".to_string()),
            ("APP_NAME_SYNONYM_2".to_string(), "微信".to_string()),
        ];
        assert_eq!(extract_localized_aliases(&pairs, "微信"), vec!["WeChat".to_string()]);
    }

    #[test]
    fn scan_paths_cover_system_locations() {
        let paths = mac_application_paths();
        assert!(paths.contains(&"/Applications".to_string()));
        assert!(paths.contains(&"/System/Applications".to_string()));
        assert!(paths.contains(&"/System/Library/CoreServices".to_string()));
    }

    #[test]
    fn icon_cache_returns_none_without_source_and_handles_bad_path() {
        let dir = std::env::temp_dir().join(format!("app-launcher-icons-{}", std::process::id()));
        let cache = crate::IconCache::new(dir.clone());
        assert!(runtime().block_on(cache.data_url(None)).is_none());
        assert!(
            runtime().block_on(cache.data_url(Some("/no/such/icon.icns"))).is_none(),
            "sips 失败要安静回落"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
