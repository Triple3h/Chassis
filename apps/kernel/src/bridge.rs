//! 插件页 → 宿主 的唯一入口（v1 `services/bridge.ts`；requirements §8.5 / P6）。
//!
//! token 校验在**内核**；origin / event.source 校验在启动台 UI（内核看不到 iframe）。
//! `ctx.settings.*` 是管理面特权，非 `internal-` 插件一律 FORBIDDEN。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};

use crate::audit::{AuditInput, AuditLog};
use crate::contract::{ErrorShape, ResultItem};
use crate::error::{KernelError, Result};
use crate::exec::{BoxFuture, ScriptRuntime};
use crate::manifest::service_capability;
use crate::registry::{CommandRegistry, SetMode, SearchResultHub};
use crate::services::host_ui::HostUiBridge;
use crate::services::primitives::Primitives;
use crate::services::quicklink::QuicklinkStore;
use crate::services::settings::SettingsService;
use crate::services::storage::PluginStorage;
use crate::session::SessionManager;
use crate::types::Session;

/// 方法 → 所需能力（'' = 无需声明）。
///
/// 真源是 `manifest::service_capability`（服务名 → 能力）：从 `ctx.<service>.<method>`
/// 取出服务名去查表即可。这里只补一张**特例表** —— clipboard 在服务表里只记
/// 「有 write 才能挂载」，而桥按方法细分读 / 写两种能力。
pub fn capability_for(method: &str) -> String {
    let override_capability = match method {
        "ctx.clipboard.readText" => Some("clipboard.read"),
        "ctx.clipboard.writeText" => Some("clipboard.write"),
        _ => None,
    };
    if let Some(capability) = override_capability {
        return capability.to_string();
    }
    let service = method.split('.').nth(1).unwrap_or("");
    service_capability(service).unwrap_or("").to_string()
}

/// 这些服务的调用**自带审计**（服务实现内部过 `audited()`）：桥不再对成功调用重复记一条。
///
/// 两边都记 = 同一次调用落两条 —— 审计环形缓冲只有 500 条，可追溯窗口被白白砍半。
/// **失败路径仍然一律记**：参数 / 能力校验可能发生在服务层 `audited()` 之前。
pub const SELF_AUDITED_PREFIXES: [&str; 7] = [
    "ctx.storage.",
    "ctx.hostUi.",
    "ctx.clipboard.",
    "ctx.shell.",
    "ctx.notify.",
    "ctx.screenshot.",
    "ctx.quicklink.",
];

pub fn is_self_audited(method: &str) -> bool {
    SELF_AUDITED_PREFIXES.iter().any(|prefix| method.starts_with(prefix))
}

