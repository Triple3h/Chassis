//! 宿主 UI 桥（v1 `services/hostUi.ts`；requirements §8.6 / plugin-spec §7.2）：
//! 读写启动台搜索框、footer 按钮、请求隐藏窗口。

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::audit::AuditLog;
use crate::error::Result;
use crate::events::{names, EventBus};
use crate::exec::BoxFuture;
use crate::services::audited;

#[derive(Debug, Clone)]
pub struct UiState {
    /// 启动台搜索框当前内容（UI 每次输入同步过来）
    pub search_content: String,
    pub theme: String,
}

impl Default for UiState {
    fn default() -> Self {
        Self { search_content: String::new(), theme: "dark".to_string() }
    }
}

type HideFn = Arc<dyn Fn() -> BoxFuture<Result<()>> + Send + Sync>;

pub struct HostUiBridge {
    bus: EventBus,
    audit: Arc<AuditLog>,
    hide: HideFn,
    state: Arc<Mutex<UiState>>,
}

impl HostUiBridge {
    pub fn new(bus: EventBus, audit: Arc<AuditLog>, hide: HideFn) -> Self {
        Self { bus, audit, hide, state: Arc::new(Mutex::new(UiState::default())) }
    }

    pub fn set_query(&self, query: &str) {
        self.state.lock().unwrap_or_else(|err| err.into_inner()).search_content = query.to_string();
    }

    pub fn search_content(&self) -> String {
        self.state.lock().unwrap_or_else(|err| err.into_inner()).search_content.clone()
    }

    pub fn set_theme(&self, theme: &str) {
        self.state.lock().unwrap_or_else(|err| err.into_inner()).theme = theme.to_string();
    }

    pub fn theme(&self) -> String {
        self.state.lock().unwrap_or_else(|err| err.into_inner()).theme.clone()
    }

    pub async fn get_search_content(&self, plugin_id: &str, sid: &str) -> Result<String> {
        let _ = sid;
        let audit = self.audit.clone();
        let plugin_id = plugin_id.to_string();
        let state = self.search_content();
        audited(&audit, &plugin_id, "ui", "ctx.hostUi.getSearchContent", "hostUi", None, async { Ok(state) }).await
    }

    pub async fn set_search_content(&self, plugin_id: &str, sid: &str, value: &str) -> Result<bool> {
        let audit = self.audit.clone();
        let bus = self.bus.clone();
        let state = self.state.clone();
        let sid = sid.to_string();
        let value = value.to_string();
        audited(
            &audit,
            plugin_id,
            "ui",
            "ctx.hostUi.setSearchContent",
            "hostUi",
            Some(json!({ "value": value })),
            async move {
                state.lock().unwrap_or_else(|err| err.into_inner()).search_content = value.clone();
                bus.emit(names::UI_SEARCH_CONTENT, &json!({ "value": value, "sid": sid }));
                Ok(true)
            },
        )
        .await
    }

    pub async fn clear_search_content(&self, plugin_id: &str, sid: &str) -> Result<bool> {
        self.set_search_content(plugin_id, sid, "").await
    }

    pub async fn set_footer(&self, plugin_id: &str, sid: &str, buttons: Vec<Value>) -> Result<bool> {
        let audit = self.audit.clone();
        let bus = self.bus.clone();
        let sid = sid.to_string();
        let payload = json!({ "buttons": buttons });
        audited(
            &audit,
            plugin_id,
            "ui",
            "ctx.hostUi.setFooter",
            "hostUi",
            Some(payload.clone()),
            async move {
                bus.emit(names::UI_FOOTER, &json!({ "sid": sid, "buttons": payload.get("buttons") }));
                Ok(true)
            },
        )
        .await
    }

    pub async fn hide(&self, plugin_id: &str, sid: &str) -> Result<()> {
        let audit = self.audit.clone();
        let bus = self.bus.clone();
        let hide = self.hide.clone();
        let sid = sid.to_string();
        audited(&audit, plugin_id, "ui", "ctx.hostUi.hide", "hostUi", None, async move {
            bus.emit(names::UI_HIDE, &json!({ "sid": sid }));
            hide().await
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::AuditLog;

    fn bridge(sink: Arc<Mutex<Vec<String>>>) -> HostUiBridge {
        let bus = EventBus::new();
        let sink_for_bus = sink.clone();
        bus.set_sink(Arc::new(move |event, payload| {
            sink_for_bus.lock().unwrap().push(format!("{event}:{payload}"));
        }));
        let sink_for_hide = sink.clone();
        let hide = Arc::new(move || {
            let sink = sink_for_hide.clone();
            Box::pin(async move {
                sink.lock().unwrap().push("hide".to_string());
                Ok(())
            }) as BoxFuture<Result<()>>
        });
        HostUiBridge::new(bus, Arc::new(AuditLog::new(std::path::Path::new("/tmp/nowhere-hostui"))), hide)
    }

    #[tokio::test]
    async fn search_content_broadcasts_and_footer_hides() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let host = bridge(events.clone());

        host.set_query("初始");
        assert_eq!(host.search_content(), "初始");

        assert!(host.set_search_content("demo", "sid-1", "新输入").await.unwrap());
        assert_eq!(host.get_search_content("demo", "sid-1").await.unwrap(), "新输入");
        assert!(host.clear_search_content("demo", "sid-1").await.unwrap());
        assert_eq!(host.search_content(), "");

        host.set_footer("demo", "sid-1", vec![json!({ "type": "button", "id": "a", "label": "A" })]).await.unwrap();
        host.hide("demo", "sid-1").await.unwrap();

        let log = events.lock().unwrap().clone();
        assert!(log[0].starts_with("ui/searchContent:"), "log = {log:?}");
        assert!(log.iter().any(|line| line.starts_with("ui/footer:")));
        assert!(log.iter().any(|line| line.starts_with("ui/hide:")));
        assert_eq!(log.last().unwrap(), "hide", "hide 事件之后才真正隐藏窗口");
    }
}
