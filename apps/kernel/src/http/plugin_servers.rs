//! 每插件一个 HTTP listener（v1 `http/pluginServers.ts`；requirements §4.1 / §8.4）：
//! 端口不同 ⇒ origin 不同 ⇒ localStorage / IndexedDB 天然隔离。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::error::{KernelError, Result};
use crate::http::server::{mime_for, LogFn};
use crate::util::fsx::{percent_decode, resolve_within_root};

// `script-src` 里的 'wasm-unsafe-eval'：放行随包 wasm 的编译（如 totp 的 zxing 二维码解码器）。
// 它只允许 WebAssembly 编译，不放行 JS 的 eval / new Function。
const CSP: &str = "default-src 'self'; \
img-src 'self' data: blob:; \
style-src 'self' 'unsafe-inline'; \
script-src 'self' 'wasm-unsafe-eval'; \
font-src 'self' data:; \
connect-src 'self' https:; \
frame-src 'none'; \
object-src 'none'; \
base-uri 'none'";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginListener {
    pub plugin_id: String,
    pub port: u16,
}

struct Entry {
    port: u16,
    shutdown: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Clone)]
struct FileState {
    root: PathBuf,
}

pub struct PluginServerPool {
    listeners: Arc<Mutex<HashMap<String, Entry>>>,
    log: LogFn,
}

impl PluginServerPool {
    pub fn new(log: LogFn) -> Self {
        Self { listeners: Arc::new(Mutex::new(HashMap::new())), log }
    }

    /// 起 listener；端口从 0 让系统分配（避免端口被占）。已存在则直接复用。
    pub async fn start(&self, plugin_id: &str, root: PathBuf) -> Result<PluginListener> {
        if let Some(existing) = self.listeners.lock().unwrap_or_else(|err| err.into_inner()).get(plugin_id) {
            return Ok(PluginListener { plugin_id: plugin_id.to_string(), port: existing.port });
        }

        let app = Router::new().fallback(get(serve_plugin_file).with_state(FileState { root }));
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|err| KernelError::new("INTERNAL", format!("插件 listener 端口分配失败：{err}")))?;
        let port = listener.local_addr().map_err(|err| KernelError::new("INTERNAL", err.to_string()))?.port();

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let server = axum::serve(listener, app).with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });
        let log = self.log.clone();
        let id = plugin_id.to_string();
        let task = tokio::spawn(async move {
            if let Err(err) = server.await {
                log("warn", &format!("插件 listener 退出（{id}）：{err}"));
            }
        });

        self.listeners
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(plugin_id.to_string(), Entry { port, shutdown: Some(shutdown_tx), task });
        Ok(PluginListener { plugin_id: plugin_id.to_string(), port })
    }

    pub fn port_of(&self, plugin_id: &str) -> Option<u16> {
        self.listeners.lock().unwrap_or_else(|err| err.into_inner()).get(plugin_id).map(|entry| entry.port)
    }

    pub async fn stop(&self, plugin_id: &str) {
        let entry = self.listeners.lock().unwrap_or_else(|err| err.into_inner()).remove(plugin_id);
        if let Some(mut entry) = entry {
            if let Some(shutdown) = entry.shutdown.take() {
                let _ = shutdown.send(());
            }
            let _ = entry.task.await;
        }
    }

    pub async fn stop_all(&self) {
        let entries: Vec<(String, Entry)> = self
            .listeners
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .drain()
            .collect();
        for (_, mut entry) in entries {
            if let Some(shutdown) = entry.shutdown.take() {
                let _ = shutdown.send(());
            }
            let _ = entry.task.await;
        }
    }
}

