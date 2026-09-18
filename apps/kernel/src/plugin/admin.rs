//! 插件管理动作（v1 `pluginAdmin.ts`）：托盘 / 设置面板 / HTTP API 共用同一条路径。
//!
//! 只依赖「插件管理器 + 覆盖层 + 设置值层 + 配置 + 壳原语」，与搜索 / 会话 / 显隐没有交集。

use std::sync::Arc;

use serde_json::{json, Value};

use crate::config::ConfigStore;
use crate::error::{KernelError, Result};
use crate::manifest::{SettingDecl, SettingValue};
use crate::overrides::OverrideStore;
use crate::plugin::manager::{PluginManager, PluginRecord};
use crate::plugin_settings::{is_valid_setting_value, PluginSettingStore};
use crate::services::primitives::Primitives;

pub struct PluginAdminDeps {
    pub plugins: Arc<PluginManager>,
    pub overrides: Arc<OverrideStore>,
    pub plugin_settings: Arc<PluginSettingStore>,
    pub config: Arc<ConfigStore>,
    pub primitives: Arc<Primitives>,
}

pub struct PluginAdmin {
    deps: PluginAdminDeps,
}

impl PluginAdmin {
    pub fn new(deps: PluginAdminDeps) -> Self {
        Self { deps }
    }

    pub async fn run(&self, action: &str, payload: &Value) -> Result<Value> {
        let id = payload.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        let path = payload.get("path").and_then(Value::as_str).unwrap_or_default().to_string();
        let overwrite = payload.get("overwrite").and_then(Value::as_bool).unwrap_or(false);

        match action {
            "enable" => {
                self.deps.plugins.set_disabled(&id, false).await?;
                Ok(json!({ "ok": true }))
            }
            "disable" => {
                self.deps.plugins.set_disabled(&id, true).await?;
                Ok(json!({ "ok": true }))
            }
            "reload" => {
                self.deps.plugins.reload(&id).await?;
                Ok(json!({ "ok": true }))
            }
            "reloadAll" => {
                self.deps.plugins.reload_all().await;
                Ok(json!({ "ok": true }))
            }
            "uninstall" => {
                self.deps.plugins.uninstall(&id).await?;
                Ok(json!({ "ok": true }))
            }
            "installDir" => {
                self.deps.plugins.install_from_directory(std::path::Path::new(&path), overwrite).await?;
                Ok(json!({ "ok": true }))
            }
            "installZip" => {
                self.deps.plugins.install_from_zip(std::path::Path::new(&path), overwrite).await?;
                Ok(json!({ "ok": true }))
            }
            // 恢复出厂版本（插件更新机制的逃生口）：`reverted=false` = 本来就没有覆盖
            "revertToBuiltin" => {
                let reverted: bool = self.deps.plugins.revert_to_builtin(&id).await?;
                Ok(json!({ "ok": true, "reverted": reverted }))
            }
            "reveal" => {
                let dir = self
                    .deps
                    .plugins
                    .dir_of(&id)
                    .ok_or_else(|| KernelError::not_found(format!("插件不存在：{id}")))?;
                self.deps.primitives.shell_reveal("kernel", &dir.to_string_lossy()).await?;
                Ok(json!({ "ok": true }))
            }
            "openData" => {
                let dir = self.deps.plugins.data_path_for(&id);
                self.deps.primitives.shell_open_path("kernel", &dir.to_string_lossy()).await?;
                Ok(json!({ "ok": true }))
            }
            "setKeywords" => {
                // 界面化编辑别名：覆盖层落盘 + 当场重进注册表（不用重载插件，下一次搜索即生效）
                let (command, record) = self.require_override_target(&id, payload)?;
                let keywords: Vec<String> = payload
                    .get("keywords")
                    .and_then(Value::as_array)
                    .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default();
                if command.is_empty() {
                    let _ = self.deps.overrides.set_plugin_keywords(&record.id, Some(keywords));
                } else {
                    let _ = self.deps.overrides.set_command_keywords(&record.id, &command, Some(keywords));
                }
                self.deps.plugins.apply_overrides(&record.id);
                Ok(json!({ "ok": true, "plugins": self.deps.plugins.info() }))
            }
            "resetKeywords" => {
                let (command, record) = self.require_override_target(&id, payload)?;
                if command.is_empty() {
                    let _ = self.deps.overrides.set_plugin_keywords(&record.id, None);
                } else {
                    let _ = self.deps.overrides.set_command_keywords(&record.id, &command, None);
                }
                self.deps.plugins.apply_overrides(&record.id);
                Ok(json!({ "ok": true, "plugins": self.deps.plugins.info() }))
            }
            "setSetting" => {
                // 插件设置：值存用户值层，改完重载插件 —— 逻辑层子进程启动时读快照
                let (record, decl) = self.require_setting_target(&id, payload)?;
                let value = setting_value_of(payload.get("value"))
                    .ok_or_else(|| KernelError::bad_args("设置值必须是布尔或字符串"))?;
                if !is_valid_setting_value(&decl, &value) {
                    return Err(KernelError::bad_args(format!("设置值不合法：{}", decl.key)));
                }
                let _ = self.deps.plugin_settings.set(&record.id, &decl.key, value);
                self.deps.plugins.reload_or_load(&record.id).await?;
                Ok(json!({ "ok": true, "plugins": self.deps.plugins.info() }))
            }
            "resetSetting" => {
                let (record, decl) = self.require_setting_target(&id, payload)?;
                let _ = self.deps.plugin_settings.reset(&record.id, &decl.key);
                self.deps.plugins.reload_or_load(&record.id).await?;
                Ok(json!({ "ok": true, "plugins": self.deps.plugins.info() }))
            }
            "setCapability" => {
                // 用户拒绝 / 恢复某项高风险能力（安装时确认的落点）
                let capability = payload.get("capability").and_then(Value::as_str).unwrap_or_default().to_string();
                let denied = payload.get("denied").and_then(Value::as_bool).unwrap_or(false);
                let mut config = self.deps.config.get();
                let mut list = config.denied.get(&id).cloned().unwrap_or_default();
                if denied {
                    if !list.contains(&capability) {
                        list.push(capability.clone());
                    }
                } else {
                    list.retain(|entry| entry != &capability);
                }
                config.denied.insert(id.clone(), list);
                self.deps
                    .config
                    .patch(&json!({ "denied": config.denied }))
                    .map_err(|err| KernelError::new("INTERNAL", err.to_string()))?;
                self.deps.plugins.reload_or_load(&id).await?;
                Ok(json!({ "ok": true }))
            }
            other => Err(KernelError::bad_args(format!("未知插件动作：{other}"))),
        }
    }

