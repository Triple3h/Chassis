//! 逻辑层插件运行时：**子进程 + NDJSON over stdio**（v1 `apps/kernel/src/services/exec.ts` 的 v2 版）。
//!
//! 协议权威定义见 `docs/plugin-spec.md` §4.4；语义逐条对齐 v1：
//! - `run`：spawn → 等 `done` → 回收；超时默认 10s、上限 5min → `TIMEOUT`
//! - `search`：常驻，宿主按查询写 `query` 行；空闲 5 分钟回收；同插件并发上限 4（排队）
//! - 崩溃：非零退出 / `{__error}` → `SCRIPT_ERROR` + 失败计数（连续 3 次由上层判降级）
//! - stdout 只走协议（非协议行容忍转日志）；stderr 一律转 warn 日志；单行 > 1MB 丢弃

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex, Semaphore};

use crate::error::{KernelError, Result};
use crate::manifest::{script_entry_candidates, SettingValue};

pub type BoxFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>;
/// 插件侧 RPC（`storage.*` 等）→ 宿主服务（可审计，P6）。
pub type RpcHandler = Arc<dyn Fn(String, String, Value) -> BoxFuture<std::result::Result<Value, KernelError>> + Send + Sync>;

/// 预算超时**之后**才到达的搜索结果（`plugin_id` / `token` / 原始结果项）。
///
/// v1 里它们被直接丢弃（`pending` 里的等待者已随超时移除）—— 慢源因此永远不出现在界面上：
/// 实测 `mdfind`（file-search）固定要 ~450ms，而搜索预算是 200ms。交给上层写进 hub 并补位推送。
pub type LateResultHandler = Arc<dyn Fn(&str, u64, Vec<Value>) + Send + Sync>;

pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;
pub const MAX_TIMEOUT_MS: u64 = 5 * 60_000;
pub const MAX_CONCURRENT_PER_PLUGIN: usize = 4;
pub const SEARCH_IDLE: Duration = Duration::from_secs(5 * 60);
const MAX_LINE_BYTES: usize = 1_000_000;

#[derive(Clone)]
pub struct RuntimeOptions {
    pub data_root: PathBuf,
    pub resolve_plugin_dir: Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>,
    pub data_path_for: Arc<dyn Fn(&str) -> PathBuf + Send + Sync>,
    pub settings_for: Arc<dyn Fn(&str) -> HashMap<String, SettingValue> + Send + Sync>,
    pub handle_rpc: RpcHandler,
    /// 连续失败计数回调（连续 3 次 → 上层把插件标记 degraded）
    pub on_failure: Arc<dyn Fn(&str, &str) + Send + Sync>,
    /// 预算超时之后才到达的搜索结果（见 `LateResultHandler`）
    pub on_late_result: LateResultHandler,
}

pub struct ScriptRuntime {
    options: RuntimeOptions,
    workers: StdMutex<HashMap<String, Arc<SearchWorker>>>,
    semaphores: StdMutex<HashMap<String, Arc<Semaphore>>>,
    closed: AtomicBool,
}

impl ScriptRuntime {
    pub fn new(options: RuntimeOptions) -> Self {
        Self {
            options,
            workers: StdMutex::new(HashMap::new()),
            semaphores: StdMutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
        }
    }

    /// 产物查找顺序：`<name>` → `<name>.exe` → `workers/<name>` → `workers/<name>.exe`（plugin-spec §2.2）。
    pub fn resolve_entry(&self, plugin_id: &str, command: &str) -> Option<PathBuf> {
        let dir = (self.options.resolve_plugin_dir)(plugin_id)?;
        for candidate in script_entry_candidates(command) {
            let absolute = dir.join(&candidate);
            if absolute.is_file() {
                return Some(absolute);
            }
        }
        None
    }

