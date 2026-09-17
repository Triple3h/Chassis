//! 启动台 UI 的宿主服务（v1 `http/server.ts`；ADR-0001：内核托管 UI 静态资源，
//! UI 走 HTTP + SSE 与内核通信）。
//!
//! `infra_router` 产出**可 merge 进任意 Router 的片段**（SSE + 静态 + 兜底），
//! 业务路由由 `api.rs` 构造后 merge，最后统一用 `with_cors` 挂 CORS ——
//! 这样本模块不必知道内核状态的具体类型，也不会漏挂中间件。

use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, Method, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, oneshot};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{once, Stream, StreamExt};

use crate::error::{KernelError, Result};
use crate::util::fsx::{percent_decode, resolve_within_root};

pub type LogFn = Arc<dyn Fn(&'static str, &str) + Send + Sync>;

#[derive(Clone, Debug)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

/// 事件扇出（UI 与插件页的事件都从这里走）：`broadcast` 的生产者 + 每个 SSE 连接一个订阅者。
#[derive(Clone)]
pub struct SseHub {
    tx: broadcast::Sender<SseEvent>,
    /// 自己的 origin（`http://127.0.0.1:<port>`），启动后回填 —— CORS 判定要用
    self_origin: Arc<OnceLock<String>>,
}

impl Default for SseHub {
    fn default() -> Self {
        Self::new(256)
    }
}

impl SseHub {
    pub fn new(capacity: usize) -> Self {
        let (tx, _receiver) = broadcast::channel(capacity);
        Self { tx, self_origin: Arc::new(OnceLock::new()) }
    }

    /// 广播一个事件（没有订阅者时静默丢弃，与 v1 的 Set 扇出一致）。
    pub fn broadcast(&self, event: &str, payload: &Value) {
        let data = serde_json::to_string(payload).unwrap_or_else(|_| "null".to_string());
        let _ = self.tx.send(SseEvent { event: event.to_string(), data });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SseEvent> {
        self.tx.subscribe()
    }

    pub fn subscriber_count(&self) -> usize {
        self.tx.receiver_count()
    }
}

pub struct ServerOptions {
    /// 启动台 UI 静态资源目录（生产构建产物）；None 时只提供 API
    pub ui_dist_dir: Option<PathBuf>,
    /// 开发模式：UI 由 vite dev server 提供，内核把请求 302 过去
    pub ui_dev_url: Option<String>,
    /// 允许跨域的来源（vite dev server 直连内核 API 时用）
    pub allowed_origins: Vec<String>,
    /// 0 = 让系统分配端口（与 v1 一致）
    pub port: u16,
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self { ui_dist_dir: None, ui_dev_url: None, allowed_origins: Vec::new(), port: 0 }
    }
}

#[derive(Clone)]
pub struct InfraState {
    pub hub: SseHub,
    dist: Option<PathBuf>,
    dev_url: Option<String>,
    allowed_origins: Vec<String>,
}

impl InfraState {
    pub fn new(hub: SseHub, options: &ServerOptions) -> Self {
        Self {
            hub,
            dist: options.ui_dist_dir.clone(),
            dev_url: options.ui_dev_url.clone(),
            allowed_origins: options.allowed_origins.clone(),
        }
    }

    fn origin_allowed(&self, origin: &str) -> bool {
        if self.allowed_origins.iter().any(|allowed| allowed == origin) {
            return true;
        }
        self.hub.self_origin.get().map(|own| own == origin).unwrap_or(false)
    }
}

/// 可 merge 进任意 `Router<S>` 的基础设施片段：SSE + 静态资源。
///
/// **CORS 不在这里挂**：`Router::layer` 只作用于本 router 已有的路由，而业务路由
/// （`/api/*`）是另一棵树（`api::router`），merge 之后覆盖不到它们 ——
/// 必须等整棵树拼完再统一挂（见 `with_cors`，调用点在 `kernel.rs`）。
pub fn infra_router<S>(state: InfraState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/api/events", get(sse_handler).with_state(state.hub.clone()))
        .fallback(get(serve_static).with_state(state))
}

/// 给**整棵路由树**挂 CORS（必须在 merge 之后调用）。
///
/// 踩坑记录（2026-09-17 实机复现）：一开始把 CORS layer 挂在 `infra_router` 上，
/// 于是 `/api/*` 全都漏掉 —— dev 模式（UI 跑在 vite dev server、直连内核 API）下
/// 预检 OPTIONS 返回 405、响应也没有 `Access-Control-Allow-Origin`，浏览器把请求
/// 整个拦掉（表现为启动台搜不出任何东西）。生产模式 UI 由内核托管（same-origin）
/// 没有跨域，所以这个问题只在 `pnpm dev` 下暴露。
pub fn with_cors<S>(router: Router<S>, state: InfraState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    router.layer(middleware::from_fn_with_state(state, cors_middleware))
}

pub struct UiServer {
    pub port: u16,
    hub: SseHub,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl UiServer {
    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn hub(&self) -> &SseHub {
        &self.hub
    }

    /// 事件推送（SSE）：UI 与插件页的事件都从这里扇出。
    pub fn broadcast(&self, event: &str, payload: &Value) {
        self.hub.broadcast(event, payload);
    }

    pub async fn stop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

/// 启动 UI 服务；返回的 `UiServer` 持有端口与关闭句柄。
pub async fn serve<S>(router: Router<S>, state: S, hub: SseHub, options: ServerOptions, log: LogFn) -> Result<UiServer>
where
    S: Clone + Send + Sync + 'static,
{
    let app = router.with_state(state);
    let listener = TcpListener::bind(("127.0.0.1", options.port))
        .await
        .map_err(|err| KernelError::new("INTERNAL", format!("UI 服务端口分配失败：{err}")))?;
    let port = listener.local_addr().map_err(|err| KernelError::new("INTERNAL", err.to_string()))?.port();
    if hub.self_origin.set(format!("http://127.0.0.1:{port}")).is_err() {
        log("warn", "SSE hub 的 self_origin 被重复设置（应只在启动时一次）");
    }

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let server = axum::serve(listener, app).with_graceful_shutdown(async move {
        let _ = shutdown_rx.await;
    });
    let task = tokio::spawn(async move {
        if let Err(err) = server.await {
            eprintln!("[kernel] UI 服务退出：{err}");
        }
    });
    Ok(UiServer { port, hub, shutdown: Some(shutdown_tx), task: Some(task) })
}

async fn sse_handler(State(hub): State<SseHub>) -> Sse<impl Stream<Item = std::result::Result<Event, Infallible>>> {
    let receiver = hub.subscribe();
    let initial = once(Ok::<Event, Infallible>(Event::default().comment("connected")));
    let live = BroadcastStream::new(receiver).filter_map(|item| match item {
        Ok(event) => Some(Ok::<Event, Infallible>(Event::default().event(event.event).data(event.data))),
        // Lagged：慢客户端丢帧而不是拖住内核
        Err(_) => None,
    });
    Sse::new(initial.chain(live)).keep_alive(KeepAlive::new().interval(Duration::from_secs(20)).text("ping"))
}

async fn cors_middleware(State(state): State<InfraState>, request: Request<Body>, next: Next) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let allowed = origin.as_deref().map(|value| state.origin_allowed(value)).unwrap_or(false);

    if request.method() == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        if allowed {
            if let Some(origin) = origin.as_deref() {
                apply_cors(&mut response, origin);
            }
        }
        return response;
    }

    let mut response = next.run(request).await;
    if allowed {
        if let Some(origin) = origin.as_deref() {
            apply_cors(&mut response, origin);
        }
    }
    response
}

fn apply_cors(response: &mut Response, origin: &str) {
    let headers = response.headers_mut();
    if let Ok(value) = header::HeaderValue::from_str(origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, header::HeaderValue::from_static("GET, POST, OPTIONS"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, header::HeaderValue::from_static("Content-Type"));
    headers.insert(header::VARY, header::HeaderValue::from_static("Origin"));
}

async fn serve_static(State(state): State<InfraState>, request: Request<Body>) -> Response {
    let pathname = percent_decode(request.uri().path());

    if pathname.starts_with("/api/") {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({ "ok": false, "error": { "code": "NOT_FOUND", "message": format!("未知接口：{pathname}") } }),
        );
    }

    if let Some(dev_url) = &state.dev_url {
        let target = format!("{}{}", dev_url.trim_end_matches('/'), if pathname == "/" { "/" } else { pathname.as_str() });
        return (StatusCode::FOUND, [(header::LOCATION, target)]).into_response();
    }

    let Some(dist) = &state.dist else {
        return (StatusCode::SERVICE_UNAVAILABLE, "启动台 UI 尚未构建：请先执行 pnpm build:ui").into_response();
    };

    let relative = if pathname == "/" { "index.html".to_string() } else { pathname.trim_start_matches('/').to_string() };
    let Some(resolved) = resolve_within_root(dist, &relative) else {
        return (StatusCode::FORBIDDEN, "403").into_response();
    };

    if let Ok(meta) = tokio::fs::metadata(&resolved).await {
        if !meta.is_dir() {
            if let Ok(bytes) = tokio::fs::read(&resolved).await {
                return (StatusCode::OK, [(header::CONTENT_TYPE, mime_for(&resolved)), (header::CACHE_CONTROL, "no-cache")], bytes)
                    .into_response();
            }
        }
    }

    // SPA 兜底：未知路径回 index.html
    let index = dist.join("index.html");
    match tokio::fs::read(&index).await {
        Ok(bytes) => (StatusCode::OK, [(header::CONTENT_TYPE, "text/html; charset=utf-8")], bytes).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "404").into_response(),
    }
}

