//! apiVersion 2 协议消息（NDJSON over stdio）—— 见 `docs/plugin-spec.md` §4.4。
//!
//! 语义与 v1（worker_threads）逐条对齐：
//! 插件 → 宿主：`result` / `done` / `log` / `progress` / `rpc`；
//! 宿主 → 插件：`query` / `rpc-result` / `shutdown`。

use serde_json::{Map, Value};

/// 日志级别（序列化为 v1 同名字符串）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }
}

fn message(kind: &str) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("type".to_string(), Value::String(kind.to_string()));
    map
}

/// `{ type: 'log', level, message, data? }`（data 缺省时不出现该字段，与 v1 一致）。
pub(crate) fn log_line(level: Level, text: &str, data: Option<&Value>) -> Value {
    let mut map = message("log");
    map.insert("level".to_string(), Value::String(level.as_str().to_string()));
    map.insert("message".to_string(), Value::String(text.to_string()));
    if let Some(data) = data {
        map.insert("data".to_string(), data.clone());
    }
    Value::Object(map)
}

/// `{ type: 'progress', p, data? }`（p 钳制到 0..1，同 v1 的 `Math.min/max`）。
pub(crate) fn progress_line(p: f64, data: Option<&Value>) -> Value {
    let clamped = if p.is_finite() { p.clamp(0.0, 1.0) } else { 0.0 };
    let mut map = message("progress");
    map.insert("p".to_string(), Value::from(clamped));
    if let Some(data) = data {
        map.insert("data".to_string(), data.clone());
    }
    Value::Object(map)
}

/// `{ type: 'result', data }`（`run` 模式的递交结果）。
pub(crate) fn result_line(data: Value) -> Value {
    let mut map = message("result");
    map.insert("data".to_string(), data);
    Value::Object(map)
}

/// `{ type: 'result', token, data }`（`search` 模式对某次查询的应答）。
pub(crate) fn search_result_line(token: u64, data: Value) -> Value {
    let mut map = message("result");
    map.insert("token".to_string(), Value::from(token));
    map.insert("data".to_string(), data);
    Value::Object(map)
}

/// `{ type: 'done' }` —— 本次执行的唯一结束信号。
pub(crate) fn done_line() -> Value {
    Value::Object(message("done"))
}

/// `{ type: 'rpc', id, method, params }` —— 调用宿主。
pub(crate) fn rpc_line(id: u64, method: &str, params: Value) -> Value {
    let mut map = message("rpc");
    map.insert("id".to_string(), Value::from(id));
    map.insert("method".to_string(), Value::String(method.to_string()));
    map.insert("params".to_string(), params);
    Value::Object(map)
}
