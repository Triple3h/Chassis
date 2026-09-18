//! 内核热更新：变更描述（spec）的解析、校验与扩展路由构造。
//!
//! spec 是内核热更新的**唯一输入**（对齐插件热更新的 zip 清单 `package.json`）：
//! 内核零能力（不联网）⇒ 谁下载谁投递，内核只认「本地文件路径」或「HTTP 请求体里的 JSON」。
//!
//! 版本标注：`HOT_UPDATE_VERSION`（0.1.0）= 热更新机制自身的版本；
//! spec 里必须声明同一个 `hotVersion`，不匹配一律拒绝（不猜测、不迁移）。

use std::collections::BTreeSet;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::any;
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::error::{KernelError, Result};

/// 热更新机制版本（本次实现暂定 0.1.0；写进每条日志与 `hot/status`）。
pub const HOT_UPDATE_VERSION: &str = "0.1.0";
/// spec 文件的 schema：不认识的 schema 一律拒绝。
pub const HOT_SCHEMA: u32 = 1;
/// 自检请求头：中间件识别后跳过「维护模式」这类**拦截型**逻辑（放行探测，其余照常走链）。
pub const PROBE_HEADER: &str = "x-hot-probe";

const MODULES: [&str; 3] = ["routes", "middleware", "bus"];
const METHODS: [&str; 8] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "*"];