pub fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).map(str::to_lowercase).as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

pub fn json_response(status: StatusCode, payload: Value) -> Response {
    let body = serde_json::to_string(&payload).unwrap_or_else(|_| "null".to_string());
    (status, [(header::CONTENT_TYPE, "application/json; charset=utf-8")], body).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    const DEV_ORIGIN: &str = "http://127.0.0.1:3333";

    fn state_with(allowed: Vec<String>) -> InfraState {
        InfraState::new(SseHub::new(8), &ServerOptions { allowed_origins: allowed, ..Default::default() })
    }

    fn ping_app() -> Router {
        let state = state_with(vec![DEV_ORIGIN.to_string()]);
        let api = Router::new().route("/api/ping", get(|| async { "pong" }));
        with_cors(api.merge(infra_router::<()>(state.clone())), state)
    }

    /// 回归：CORS 必须覆盖到 merge 进来的业务路由。
    /// 只挂在 `infra_router` 上时，dev 模式（UI 在 vite dev server、直连内核 API）
    /// 的预检返回 405 且响应无 CORS 头，浏览器把请求整个拦掉 —— 启动台什么都搜不出来。
    #[tokio::test]
    async fn cors_covers_merged_api_routes() {
        let preflight = ping_app()
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/api/ping")
                    .header(header::ORIGIN, DEV_ORIGIN)
                    .header("access-control-request-method", "POST")
                    .header("access-control-request-headers", "content-type")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT, "预检应返回 204");
        assert_eq!(allow_origin_of(&preflight), Some(DEV_ORIGIN));

        let response = ping_app()
            .oneshot(Request::builder().uri("/api/ping").header(header::ORIGIN, DEV_ORIGIN).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(allow_origin_of(&response), Some(DEV_ORIGIN), "业务响应也要带 CORS 头");
    }

    /// 白名单之外的来源不给 CORS 头（内核对「别的网页」保持关闭）
    #[tokio::test]
    async fn cors_rejects_unknown_origin() {
        let response = ping_app()
            .oneshot(
                Request::builder()
                    .uri("/api/ping")
                    .header(header::ORIGIN, "http://evil.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(allow_origin_of(&response), None);
    }

    fn allow_origin_of(response: &Response) -> Option<&str> {
        response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).and_then(|value| value.to_str().ok())
    }
}
