//! 插件设置的**用户值层**（对齐 v1 `apps/kernel/src/pluginSettings.ts`）。
//!
//! 与别名覆盖层同款思路：清单里的 `settings` 只描述「有哪些设置、长什么样」，用户改过的值
//! 单独存 `<dataRoot>/plugin-settings.json`（插件产物是构建产物，重装即丢）。
//! 生效值 = 用户值 ?? 声明里的 `default`；改完由插件管理重载插件（子进程启动时注入）。

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;

use crate::manifest::{SettingDecl, SettingValue};
use crate::util::fsx::{read_json, write_json_atomic};

pub const MAX_TEXT_SETTING_LENGTH: usize = 200;

pub type PluginSettingsFile = HashMap<String, HashMap<String, SettingValue>>;

/// 值是否合法（按声明逐项校验；设置页与 HTTP API 共用这一份）。
pub fn is_valid_setting_value(decl: &SettingDecl, value: &SettingValue) -> bool {
    match (decl.kind.as_str(), value) {
        ("switch", SettingValue::Bool(_)) => true,
        ("switch", SettingValue::Str(_)) => false,
        ("select", SettingValue::Str(text)) => {
            decl.options.as_ref().is_some_and(|options| options.iter().any(|option| &option.value == text))
        }
        (_, SettingValue::Str(text)) => text.chars().count() <= MAX_TEXT_SETTING_LENGTH,
        (_, SettingValue::Bool(_)) => false,
    }
}

/// 按当前声明过滤用户值：清单里删掉的键、类型对不上的值一律丢弃（清单更新后不留残渣）。
pub fn sanitize_setting_values(raw: Option<&Value>, decls: &[SettingDecl]) -> HashMap<String, SettingValue> {
    let mut out = HashMap::new();
    let Some(Value::Object(map)) = raw else { return out };
    for decl in decls {
        let Some(value) = map.get(&decl.key) else { continue };
        let Ok(parsed) = serde_json::from_value::<SettingValue>(value.clone()) else { continue };
        if is_valid_setting_value(decl, &parsed) {
            out.insert(decl.key.clone(), parsed);
        }
    }
    out
}

/// 生效值：用户值优先，缺省回落到清单 default（都没有则不出现在结果里）。
pub fn effective_settings(
    decls: &[SettingDecl],
    values: Option<&HashMap<String, SettingValue>>,
) -> HashMap<String, SettingValue> {
    let mut out = HashMap::new();
    for decl in decls {
        let value = values.and_then(|map| map.get(&decl.key)).cloned().or_else(|| decl.default.clone());
        if let Some(value) = value {
            out.insert(decl.key.clone(), value);
        }
    }
    out
}

/// 文件级粗过滤（此时不知道插件声明，只保证「值是 string | boolean」）。
pub fn sanitize_settings_file(raw: Option<&Value>) -> PluginSettingsFile {
    let mut out = PluginSettingsFile::new();
    let Some(Value::Object(map)) = raw else { return out };
    for (plugin_id, value) in map {
        if plugin_id.is_empty() {
            continue;
        }
        let Value::Object(entry) = value else { continue };
        let mut parsed: HashMap<String, SettingValue> = HashMap::new();
        for (key, item) in entry {
            if key.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_value::<SettingValue>(item.clone()) {
                parsed.insert(key.clone(), value);
            }
        }
        if !parsed.is_empty() {
            out.insert(plugin_id.clone(), parsed);
        }
    }
    out
}

pub struct PluginSettingStore {
    file: PathBuf,
    cache: Mutex<PluginSettingsFile>,
}

