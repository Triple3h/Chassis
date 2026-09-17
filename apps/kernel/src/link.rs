//! 壳 ↔ 内核：stdio + newline-delimited JSON-RPC 2.0（requirements §4.1 / ADR-0001）。
//!
//! 约定：**协议只走 stdout / stdin，日志一律 stderr**。语义逐条对齐 v1 `jsonrpc.ts`：
//! - 请求：`{jsonrpc:'2.0', id, method, params?}`；应答：`{jsonrpc:'2.0', id, result}` 或 `{jsonrpc:'2.0', id, error:{code,message}}`
//! - 通知（无 id）不产生应答；方法未实现 → `-32601`；handler 出错 → `-32000`
//! - 未连接时 request 立即失败、notify 静默丢弃

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt};
use tokio::sync::oneshot;

use crate::error::{KernelError, Result};

/// handler 的异步返回（boxed future，便于把不同闭包存进同一张表）。
pub type HandlerFuture = Pin<Box<dyn Future<Output = Result<Value>> + Send>>;
pub type Handler = Arc<dyn Fn(Value) -> HandlerFuture + Send + Sync>;

/// 输出通道：生产环境写 stdout；测试里换成收集器。
pub type OutputFn = Arc<dyn Fn(String) + Send + Sync>;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
/// 单行上限：超过即丢弃（防壳侧写出异常长行把内存吃满；v1 同款保护）
const MAX_LINE_BYTES: usize = 1_000_000;

#[derive(Clone)]
pub struct ShellLink {
    inner: Arc<Inner>,
}

struct Inner {
    output: OutputFn,
    handlers: RwLock<HashMap<String, Handler>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>,
    next_id: AtomicU64,
    connected: AtomicBool,
}

impl ShellLink {
    pub fn new(output: OutputFn) -> Self {
        Self {
            inner: Arc::new(Inner {
                output,
                handlers: RwLock::new(HashMap::new()),
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(0),
                connected: AtomicBool::new(false),
            }),
        }
    }

    /// 生产环境：写 stdout（每行写完 flush）。
    pub fn with_stdout() -> Self {
        Self::new(stdout_output())
    }

    pub fn mark_connected(&self) {
        self.inner.connected.store(true, Ordering::SeqCst);
    }

    pub fn is_connected(&self) -> bool {
        self.inner.connected.load(Ordering::SeqCst)
    }

    /// 注册壳方法（21 个原语 + 5 个上报，见 requirements §6.1 / m5 计划 §A1.3）。
    pub fn handle<F, Fut>(&self, method: &str, handler: F)
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value>> + Send + 'static,
    {
        let boxed: Handler = Arc::new(move |params| Box::pin(handler(params)));
        self.inner
            .handlers
            .write()
            .unwrap_or_else(|err| err.into_inner())
            .insert(method.to_string(), boxed);
    }

    /// 调用壳（默认 3s 超时，与 v1 一致）。
    pub async fn request(&self, method: &str, params: Option<Value>) -> Result<Value> {
        self.request_with_timeout(method, params, REQUEST_TIMEOUT).await
    }

    pub async fn request_with_timeout(
        &self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<Value> {
        if !self.is_connected() {
            return Err(KernelError::not_found(format!("壳未连接，无法调用 {method}")));
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending().insert(id, tx);

        let mut payload = json!({ "jsonrpc": "2.0", "id": id, "method": method });
        if let Some(params) = params {
            payload["params"] = params;
        }
        self.write_line(&payload);

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(KernelError::not_found("壳连接已断开")),
            Err(_) => {
                self.pending().remove(&id);
                Err(KernelError::timeout(format!("壳调用超时：{method}")))
            }
        }
    }

    /// 通知（无 id、无应答）；未连接时静默丢弃（与 v1 一致）。
    pub fn notify(&self, method: &str, params: Option<Value>) {
        if !self.is_connected() {
            return;
        }
        let mut payload = json!({ "jsonrpc": "2.0", "method": method });
        if let Some(params) = params {
            payload["params"] = params;
        }
        self.write_line(&payload);
    }

    /// 读循环：直到 EOF / IO 错误（壳退出）。结束时清 pending 并置为未连接。
    pub async fn read_loop<R: AsyncBufRead + Unpin>(&self, mut reader: R) {
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    if line.len() > MAX_LINE_BYTES {
                        crate::log_warn!("壳消息单行超过 {} 字节，已丢弃", MAX_LINE_BYTES);
                        continue;
                    }
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        self.dispatch(trimmed).await;
                    }
                }
                Err(_) => break,
            }
        }
        self.on_close();
    }

    async fn dispatch(&self, line: &str) {
        let message: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => return,
        };
        if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return;
        }

        let id = message.get("id").cloned().filter(|value| !value.is_null());
        let method = message.get("method").and_then(Value::as_str).map(str::to_string);

        // 应答：匹配 pending（只认数字 id，与壳侧一致）
        let Some(method) = method else {
            let Some(numeric_id) = id.as_ref().and_then(Value::as_u64) else { return };
            let waiting = self.pending().remove(&numeric_id);
            if let Some(tx) = waiting {
                if let Some(error) = message.get("error") {
                    let text = error.get("message").and_then(Value::as_str).unwrap_or("壳调用失败").to_string();
                    let _ = tx.send(Err(KernelError::internal(text)));
                } else {
                    let _ = tx.send(Ok(message.get("result").cloned().unwrap_or(Value::Null)));
                }
            }
            return;
        };

        // 请求 / 通知
        let handler = self
            .inner
            .handlers
            .read()
            .unwrap_or_else(|err| err.into_inner())
            .get(&method)
            .cloned();
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));

        let Some(handler) = handler else {
            if let Some(id) = id {
                self.write_line(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("方法未实现：{method}") },
                }));
            }
            return;
        };

        // **必须 spawn，绝不能内联 await**：handler 自己常常要等链路请求的回复
        // （`window/blurred` → `hide_window_animated` → `window.hide`、`tray/menu(show)` → `window.show`），
        // 而回复正是由**本读循环**读取的 —— 内联 await = 自己等自己的回复：必然超时，
        // 并且在这期间把所有壳往来一起堵死（`window/blurred` 实测踩过：之后连
        // `/api/window/visible` 都退回 null，因为请求全在等这个被堵住的循环）。
        let link = self.clone();
        tokio::spawn(async move {
            match handler(params).await {
                Ok(result) => {
                    if let Some(id) = id {
                        link.write_line(&json!({ "jsonrpc": "2.0", "id": id, "result": result }));
                    }
                }
                Err(err) => {
                    if let Some(id) = id {
                        link.write_line(&json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": -32000, "message": err.message },
                        }));
                    }
                }
            }
        });
    }

    fn write_line(&self, value: &Value) {
        let Ok(line) = serde_json::to_string(value) else { return };
        (self.inner.output)(format!("{line}\n"));
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<Result<Value>>>> {
        self.inner.pending.lock().unwrap_or_else(|err| err.into_inner())
    }

    fn on_close(&self) {
        self.inner.connected.store(false, Ordering::SeqCst);
        let mut pending = self.pending();
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(KernelError::not_found("壳连接已断开")));
        }
    }
}

