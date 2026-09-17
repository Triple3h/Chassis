//! 内核内部类型（v1 `apps/kernel/src/types.ts` 的 Rust 版）。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::manifest::CommandMode;

pub type Disposer = Box<dyn Fn() + Send + Sync>;

/// 会话为什么被关掉：`reload` 时 UI 应当在插件重载完成后重开该页面。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionCloseReason {
    Close,
    Ui,
    Reload,
    Disable,
    Uninstall,
    Shutdown,
}

impl SessionCloseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionCloseReason::Close => "close",
            SessionCloseReason::Ui => "ui",
            SessionCloseReason::Reload => "reload",
            SessionCloseReason::Disable => "disable",
            SessionCloseReason::Uninstall => "uninstall",
            SessionCloseReason::Shutdown => "shutdown",
        }
    }
}

/// 一次 view 命令的打开实例。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub sid: String,
    pub plugin_id: String,
    pub command: String,
    pub token: String,
    pub port: u16,
    pub created_at: i64,
    /// 最近一次搜索广播的 token（`searchResult.set` 的新鲜度校验）
    pub last_search_token: u64,
}

/// 一次命令执行的上下文（管线中间件用）。
#[derive(Debug, Clone)]
pub struct ExecContext {
    /// 全局命令 id = `${pluginId}:${command}`
    pub id: String,
    pub plugin_id: String,
    pub command: String,
    pub mode: CommandMode,
    pub args: Option<Value>,
    /// 触发该项的会话（若来自插件页）
    pub session: Option<Session>,
    /// 调用来源：`ui` | `plugin` | `host`
    pub source: String,
    pub meta: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Quicklink {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}
