//! 会话管理（v1 `apps/kernel/src/session.ts`）。
//!
//! 会话 = 一次 `view` 命令的打开实例（每次打开都是新会话，sid 区分）；
//! `close` 的 reason 会随关闭事件广播给 UI（`reload` 表示插件正在重启，页面稍后会被重开）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use uuid::Uuid;

use crate::search::ViewSessions;
use crate::types::{Disposer, Session, SessionCloseReason};
use crate::util::now_ms;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEvent {
    Open,
    Close,
}

type Listener = Arc<dyn Fn(&Session, SessionEvent, Option<SessionCloseReason>) + Send + Sync>;

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, Session>>,
    listeners: Mutex<Vec<(u64, Listener)>>,
    next_id: AtomicU64,
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create(&self, plugin_id: &str, command: &str, port: u16) -> Session {
        let session = Session {
            sid: Uuid::new_v4().to_string(),
            plugin_id: plugin_id.to_string(),
            command: command.to_string(),
            token: Uuid::new_v4().simple().to_string(),
            port,
            created_at: now_ms(),
            last_search_token: 0,
        };
        self.sessions
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(session.sid.clone(), session.clone());
        self.emit(&session, SessionEvent::Open, None);
        session
    }

    pub fn get(&self, sid: &str) -> Option<Session> {
        self.sessions.lock().unwrap_or_else(|err| err.into_inner()).get(sid).cloned()
    }

    pub fn by_plugin(&self, plugin_id: &str) -> Vec<Session> {
        self.sessions
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .values()
            .filter(|session| session.plugin_id == plugin_id)
            .cloned()
            .collect()
    }

    pub fn all(&self) -> Vec<Session> {
        self.sessions.lock().unwrap_or_else(|err| err.into_inner()).values().cloned().collect()
    }

    /// reason 会随关闭事件广播给 UI。
    pub fn close(&self, sid: &str, reason: SessionCloseReason) -> bool {
        let session = self.sessions.lock().unwrap_or_else(|err| err.into_inner()).remove(sid);
        match session {
            Some(session) => {
                self.emit(&session, SessionEvent::Close, Some(reason));
                true
            }
            None => false,
        }
    }

    pub fn close_plugin(&self, plugin_id: &str, reason: SessionCloseReason) -> usize {
        let sids: Vec<String> = self
            .sessions
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .values()
            .filter(|session| session.plugin_id == plugin_id)
            .map(|session| session.sid.clone())
            .collect();
        sids.into_iter().filter(|sid| self.close(sid, reason)).count()
    }

    /// 更新最近一次搜索广播的 token（`searchResult.set` 的新鲜度校验）。
    pub fn mark_search_token(&self, sid: &str, token: u64) {
        if let Some(session) = self
            .sessions
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get_mut(sid)
        {
            session.last_search_token = token;
        }
    }

    pub fn on(self: &Arc<Self>, listener: Listener) -> Disposer {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        self.listeners.lock().unwrap_or_else(|err| err.into_inner()).push((id, listener));
        let manager = self.clone();
        Box::new(move || {
            manager
                .listeners
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .retain(|(existing, _)| *existing != id);
        })
    }

    fn emit(&self, session: &Session, kind: SessionEvent, reason: Option<SessionCloseReason>) {
        let listeners: Vec<Listener> = self
            .listeners
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .iter()
            .map(|(_, listener)| listener.clone())
            .collect();
        for listener in listeners {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(session, kind, reason)));
        }
    }
}

/// 搜索引擎只需要「有哪些会话」与「标记 token」（见 `search::ViewSessions`）。
impl ViewSessions for SessionManager {
    fn list(&self) -> Vec<(String, String)> {
        self.all().into_iter().map(|session| (session.sid, session.plugin_id)).collect()
    }

    fn mark_search(&self, sid: &str, token: u64) {
        self.mark_search_token(sid, token);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_close_and_close_plugin() {
        let manager = Arc::new(SessionManager::new());
        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let log = events.clone();
        let _disposer = manager.on(Arc::new(move |session, kind, reason| {
            let label = match kind {
                SessionEvent::Open => "open".to_string(),
                SessionEvent::Close => format!("close:{}", reason.map(|value| value.as_str()).unwrap_or("none")),
            };
            log.lock().unwrap().push(format!("{}:{label}", session.plugin_id));
        }));

        let first = manager.create("demo", "show", 1234);
        let second = manager.create("demo", "show", 1235);
        let other = manager.create("other", "show", 1236);

        assert_eq!(manager.get(&first.sid).unwrap().command, "show");
        assert_eq!(manager.by_plugin("demo").len(), 2);
        assert_eq!(manager.all().len(), 3);
        assert_ne!(first.token, second.token, "每次打开都是独立 token");
        assert_eq!(first.token.len(), 32, "token 去掉连字符");

        assert!(manager.close(&first.sid, SessionCloseReason::Close));
        assert!(!manager.close(&first.sid, SessionCloseReason::Close), "重复关闭返回 false");

        assert_eq!(manager.close_plugin("demo", SessionCloseReason::Reload), 1);
        assert!(manager.get(&second.sid).is_none());
        assert!(manager.get(&other.sid).is_some());

        let log = events.lock().unwrap().clone();
        assert_eq!(log[0], "demo:open");
        assert!(log.contains(&"demo:close:close".to_string()));
        assert!(log.contains(&"demo:close:reload".to_string()));
    }

    #[test]
    fn view_sessions_trait_marks_search_token() {
        let manager = Arc::new(SessionManager::new());
        let session = manager.create("demo", "feed", 1);
        assert_eq!(ViewSessions::list(manager.as_ref()), vec![(session.sid.clone(), "demo".to_string())]);
        ViewSessions::mark_search(manager.as_ref(), &session.sid, 42);
        assert_eq!(manager.get(&session.sid).unwrap().last_search_token, 42);
    }
}