async fn serve_plugin_file(State(state): State<FileState>, request: Request<Body>) -> Response {
    let pathname = percent_decode(request.uri().path());
    let relative = if pathname == "/" { "index.html".to_string() } else { pathname.trim_start_matches('/').to_string() };

    let Some(resolved) = resolve_within_root(&state.root, &relative) else {
        return (StatusCode::FORBIDDEN, "403 禁止访问").into_response();
    };

    if let Ok(meta) = tokio::fs::metadata(&resolved).await {
        if meta.is_dir() {
            return (StatusCode::FORBIDDEN, "403 目录不可列").into_response();
        }
        if let Ok(bytes) = tokio::fs::read(&resolved).await {
            return (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, mime_for(&resolved)),
                    (header::CONTENT_SECURITY_POLICY, CSP),
                    (header::CACHE_CONTROL, "no-cache"),
                    (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                    (header::REFERRER_POLICY, "no-referrer"),
                ],
                bytes,
            )
                .into_response();
        }
    }
    (StatusCode::NOT_FOUND, "404 未找到").into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log() -> LogFn {
        Arc::new(|_, _| {})
    }

    #[tokio::test]
    async fn serves_files_under_root_and_blocks_escape() {
        let dir = std::env::temp_dir().join(format!("plugin-serve-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("index.html"), "<html>ok</html>").unwrap();
        std::fs::write(dir.join("assets/app.js"), "console.log(1)").unwrap();
        // root 之外的同级文件：穿越访问必须被挡
        std::fs::write(dir.parent().unwrap().join("outside-secret.txt"), "secret").unwrap();

        let pool = PluginServerPool::new(log());
        let listener = pool.start("demo", dir.clone()).await.unwrap();
        assert_eq!(pool.port_of("demo"), Some(listener.port));
        assert_eq!(pool.start("demo", dir.clone()).await.unwrap().port, listener.port, "重复 start 复用同一 listener");

        let base = format!("http://127.0.0.1:{}", listener.port);
        let client = reqwest_like_get(&format!("{base}/")).await;
        assert_eq!(client.0, 200);
        assert!(client.1.contains("ok"));

        let js = reqwest_like_get(&format!("{base}/assets/app.js")).await;
        assert_eq!(js.0, 200);
        assert!(js.2.contains("text/javascript"), "Content-Type 按扩展名给出");

        let escaped = reqwest_like_get(&format!("{base}/../outside-secret.txt")).await;
        assert_eq!(escaped.0, 403, "越界路径必须 403");

        let missing = reqwest_like_get(&format!("{base}/nope.js")).await;
        assert_eq!(missing.0, 404);

        pool.stop("demo").await;
        assert_eq!(pool.port_of("demo"), None);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(dir.parent().unwrap().join("outside-secret.txt"));
    }

    /// 插件页 CSP：放行随包 wasm 的编译，但**不得**放行 JS 的 eval / new Function。
    /// （原 `tests/unit/security.test.ts` 退役后由这条守护；规则 `chassis-core` 引用它。）
    #[tokio::test]
    async fn plugin_page_csp_allows_wasm_but_not_eval() {
        let script_src = CSP
            .split("; ")
            .find(|directive| directive.starts_with("script-src"))
            .expect("CSP 缺少 script-src");
        let tokens = script_src.split(' ').collect::<Vec<_>>();
        assert!(tokens.contains(&"'wasm-unsafe-eval'"), "插件页 wasm 未放行（totp 扫码会 CompileError）：{script_src}");
        assert!(!tokens.contains(&"'unsafe-eval'"), "不得放行 JS 的 eval：{script_src}");
        assert!(CSP.contains("object-src 'none'"), "object-src 应保持关闭：{CSP}");

        // 响应头也要真的带上它 —— 常量对但没挂上去等于没有
        let dir = std::env::temp_dir().join(format!("plugin-csp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "<html>ok</html>").unwrap();
        let pool = PluginServerPool::new(log());
        let listener = pool.start("csp-demo", dir.clone()).await.unwrap();
        let (status, _body, headers) = reqwest_like_get(&format!("http://127.0.0.1:{}/", listener.port)).await;
        assert_eq!(status, 200);
        assert!(
            headers.to_lowercase().contains("content-security-policy"),
            "响应缺少 CSP 头：{headers}"
        );
        assert!(headers.contains("'wasm-unsafe-eval'"), "响应头里的 CSP 应当放行 wasm：{headers}");
        pool.stop("csp-demo").await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 最小 HTTP 客户端：不引 reqwest，用 tokio 的 TcpStream 手写一次 GET。
    async fn reqwest_like_get(url: &str) -> (u16, String, String) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let without_scheme = url.trim_start_matches("http://");
        let (authority, path) = match without_scheme.split_once('/') {
            Some((authority, rest)) => (authority, format!("/{rest}")),
            None => (without_scheme, "/".to_string()),
        };
        let mut stream = tokio::net::TcpStream::connect(authority).await.unwrap();
        let request = format!("GET {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).await.unwrap();
        let text = String::from_utf8_lossy(&raw).to_string();
        let status = text
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse::<u16>().ok())
            .unwrap_or(0);
        let (headers, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_str(), ""));
        (status, body.to_string(), headers.to_string())
    }
}