    /// 一次性执行 `no-view` / `script` 命令。
    pub async fn run(
        &self,
        plugin_id: &str,
        command: &str,
        args: Option<Value>,
        timeout_ms: Option<u64>,
    ) -> Result<Value> {
        let entry = self
            .resolve_entry(plugin_id, command)
            .ok_or_else(|| KernelError::new("ENTRY_MISSING", format!("未找到插件产物：{command}")))?;
        let _permit = self.acquire(plugin_id).await?;
        let timeout = normalize_timeout(timeout_ms);
        self.run_child(&entry, plugin_id, command, args, timeout).await
    }

    /// 贡献型搜索：常驻子进程复用（搜索每 80ms 触发一次，不能每次冷启动）。
    pub async fn query_search_source(
        &self,
        plugin_id: &str,
        command: &str,
        query: &str,
        timeout: Duration,
        token: u64,
    ) -> Option<Vec<Value>> {
        let worker = match self.ensure_search_worker(plugin_id, command).await {
            Ok(worker) => worker,
            Err(err) => {
                crate::log_warn!("搜索 worker 启动失败：{plugin_id}:{command}：{}", err.message);
                return None;
            }
        };
        worker.touch();

        let (tx, rx) = oneshot::channel();
        worker.pending.lock().unwrap_or_else(|err| err.into_inner()).insert(token, tx);
        if worker.write(&json!({ "type": "query", "token": token, "query": query })).await.is_err() {
            worker.pending.lock().unwrap_or_else(|err| err.into_inner()).remove(&token);
            return None;
        }

        let wait = std::cmp::max(Duration::from_millis(50), timeout);
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(data)) => data.as_array().cloned(),
            Ok(Err(_)) => None,
            Err(_) => {
                worker.pending.lock().unwrap_or_else(|err| err.into_inner()).remove(&token);
                None
            }
        }
    }

    /// 预热常驻搜索源（插件激活后调用）：让第一次输入就有结果，而不是先吃一次冷启动超时。
    pub async fn prewarm(&self, plugin_id: &str, command: &str) {
        let key = worker_key(plugin_id, command);
        if self.closed.load(Ordering::SeqCst) || self.workers().contains_key(&key) {
            return;
        }
        if let Err(err) = self.ensure_search_worker(plugin_id, command).await {
            crate::log_warn!("搜索 worker 预热失败：{key}：{}", err.message);
        }
    }

    /// 插件停用 / 卸载时回收其全部常驻子进程。
    pub async fn release_plugin(&self, plugin_id: &str) {
        let prefix = format!("{plugin_id}:");
        let stale: Vec<(String, Arc<SearchWorker>)> = {
            let mut workers = self.workers();
            let keys: Vec<String> = workers.keys().filter(|key| key.starts_with(&prefix)).cloned().collect();
            keys.into_iter().filter_map(|key| workers.remove(&key).map(|worker| (key, worker))).collect()
        };
        for (key, worker) in stale {
            crate::log_debug!("回收搜索 worker：{key}");
            worker.destroy().await;
        }
    }

    pub async fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let workers: Vec<(String, Arc<SearchWorker>)> = self.workers().drain().collect();
        for (_, worker) in workers {
            worker.destroy().await;
        }
    }

    /// 空闲回收循环（每 30s 扫描一次；由内核启动）。
    pub fn spawn_reaper(self: Arc<Self>) {
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(30));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let now = Instant::now();
                let stale: Vec<(String, Arc<SearchWorker>)> = {
                    let mut workers = self.workers();
                    let keys: Vec<String> = workers
                        .iter()
                        .filter(|(_, worker)| now.duration_since(worker.last_used()) > SEARCH_IDLE)
                        .map(|(key, _)| key.clone())
                        .collect();
                    keys.into_iter().filter_map(|key| workers.remove(&key).map(|worker| (key, worker))).collect()
                };
                for (key, worker) in stale {
                    crate::log_debug!("空闲回收搜索 worker：{key}");
                    worker.destroy().await;
                }
            }
        });
    }

    // ── 内部 ─────────────────────────────────────────────────────

    async fn run_child(
        &self,
        entry: &Path,
        plugin_id: &str,
        command: &str,
        args: Option<Value>,
        timeout: Duration,
    ) -> Result<Value> {
        let mut process = self.spawn_process(entry, plugin_id, command, "run", args).await?;
        let stdin = Arc::new(Mutex::new(process.stdin.take()));
        let Some(stdout) = process.stdout.take() else {
            return Err(KernelError::internal("无法读取插件 stdout"));
        };
        if let Some(stderr) = process.stderr.take() {
            spawn_stderr_logger(plugin_id, command, stderr);
        }

        let handle_rpc = self.options.handle_rpc.clone();
        let outcome = tokio::time::timeout(
            timeout,
            read_run_output(plugin_id, command, stdout, stdin, handle_rpc),
        )
        .await;

        match outcome {
            Ok(RunOutcome::Done(result)) => {
                terminate(&mut process).await;
                match result {
                    Some(value) if is_failure_payload(&value) => {
                        (self.options.on_failure)(plugin_id, command);
                        Err(KernelError::new("SCRIPT_ERROR", error_text(&value)))
                    }
                    other => Ok(other.unwrap_or(Value::Null)),
                }
            }
            Ok(RunOutcome::Eof { result }) => {
                // 子进程已退出（stdout EOF）：按退出码判定，与 v1 `worker.on('exit')` 一致
                let code = process.wait().await.ok().and_then(|status| status.code());
                if code.unwrap_or(0) == 0 {
                    Ok(result.unwrap_or(Value::Null))
                } else {
                    (self.options.on_failure)(plugin_id, command);
                    Err(KernelError::new("SCRIPT_ERROR", format!("插件退出码 {}", code.unwrap_or(-1))))
                }
            }
            Err(_) => {
                terminate(&mut process).await;
                (self.options.on_failure)(plugin_id, command);
                Err(KernelError::timeout(format!("插件执行超时（{}ms）：{command}", timeout.as_millis())))
            }
        }
    }

    async fn ensure_search_worker(&self, plugin_id: &str, command: &str) -> Result<Arc<SearchWorker>> {
        let key = worker_key(plugin_id, command);
        if let Some(worker) = self.workers().get(&key) {
            return Ok(worker.clone());
        }
        let entry = self
            .resolve_entry(plugin_id, command)
            .ok_or_else(|| KernelError::new("ENTRY_MISSING", format!("未找到插件产物：{command}")))?;
        let mut process = self.spawn_process(&entry, plugin_id, command, "search", None).await?;
        let stdin = process.stdin.take();
        let Some(stdout) = process.stdout.take() else {
            return Err(KernelError::internal("无法读取插件 stdout"));
        };
        if let Some(stderr) = process.stderr.take() {
            spawn_stderr_logger(plugin_id, command, stderr);
        }

        let worker = Arc::new(SearchWorker {
            plugin_id: plugin_id.to_string(),
            command: command.to_string(),
            stdin: Mutex::new(stdin),
            pending: StdMutex::new(HashMap::new()),
            last_used: StdMutex::new(Instant::now()),
            killed: AtomicBool::new(false),
            handle_rpc: self.options.handle_rpc.clone(),
            on_late_result: self.options.on_late_result.clone(),
            child: StdMutex::new(Some(process)),
        });
        self.workers().insert(key, worker.clone());

        let reader = worker.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => handle_search_line(&reader, &line).await,
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
            reader.on_exit();
        });
        Ok(worker)
    }

    async fn spawn_process(
        &self,
        entry: &Path,
        plugin_id: &str,
        command: &str,
        mode: &str,
        args: Option<Value>,
    ) -> Result<Child> {
        let payload = self.context_payload(plugin_id, command, mode, args);
        let encoded = {
            use base64::Engine;
            let bytes = serde_json::to_vec(&payload).map_err(|err| KernelError::internal(err.to_string()))?;
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
        };
        Command::new(entry)
            .arg("--mode")
            .arg(mode)
            .arg("--launcher-context")
            .arg(encoded)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|err| KernelError::new("SCRIPT_ERROR", format!("无法启动插件进程 {}：{err}", entry.display())))
    }

    fn context_payload(&self, plugin_id: &str, command: &str, mode: &str, args: Option<Value>) -> Value {
        let plugin_path = (self.options.resolve_plugin_dir)(plugin_id).unwrap_or_default();
        let data_path = (self.options.data_path_for)(plugin_id);
        let settings = (self.options.settings_for)(plugin_id);
        json!({
            "pluginId": plugin_id,
            "command": command,
            "pluginPath": plugin_path.to_string_lossy(),
            "dataPath": data_path.to_string_lossy(),
            "dataRoot": self.options.data_root.to_string_lossy(),
            "mode": mode,
            "args": args.unwrap_or(Value::Null),
            "settings": settings,
            "host": "launcher",
            "apiVersion": 2,
        })
    }

    /// 同插件并发上限 4（超限排队）—— 与 v1 `MAX_CONCURRENT_PER_PLUGIN` 一致。
    async fn acquire(&self, plugin_id: &str) -> Result<tokio::sync::OwnedSemaphorePermit> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(KernelError::not_found("内核正在退出"));
        }
        let semaphore = {
            let mut semaphores = self.semaphores.lock().unwrap_or_else(|err| err.into_inner());
            semaphores
                .entry(plugin_id.to_string())
                .or_insert_with(|| Arc::new(Semaphore::new(MAX_CONCURRENT_PER_PLUGIN)))
                .clone()
        };
        semaphore
            .acquire_owned()
            .await
            .map_err(|_| KernelError::internal("并发信号量已关闭"))
    }

    fn workers(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<SearchWorker>>> {
        self.workers.lock().unwrap_or_else(|err| err.into_inner())
    }
}

