//! 贡献型搜索（`contributes: true`）：注册 `on_query`、等宿主下发 `query`、回 `result(token)`。
//!
//! 与 v1 `onQuery` 的差异只有载体：v1 是 worker 的 `parentPort` 消息，v2 是 stdin/stdout 的 NDJSON。

use std::sync::Arc;

use serde_json::Value;

use crate::{Context, Result};

pub(crate) type QueryHandler = Arc<dyn Fn(&str, u64) -> Result<Vec<Value>> + Send + Sync + 'static>;

impl Context {
    /// 注册查询处理器（`mode=search` 的常驻命令；可重复调用，后者覆盖前者）。
    ///
    /// 返回值即结果项数组（`ResultItem[]`，见 `docs/plugin-spec.md` §9.3）；
    /// 返回 `Err` 只记日志、不回 result —— 与 v1 一致，由宿主按 200ms 超时丢弃本次贡献。
    pub fn on_query<F>(&self, handler: F) -> Result<()>
    where
        F: Fn(&str, u64) -> Result<Vec<Value>> + Send + Sync + 'static,
    {
        let mut state = self.inner.query.lock().unwrap_or_else(|err| err.into_inner());
        state.handler = Some(Arc::new(handler));
        drop(state);
        self.ensure_executor();
        Ok(())
    }

    /// 阻塞直到宿主 `shutdown` 或 stdin EOF（`search` 模式在 `run()` 返回后调用）。
    pub(crate) fn wait_shutdown(&self) {
        let mut flag = self.inner.shutdown.lock().unwrap_or_else(|err| err.into_inner());
        while !*flag {
            flag = self.inner.shutdown_cv.wait(flag).unwrap_or_else(|err| err.into_inner());
        }
    }
}
