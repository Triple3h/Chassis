//! 宿主 RPC 客户端：写 `rpc` 行 → 等 `rpc-result` 行（由 reader 线程唤醒）。
//!
//! 同步实现（SDK 不引入异步运行时）：调用线程阻塞等待，超时默认 5s（与 v1 `@launcher/api-node` 一致）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;

use crate::output::Out;
use crate::protocol;
use crate::{Result, SdkError};

#[derive(Debug, Clone)]
pub(crate) struct ApiError {
    pub(crate) code: String,
    pub(crate) message: String,
}

pub(crate) struct RpcClient {
    out: Out,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Sender<std::result::Result<Value, ApiError>>>>,
    timeout: Duration,
}

impl RpcClient {
    pub(crate) fn new(out: Out) -> Self {
        Self {
            out,
            next_id: AtomicU64::new(0),
            pending: Mutex::new(HashMap::new()),
            timeout: Duration::from_millis(5_000),
        }
    }

    pub(crate) fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap_or_else(|err| err.into_inner()).insert(id, tx);
        self.out.send(&protocol::rpc_line(id, method, params))?;
        match rx.recv_timeout(self.timeout) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(err)) => Err(SdkError::new(err.code, err.message)),
            Err(_) => {
                self.pending.lock().unwrap_or_else(|err| err.into_inner()).remove(&id);
                Err(SdkError::new("TIMEOUT", format!("宿主调用超时：{method}")))
            }
        }
    }

    /// 由 reader 线程调用：`{ type:'rpc-result', id, ok, data?, error? }`。
    pub(crate) fn resolve_from(&self, message: &Value) {
        let id = message.get("id").and_then(Value::as_u64).unwrap_or(0);
        let ok = message.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let result = if ok {
            Ok(message.get("data").cloned().unwrap_or(Value::Null))
        } else {
            let error = message.get("error").cloned().unwrap_or(Value::Null);
            Err(ApiError {
                code: error.get("code").and_then(Value::as_str).unwrap_or("INTERNAL").to_string(),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("宿主调用失败")
                    .to_string(),
            })
        };
        if let Some(tx) = self.pending.lock().unwrap_or_else(|err| err.into_inner()).remove(&id) {
            let _ = tx.send(result);
        }
    }
}