enum RunOutcome {
    Done(Option<Value>),
    Eof { result: Option<Value> },
}

async fn read_run_output(
    plugin_id: &str,
    command: &str,
    stdout: tokio::process::ChildStdout,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    handle_rpc: RpcHandler,
) -> RunOutcome {
    let mut lines = BufReader::new(stdout).lines();
    let mut result: Option<Value> = None;
    while let Ok(Some(line)) = lines.next_line().await {
        if line.len() > MAX_LINE_BYTES {
            crate::log_warn!("[{plugin_id}:{command}] 协议行超过 {MAX_LINE_BYTES} 字节，已丢弃");
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
            crate::log_info!("[{plugin_id}:{command}] {trimmed}");
            continue;
        };
        match message.get("type").and_then(Value::as_str) {
            Some("result") => {
                result = Some(message.get("data").cloned().unwrap_or(Value::Null));
            }
            Some("done") => return RunOutcome::Done(result),
            Some("log") => log_from_plugin(plugin_id, command, &message),
            Some("progress") => {
                crate::log_debug!("[{plugin_id}:{command}] progress {}", message.get("data").unwrap_or(&Value::Null));
            }
            Some("rpc") => {
                let reply = rpc_reply(plugin_id, &handle_rpc, &message).await;
                write_line(&stdin, &reply).await;
            }
            other => {
                let kind = other.unwrap_or("<缺 type>");
                crate::log_warn!("[{plugin_id}:{command}] 未知的协议消息：{kind}");
            }
        }
    }
    RunOutcome::Eof { result }
}

