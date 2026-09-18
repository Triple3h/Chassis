//! 管理面特权服务（v1 `services/settings.ts` + `services/settingsHost.ts`）。
//!
//! 只有 internal 插件（`internal-settings`）在装配期获得该服务，第三方插件拿不到，
//! 因此「设置 / 插件管理」不需要往通用 API 里塞配置读写（P1/P5 不被污染）。
//! 真实能力由宿主实现（`SettingsHost`，内核在 `kernel.rs` 里装配）。

use std::sync::Arc;

use serde_json::{json, Value};

use crate::error::{KernelError, Result};
use crate::exec::BoxFuture;

/// 宿主侧实现（内核）。谁是 internal 由 `SettingsService::guard` 决定，这里不做权限判断。
pub trait SettingsHost: Send + Sync {
    fn get_config(&self) -> Value;
    /// 配置写入的唯一收口（`Kernel::patch_config`）：副作用（历史上限 / 自启 / 热键）与广播都在里面。
    fn patch_config(&self, patch: Value) -> BoxFuture<Result<Value>>;
    fn set_autostart(&self, enabled: bool) -> BoxFuture<Result<()>>;
    fn set_history_limit(&self, limit: i64) -> BoxFuture<Result<()>>;
    fn list_plugins(&self) -> BoxFuture<Result<Vec<Value>>>;
    fn plugin_action(&self, action: String, payload: Value) -> BoxFuture<Result<Value>>;
    /// 导出诊断日志（内核日志 + 插件状态 + 审计摘要）：`scope` = `session`（本次运行）| `all`（跨运行）。
    fn export_logs(&self, scope: String) -> BoxFuture<Result<Value>>;
    fn query_audit(&self, limit: usize) -> Vec<Value>;
    fn clear_audit(&self);
    fn clear_history(&self);
    fn open_data_dir(&self) -> BoxFuture<Result<()>>;
    fn reveal_path(&self, target: String) -> BoxFuture<Result<()>>;
    fn host_info(&self) -> Value;
}

pub struct SettingsService {
    host: Arc<dyn SettingsHost>,
    plugin_id: String,
}

impl SettingsService {
    pub fn new(host: Arc<dyn SettingsHost>, plugin_id: &str) -> Self {
        Self { host, plugin_id: plugin_id.to_string() }
    }

    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    fn guard(&self, action: &str) -> Result<()> {
        if !self.plugin_id.starts_with("internal-") {
            return Err(KernelError::new("FORBIDDEN", format!("仅管理面插件可调用 settings.{action}")));
        }
        Ok(())
    }

    pub async fn get(&self) -> Result<Value> {
        self.guard("get")?;
        Ok(self.host.get_config())
    }

    pub async fn patch(&self, patch: Value) -> Result<Value> {
        self.guard("patch")?;
        self.host.patch_config(patch).await
    }

    pub async fn set_autostart(&self, enabled: bool) -> Result<()> {
        self.guard("setAutostart")?;
        self.host.set_autostart(enabled).await
    }

    pub async fn set_history_limit(&self, limit: i64) -> Result<()> {
        self.guard("setHistoryLimit")?;
        self.host.set_history_limit(limit).await
    }

    pub async fn plugins(&self) -> Result<Vec<Value>> {
        self.guard("plugins")?;
        self.host.list_plugins().await
    }

    pub async fn plugin_action(&self, action: &str, payload: Value) -> Result<Value> {
        self.guard("pluginAction")?;
        if action.is_empty() {
            return Err(KernelError::bad_args("action 必填"));
        }
        self.host.plugin_action(action.to_string(), payload).await
    }

    /// 导出诊断日志（设置页「关于 → 导出日志」）：宿主写文件并返回落点，不在响应里回传全文。
    pub async fn export_logs(&self, scope: Option<String>) -> Result<Value> {
        self.guard("exportLogs")?;
        self.host.export_logs(scope.unwrap_or_else(|| "session".to_string())).await
    }

    pub async fn audit(&self, limit: Option<i64>) -> Result<Vec<Value>> {
        self.guard("audit")?;
        let limit = limit.unwrap_or(100).clamp(1, 500);
        Ok(self.host.query_audit(limit as usize))
    }

    pub async fn clear_audit(&self) -> Result<()> {
        self.guard("clearAudit")?;
        self.host.clear_audit();
        Ok(())
    }

    pub async fn clear_history(&self) -> Result<()> {
        self.guard("clearHistory")?;
        self.host.clear_history();
        Ok(())
    }

    pub async fn open_data_dir(&self) -> Result<()> {
        self.guard("openDataDir")?;
        self.host.open_data_dir().await
    }

    pub async fn reveal_plugin(&self, id: &str) -> Result<()> {
        self.guard("revealPlugin")?;
        let plugins = self.host.list_plugins().await?;
        let record = plugins.iter().find(|entry| entry.get("id").and_then(Value::as_str) == Some(id));
        let Some(record) = record else {
            return Err(KernelError::not_found(format!("插件不存在：{id}")));
        };
        let dir = record.get("dir").and_then(Value::as_str).unwrap_or_default().to_string();
        self.host.reveal_path(dir).await
    }

    pub async fn info(&self) -> Result<Value> {
        self.guard("info")?;
        Ok(self.host.host_info())
    }