impl PluginSettingStore {
    pub fn new(data_root: &Path) -> Self {
        Self { file: data_root.join("plugin-settings.json"), cache: Mutex::new(PluginSettingsFile::new()) }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    pub fn load(&self) -> PluginSettingsFile {
        let raw = read_json::<Value>(&self.file, Value::Object(Default::default()));
        let parsed = sanitize_settings_file(Some(&raw));
        *self.cache() = parsed.clone();
        parsed
    }

    pub fn get_for(&self, plugin_id: &str) -> Option<HashMap<String, SettingValue>> {
        self.cache().get(plugin_id).cloned()
    }

    pub fn set(&self, plugin_id: &str, key: &str, value: SettingValue) -> io::Result<()> {
        let mut entry = self.get_for(plugin_id).unwrap_or_default();
        entry.insert(key.to_string(), value);
        self.commit(plugin_id, entry)
    }

    /// 恢复默认：删掉用户值（而不是写一份 default —— 清单以后改了默认值要能跟上）。
    pub fn reset(&self, plugin_id: &str, key: &str) -> io::Result<()> {
        let mut entry = self.get_for(plugin_id).unwrap_or_default();
        entry.remove(key);
        self.commit(plugin_id, entry)
    }

    /// 卸载插件时一并清掉（重装后不该还带着上一份设置）。
    pub fn clear(&self, plugin_id: &str) -> io::Result<()> {
        if self.get_for(plugin_id).is_none() {
            return Ok(());
        }
        self.commit(plugin_id, HashMap::new())
    }

    fn commit(&self, plugin_id: &str, entry: HashMap<String, SettingValue>) -> io::Result<()> {
        let mut next = self.cache().clone();
        if entry.is_empty() {
            next.remove(plugin_id);
        } else {
            next.insert(plugin_id.to_string(), entry);
        }
        write_json_atomic(&self.file, &next)?;
        *self.cache() = next;
        Ok(())
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, PluginSettingsFile> {
        self.cache.lock().unwrap_or_else(|err| err.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::SettingOption;
    use serde_json::json;
    use std::collections::HashMap as Map;

    fn decl(kind: &str, options: Option<Vec<&str>>) -> SettingDecl {
        SettingDecl {
            key: "engine".to_string(),
            kind: kind.to_string(),
            title: "引擎".to_string(),
            description: None,
            default: None,
            options: options.map(|values| {
                values.into_iter().map(|value| SettingOption { value: value.to_string(), label: value.to_string() }).collect()
            }),
        }
    }

    #[test]
    fn value_validity_follows_decl() {
        let switch = decl("switch", None);
        assert!(is_valid_setting_value(&switch, &SettingValue::Bool(true)));
        assert!(!is_valid_setting_value(&switch, &SettingValue::Str("x".to_string())));

        let select = decl("select", Some(vec!["a", "b"]));
        assert!(is_valid_setting_value(&select, &SettingValue::Str("a".to_string())));
        assert!(!is_valid_setting_value(&select, &SettingValue::Str("c".to_string())));

        let text = decl("text", None);
        assert!(is_valid_setting_value(&text, &SettingValue::Str("x".repeat(200))));
        assert!(!is_valid_setting_value(&text, &SettingValue::Str("x".repeat(201))));
    }

    #[test]
    fn sanitize_drops_stale_keys_and_effective_falls_back_to_default() {
        let mut decls = vec![decl("select", Some(vec!["a", "b"]))];
        decls[0].default = Some(SettingValue::Str("b".to_string()));

        // 清单里删掉的键（gone）与类型不符的值（engine: 42）都丢弃
        let raw = json!({ "engine": 42, "gone": "x" });
        let values = sanitize_setting_values(Some(&raw), &decls);
        assert!(values.is_empty());

        // 生效值回落 default
        let effective = effective_settings(&decls, Some(&values));
        assert_eq!(effective.get("engine"), Some(&SettingValue::Str("b".to_string())));

        // 用户值优先
        let user = sanitize_setting_values(Some(&json!({ "engine": "a" })), &decls);
        let effective = effective_settings(&decls, Some(&user));
        assert_eq!(effective.get("engine"), Some(&SettingValue::Str("a".to_string())));
    }

    #[test]
    fn store_round_trips_and_reset_removes_user_value() {
        let dir = std::env::temp_dir().join(format!("plugin-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let store = PluginSettingStore::new(&dir);
        store.load();
        store.set("web-open", "engine", SettingValue::Str("baidu".to_string())).unwrap();
        store.set("web-open", "enabled", SettingValue::Bool(true)).unwrap();

        let reloaded = PluginSettingStore::new(&dir);
        let file = reloaded.load();
        assert_eq!(file.get("web-open").unwrap().get("engine"), Some(&SettingValue::Str("baidu".to_string())));

        // reset 删掉键；全删后整条插件记录消失
        reloaded.reset("web-open", "engine").unwrap();
        reloaded.reset("web-open", "enabled").unwrap();
        assert!(reloaded.get_for("web-open").is_none());
        let disk = PluginSettingStore::new(&dir);
        assert!(disk.load().is_empty());

        // 粗过滤：非 string / boolean 的值不落文件
        let dirty = json!({ "p": { "ok": "v", "num": 3, "arr": [1] } });
        let sanitized = sanitize_settings_file(Some(&dirty));
        assert_eq!(sanitized.get("p").unwrap().len(), 1);
        let _: Map<String, SettingValue> = sanitized.get("p").unwrap().clone();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