async fn write_line(stdin: &Arc<Mutex<Option<ChildStdin>>>, message: &Value) {
    let Ok(mut text) = serde_json::to_string(message) else { return };
    text.push('\n');
    let mut guard = stdin.lock().await;
    if let Some(stdin) = guard.as_mut() {
        let _ = stdin.write_all(text.as_bytes()).await;
        let _ = stdin.flush().await;
    }
}

async fn rpc_reply(plugin_id: &str, handle_rpc: &RpcHandler, message: &Value) -> Value {
    let id = message.get("id").and_then(Value::as_u64).unwrap_or(0);
    let method = message.get("method").and_then(Value::as_str).unwrap_or("").to_string();
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    match handle_rpc(plugin_id.to_string(), method, params).await {
        Ok(data) => json!({ "type": "rpc-result", "id": id, "ok": true, "data": data }),
        Err(err) => json!({
            "type": "rpc-result",
            "id": id,
            "ok": false,
            "error": { "code": err.code, "message": err.message },
        }),
    }
}

async fn handle_search_line(worker: &Arc<SearchWorker>, line: &str) {
    if line.len() > MAX_LINE_BYTES {
        crate::log_warn!("[{}:{}] 协议行超过 {MAX_LINE_BYTES} 字节，已丢弃", worker.plugin_id, worker.command);
        return;
    }
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
        crate::log_info!("[{}:{}] {trimmed}", worker.plugin_id, worker.command);
        return;
    };
    match message.get("type").and_then(Value::as_str) {
        Some("result") => {
            if let Some(token) = message.get("token").and_then(Value::as_u64) {
                let waiting = worker.pending.lock().unwrap_or_else(|err| err.into_inner()).remove(&token);
                match waiting {
                    Some(tx) => {
                        let _ = tx.send(message.get("data").cloned().unwrap_or(Value::Null));
                    }
                    // 没有等待者 = 这次搜索的预算已经超时。**不要丢**：交给上层补位推送
                    // （v1 就是在这里把慢源的结果扔掉的）
                    None => {
                        let items = message.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
                        if !items.is_empty() {
                            (worker.on_late_result)(&worker.plugin_id, token, items);
                        }
                    }
                }
            }
        }
        Some("log") => log_from_plugin(&worker.plugin_id, &worker.command, &message),
        Some("progress") => {
            crate::log_debug!("[{}:{}] progress {}", worker.plugin_id, worker.command, message.get("data").unwrap_or(&Value::Null));
        }
        Some("rpc") => {
            let reply = rpc_reply(&worker.plugin_id, &worker.handle_rpc, &message).await;
            let _ = worker.write(&reply).await;
        }
        Some("done") => {
            crate::log_warn!("[{}:{}] search 模式不应发送 done", worker.plugin_id, worker.command);
        }
        other => {
            let kind = other.unwrap_or("<缺 type>");
            crate::log_warn!("[{}:{}] 未知的协议消息：{kind}", worker.plugin_id, worker.command);
        }
    }
}