pub type InvokeCommandFn = Arc<dyn Fn(String, Option<Value>, &'static str) -> BoxFuture<Result<Value>> + Send + Sync>;
pub type CapabilitiesFn = Arc<dyn Fn(&str) -> HashSet<String> + Send + Sync>;
pub type SettingsForFn = Arc<dyn Fn(&str) -> Option<Arc<SettingsService>> + Send + Sync>;

pub struct BridgeDeps {
    pub sessions: Arc<SessionManager>,
    pub registry: Arc<CommandRegistry>,
    pub hub: Arc<SearchResultHub>,
    pub audit: Arc<AuditLog>,
    pub storage: Arc<PluginStorage>,
    pub primitives: Arc<Primitives>,
    pub host_ui: Arc<HostUiBridge>,
    pub quicklinks: Arc<QuicklinkStore>,
    pub exec: Arc<ScriptRuntime>,
    pub version: String,
    pub platform: String,
    pub data_root: PathBuf,
    pub invoke_command: InvokeCommandFn,
    pub capabilities_of: CapabilitiesFn,
    /// 管理面特权服务（非 internal 插件调用会被服务内部拒绝）
    pub settings_for: Option<SettingsForFn>,
}

#[derive(Debug, Clone)]
pub struct BridgeCall {
    pub sid: String,
    pub token: String,
    pub id: i64,
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BridgeResult {
    pub id: i64,
    pub ok: bool,
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorShape>,
}

pub struct BridgeDispatcher {
    deps: BridgeDeps,
}

impl BridgeDispatcher {
    pub fn new(deps: BridgeDeps) -> Self {
        Self { deps }
    }

    pub async fn dispatch(&self, call: BridgeCall) -> BridgeResult {
        let session = self.deps.sessions.get(&call.sid).filter(|session| session.token == call.token);
        let Some(session) = session else {
            let plugin_id = self
                .deps
                .sessions
                .get(&call.sid)
                .map(|session| session.plugin_id)
                .unwrap_or_else(|| "unknown".to_string());
            let error = ErrorShape { code: "SESSION_INVALID".to_string(), message: "会话或 token 不匹配".to_string() };
            self.deps.audit.record(AuditInput {
                plugin_id,
                channel: "ui",
                method: format!("bridge:{}", call.method),
                ok: false,
                ms: 0,
                capability: None,
                error: Some(error.clone()),
                args: None,
            });
            return BridgeResult { id: call.id, ok: false, result: None, error: Some(error) };
        };

        let started = Instant::now();
        match self.invoke(&session, &call).await {
            Ok(result) => {
                // 自带审计的服务只记服务层那一条（否则同一次调用双记）
                if !is_self_audited(&call.method) {
                    self.deps.audit.record(AuditInput {
                        plugin_id: session.plugin_id.clone(),
                        channel: "ui",
                        method: call.method.clone(),
                        ok: true,
                        ms: started.elapsed().as_millis() as i64,
                        capability: Some(capability_for(&call.method)),
                        error: None,
                        args: call.params.clone(),
                    });
                }
                BridgeResult { id: call.id, ok: true, result: Some(result), error: None }
            }
            Err(err) => {
                let error = ErrorShape { code: err.code.to_string(), message: err.message.clone() };
                self.deps.audit.record(AuditInput {
                    plugin_id: session.plugin_id.clone(),
                    channel: "ui",
                    method: call.method.clone(),
                    ok: false,
                    ms: started.elapsed().as_millis() as i64,
                    capability: Some(capability_for(&call.method)),
                    error: Some(error.clone()),
                    args: call.params.clone(),
                });
                BridgeResult { id: call.id, ok: false, result: None, error: Some(error) }
            }
        }
    }

    async fn invoke(&self, session: &Session, call: &BridgeCall) -> Result<Value> {
        let plugin_id = session.plugin_id.as_str();
        let sid = session.sid.as_str();
        let params = call.params.clone().unwrap_or_else(|| json!({}));

        let capability = capability_for(&call.method);
        if !capability.is_empty() && !(self.deps.capabilities_of)(plugin_id).contains(&capability) {
            return Err(KernelError::new("CAPABILITY_DENIED", format!("未声明能力：{capability}")));
        }

        match call.method.as_str() {
            "ctx.host.info" => {
                return Ok(json!({
                    "version": self.deps.version,
                    "platform": self.deps.platform,
                    "dataRoot": self.deps.data_root,
                    "pluginId": plugin_id,
                    "command": session.command,
                    "sid": sid,
                }))
            }
            "ctx.log" | "ctx.log.info" => return Ok(Value::Null),
            "ctx.commands.invoke" => {
                let command = str_param(&params, "command")?;
                let id = if command.contains(':') { command } else { format!("{plugin_id}:{command}") };
                return (self.deps.invoke_command)(id, params.get("args").cloned(), "plugin").await;
            }
            "ctx.commands.close" => {
                // 关闭理由由内核的会话监听统一广播（`session/closed`），这里不再单独发事件
                self.deps.sessions.close(sid, crate::types::SessionCloseReason::Ui);
                return Ok(Value::Null);
            }
            // UI 侧的动作处理器留在插件页本地；宿主只在 ResultItem.actions 里出现时回调（v1 简化：无需注册）
            "ctx.commands.registerAction" => return Ok(Value::Null),
            "ctx.searchResult.set" | "ctx.searchResult.append" | "ctx.searchResult.clear" => {
                let token = num_u64(&params, "token").unwrap_or(session.last_search_token);
                let items = if call.method.ends_with("clear") { Vec::new() } else { as_items(&params)? };
                let mode = if call.method.ends_with("append") {
                    SetMode::Append
                } else if call.method.ends_with("clear") {
                    SetMode::Clear
                } else {
                    SetMode::Set
                };
                self.deps.hub.accept(Some(token), plugin_id, items, mode);
                return Ok(Value::Null);
            }
            _ => {}
        }

        if let Some(method) = call.method.strip_prefix("ctx.storage.") {
            // 方法名转发给统一实现（与脚本侧 `storage.*` 同一处）
            return self.deps.storage.call(plugin_id, "ui", method, &params).await;
        }
        if let Some(method) = call.method.strip_prefix("ctx.hostUi.") {
            return match method {
                "getSearchContent" => Ok(Value::String(self.deps.host_ui.get_search_content(plugin_id, sid).await?)),
                "setSearchContent" => {
                    let value = params.get("value").and_then(Value::as_str).unwrap_or_default().to_string();
                    Ok(Value::Bool(self.deps.host_ui.set_search_content(plugin_id, sid, &value).await?))
                }
                "clearSearchContent" => Ok(Value::Bool(self.deps.host_ui.clear_search_content(plugin_id, sid).await?)),
                "setFooter" => {
                    let buttons = as_footer(&params);
                    Ok(Value::Bool(self.deps.host_ui.set_footer(plugin_id, sid, buttons).await?))
                }
                "hide" => {
                    self.deps.host_ui.hide(plugin_id, sid).await?;
                    Ok(Value::Null)
                }
                other => Err(KernelError::not_found(format!("未知方法：ctx.hostUi.{other}"))),
            };
        }
        if let Some(method) = call.method.strip_prefix("ctx.clipboard.") {
            return match method {
                "readText" => Ok(Value::String(self.deps.primitives.clipboard_read_text(plugin_id, "ui").await?)),
                "writeText" => {
                    let text = params.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
                    self.deps.primitives.clipboard_write_text(plugin_id, "ui", &text).await?;
                    Ok(Value::Null)
                }
                other => Err(KernelError::not_found(format!("未知方法：ctx.clipboard.{other}"))),
            };
        }
        if let Some(method) = call.method.strip_prefix("ctx.shell.") {
            return match method {
                "openUrl" => {
                    let url = str_param(&params, "url")?;
                    self.deps.primitives.shell_open_url(plugin_id, &url).await?;
                    Ok(Value::Null)
                }
                "openPath" => {
                    let path = str_param(&params, "path")?;
                    self.deps.primitives.shell_open_path(plugin_id, &path).await?;
                    Ok(Value::Null)
                }
                "reveal" => {
                    let path = str_param(&params, "path")?;
                    self.deps.primitives.shell_reveal(plugin_id, &path).await?;
                    Ok(Value::Null)
                }
                other => Err(KernelError::not_found(format!("未知方法：ctx.shell.{other}"))),
            };
        }
        if let Some(method) = call.method.strip_prefix("ctx.notify.") {
            return match method {
                "show" => {
                    let title = params.get("title").and_then(Value::as_str).unwrap_or_default().to_string();
                    let body = params.get("body").and_then(Value::as_str).unwrap_or_default().to_string();
                    let silent = params.get("silent").and_then(Value::as_bool).unwrap_or(false);
                    Ok(Value::Bool(self.deps.primitives.notify_show(plugin_id, "ui", &title, &body, silent).await?))
                }
                other => Err(KernelError::not_found(format!("未知方法：ctx.notify.{other}"))),
            };
        }
        if let Some(method) = call.method.strip_prefix("ctx.screenshot.") {
            return match method {
                "start" => Ok(Value::Bool(self.deps.primitives.screenshot_start(plugin_id).await?)),
                other => Err(KernelError::not_found(format!("未知方法：ctx.screenshot.{other}"))),
            };
        }
        if let Some(method) = call.method.strip_prefix("ctx.quicklink.") {
            return match method {
                "all" => Ok(serde_json::to_value(self.deps.quicklinks.all(plugin_id).await?).unwrap_or(Value::Null)),
                "add" => {
                    let url = str_param(&params, "url")?;
                    let name = params.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
                    let item = self.deps.quicklinks.add(plugin_id, &json!({ "name": name, "url": url })).await?;
                    Ok(serde_json::to_value(item).unwrap_or(Value::Null))
                }
                "edit" => {
                    let id = str_param(&params, "id")?;
                    let mut patch = serde_json::Map::new();
                    for field in ["name", "url", "icon"] {
                        if let Some(value) = params.get(field) {
                            patch.insert(field.to_string(), value.clone());
                        }
                    }
                    self.deps.quicklinks.edit(plugin_id, &id, &Value::Object(patch)).await?;
                    Ok(Value::Null)
                }
                "remove" => {
                    let id = str_param(&params, "id")?;
                    self.deps.quicklinks.remove(plugin_id, &id).await?;
                    Ok(Value::Null)
                }
                other => Err(KernelError::not_found(format!("未知方法：ctx.quicklink.{other}"))),
            };
        }
        if call.method == "ctx.exec.run" {
            let command = str_param(&params, "command")?;
            // 只能调本插件的 script / no-view 命令（plugin-spec §7.2）
            if self.deps.registry.get(&format!("{plugin_id}:{command}")).is_none() {
                return Err(KernelError::not_found(format!("本插件不存在命令：{command}")));
            }
            return self
                .deps
                .exec
                .run(plugin_id, &command, params.get("args").cloned(), num_u64(&params, "timeoutMs"))
                .await;
        }

        // 管理面特权（`internal-*` 之外一律 FORBIDDEN）
        if let Some(method) = call.method.strip_prefix("ctx.settings.") {
            let service = self.deps.settings_for.as_ref().and_then(|settings_for| settings_for(plugin_id));
            let Some(service) = service else {
                return Err(KernelError::new("FORBIDDEN", "本插件没有管理面权限"));
            };
            return service.call(method, &params).await;
        }

        Err(KernelError::not_found(format!("未知方法：{}", call.method)))
    }
}

fn str_param(params: &Value, field: &str) -> Result<String> {
    match params.get(field).and_then(Value::as_str) {
        Some(value) if !value.is_empty() => Ok(value.to_string()),
        _ => Err(KernelError::bad_args(format!("{field} 必须是非空字符串"))),
    }
}

fn num_u64(params: &Value, field: &str) -> Option<u64> {
    params.get(field).and_then(Value::as_u64).or_else(|| params.get(field).and_then(Value::as_f64).map(|value| value as u64))
}

fn as_items(params: &Value) -> Result<Vec<ResultItem>> {
    let Some(value) = params.get("items") else {
        return Err(KernelError::bad_args("items 必须是数组"));
    };
    let Some(list) = value.as_array() else {
        return Err(KernelError::bad_args("items 必须是数组"));
    };
    if list.len() > 100 {
        return Err(KernelError::bad_args("单次提交结果不得超过 100 条"));
    }
    let mut items = Vec::with_capacity(list.len());
    for item in list {
        let ok = item.get("id").and_then(Value::as_str).is_some()
            && item.get("title").and_then(Value::as_str).is_some()
            && item.get("action").is_some();
        if !ok {
            return Err(KernelError::bad_args("结果项必须包含 id / title / action"));
        }
        items.push(serde_json::from_value(item.clone()).map_err(|_| KernelError::bad_args("结果项字段不合法"))?);
    }
    Ok(items)
}

/// footer 按钮最多 8 个（超出截断，与 v1 一致）。
fn as_footer(params: &Value) -> Vec<Value> {
    params
        .get("buttons")
        .and_then(Value::as_array)
        .map(|buttons| buttons.iter().take(8).cloned().collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_lookup_uses_service_table_with_clipboard_override() {
        assert_eq!(capability_for("ctx.storage.get"), "storage");
        assert_eq!(capability_for("ctx.shell.openUrl"), "shell.open");
        assert_eq!(capability_for("ctx.quicklink.all"), "quicklink");
        // 特例表：clipboard 按方法细分读 / 写
        assert_eq!(capability_for("ctx.clipboard.readText"), "clipboard.read");
        assert_eq!(capability_for("ctx.clipboard.writeText"), "clipboard.write");
        // 无需能力的服务
        assert_eq!(capability_for("ctx.host.info"), "");
        assert_eq!(capability_for("ctx.log"), "");
        assert_eq!(capability_for("ctx.commands.invoke"), "");
        assert_eq!(capability_for("ctx.settings.get"), "");
    }

    #[test]
    fn self_audited_prefixes_cover_service_layer() {
        for method in [
            "ctx.storage.get",
            "ctx.hostUi.hide",
            "ctx.clipboard.readText",
            "ctx.shell.reveal",
            "ctx.notify.show",
            "ctx.screenshot.start",
            "ctx.quicklink.add",
        ] {
            assert!(is_self_audited(method), "{method} 由服务层记账");
        }
        for method in ["ctx.exec.run", "ctx.commands.invoke", "ctx.host.info", "ctx.settings.get", "ctx.log"] {
            assert!(!is_self_audited(method), "{method} 由桥记账");
        }
    }

    #[test]
    fn footer_is_capped_at_eight() {
        let buttons: Vec<Value> = (0..12).map(|index| json!({ "type": "button", "id": format!("b{index}"), "label": "B" })).collect();
        let footer = as_footer(&json!({ "buttons": buttons }));
        assert_eq!(footer.len(), 8);
        assert!(as_footer(&json!({})).is_empty(), "没有 buttons 时是空数组而不是报错");
    }

    #[test]
    fn items_validation_rejects_bad_shapes() {
        assert_eq!(as_items(&json!({})).unwrap_err().code, "BAD_ARGS");
        assert_eq!(as_items(&json!({ "items": "nope" })).unwrap_err().code, "BAD_ARGS");
        assert_eq!(
            as_items(&json!({ "items": [{ "id": "a", "title": "A" }] })).unwrap_err().code,
            "BAD_ARGS",
            "缺 action 必须拒绝"
        );
        let too_many: Vec<Value> = (0..101)
            .map(|index| json!({ "id": format!("i{index}"), "title": "T", "action": { "type": "open" } }))
            .collect();
        assert_eq!(as_items(&json!({ "items": too_many })).unwrap_err().code, "BAD_ARGS");
        let item = json!({
            "id": "i1",
            "title": "T",
            "action": { "type": "open", "target": "https://example.com" }
        });
        assert_eq!(as_items(&json!({ "items": [item] })).unwrap().len(), 1);
    }

    #[test]
    fn param_helpers_enforce_non_empty_strings() {
        assert_eq!(str_param(&json!({}), "url").unwrap_err().code, "BAD_ARGS");
        assert_eq!(str_param(&json!({ "url": "" }), "url").unwrap_err().code, "BAD_ARGS");
        assert_eq!(str_param(&json!({ "url": "x" }), "url").unwrap(), "x");
        assert_eq!(num_u64(&json!({ "timeoutMs": 5000 }), "timeoutMs"), Some(5000));
        assert_eq!(num_u64(&json!({}), "timeoutMs"), None);
    }
}
