//! 运行上下文：`--launcher-context` 解析、stdin reader、search executor（见 `search.rs`）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};

use serde::de::DeserializeOwned;
use serde_json::{json, Map, Value};

use crate::output::Out;
use crate::protocol::{self, Level};
use crate::rpc::RpcClient;
use crate::search::QueryHandler;
use crate::{Result, SdkError};

/// 运行模式：`run` = 一次性执行；`search` = 贡献型常驻（宿主按需启停）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Run,
    Search,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Run => "run",
            Mode::Search => "search",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "run" => Some(Mode::Run),
            "search" => Some(Mode::Search),
            _ => None,
        }
    }
}

pub(crate) struct QueryState {
    pub(crate) handler: Option<QueryHandler>,
    pub(crate) tx: Option<mpsc::Sender<(u64, String)>>,
    /// handler 注册前到达的 query（宿主 prewarm 后可能立刻下发；缓冲住，注册后补投）
    pub(crate) early: Vec<(u64, String)>,
}

pub(crate) struct Inner {
    pub(crate) plugin_id: String,
    pub(crate) command: String,
    pub(crate) plugin_path: PathBuf,
    pub(crate) data_path: PathBuf,
    pub(crate) data_root: String,
    pub(crate) mode: Mode,
    pub(crate) args: Value,
    pub(crate) settings: Map<String, Value>,
    pub(crate) out: Out,
    pub(crate) rpc: RpcClient,
    pub(crate) done: AtomicBool,
    pub(crate) query: Mutex<QueryState>,
    pub(crate) shutdown: Mutex<bool>,
    pub(crate) shutdown_cv: Condvar,
}

impl Inner {
    pub(crate) fn set_shutdown(&self) {
        let mut flag = self.shutdown.lock().unwrap_or_else(|err| err.into_inner());
        *flag = true;
        self.shutdown_cv.notify_all();
    }
}

/// 插件运行上下文（克隆很便宜；可以传进 `on_query` 的闭包）。
#[derive(Clone)]
pub struct Context {
    pub(crate) inner: Arc<Inner>,
}

