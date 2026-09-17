//! `launcher-plugin-sdk` —— Chassis 逻辑层插件 Rust SDK（apiVersion 2）。
//!
//! 逻辑层插件（`no-view` / `script`）是独立可执行文件：宿主 `spawn` 后按行读写 NDJSON。
//! 协议权威定义见 `docs/plugin-spec.md` §4.4；决策背景见 `docs/decisions/ADR-0005-kernel-language.md`。
//!
//! 最小用法：
//!
//! ```no_run
//! use launcher_plugin_sdk::{json, Level, Mode};
//!
//! fn main() {
//!     launcher_plugin_sdk::run(|ctx| {
//!         match ctx.mode() {
//!             Mode::Run => {
//!                 ctx.log("开始", Some(&json!({ "command": ctx.command() })), Level::Info)?;
//!                 ctx.done(json!({ "ok": true }))?;
//!             }
//!             Mode::Search => ctx.on_query(|query, _token| Ok(vec![json!({ "id": query, "title": query })]))?,
//!         }
//!         Ok(())
//!     });
//! }
//! ```

mod context;
mod log;
mod output;
mod rpc;
mod search;

pub mod protocol;

pub use context::{Context, Mode, Storage};
pub use protocol::Level;
pub use serde_json::{json, Map, Value};

/// SDK 错误（`code` 与宿主错误码对齐：`BAD_ARGS` / `TIMEOUT` / `RPC_ERROR` / `IO` / `INTERNAL`）。
#[derive(Debug, Clone)]
pub struct SdkError {
    pub code: String,
    pub message: String,
}

impl SdkError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl std::fmt::Display for SdkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for SdkError {}

pub type Result<T> = std::result::Result<T, SdkError>;

/// 插件入口：解析上下文 → 分发 → 收尾。
///
/// - 闭包正常返回：`run` 模式补一条 `done`（若未显式结束）；`search` 模式继续常驻等 `shutdown` / stdin EOF。
/// - 闭包返回 `Err` 或 panic：自动转 `fail`（`{result, data:{__error}}` + `done`），与 v1 语义一致。
pub fn run<F>(main: F)
where
    F: FnOnce(&Context) -> Result<()>,
{
    let ctx = Context::from_args_and_env();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| main(&ctx)));
    match outcome {
        Ok(Ok(())) => {
            if ctx.mode() == Mode::Run {
                let _ = ctx.finish();
            }
        }
        Ok(Err(err)) => {
            let _ = ctx.fail(err.message);
        }
        Err(payload) => {
            let _ = ctx.fail(panic_text(&payload));
        }
    }
    if ctx.mode() == Mode::Search {
        ctx.wait_shutdown();
    }
}

fn panic_text(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        format!("panic：{text}")
    } else if let Some(text) = payload.downcast_ref::<String>() {
        format!("panic：{text}")
    } else {
        "panic".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sdk_error_display_is_message() {
        let err = SdkError::new("BAD_ARGS", "参数不合法");
        assert_eq!(err.to_string(), "参数不合法");
        assert_eq!(err.code, "BAD_ARGS");
    }
}