fn log_from_plugin(plugin_id: &str, command: &str, message: &Value) {
    let level = message.get("level").and_then(Value::as_str).unwrap_or("info");
    let text = message.get("message").and_then(Value::as_str).unwrap_or("");
    match level {
        "error" => crate::log_error!("[{plugin_id}:{command}] {text}"),
        "warn" => crate::log_warn!("[{plugin_id}:{command}] {text}"),
        "debug" => crate::log_debug!("[{plugin_id}:{command}] {text}"),
        _ => crate::log_info!("[{plugin_id}:{command}] {text}"),
    }
}

fn spawn_stderr_logger(plugin_id: &str, command: &str, stderr: tokio::process::ChildStderr) {
    let plugin_id = plugin_id.to_string();
    let command = command.to_string();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            crate::log_warn!("[{plugin_id}:{command}] {line}");
        }
    });
}

async fn terminate(process: &mut Child) {
    let _ = process.start_kill();
    let _ = process.wait().await;
}

fn is_failure_payload(value: &Value) -> bool {
    value.get("__error").is_some()
}

fn error_text(value: &Value) -> String {
    match value.get("__error") {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => "插件执行失败".to_string(),
    }
}

fn normalize_timeout(timeout_ms: Option<u64>) -> Duration {
    let value = timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    if value == 0 {
        return Duration::from_millis(DEFAULT_TIMEOUT_MS);
    }
    Duration::from_millis(value.clamp(50, MAX_TIMEOUT_MS))
}

