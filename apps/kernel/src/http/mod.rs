//! HTTP 层（v1 `apps/kernel/src/http/`）：
//! - `server`：启动台 UI 宿主（静态资源 + API + SSE 扇出，ADR-0001）
//! - `plugin_servers`：每插件一个 listener（端口不同 ⇒ origin 不同 ⇒ 存储天然隔离）

pub mod plugin_servers;
pub mod server;