impl Context {
    /// 解析 `--mode` / `--launcher-context`（缺失字段用 `LAUNCHER_PLUGIN_ID` / `LAUNCHER_DATA_PATH` 兜底）。
    pub fn from_args_and_env() -> Self {
        let mut mode_arg = None;
        let mut context_arg = None;
        let mut iter = std::env::args().skip(1);
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--mode" => mode_arg = iter.next().as_deref().and_then(Mode::parse),
                "--launcher-context" => context_arg = iter.next(),
                _ => {}
            }
        }
        let raw = context_arg.as_deref().and_then(decode_context).unwrap_or(Value::Null);

        let out = Out::new();
        let rpc = RpcClient::new(out.clone());
        let inner = Arc::new(Inner {
            plugin_id: text(&raw, "pluginId").or_else(|| env_text("LAUNCHER_PLUGIN_ID")).unwrap_or_default(),
            command: text(&raw, "command").unwrap_or_default(),
            plugin_path: PathBuf::from(text(&raw, "pluginPath").unwrap_or_default()),
            data_path: PathBuf::from(
                text(&raw, "dataPath").or_else(|| env_text("LAUNCHER_DATA_PATH")).unwrap_or_default(),
            ),
            data_root: text(&raw, "dataRoot").unwrap_or_default(),
            mode: mode_arg
                .or_else(|| text(&raw, "mode").as_deref().and_then(Mode::parse))
                .unwrap_or(Mode::Run),
            args: raw.get("args").cloned().unwrap_or(Value::Null),
            settings: raw.get("settings").and_then(Value::as_object).cloned().unwrap_or_default(),
            out,
            rpc,
            done: AtomicBool::new(false),
            query: Mutex::new(QueryState { handler: None, tx: None, early: Vec::new() }),
            shutdown: Mutex::new(false),
            shutdown_cv: Condvar::new(),
        });
        spawn_reader(inner.clone());
        Self { inner }
    }

    pub fn plugin_id(&self) -> &str {
        &self.inner.plugin_id
    }

    pub fn command(&self) -> &str {
        &self.inner.command
    }

    pub fn mode(&self) -> Mode {
        self.inner.mode
    }

    /// 只读安装目录（N2：不得写入）。
    pub fn plugin_path(&self) -> &Path {
        &self.inner.plugin_path
    }

    /// 唯一可写目录（`<dataRoot>/plugins/<id>/`）。
    pub fn data_path(&self) -> &Path {
        &self.inner.data_path
    }

    pub fn data_root(&self) -> &str {
        &self.inner.data_root
    }

    /// 生效设置（启动时快照；改设置会重载插件）。
    pub fn settings(&self) -> &Map<String, Value> {
        &self.inner.settings
    }

    pub fn settings_str(&self, key: &str) -> Option<&str> {
        self.inner.settings.get(key).and_then(Value::as_str)
    }

    pub fn settings_bool(&self, key: &str) -> Option<bool> {
        self.inner.settings.get(key).and_then(Value::as_bool)
    }

    /// `--launcher-context` 的 `args`（`mode=run` 的入参）。
    pub fn raw_args(&self) -> &Value {
        &self.inner.args
    }

    /// 反序列化 `args`（缺字段用 `#[serde(default)]` / `Option` 处理）。
    pub fn args<T: DeserializeOwned>(&self) -> Result<T> {
        serde_json::from_value(self.inner.args.clone())
            .map_err(|err| SdkError::new("BAD_ARGS", format!("args 反序列化失败：{err}")))
    }

    /// 正常结束：写 `result` + `done`（幂等，重复调用无副作用）。
    pub fn done(&self, data: Value) -> Result<()> {
        if self.inner.done.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.send(&protocol::result_line(data))?;
        self.send(&protocol::done_line())
    }

    /// 异常结束：写 `{result, data:{__error}}` + `done`（宿主沿用 v1 的 `isFailurePayload` 判定）。
    pub fn fail(&self, error: impl std::fmt::Display) -> Result<()> {
        if self.inner.done.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.send(&protocol::result_line(json!({ "__error": error.to_string() })))?;
        self.send(&protocol::done_line())
    }

    /// 收尾：若未显式结束，补一条 `done`（无 result）。
    pub fn finish(&self) -> Result<()> {
        if self.inner.done.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.send(&protocol::done_line())
    }

    /// 插件私有 KV（走宿主 RPC，与 UI 侧同一份数据）。
    pub fn storage(&self) -> Storage {
        Storage { inner: self.inner.clone() }
    }

    pub(crate) fn send(&self, message: &Value) -> Result<()> {
        self.inner.out.send(message)
    }

    /// 首次注册 `on_query` 时启动 executor 线程（串行处理 query）。
    pub(crate) fn ensure_executor(&self) {
        let mut state = self.inner.query.lock().unwrap_or_else(|err| err.into_inner());
        if state.tx.is_some() {
            return;
        }
        let (tx, rx) = mpsc::channel::<(u64, String)>();
        for pending in state.early.drain(..) {
            let _ = tx.send(pending);
        }
        state.tx = Some(tx);
        drop(state);

        let inner = self.inner.clone();
        std::thread::spawn(move || {
            while let Ok((token, query)) = rx.recv() {
                let handler = inner.query.lock().unwrap_or_else(|err| err.into_inner()).handler.clone();
                let Some(handler) = handler else { continue };
                match handler(&query, token) {
                    Ok(items) => {
                        let _ = inner
                            .out
                            .send(&protocol::search_result_line(token, Value::Array(items)));
                    }
                    Err(err) => {
                        // v1 语义：handler 异常只记日志、不回 result ⇒ 宿主按超时丢弃本次贡献
                        let _ = inner.out.send(&protocol::log_line(
                            Level::Error,
                            &format!("on_query 处理失败：{}", err.message),
                            None,
                        ));
                    }
                }
            }
        });
    }
}

/// 插件私有 KV（`<dataRoot>/plugins/<id>/storage.json`）。
///
/// 内部是 `Arc<Inner>`：`Clone` 只是复制句柄 —— 便于把它捕获进 `on_query` 的 handler。
#[derive(Clone)]
pub struct Storage {
    inner: Arc<Inner>,
}

impl Storage {
    pub fn get(&self, key: &str) -> Result<Option<Value>> {
        let value = self.inner.rpc.call("storage.get", json!({ "key": key }))?;
        Ok(match value {
            Value::Null => None,
            other => Some(other),
        })
    }