    /// 管理面方法名 → 调用（view 桥与逻辑层 RPC 共用这一处转发）。
    pub async fn call(&self, method: &str, params: &Value) -> Result<Value> {
        match method {
            "get" => self.get().await,
            "patch" => {
                let patch = params.get("patch").cloned().unwrap_or_else(|| params.clone());
                self.patch(patch).await
            }
            "setAutostart" => {
                let enabled = params.get("enabled").and_then(Value::as_bool).unwrap_or(false);
                self.set_autostart(enabled).await.map(|_| Value::Null)
            }
            "setHistoryLimit" => {
                let limit = params.get("limit").and_then(Value::as_i64).unwrap_or(0);
                self.set_history_limit(limit).await.map(|_| Value::Null)
            }
            "plugins" => Ok(Value::Array(self.plugins().await?)),
            "pluginAction" => {
                let action = params.get("action").and_then(Value::as_str).unwrap_or_default().to_string();
                let payload = params.get("payload").cloned().unwrap_or_else(|| json!({}));
                self.plugin_action(&action, payload).await
            }
            "exportLogs" => {
                let scope = params.get("scope").and_then(Value::as_str).map(str::to_string);
                self.export_logs(scope).await
            }
            "audit" => Ok(Value::Array(self.audit(params.get("limit").and_then(Value::as_i64)).await?)),
            "clearAudit" => self.clear_audit().await.map(|_| Value::Null),
            "clearHistory" => self.clear_history().await.map(|_| Value::Null),
            "openDataDir" => self.open_data_dir().await.map(|_| Value::Null),
            "revealPlugin" => {
                let id = params.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                self.reveal_plugin(&id).await.map(|_| Value::Null)
            }
            "info" => self.info().await,
            other => Err(KernelError::not_found(format!("未知 settings 方法：{other}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeHost {
        calls: AtomicUsize,
        history_cleared: AtomicUsize,
    }

    impl FakeHost {
        fn new() -> Self {
            Self { calls: AtomicUsize::new(0), history_cleared: AtomicUsize::new(0) }
        }
    }

    impl SettingsHost for FakeHost {
        fn get_config(&self) -> Value {
            self.calls.fetch_add(1, Ordering::SeqCst);
            json!({ "hotkey": "Alt+Space" })
        }
        fn patch_config(&self, patch: Value) -> BoxFuture<Result<Value>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { Ok(json!({ "config": patch })) })
        }
        fn set_autostart(&self, _enabled: bool) -> BoxFuture<Result<()>> {
            Box::pin(async { Ok(()) })
        }
        fn set_history_limit(&self, _limit: i64) -> BoxFuture<Result<()>> {
            Box::pin(async { Ok(()) })
        }
        fn list_plugins(&self) -> BoxFuture<Result<Vec<Value>>> {
            Box::pin(async { Ok(vec![json!({ "id": "demo", "dir": "/tmp/demo" })]) })
        }
        fn plugin_action(&self, action: String, _payload: Value) -> BoxFuture<Result<Value>> {
            Box::pin(async move { Ok(json!({ "action": action })) })
        }
        fn export_logs(&self, scope: String) -> BoxFuture<Result<Value>> {
            Box::pin(async move { Ok(json!({ "scope": scope })) })
        }
        fn query_audit(&self, limit: usize) -> Vec<Value> {
            vec![json!({ "limit": limit })]
        }
        fn clear_audit(&self) {}
        fn clear_history(&self) {
            self.history_cleared.fetch_add(1, Ordering::SeqCst);
        }
        fn open_data_dir(&self) -> BoxFuture<Result<()>> {
            Box::pin(async { Ok(()) })
        }
        fn reveal_path(&self, _target: String) -> BoxFuture<Result<()>> {
            Box::pin(async { Ok(()) })
        }
        fn host_info(&self) -> Value {
            json!({ "version": "0.5.0", "platform": std::env::consts::OS, "dataRoot": "/tmp", "node": "—" })
        }
    }

    #[tokio::test]
    async fn guard_blocks_third_party_plugins() {
        let host = Arc::new(FakeHost::new());
        let service = SettingsService::new(host.clone(), "demo-plugin");
        let err = service.get().await.unwrap_err();
        assert_eq!(err.code, "FORBIDDEN");
        assert_eq!(host.calls.load(Ordering::SeqCst), 0, "没权限时不得触碰宿主");

        let internal = SettingsService::new(host, "internal-settings");
        assert!(internal.get().await.is_ok());
        assert_eq!(internal.audit(Some(999)).await.unwrap()[0]["limit"], 500, "limit 钳到 1..=500");
    }

    #[tokio::test]
    async fn internal_plugin_calls_forwarded() {
        let host = Arc::new(FakeHost::new());
        let service = SettingsService::new(host.clone(), "internal-settings");

        assert_eq!(service.call("get", &json!({})).await.unwrap()["hotkey"], "Alt+Space");
        assert_eq!(service.call("plugins", &json!({})).await.unwrap()[0]["id"], "demo");
        assert_eq!(service.call("pluginAction", &json!({ "action": "reload" })).await.unwrap()["action"], "reload");
        assert_eq!(service.call("exportLogs", &json!({ "scope": "all" })).await.unwrap()["scope"], "all");
        assert_eq!(service.call("exportLogs", &json!({})).await.unwrap()["scope"], "session", "缺省范围 = 最近一次会话");
        service.call("clearHistory", &json!({})).await.unwrap();
        assert_eq!(host.history_cleared.load(Ordering::SeqCst), 1);
        service.call("revealPlugin", &json!({ "id": "demo" })).await.unwrap();

        let err = service.call("revealPlugin", &json!({ "id": "missing" })).await.unwrap_err();
        assert_eq!(err.code, "NOT_FOUND");
        let err = service.call("nope", &json!({})).await.unwrap_err();
        assert_eq!(err.code, "NOT_FOUND");
    }
}