pub fn stdout_output() -> OutputFn {
    use std::io::Write;
    Arc::new(|line: String| {
        let stdout = std::io::stdout();
        let mut handle = stdout.lock();
        let _ = handle.write_all(line.as_bytes());
        let _ = handle.flush();
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handlers_table_starts_empty() {
        let link = ShellLink::new(Arc::new(|_| {}));
        assert!(!link.is_connected());
        assert_eq!(link.inner.handlers.read().unwrap().len(), 0);
    }

    /// handler 里 await 链路请求**不能死锁**：回复是由读循环读的，而 handler 也跑在读循环里
    /// —— 内联 await 就是「自己等自己的回复」，必然超时，而且会把之后的全部壳往来一起堵死。
    /// 实测事故：`window/blurred` → `hide_window_animated()` 把读循环堵住后，内核再也收不到
    /// 任何壳回复（`/api/window/visible` 从此退回 null、`window.hide` 全部超时）。
    #[tokio::test]
    async fn handler_may_await_link_requests() {
        use tokio::io::{AsyncWriteExt, BufReader};

        let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let link = Arc::new(ShellLink::new(Arc::new(move |line| {
            let _ = out_tx.send(line);
        })));
        link.mark_connected();

        // 内核侧 handler：先等一条链路请求的回复，再广播 done（通知没有任何应答，只能靠假壳观察）
        let handler_link = link.clone();
        link.handle("shell/ping-me", move |_| {
            let link = handler_link.clone();
            Box::pin(async move {
                let visible = link.request("window.isVisible", None).await?;
                link.notify("handler/done", Some(json!({ "visible": visible })));
                Ok(json!({ "ok": true }))
            })
        });

        // 假壳：**应答写回同一条管道**（真壳就是这么回话的）—— 回复必须经内核读循环才能
        // 到达 pending，所以读循环一旦被 handler 堵住就没救了。
        let done = Arc::new(tokio::sync::Notify::new());
        let shell_done = done.clone();
        let (kernel_in, mut shell_out) = tokio::io::duplex(8192);

        // 触发（壳 → 内核）：一条通知，无 id、不期望应答
        shell_out
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"shell/ping-me\",\"params\":{}}\n")
            .await
            .unwrap();

        let shell = tokio::spawn(async move {
            while let Some(line) = out_rx.recv().await {
                let Ok(message) = serde_json::from_str::<Value>(line.trim()) else { continue };
                match message.get("method").and_then(Value::as_str) {
                    Some("window.isVisible") => {
                        if let Some(id) = message.get("id") {
                            let reply = json!({ "jsonrpc": "2.0", "id": id, "result": true });
                            let _ = shell_out.write_all(format!("{reply}\n").as_bytes()).await;
                        }
                    }
                    Some("handler/done") => shell_done.notify_one(),
                    _ => {}
                }
            }
        });

        let loop_link = link.clone();
        let reader = tokio::spawn(async move {
            loop_link.read_loop(BufReader::new(kernel_in)).await;
        });

        tokio::time::timeout(std::time::Duration::from_millis(800), done.notified())
            .await
            .expect("handler 等链路回复超时：读循环被内联 await 堵住了");

        shell.abort();
        reader.abort();
    }
}
