//! 插件别名的**用户覆盖层**（对齐 v1 `apps/kernel/src/overrides.ts`）。
//!
//! 为什么不写进清单：插件产物里的 `package.json` 是构建产物（重装即丢）；用户改出来的别名
//! 单独存 `<dataRoot>/plugin-overrides.json`，装配命令时与清单合并（改完只需 registry 更新即生效）。
//!
//! 两层语义：插件级 keywords 兜底给该插件**全部**入口命令；命令级只作用于该命令；
//! 实际参与搜索 = 插件级 ∪ 命令级（忽略大小写去重保序）。
//! **`None` = 未覆盖（用清单原值），`Some([])` = 用户显式清空** —— 两者必须区分。

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::util::fsx::{read_json, write_json_atomic};

pub const MAX_KEYWORDS: usize = 10;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keywords: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keywords: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commands: Option<HashMap<String, CommandOverride>>,
}

pub type OverridesFile = HashMap<String, PluginOverride>;

/// 归一化：去空白 / 去空串 / 忽略大小写去重 / 截断到 `MAX_KEYWORDS`。
fn normalize_keywords<'a, I: IntoIterator<Item = &'a str>>(items: I) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for raw in items {
        let keyword = raw.trim();
        if keyword.is_empty() {
            continue;
        }
        if !seen.insert(keyword.to_lowercase()) {
            continue;
        }
        out.push(keyword.to_string());
        if out.len() >= MAX_KEYWORDS {
            break;
        }
    }
    out
}

/// 用户输入（JSON）→ 规范化别名；非数组 → `None`。
pub fn sanitize_keywords(value: Option<&Value>) -> Option<Vec<String>> {
    let items = value?.as_array()?;
    Some(normalize_keywords(items.iter().filter_map(Value::as_str)))
}

pub fn sanitize_keyword_list(values: &[String]) -> Vec<String> {
    normalize_keywords(values.iter().map(String::as_str))
}

/// 整份覆盖文件的宽容清洗（形状不对的项整条丢弃）。
pub fn sanitize_overrides(raw: Option<&Value>) -> OverridesFile {
    let mut out = OverridesFile::new();
    let Some(Value::Object(map)) = raw else { return out };
    for (plugin_id, value) in map {
        if plugin_id.is_empty() {
            continue;
        }
        let Value::Object(source) = value else { continue };
        let mut entry = PluginOverride::default();
        if let Some(keywords) = sanitize_keywords(source.get("keywords")) {
            entry.keywords = Some(keywords);
        }
        if let Some(Value::Object(commands)) = source.get("commands") {
            let mut parsed: HashMap<String, CommandOverride> = HashMap::new();
            for (name, command) in commands {
                if name.is_empty() {
                    continue;
                }
                let Value::Object(command) = command else { continue };
                if let Some(keywords) = sanitize_keywords(command.get("keywords")) {
                    parsed.insert(name.clone(), CommandOverride { keywords: Some(keywords) });
                }
            }
            if !parsed.is_empty() {
                entry.commands = Some(parsed);
            }
        }
        if entry.keywords.is_some() || entry.commands.is_some() {
            out.insert(plugin_id.clone(), entry);
        }
    }
    out
}

/// 插件级有效别名：覆盖优先（显式空数组 = 用户清空，不再回落到清单值）。
pub fn plugin_keywords_of(manifest_keywords: Option<&Vec<String>>, overrides: Option<&PluginOverride>) -> Vec<String> {
    overrides
        .and_then(|entry| entry.keywords.clone())
        .or_else(|| manifest_keywords.cloned())
        .unwrap_or_default()
}

/// 命令级有效别名：覆盖优先。
pub fn command_keywords_of(
    declared: Option<&Vec<String>>,
    overrides: Option<&PluginOverride>,
    command_name: &str,
) -> Vec<String> {
    overrides
        .and_then(|entry| entry.commands.as_ref())
        .and_then(|commands| commands.get(command_name))
        .and_then(|command| command.keywords.clone())
        .or_else(|| declared.cloned())
        .unwrap_or_default()
}

/// 实际参与搜索的别名 = 插件级 + 命令级（忽略大小写去重，保序）。
pub fn merge_keywords(plugin_keywords: &[String], command_keywords: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for keyword in plugin_keywords.iter().chain(command_keywords.iter()) {
        if seen.insert(keyword.to_lowercase()) {
            out.push(keyword.clone());
        }
    }
    out
}

pub struct OverrideStore {
    file: PathBuf,
    cache: Mutex<OverridesFile>,
}