    pub fn set(&self, key: &str, value: Value) -> Result<()> {
        self.inner.rpc.call("storage.set", json!({ "key": key, "value": value }))?;
        Ok(())
    }

    pub fn remove(&self, key: &str) -> Result<()> {
        self.inner.rpc.call("storage.remove", json!({ "key": key }))?;
        Ok(())
    }

    pub fn all(&self) -> Result<Value> {
        self.inner.rpc.call("storage.all", json!({}))
    }

    pub fn clear(&self) -> Result<()> {
        self.inner.rpc.call("storage.clear", json!({}))?;
        Ok(())
    }
}

/// stdin reader：分发 `rpc-result` / `query` / `shutdown`；未知行宽容转日志（与 v1 `pipeOutput` 语义一致）。
fn spawn_reader(inner: Arc<Inner>) {
    std::thread::spawn(move || {
        use std::io::BufRead;
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let line = match line {
                Ok(line) => line,
                Err(_) => break,
            };
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            let message = match serde_json::from_str::<Value>(&line) {
                Ok(value) => value,
                Err(_) => {
                    let _ = inner.out.send(&protocol::log_line(
                        Level::Warn,
                        &format!("无法解析协议行：{line}"),
                        None,
                    ));
                    continue;
                }
            };
            match message.get("type").and_then(Value::as_str) {
                Some("rpc-result") => inner.rpc.resolve_from(&message),
                Some("query") => {
                    let token = message.get("token").and_then(Value::as_u64).unwrap_or(0);
                    let query = message.get("query").and_then(Value::as_str).unwrap_or("").to_string();
                    let mut state = inner.query.lock().unwrap_or_else(|err| err.into_inner());
                    match state.tx.clone() {
                        Some(tx) => {
                            let _ = tx.send((token, query));
                        }
                        None => {
                            // on_query 还没注册：先缓冲（v1 的 worker 端口也会缓存早期消息）
                            if state.early.len() < 32 {
                                state.early.push((token, query));
                            }
                        }
                    }
                }
                Some("shutdown") => {
                    inner.set_shutdown();
                    break;
                }
                other => {
                    let kind = other.unwrap_or("<缺 type>");
                    let _ = inner.out.send(&protocol::log_line(
                        Level::Warn,
                        &format!("未知的宿主消息：{kind}"),
                        None,
                    ));
                }
            }
        }
        // stdin EOF / shutdown：通知主线程退出（search 模式）
        inner.set_shutdown();
    });
}

fn text(raw: &Value, key: &str) -> Option<String> {
    raw.get(key).and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_string)
}

fn env_text(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

/// `--launcher-context` = base64url(JSON)；解码容错三种变体（URL_SAFE_NO_PAD / URL_SAFE / 标准）。
fn decode_context(encoded: &str) -> Option<Value> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(encoded))
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(encoded))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn encode(json_text: &str) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json_text.as_bytes())
    }

    #[test]
    fn decode_context_reads_base64url_json() {
        let raw = decode_context(&encode(r#"{"pluginId":"demo","mode":"search"}"#)).expect("应能解码");
        assert_eq!(raw.get("pluginId").and_then(Value::as_str), Some("demo"));
    }

    #[test]
    fn decode_context_tolerates_standard_base64() {
        let standard = base64::engine::general_purpose::STANDARD.encode(r#"{"command":"job"}"#.as_bytes());
        let raw = decode_context(&standard).expect("标准 base64 也应可解码");
        assert_eq!(raw.get("command").and_then(Value::as_str), Some("job"));
    }

    #[test]
    fn decode_context_rejects_garbage() {
        assert!(decode_context("!!!not-base64!!!").is_none());
    }

    #[test]
    fn mode_parse_accepts_known_values_only() {
        assert_eq!(Mode::parse("run"), Some(Mode::Run));
        assert_eq!(Mode::parse("search"), Some(Mode::Search));
        assert_eq!(Mode::parse("bogus"), None);
    }

    #[test]
    fn text_filters_empty_strings() {
        let raw: Value = serde_json::from_str(r#"{"pluginId":"","command":"job"}"#).unwrap();
        assert_eq!(text(&raw, "pluginId"), None);
        assert_eq!(text(&raw, "command"), Some("job".to_string()));
    }
}
