//! 热中间件：随 generation 一起热替换的请求链（`requestLog` / `timeout` / `maintenance`）。
//!
//! 每次 `apply` 都会用新配置**重新构造**这一层（配置在构造时被捕获进闭包），
//! 所以中间件与路由是同一次原子切换的一部分 —— 不存在「路由换了、中间件还是旧的」的中间态。
//!
//! 两条豁免（长连接与自检不能被拦）：
//!  - `/api/events`（SSE 长连接）：不计数、不超时、不记请求日志；
//!  - 带 `x-hot-probe` 头的自检请求：跳过维护模式（其余照常走链）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Method, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::hot::log::HotLog;
use crate::hot::spec::{MiddlewareSpec, PROBE_HEADER};

/// 在途请求计数 + 日志 + 本轮中间件配置（构造 generation 时生成）。
#[derive(Clone)]
pub struct HotMiddlewareCtx {
    pub inflight: Arc<AtomicU64>,
    pub log: HotLog,
    pub config: MiddlewareSpec,
}

/// 在途计数守卫：handler panic / 提前返回都不会漏减。
struct InflightGuard(Arc<AtomicU64>);

impl Drop for InflightGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

pub async fn hot_middleware(State(ctx): State<HotMiddlewareCtx>, request: Request<Body>, next: Next) -> Response {
    let path = request.uri().path().to_string();
    let method = request.method().clone();
    let is_sse = path == "/api/events";
    let is_probe = request.headers().contains_key(PROBE_HEADER);
    let is_hot_api = path.starts_with("/api/hot");

    // 维护模式：拦住「会改变状态」的 API 写请求；GET 读接口保持可用（状态条 / 搜索页仍能看）
    if ctx.config.maintenance
        && !is_sse
        && !is_probe
        && !is_hot_api
        && path.starts_with("/api/")
        && !matches!(method, Method::GET | Method::HEAD | Method::OPTIONS)
    {
        ctx.log.append(json!({
            "type": "request",
            "result": "blocked",
            "reason": "maintenance",
            "method": method.as_str(),
            "path": path,
        }));
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(json!({
                "ok": false,
                "error": { "code": "MAINTENANCE", "message": "内核处于维护模式（热更新进行中），请稍后再试" }
            })),
        )
            .into_response();
    }

    // 在途计数 = 「业务请求」在途数：
    //  - SSE 长连接不计入（否则优雅重启的排空会永远等它）；
    //  - 热更新 API 自身不计入（status 不该把自己算成 1，排空也不该被元操作拖住）。
    let _guard = if is_sse || is_hot_api {
        None
    } else {
        ctx.inflight.fetch_add(1, Ordering::SeqCst);
        Some(InflightGuard(ctx.inflight.clone()))
    };
    let started = Instant::now();

    let response = if ctx.config.timeout_ms > 0 && !is_sse {
        match tokio::time::timeout(Duration::from_millis(ctx.config.timeout_ms), next.run(request)).await {
            Ok(response) => response,
            Err(_) => {
                ctx.log.append(json!({
                    "type": "request",
                    "result": "timeout",
                    "method": method.as_str(),
                    "path": path,
                    "timeoutMs": ctx.config.timeout_ms,
                }));
                (
                    StatusCode::GATEWAY_TIMEOUT,
                    axum::Json(json!({
                        "ok": false,
                        "error": { "code": "TIMEOUT", "message": format!("请求超过热更新配置的超时上限（{}ms）", ctx.config.timeout_ms) }
                    })),
                )
                    .into_response()
            }
        }
    } else {
        next.run(request).await
    };

    if ctx.config.request_log && !is_sse {
        ctx.log.append(json!({
            "type": "request",
            "result": "done",
            "method": method.as_str(),
            "path": path,
            "status": response.status().as_u16(),
            "ms": started.elapsed().as_millis() as u64,
        }));
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hot::log::HotLog;
    use axum::routing::{get, post};
    use axum::Router;
    use serde_json::Value;

    fn ctx(dir: &std::path::Path, config: MiddlewareSpec) -> HotMiddlewareCtx {
        HotMiddlewareCtx { inflight: Arc::new(AtomicU64::new(0)), log: HotLog::new(dir), config }
    }

    async fn send(router: Router, method: &str, path: &str) -> (u16, Option<Value>) {
        let request = Request::builder().method(method).uri(path).body(Body::empty()).unwrap();
        let response = tower::ServiceExt::oneshot(router, request).await.unwrap();
        let status = response.status().as_u16();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value = serde_json::from_slice(&bytes).ok();
        (status, value)
    }

    fn app(dir: &std::path::Path, config: MiddlewareSpec) -> Router {
        Router::new()
            .route("/api/search", post(|| async { "ok" }))
            .route("/api/health", get(|| async { "ok" }))
            .route("/api/hot/status", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn_with_state(ctx(dir, config), hot_middleware))
    }

    #[tokio::test]
    async fn maintenance_blocks_writes_but_keeps_reads_and_hot_api() {
        let dir = std::env::temp_dir().join(format!("hot-mw-test-{}", crate::util::now_ms()));
        let router = app(&dir, MiddlewareSpec { maintenance: true, ..Default::default() });

        let (status, body) = send(router.clone(), "POST", "/api/search").await;
        assert_eq!(status, 503);
        assert_eq!(body.unwrap()["error"]["code"], "MAINTENANCE");

        let (status, _) = send(router.clone(), "GET", "/api/health").await;
        assert_eq!(status, 200, "读接口在维护模式下保持可用");

        let (status, _) = send(router, "GET", "/api/hot/status").await;
        assert_eq!(status, 200, "热更新 API 必须能自己解开维护模式");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn probe_header_bypasses_maintenance() {
        let dir = std::env::temp_dir().join(format!("hot-mw-probe-{}", crate::util::now_ms()));
        let router = app(&dir, MiddlewareSpec { maintenance: true, ..Default::default() });
        let request = Request::builder()
            .method("POST")
            .uri("/api/search")
            .header(PROBE_HEADER, "1")
            .body(Body::empty())
            .unwrap();
        let response = tower::ServiceExt::oneshot(router, request).await.unwrap();
        assert_eq!(response.status().as_u16(), 200, "自检请求要穿过维护模式（否则任何写路由的候选版本都装不上）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn timeout_and_request_log_record_into_hot_log() {
        let dir = std::env::temp_dir().join(format!("hot-mw-log-{}", crate::util::now_ms()));
        let router = Router::new()
            .route("/api/slow", get(|| async { tokio::time::sleep(Duration::from_millis(80)).await; "late" }))
            .layer(axum::middleware::from_fn_with_state(
                ctx(&dir, MiddlewareSpec { request_log: true, timeout_ms: 20, maintenance: false }),
                hot_middleware,
            ));
        let (status, body) = send(router, "GET", "/api/slow").await;
        assert_eq!(status, 504, "超过热更新配置的超时上限要返回 504");
        assert_eq!(body.unwrap()["error"]["code"], "TIMEOUT");

        let log = HotLog::new(&dir).read_tail(10);
        assert!(log.iter().any(|entry| entry["result"] == "timeout"), "超时要落日志：{log:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn inflight_counter_returns_to_zero() {
        let dir = std::env::temp_dir().join(format!("hot-mw-inflight-{}", crate::util::now_ms()));
        let state = ctx(&dir, MiddlewareSpec::default());
        let inflight = state.inflight.clone();
        let router = Router::new().route("/api/health", get(|| async { "ok" })).layer(
            axum::middleware::from_fn_with_state(state, hot_middleware),
        );
        let _ = send(router, "GET", "/api/health").await;
        assert_eq!(inflight.load(Ordering::SeqCst), 0, "请求结束后在途计数必须归零");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