/// 热更新 spec（磁盘上的 `current.json` / 请求体里的 JSON 同构）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HotSpec {
    /// 必须等于 `HOT_SCHEMA`
    pub schema: u32,
    /// 必须等于 `HOT_UPDATE_VERSION`
    pub hot_version: String,
    /// 目标内核版本（标注用；不参与兼容判断——兼容由 schema / hotVersion 表达）
    pub kernel_version: String,
    /// 本次变更的版本标识（日志 / 回滚展示用；留空则自动生成 `gen-<n>`）
    pub revision: String,
    /// 人类可读的变更说明
    pub note: String,
    /// 作者声明的变更模块（`routes` / `middleware` / `bus`；留空则按实际差异推断）
    pub modules: Vec<String>,
    pub routes: RoutesSpec,
    pub middleware: MiddlewareSpec,
    pub bus: BusSpec,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RoutesSpec {
    /// 声明式扩展路由（json / text / redirect 三种；不做任意代码执行）
    pub extensions: Vec<ExtensionRoute>,
    /// 停用的**内置**路由（路径必须真实存在，写错即拒绝 —— 免得「以为关了其实没关」）
    pub disabled: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExtensionRoute {
    /// `json` | `text` | `redirect`
    pub kind: String,
    /// 默认 `GET`；`*` = 任意方法
    pub method: String,
    pub path: String,
    /// 响应状态码（缺省：json/text 200、redirect 302）
    pub status: Option<u16>,
    /// kind=json
    pub body: Option<Value>,
    /// kind=text
    pub text: Option<String>,
    /// kind=redirect
    pub location: Option<String>,
    /// 说明（展示在 hot/status）
    pub description: String,
}

impl Default for ExtensionRoute {
    fn default() -> Self {
        Self {
            kind: "json".to_string(),
            method: "GET".to_string(),
            path: String::new(),
            status: None,
            body: None,
            text: None,
            location: None,
            description: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MiddlewareSpec {
    /// 记录请求日志（method / path / status / 耗时）到热更新日志
    pub request_log: bool,
    /// 请求超时毫秒（0 = 关闭；SSE 长连接豁免）
    pub timeout_ms: u64,
    /// 维护模式：`/api/*` 的写请求（非 GET/HEAD/OPTIONS）一律 503；热更新 API 与 SSE 豁免
    pub maintenance: bool,
}

impl Default for MiddlewareSpec {
    fn default() -> Self {
        Self { request_log: false, timeout_ms: 0, maintenance: false }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BusSpec {
    /// 订阅这些事件、收到即写一行热更新日志（`type:"event"`）
    pub log: Vec<String>,
}

/// 校验 spec；不合法一律拒绝（调用方保持当前代不动 = 回滚到上一稳定版本）。
pub fn validate(spec: &HotSpec, builtin_paths: &[&'static str]) -> Result<()> {
    if spec.schema != HOT_SCHEMA {
        return Err(KernelError::bad_args(format!(
            "spec schema 不受支持：{}（当前支持 {HOT_SCHEMA}）",
            spec.schema
        )));
    }
    if spec.hot_version != HOT_UPDATE_VERSION {
        return Err(KernelError::bad_args(format!(
            "hotVersion 不匹配：{}（内核热更新版本 {HOT_UPDATE_VERSION}）",
            if spec.hot_version.is_empty() { "（缺失）" } else { spec.hot_version.as_str() }
        )));
    }
    for module in &spec.modules {
        if !MODULES.contains(&module.as_str()) {
            return Err(KernelError::bad_args(format!(
                "未知变更模块：{module}（可用：{}）",
                MODULES.join(" / ")
            )));
        }
    }

    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for route in &spec.routes.extensions {
        if !route.path.starts_with('/') {
            return Err(KernelError::bad_args(format!("扩展路由路径必须以 / 开头：{}", route.path)));
        }
        if route.path.starts_with("/api/hot") {
            return Err(KernelError::bad_args(format!("扩展路由不允许占用热更新 API 前缀：{}", route.path)));
        }
        if builtin_paths.contains(&route.path.as_str()) {
            return Err(KernelError::bad_args(format!(
                "扩展路由与内置路由冲突：{}（要改内置路由请用 disabled 停用，或换一个路径）",
                route.path
            )));
        }
        if !seen.insert(route.path.as_str()) {
            return Err(KernelError::bad_args(format!("扩展路由重复声明：{}", route.path)));
        }
        match route.kind.as_str() {
            "json" | "text" | "redirect" => {}
            other => {
                return Err(KernelError::bad_args(format!(
                    "未知扩展路由类型：{other}（可用：json / text / redirect）"
                )))
            }
        }
        if !METHODS.contains(&route.method.to_uppercase().as_str()) {
            return Err(KernelError::bad_args(format!("未知 HTTP 方法：{}", route.method)));
        }
        if let Some(status) = route.status {
            if !(100..=599).contains(&status) {
                return Err(KernelError::bad_args(format!("非法状态码：{status}（合法范围 100–599）")));
            }
        }
        if route.kind == "redirect" && route.location.as_deref().unwrap_or_default().is_empty() {
            return Err(KernelError::bad_args(format!("redirect 路由缺少 location：{}", route.path)));
        }
    }
    for path in &spec.routes.disabled {
        if !builtin_paths.contains(&path.as_str()) {
            return Err(KernelError::bad_args(format!("disabled 里不是内置路由：{path}")));
        }
    }
    if spec.bus.log.iter().any(|event| event.trim().is_empty()) {
        return Err(KernelError::bad_args("bus.log 里存在空事件名"));
    }
    if spec.middleware.timeout_ms > 600_000 {
        return Err(KernelError::bad_args("middleware.timeoutMs 上限 600000（10 分钟）"));
    }
    Ok(())
}

/// 扩展路由树（可 merge 进任意 state 的业务路由；handler 全为纯读，无副作用）。
pub fn extension_router<S>(spec: &HotSpec) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let mut router: Router<S> = Router::new();
    for route in &spec.routes.extensions {
        let route = route.clone();
        let path = route.path.clone();
        let handler = move |request: Request<Body>| {
            let route = route.clone();
            async move {
                let expected = route.method.to_uppercase();
                if expected != "*" && request.method().as_str() != expected {
                    return (
                        StatusCode::METHOD_NOT_ALLOWED,
                        [(header::ALLOW, expected.as_str().to_string())],
                        format!("405：该热更新路由只接受 {expected}"),
                    )
                        .into_response();
                }
                match route.kind.as_str() {
                    "json" => {
                        let status = StatusCode::from_u16(route.status.unwrap_or(200)).unwrap_or(StatusCode::OK);
                        (status, axum::Json(route.body.clone().unwrap_or(Value::Null))).into_response()
                    }
                    "text" => {
                        let status = StatusCode::from_u16(route.status.unwrap_or(200)).unwrap_or(StatusCode::OK);
                        (status, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], route.text.clone().unwrap_or_default())
                            .into_response()
                    }
                    "redirect" => {
                        let status = StatusCode::from_u16(route.status.unwrap_or(302)).unwrap_or(StatusCode::FOUND);
                        let location = route.location.clone().unwrap_or_default();
                        (status, [(header::LOCATION, location)]).into_response()
                    }
                    _ => (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        axum::Json(json!({ "ok": false, "error": { "code": "BAD_SPEC", "message": "未知扩展路由类型" } })),
                    )
                        .into_response(),
                }
            }
        };
        router = router.route(&path, any(handler));
    }
    router
}

/// 自检：对声明里的扩展路由逐条发一发（走**候选树**，不带 state 之外的副作用）。
///
/// 这是「新版本加载失败则自动恢复」的第一道闸门 —— 不过关就不切换，当前代原样在跑。
pub async fn probe(tree: &Router, spec: &HotSpec) -> Result<usize> {
    let mut probed = 0usize;
    for route in &spec.routes.extensions {
        let method = if route.method == "*" { "GET".to_string() } else { route.method.to_uppercase() };
        let expected = match route.kind.as_str() {
            "redirect" => route.status.unwrap_or(302),
            _ => route.status.unwrap_or(200),
        };
        let request = Request::builder()
            .method(method.as_str())
            .uri(&route.path)
            .header(PROBE_HEADER, "1")
            .body(Body::empty())
            .map_err(|err| KernelError::new("INTERNAL", format!("自检请求构造失败：{err}")))?;
        let response = tree
            .clone()
            .oneshot(request)
            .await
            .map_err(|err| KernelError::new("INTERNAL", format!("自检请求失败（{}）：{err}", route.path)))?;
        if response.status().as_u16() != expected {
            return Err(KernelError::new(
                "PROBE_FAILED",
                format!("自检未通过：{} {} 期望 {expected}，实际 {}", method, route.path, response.status().as_u16()),
            ));
        }
        probed += 1;
    }
    Ok(probed)
}

/// 实际差异推断（供日志记录「本次真正换了哪些模块」）。
pub fn changed_modules(old: &HotSpec, new: &HotSpec) -> Vec<String> {
    let mut modules = Vec::new();
    if old.routes != new.routes {
        modules.push("routes".to_string());
    }
    if old.middleware != new.middleware {
        modules.push("middleware".to_string());
    }
    if old.bus != new.bus {
        modules.push("bus".to_string());
    }
    modules
}

/// 内置路由清单（唯一源在 `api.rs::builtin_routes()`，这里只是取路径的便捷函数）。
pub fn builtin_paths() -> Vec<&'static str> {
    crate::api::builtin_routes().into_iter().map(|(path, _)| path).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_spec() -> HotSpec {
        HotSpec {
            schema: HOT_SCHEMA,
            hot_version: HOT_UPDATE_VERSION.to_string(),
            kernel_version: "0.1.0".to_string(),
            revision: "2026.09.18-1".to_string(),
            note: "维护模式 + 别名路由".to_string(),
            modules: vec!["routes".to_string(), "middleware".to_string()],
            routes: RoutesSpec {
                extensions: vec![ExtensionRoute {
                    path: "/api/ext/ping".to_string(),
                    kind: "json".to_string(),
                    ..Default::default()
                }],
                disabled: vec!["/api/dev/register".to_string()],
            },
            middleware: MiddlewareSpec { request_log: true, timeout_ms: 30_000, maintenance: false },
            bus: BusSpec { log: vec!["history/changed".to_string()] },
        }
    }

    const BUILTIN: [&str; 3] = ["/api/health", "/api/dev/register", "/api/search"];

    #[test]
    fn accepts_valid_spec() {
        validate(&valid_spec(), &BUILTIN).expect("合法 spec 应当通过");
    }

    #[test]
    fn rejects_unknown_schema_and_hot_version() {
        let mut spec = valid_spec();
        spec.schema = 99;
        assert!(validate(&spec, &BUILTIN).is_err(), "未知 schema 必须拒绝");

        let mut spec = valid_spec();
        spec.hot_version = "9.9.9".to_string();
        let err = validate(&spec, &BUILTIN).expect_err("版本不匹配必须拒绝");
        assert!(err.message.contains(HOT_UPDATE_VERSION), "错误信息要带机制版本：{}", err.message);
    }

    #[test]
    fn rejects_route_conflicts_and_duplicates() {
        let mut spec = valid_spec();
        spec.routes.extensions[0].path = "/api/health".to_string();
        assert!(validate(&spec, &BUILTIN).is_err(), "与内置路由冲突必须拒绝");

        let mut spec = valid_spec();
        spec.routes.extensions.push(spec.routes.extensions[0].clone());
        assert!(validate(&spec, &BUILTIN).is_err(), "重复声明必须拒绝");

        let mut spec = valid_spec();
        spec.routes.extensions[0].path = "/api/hot/apply".to_string();
        assert!(validate(&spec, &BUILTIN).is_err(), "热更新 API 前缀必须保护");
    }

    #[test]
    fn rejects_unknown_disabled_path_and_bad_kind() {
        let mut spec = valid_spec();
        spec.routes.disabled = vec!["/api/not-builtin".to_string()];
        assert!(validate(&spec, &BUILTIN).is_err(), "停用不存在的内置路由必须拒绝");

        let mut spec = valid_spec();
        spec.routes.extensions[0].kind = "wasm".to_string();
        assert!(validate(&spec, &BUILTIN).is_err(), "未知路由类型必须拒绝");

        let mut spec = valid_spec();
        spec.routes.extensions[0].kind = "redirect".to_string();
        spec.routes.extensions[0].location = None;
        assert!(validate(&spec, &BUILTIN).is_err(), "redirect 缺 location 必须拒绝");
    }

    #[test]
    fn infers_changed_modules_from_diff() {
        let old = valid_spec();
        let mut new = old.clone();
        new.middleware.maintenance = true;
        assert_eq!(changed_modules(&old, &new), vec!["middleware"]);

        let mut new = old.clone();
        new.bus.log.push("config/changed".to_string());
        assert_eq!(changed_modules(&old, &new), vec!["bus"]);

        assert!(changed_modules(&old, &old.clone()).is_empty(), "无变化 ⇒ 空模块列表");
    }

    #[tokio::test]
    async fn extension_router_serves_json_text_and_redirect() {
        let spec = HotSpec {
            schema: HOT_SCHEMA,
            hot_version: HOT_UPDATE_VERSION.to_string(),
            routes: RoutesSpec {
                extensions: vec![
                    ExtensionRoute {
                        kind: "json".to_string(),
                        path: "/api/ext/json".to_string(),
                        body: Some(json!({ "hello": "hot" })),
                        ..Default::default()
                    },
                    ExtensionRoute {
                        kind: "text".to_string(),
                        path: "/api/ext/text".to_string(),
                        text: Some("hot-update 0.1.0".to_string()),
                        ..Default::default()
                    },
                    ExtensionRoute {
                        kind: "redirect".to_string(),
                        path: "/api/ext/go".to_string(),
                        location: Some("https://example.com".to_string()),
                        ..Default::default()
                    },
                ],
                disabled: Vec::new(),
            },
            ..Default::default()
        };
        let tree: Router = extension_router::<()>(&spec);

        let probed = probe(&tree, &spec).await.expect("三条扩展路由都应自检通过");
        assert_eq!(probed, 3);

        let text = tree
            .clone()
            .oneshot(Request::builder().uri("/api/ext/text").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(text.status(), StatusCode::OK);

        let wrong_method = tree
            .clone()
            .oneshot(Request::builder().method("POST").uri("/api/ext/text").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(wrong_method.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
}
