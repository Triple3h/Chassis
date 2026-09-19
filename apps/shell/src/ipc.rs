//! 壳 ↔ 内核：stdio + newline-delimited JSON-RPC 2.0（requirements §4.1）。
//!
//! 约定：
//!  - 协议只走 stdout/stdin；内核日志走 stderr，由 sidecar 转发到壳的日志
//!  - 壳只实现 §6.1 的原语方法，不做任何业务

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStdin, ChildStdout};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;

/// 原语的处理结果：
///  - `Now`：同步执行完，立刻应答；
///  - `Later`：慢原语（交互式截图等）已在别的线程上跑，读循环把「等结果 + 应答」交给独立线程，
///    自己继续服务后续请求 —— 读循环是单线程串行的，内联等几十秒会把壳整个堵死。
pub enum Outcome {
    Now(Result<Value, String>),
    Later(Receiver<Result<Value, String>>),
}

/// 原语处理器：内核请求 → 壳执行（见 primitives::dispatch）
pub type Handler = fn(&AppHandle, &str, &Value) -> Outcome;

pub struct Link {
    stdin: Mutex<Option<ChildStdin>>,
    app: Mutex<Option<AppHandle>>,
    pending: Mutex<HashMap<u64, Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    connected: Mutex<bool>,
    handler: Mutex<Option<Handler>>,
}

impl Link {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            stdin: Mutex::new(None),
            app: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            connected: Mutex::new(false),
            handler: Mutex::new(None),
        })
    }

    pub fn set_handler(&self, handler: Handler) {
        if let Ok(mut slot) = self.handler.lock() {
            *slot = Some(handler);
        }
    }

    pub fn attach(self: &Arc<Self>, stdin: ChildStdin, stdout: ChildStdout, app: AppHandle) {
        if let Ok(mut slot) = self.stdin.lock() {
            *slot = Some(stdin);
        }
        if let Ok(mut slot) = self.app.lock() {
            *slot = Some(app);
        }
        if let Ok(mut flag) = self.connected.lock() {
            *flag = true;
        }
        let this = Arc::clone(self);
        std::thread::spawn(move || this.read_loop(stdout));
    }

    pub fn detach(&self) {
        if let Ok(mut slot) = self.stdin.lock() {
            *slot = None;
        }
        if let Ok(mut flag) = self.connected.lock() {
            *flag = false;
        }
        if let Ok(mut map) = self.pending.lock() {
            for (_, sender) in map.drain() {
                let _ = sender.send(Err("内核已退出".to_string()));
            }
        }
    }

    pub fn is_connected(&self) -> bool {
        self.connected.lock().map(|flag| *flag).unwrap_or(false)
    }

    fn read_loop(self: Arc<Self>, stdout: ChildStdout) {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
                eprintln!("[shell] 内核输出无法解析：{trimmed}");
                continue;
            };
            let id = message.get("id").cloned();
            let method = message.get("method").and_then(|m| m.as_str()).map(str::to_string);

            match method {
                // 应答
                None => {
                    if let Some(Value::Number(num)) = id {
                        let key = num.as_u64().unwrap_or(0);
                        if let Ok(mut map) = self.pending.lock() {
                            if let Some(sender) = map.remove(&key) {
                                let payload = if let Some(err) = message.get("error") {
                                    Err(err
                                        .get("message")
                                        .and_then(|m| m.as_str())
                                        .unwrap_or("内核返回错误")
                                        .to_string())
                                } else {
                                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                                };
                                let _ = sender.send(payload);
                            }
                        }
                    }
                }
                // 内核 → 壳 的请求
                Some(name) => {
                    let params = message.get("params").cloned().unwrap_or(Value::Null);
                    let outcome = {
                        let handler = self.handler.lock().ok().and_then(|slot| *slot);
                        let app = self.app.lock().ok().and_then(|slot| slot.clone());
                        match (handler, app) {
                            (Some(handler), Some(app)) => handler(&app, &name, &params),
                            _ => Outcome::Now(Err("壳尚未就绪".to_string())),
                        }
                    };
                    match outcome {
                        Outcome::Now(result) => self.reply(id, result),
                        // 慢原语：执行已经在独立线程上跑，这里只把「等结果 + 应答」挪出读循环
                        Outcome::Later(receiver) => {
                            let link = Arc::clone(&self);
                            std::thread::spawn(move || {
                                let result = receiver
                                    .recv()
                                    .unwrap_or_else(|_| Err("原语任务未返回结果".to_string()));
                                link.reply(id, result);
                            });
                        }
                    }
                }
            }
        }
        eprintln!("[shell] 内核输出流已关闭");
        self.detach();
    }

    fn reply(&self, id: Option<Value>, result: Result<Value, String>) {
        let Some(id) = id else { return };
        let payload = match result {
            Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
            Err(message) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": message } }),
        };
        self.send_value(payload);
    }

    pub fn notify(&self, method: &str, params: Value) {
        self.send_value(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    fn send_value(&self, payload: Value) {
        let Ok(mut guard) = self.stdin.lock() else { return };
        let Some(stdin) = guard.as_mut() else { return };
        if writeln!(stdin, "{payload}").is_err() || stdin.flush().is_err() {
            drop(guard);
            self.detach();
        }
    }

    /// 壳 → 内核 的同步请求（带超时）
    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        if !self.is_connected() {
            return Err(format!("内核未连接，无法调用 {method}"));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = channel();
        if let Ok(mut map) = self.pending.lock() {
            map.insert(id, sender);
        }
        self.send_value(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                if let Ok(mut map) = self.pending.lock() {
                    map.remove(&id);
                }
                Err(format!("调用超时：{method}"))
            }
        }
    }
}