impl OverrideStore {
    pub fn new(data_root: &Path) -> Self {
        Self { file: data_root.join("plugin-overrides.json"), cache: Mutex::new(OverridesFile::new()) }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    pub fn load(&self) -> OverridesFile {
        let raw = read_json::<Value>(&self.file, Value::Object(Default::default()));
        let parsed = sanitize_overrides(Some(&raw));
        *self.cache() = parsed.clone();
        parsed
    }

    pub fn get(&self) -> OverridesFile {
        self.cache().clone()
    }

    pub fn get_for(&self, plugin_id: &str) -> Option<PluginOverride> {
        self.cache().get(plugin_id).cloned()
    }

    /// `keywords = None` ⇒ 恢复默认（删掉覆盖项）。
    pub fn set_plugin_keywords(&self, plugin_id: &str, keywords: Option<Vec<String>>) -> io::Result<()> {
        let mut entry = self.get_for(plugin_id).unwrap_or_default();
        entry.keywords = keywords.map(|list| sanitize_keyword_list(&list));
        self.commit(plugin_id, Some(entry))
    }

    /// `keywords = None` ⇒ 恢复默认（删掉该命令的覆盖项）。
    pub fn set_command_keywords(
        &self,
        plugin_id: &str,
        command_name: &str,
        keywords: Option<Vec<String>>,
    ) -> io::Result<()> {
        let mut entry = self.get_for(plugin_id).unwrap_or_default();
        let mut commands = entry.commands.take().unwrap_or_default();
        match keywords {
            None => {
                commands.remove(command_name);
            }
            Some(list) => {
                commands.insert(command_name.to_string(), CommandOverride { keywords: Some(sanitize_keyword_list(&list)) });
            }
        }
        entry.commands = if commands.is_empty() { None } else { Some(commands) };
        self.commit(plugin_id, Some(entry))
    }

    /// 卸载插件时一并清掉覆盖（否则重装后还带着上一份别名）。
    pub fn clear(&self, plugin_id: &str) -> io::Result<()> {
        if self.get_for(plugin_id).is_none() {
            return Ok(());
        }
        self.commit(plugin_id, None)
    }

    fn commit(&self, plugin_id: &str, entry: Option<PluginOverride>) -> io::Result<()> {
        let mut next = self.get();
        let meaningful = entry
            .as_ref()
            .is_some_and(|value| value.keywords.is_some() || value.commands.as_ref().is_some_and(|map| !map.is_empty()));
        if meaningful {
            next.insert(plugin_id.to_string(), entry.unwrap_or_default());
        } else {
            next.remove(plugin_id);
        }
        write_json_atomic(&self.file, &next)?;
        *self.cache() = next;
        Ok(())
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, OverridesFile> {
        self.cache.lock().unwrap_or_else(|err| err.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keywords_are_trimmed_deduped_and_capped() {
        let list: Vec<String> = (0..15).map(|index| format!("  KW{index} ")).collect();
        let raw = json!(list);
        let sanitized = sanitize_keywords(Some(&raw)).unwrap();
        assert_eq!(sanitized.len(), MAX_KEYWORDS);
        assert_eq!(sanitized[0], "KW0", "trim 生效");

        let dup = sanitize_keywords(Some(&json!(["Totp", "totp", "", "  ", 42]))).unwrap();
        assert_eq!(dup, vec!["Totp".to_string()], "忽略大小写去重 + 过滤非字符串");

        assert_eq!(sanitize_keywords(Some(&json!("not-array"))), None);
    }

    #[test]
    fn override_takes_precedence_and_explicit_empty_wins() {
        let manifest = vec!["declared".to_string()];
        // 未覆盖 → 清单值
        assert_eq!(plugin_keywords_of(Some(&manifest), None), manifest);
        // 显式清空 → 空（不回落到清单）
        let empty = PluginOverride { keywords: Some(Vec::new()), commands: None };
        assert!(plugin_keywords_of(Some(&manifest), Some(&empty)).is_empty());
        // 命令级覆盖优先
        let mut commands = HashMap::new();
        commands.insert("open".to_string(), CommandOverride { keywords: Some(vec!["custom".to_string()]) });
        let entry = PluginOverride { keywords: None, commands: Some(commands) };
        assert_eq!(command_keywords_of(Some(&manifest), Some(&entry), "open"), vec!["custom".to_string()]);

        let merged = merge_keywords(&["A".to_string(), "b".to_string()], &["B".to_string(), "c".to_string()]);
        assert_eq!(merged, vec!["A".to_string(), "b".to_string(), "c".to_string()]);
    }

    #[test]
    fn store_commits_and_reloads() {
        let dir = std::env::temp_dir().join(format!("overrides-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let store = OverrideStore::new(&dir);
        store.load();
        store.set_plugin_keywords("totp", Some(vec!["otp".to_string(), "OTP".to_string()])).unwrap();
        store.set_command_keywords("totp", "show", Some(vec!["验证码".to_string()])).unwrap();

        let reloaded = OverrideStore::new(&dir);
        let file = reloaded.load();
        assert_eq!(file.get("totp").unwrap().keywords.as_ref().unwrap(), &vec!["otp".to_string()]);
        assert_eq!(file.get("totp").unwrap().commands.as_ref().unwrap().get("show").unwrap().keywords.as_ref().unwrap(), &vec!["验证码".to_string()]);

        // 恢复默认：命令级删掉、插件级也删掉后整条消失
        reloaded.set_command_keywords("totp", "show", None).unwrap();
        reloaded.set_plugin_keywords("totp", None).unwrap();
        assert!(reloaded.get_for("totp").is_none());
        let disk = OverrideStore::new(&dir);
        assert!(disk.load().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
