//! 极简事件总线（对齐 v1 `apps/kernel/src/events.ts`）：内核内部广播 + 桥接给插件页 / 启动台 UI。
//!
//! 单个订阅者 panic 不影响其它订阅者（与 v1 的 try/catch 语义一致）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;

pub type EventHandler = Arc<dyn Fn(&Value) + Send + Sync>;
/// UI / 插件桥的扇出钩子（SSE、postMessage）。
pub type EventSink = Arc<dyn Fn(&str, &Value) + Send + Sync>;

/// 事件名（唯一真源；与 v1 `KernelEvent` 对齐）。
pub mod names {
    pub const REGISTRY_CHANGED: &str = "registry/changed";
    pub const CONFIG_CHANGED: &str = "config/changed";
    pub const PLUGIN_STATE: &str = "plugin/state";
    pub const PLUGIN_RELOADED: &str = "plugin/reloaded";
    pub const SESSION_CLOSED: &str = "session/closed";
    pub const HISTORY_CHANGED: &str = "history/changed";
    pub const PINNED_CHANGED: &str = "pinned/changed";
    pub const SEARCH_QUERY: &str = "search/query";
    pub const SEARCH_RESULTS: &str = "search/results";
    pub const UI_SEARCH_CONTENT: &str = "ui/searchContent";
    pub const UI_FOOTER: &str = "ui/footer";
    pub const UI_HIDE: &str = "ui/hide";
    /// 内核主动让 UI 打开插件页（托盘「设置…」「插件管理…」）；载荷 = `ActionResult`
    pub const UI_OPEN_VIEW: &str = "ui/openView";
    /// 内核热更新已应用 / 已回滚（载荷：generation / revision / modules）
    pub const HOT_UPDATED: &str = "hot/updated";
    /// 内核因热更新即将重启（载荷：reason / version / pid）
    pub const HOT_RESTARTING: &str = "hot/restarting";
    pub const SHELL_VISIBILITY: &str = "shell/visibility";
    pub const APP_QUIT: &str = "app/quit";
}

#[derive(Clone, Default)]
pub struct EventBus {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    handlers: Mutex<HashMap<String, Vec<(u64, EventHandler)>>>,
    sink: Mutex<Option<EventSink>>,
    next_id: AtomicU64,
}

impl EventBus {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_sink(&self, sink: EventSink) {
        *self.inner.sink.lock().unwrap_or_else(|err| err.into_inner()) = Some(sink);
    }

    /// 订阅；返回取消订阅的 Disposer。
    pub fn on(&self, event: &str, handler: EventHandler) -> Box<dyn Fn() + Send + Sync> {
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        self.inner
            .handlers
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .entry(event.to_string())
            .or_default()
            .push((id, handler));

        let inner = self.inner.clone();
        let event = event.to_string();
        Box::new(move || {
            if let Some(list) = inner.handlers.lock().unwrap_or_else(|err| err.into_inner()).get_mut(&event) {
                list.retain(|(existing_id, _)| *existing_id != id);
            }
        })
    }

    pub fn emit(&self, event: &str, payload: &Value) {
        let handlers: Vec<EventHandler> = self
            .inner
            .handlers
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(event)
            .map(|list| list.iter().map(|(_, handler)| handler.clone()).collect())
            .unwrap_or_default();
        for handler in handlers {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(payload)));
        }
        let sink = self.inner.sink.lock().unwrap_or_else(|err| err.into_inner()).clone();
        if let Some(sink) = sink {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink(event, payload)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn delivers_to_subscribers_and_sink() {
        let bus = EventBus::new();
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));

        let sink_seen = seen.clone();
        bus.set_sink(Arc::new(move |event, payload| {
            sink_seen.lock().unwrap().push(format!("sink:{event}:{payload}"));
        }));
        let handler_seen = seen.clone();
        let _disposer = bus.on(names::PLUGIN_STATE, Arc::new(move |payload| {
            handler_seen.lock().unwrap().push(format!("handler:{payload}"));
        }));

        bus.emit(names::PLUGIN_STATE, &json!({ "ok": true }));

        let log = seen.lock().unwrap().clone();
        assert_eq!(log.len(), 2);
        assert!(log[0].starts_with("handler:"));
        assert!(log[1].starts_with("sink:plugin/state:"));
    }

    #[test]
    fn disposer_unsubscribes_and_panicking_subscriber_isolated() {
        let bus = EventBus::new();
        let counter = Arc::new(Mutex::new(0));

        let first = counter.clone();
        let disposer = bus.on("x", Arc::new(move |_| {
            *first.lock().unwrap() += 1;
        }));
        let second = counter.clone();
        let _panic_subscriber = bus.on("x", Arc::new(move |_| {
            *second.lock().unwrap() += 1;
            panic!("订阅者内部 panic 不应该影响别人");
        }));

        bus.emit("x", &json!(null));
        assert_eq!(*counter.lock().unwrap(), 2);

        disposer();
        bus.emit("x", &json!(null));
        assert_eq!(*counter.lock().unwrap(), 3, "取消订阅后不再收到事件");
    }
}