fn worker_key(plugin_id: &str, command: &str) -> String {
    format!("{plugin_id}:{command}")
}

struct SearchWorker {
    plugin_id: String,
    command: String,
    stdin: Mutex<Option<ChildStdin>>,
    pending: StdMutex<HashMap<u64, oneshot::Sender<Value>>>,
    last_used: StdMutex<Instant>,
    killed: AtomicBool,
    handle_rpc: RpcHandler,
    on_late_result: LateResultHandler,
    child: StdMutex<Option<Child>>,
}

impl SearchWorker {
    async fn write(&self, message: &Value) -> Result<()> {
        let Ok(mut text) = serde_json::to_string(message) else {
            return Err(KernelError::internal("序列化协议消息失败"));
        };
        text.push('\n');
        let mut guard = self.stdin.lock().await;
        let Some(stdin) = guard.as_mut() else {
            return Err(KernelError::not_found("插件进程已回收"));
        };
        stdin.write_all(text.as_bytes()).await.map_err(|err| KernelError::internal(err.to_string()))?;
        stdin.flush().await.map_err(|err| KernelError::internal(err.to_string()))
    }

    fn touch(&self) {
        *self.last_used.lock().unwrap_or_else(|err| err.into_inner()) = Instant::now();
    }

    fn last_used(&self) -> Instant {
        *self.last_used.lock().unwrap_or_else(|err| err.into_inner())
    }