    /// `setSetting` / `resetSetting` 的入参校验：插件存在，且清单里声明了该设置项。
    fn require_setting_target(&self, id: &str, payload: &Value) -> Result<(PluginRecord, SettingDecl)> {
        let record = self
            .deps
            .plugins
            .get(id)
            .ok_or_else(|| KernelError::not_found(format!("插件不存在：{id}")))?;
        let key = payload.get("key").and_then(Value::as_str).unwrap_or_default();
        let decl = record
            .manifest
            .as_ref()
            .and_then(|manifest| manifest.settings.as_ref())
            .and_then(|settings| settings.iter().find(|item| item.key == key))
            .cloned()
            .ok_or_else(|| {
                KernelError::not_found(format!("插件未声明该设置项：{id}:{}", if key.is_empty() { "(空)" } else { key }))
            })?;
        Ok((record, decl))
    }

    /// `setKeywords` / `resetKeywords` 的入参校验：插件必须存在，命令（若给）必须在清单里。
    fn require_override_target(&self, id: &str, payload: &Value) -> Result<(String, PluginRecord)> {
        let record = self
            .deps
            .plugins
            .get(id)
            .ok_or_else(|| KernelError::not_found(format!("插件不存在：{id}")))?;
        let command = payload.get("command").and_then(Value::as_str).unwrap_or_default().to_string();
        if !command.is_empty() {
            let exists = record
                .manifest
                .as_ref()
                .map(|manifest| manifest.commands.iter().any(|decl| decl.name == command))
                .unwrap_or(false);
            if !exists {
                return Err(KernelError::not_found(format!("命令不存在：{id}:{command}")));
            }
        }
        Ok((command, record))
    }
}

fn setting_value_of(value: Option<&Value>) -> Option<SettingValue> {
    match value? {
        Value::Bool(value) => Some(SettingValue::Bool(*value)),
        Value::String(value) => Some(SettingValue::Str(value.clone())),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setting_value_only_accepts_bool_and_string() {
        assert_eq!(setting_value_of(Some(&json!(true))), Some(SettingValue::Bool(true)));
        assert_eq!(setting_value_of(Some(&json!("dark"))), Some(SettingValue::Str("dark".to_string())));
        assert_eq!(setting_value_of(Some(&json!(1))), None);
        assert_eq!(setting_value_of(None), None);
    }
}
