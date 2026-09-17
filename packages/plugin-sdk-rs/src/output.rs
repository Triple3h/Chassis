//! stdout 协议行输出（NDJSON，一行一个 JSON，写完立即 flush）。

use std::io::Write;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::{Result, SdkError};

#[derive(Clone)]
pub(crate) struct Out {
    inner: Arc<Mutex<std::io::Stdout>>,
}

impl Out {
    pub(crate) fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(std::io::stdout())) }
    }

    pub(crate) fn send(&self, value: &Value) -> Result<()> {
        let line = serde_json::to_string(value)
            .map_err(|err| SdkError::new("INTERNAL", format!("序列化协议消息失败：{err}")))?;
        let mut stdout = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        writeln!(stdout, "{line}")
            .and_then(|()| stdout.flush())
            .map_err(|err| SdkError::new("IO", format!("写 stdout 失败：{err}")))
    }
}