    async fn destroy(&self) {
        self.killed.store(true, Ordering::SeqCst);
        {
            let mut guard = self.stdin.lock().await;
            *guard = None; // 关 stdin：SDK 会据此自行退出
        }
        // 先把 child 取出来（guard 不跨 await —— std MutexGuard 不是 Send）
        let child = { self.child.lock().unwrap_or_else(|err| err.into_inner()).take() };
        if let Some(mut child) = child {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }

    /// 子进程退出：清空等待者（调用方按超时/丢弃处理）。
    fn on_exit(&self) {
        if !self.killed.load(Ordering::SeqCst) {
            crate::log_warn!("[{}:{}] 插件进程已退出", self.plugin_id, self.command);
        }
        self.pending.lock().unwrap_or_else(|err| err.into_inner()).clear();
    }
}

// 夹具是 POSIX shell 假插件（write_script 写 `#!/bin/sh` 脚本）：Windows 上 CreateProcess
// 需要真正的 PE，直接 spawn 会得到 os error 193（不是合法的 Win32 应用）⇒ 本模块暂为 Unix-only。
// 产品路径不受影响（Windows 上插件产物本来就是 .exe）；Windows 夹具（小 demo.exe）列入 M6 收尾。
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn write_script(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("demo");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    fn runtime(dir: &Path, failures: Arc<AtomicUsize>, seen_rpc: Arc<StdMutex<Vec<String>>>) -> ScriptRuntime {
        let plugin_dir = dir.to_path_buf();
        let data_root = dir.join("data");
        let failures_for_cb = failures.clone();
        let rpc_for_cb = seen_rpc.clone();
        ScriptRuntime::new(RuntimeOptions {
            data_root: data_root.clone(),
            resolve_plugin_dir: Arc::new(move |_| Some(plugin_dir.clone())),
            data_path_for: Arc::new(move |_| data_root.join("plugins").join("demo")),
            settings_for: Arc::new(|_| HashMap::new()),
            handle_rpc: Arc::new(move |_plugin, method, params| {
                let log = rpc_for_cb.clone();
                Box::pin(async move {
                    log.lock().unwrap().push(format!("{method}:{params}"));
                    Ok(json!({ "value": 42 }))
                })
            }),
            on_failure: Arc::new(move |_, _| {
                failures_for_cb.fetch_add(1, Ordering::SeqCst);
            }),
            on_late_result: Arc::new(|_, _, _| {}),
        })
    }

    #[tokio::test]
    async fn run_returns_done_payload() {
        let dir = std::env::temp_dir().join(format!("exec-run-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_script(&dir, "echo '{\"type\":\"result\",\"data\":{\"echo\":1}}'\necho '{\"type\":\"done\"}'");

        let runtime = runtime(&dir, Arc::new(AtomicUsize::new(0)), Arc::new(StdMutex::new(Vec::new())));
        let result = runtime.run("demo", "demo", Some(json!({ "n": 1 })), None).await.expect("应当成功");
        assert_eq!(result["echo"], 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_maps_failure_payload_and_counts_failure() {
        let dir = std::env::temp_dir().join(format!("exec-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_script(&dir, "echo '{\"type\":\"result\",\"data\":{\"__error\":\"boom\"}}'\necho '{\"type\":\"done\"}'");

        let failures = Arc::new(AtomicUsize::new(0));
        let runtime = runtime(&dir, failures.clone(), Arc::new(StdMutex::new(Vec::new())));
        let err = runtime.run("demo", "demo", None, None).await.expect_err("应当失败");
        assert_eq!(err.code, "SCRIPT_ERROR");
        assert_eq!(err.message, "boom");
        assert_eq!(failures.load(Ordering::SeqCst), 1, "失败必须计数（连续 3 次降级）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_times_out_and_terminates_process() {
        let dir = std::env::temp_dir().join(format!("exec-timeout-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_script(&dir, "sleep 5");

        let failures = Arc::new(AtomicUsize::new(0));
        let runtime = runtime(&dir, failures.clone(), Arc::new(StdMutex::new(Vec::new())));
        let started = Instant::now();
        let err = runtime.run("demo", "demo", None, Some(50)).await.expect_err("应当超时");
        assert_eq!(err.code, "TIMEOUT");
        assert!(started.elapsed() < Duration::from_secs(3), "超时必须及时回收子进程");
        assert_eq!(failures.load(Ordering::SeqCst), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn run_round_trips_rpc_to_host() {
        let dir = std::env::temp_dir().join(format!("exec-rpc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_script(
            &dir,
            "echo '{\"type\":\"rpc\",\"id\":7,\"method\":\"storage.get\",\"params\":{\"key\":\"k\"}}'\nIFS= read -r line\necho '{\"type\":\"result\",\"data\":{\"reply\":'\"$line\"'}}'\necho '{\"type\":\"done\"}'",
        );

        let seen = Arc::new(StdMutex::new(Vec::new()));
        let runtime = runtime(&dir, Arc::new(AtomicUsize::new(0)), seen.clone());
        let result = runtime.run("demo", "demo", None, None).await.expect("应当成功");
        assert_eq!(seen.lock().unwrap()[0], "storage.get:{\"key\":\"k\"}");
        assert_eq!(result["reply"]["type"], "rpc-result");
        assert_eq!(result["reply"]["ok"], true);
        assert_eq!(result["reply"]["data"]["value"], 42);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn search_worker_answers_queries_and_recycles() {
        let dir = std::env::temp_dir().join(format!("exec-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_script(
            &dir,
            "while IFS= read -r line; do\n  case \"$line\" in\n    *query*) echo '{\"type\":\"result\",\"token\":1,\"data\":[{\"id\":\"x\",\"title\":\"hit\"}]}' ;;\n  esac\ndone",
        );

        let runtime = runtime(&dir, Arc::new(AtomicUsize::new(0)), Arc::new(StdMutex::new(Vec::new())));
        // 2s：这条用例验证的是「有响应时能拿到结果」，不能因为并行跑测试时系统负载高而抖成超时
        let items = runtime
            .query_search_source("demo", "demo", "dee", Duration::from_millis(2000), 1)
            .await
            .expect("应当拿到结果");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["title"], "hit");

        runtime.release_plugin("demo").await;
        assert!(runtime.workers().is_empty(), "release 后常驻进程必须回收");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
