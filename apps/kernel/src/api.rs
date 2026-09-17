//! 启动台 UI ↔ 内核的全部 HTTP 接口，以及**壳 → 内核**的通知处理
//! （v1 `apps/kernel/src/api.ts`；ADR-0001）。
//!
//! 响应形状与 v1 逐字段一致：成功是各 handler 自己构造的 `{ ok: true, ... }`，
//! 失败由这里统一包成 `{ ok: false, error: { code, message } }`（`BAD_ARGS` → 400，其余 500）。

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Json;
use axum::Router;
use serde_json::{json, Value};

use crate::bridge::BridgeCall;
use crate::config::{MAX_WINDOW_HEIGHT, MAX_WINDOW_WIDTH, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH};
use crate::contract::{ItemSnapshot, ResultItem};
use crate::error::KernelError;
use crate::events::names;
use crate::history::PinnedEntry;
use crate::kernel::Kernel;
use crate::types::SessionCloseReason;

/// 业务路由（state 由 `serve(...)` 提供；`infra_router` 负责 SSE / 静态 / 兜底）。
pub fn router() -> Router<Arc<Kernel>> {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/bootstrap", get(bootstrap))
        .route("/api/search", post(search))
        .route("/api/exec", post(exec))
        .route("/api/invoke", post(invoke))
        .route("/api/history", get(history))
        .route("/api/history/remove", post(history_remove))
        .route("/api/history/clear", post(history_clear))
        .route("/api/pinned/toggle", post(pinned_toggle))
        .route("/api/pinned/reorder", post(pinned_reorder))
        .route("/api/config", get(config_get).post(config_patch))
        .route("/api/ui/theme", post(ui_theme))
        .route("/api/plugins", get(plugins_list))
        .route("/api/plugins/action", post(plugins_action))
        .route("/api/dev/register", post(dev_register))
        .route("/api/bridge", post(bridge))
        .route("/api/session/close", post(session_close))
        .route("/api/session/crashed", post(session_crashed))
        .route("/api/window/show", post(window_show))
        .route("/api/window/hide", post(window_hide))
        .route("/api/window/hidden", post(window_hidden))
        .route("/api/window/visible", get(window_visible))
        .route("/api/window/setHeight", post(window_set_height))
        .route("/api/window/setSize", post(window_set_size))
        .route("/api/window/startDrag", post(window_start_drag))
        .route("/api/window/startResize", post(window_start_resize))
        .route("/api/system/stats", get(system_stats))
        .route("/api/app/quit", post(app_quit))
        .route("/api/app/autostart", post(app_autostart))
        .route("/api/data/openDir", post(data_open_dir))
        .route("/api/audit", get(audit_get))
        .route("/api/audit/clear", post(audit_clear))
}

fn body_of(body: Option<Json<Value>>) -> Value {
    body.map(|Json(value)| value).unwrap_or_else(|| json!({}))
}

fn ok_json(payload: Value) -> Response {
    (StatusCode::OK, Json(payload)).into_response()
}

fn error_json(err: KernelError) -> Response {
    let status = if err.code == "BAD_ARGS" { StatusCode::BAD_REQUEST } else { StatusCode::INTERNAL_SERVER_ERROR };
    (status, Json(json!({ "ok": false, "error": { "code": err.code, "message": err.message } }))).into_response()
}

fn required<'a>(value: Option<&'a str>, field: &str) -> Result<&'a str, KernelError> {
    match value {
        Some(text) if !text.is_empty() => Ok(text),
        _ => Err(KernelError::bad_args(format!("{field} 必填"))),
    }
}

fn clamp(value: f64, min: i64, max: i64) -> i64 {
    (value.round() as i64).clamp(min, max)
}

// ── 基础 ────────────────────────────────────────────────────────

async fn health(State(kernel): State<Arc<Kernel>>) -> Response {
    ok_json(json!({ "ok": true, "version": kernel.version(), "ui": kernel.ui_port() }))
}

async fn bootstrap(State(kernel): State<Arc<Kernel>>) -> Response {
    let config = kernel.config.get();
    ok_json(json!({
        "ok": true,
        "version": kernel.version(),
        "platform": platform_string(),
        "dataRoot": kernel.data_root(),
        "config": config,
        "theme": kernel.host_ui.theme(),
        "plugins": kernel.plugins.info(),
        "snapshot": kernel.snapshot(),
        "historyLimit": config.history_limit,
    }))
}

async fn search(State(kernel): State<Arc<Kernel>>, body: Option<Json<Value>>) -> Response {
    let body = body_of(body);
    let query = body.get("query").and_then(Value::as_str).unwrap_or_default().to_string();
    kernel.host_ui.set_query(&query);
    let result = kernel.search.search(&query).await;
    ok_json(json!({
        "ok": true,
        "token": result.token,
        "query": result.query,
        "groups": result.groups,
        "pending": result.pending,
    }))
}

async fn exec(State(kernel): State<Arc<Kernel>>, body: Option<Json<Value>>) -> Response {
    let body = body_of(body);
    let plugin_id = match required(body.get("pluginId").and_then(Value::as_str), "pluginId") {
        Ok(value) => value.to_string(),
        Err(err) => return error_json(err),
    };
    let command = body.get("command").and_then(Value::as_str).unwrap_or_default().to_string();
    let args = body.get("args").cloned();

    if let Some(action) = body.get("action") {
        let result = kernel.run_action(action, (&plugin_id, &command)).await;
        return ok_json(json!({ "ok": true, "result": result }));
    }
    if let Some(item) = body.get("item") {
        let Ok(item) = serde_json::from_value::<ResultItem>(item.clone()) else {
            return error_json(KernelError::bad_args("item 字段不合法"));
        };
        let result = kernel
            .execute_item(&plugin_id, &item, args, if command.is_empty() { None } else { Some(&command) })
            .await;
        return ok_json(json!({ "ok": true, "result": result }));
    }
    let Some(command) = (if command.is_empty() { None } else { Some(command) }) else {
        return error_json(KernelError::bad_args("command 必填"));
    };
    let result = kernel.invoke(&format!("{plugin_id}:{command}"), args, "ui").await;
    ok_json(json!({ "ok": true, "result": result }))
}

async fn invoke(State(kernel): State<Arc<Kernel>>, body: Option<Json<Value>>) -> Response {
    let body = body_of(body);
    let Ok(id) = required(body.get("id").and_then(Value::as_str), "id") else {
        return error_json(KernelError::bad_args("id 必填"));
    };
    let result = kernel.invoke(id, body.get("args").cloned(), "ui").await;
    ok_json(json!({ "ok": true, "result": result }))
}

// ── 历史 / 固定 ─────────────────────────────────────────────────

async fn history(State(kernel): State<Arc<Kernel>>) -> Response {
    ok_json(json!({
        "ok": true,
        "items": kernel.history.all_recent(),
        "pinned": kernel.history.pinned_list(),
        "limit": kernel.config.get().history_limit,
    }))
}

async fn history_remove(State(kernel): State<Arc<Kernel>>, body: Option<Json<Value>>) -> Response {
    let body = body_of(body);
    let Ok(key) = required(body.get("key").and_then(Value::as_str), "key") else {
        return error_json(KernelError::bad_args("key 必填"));
    };
    kernel.history.remove(key);
    ok_json(json!({ "ok": true }))
}

async fn history_clear(State(kernel): State<Arc<Kernel>>) -> Response {
    kernel.history.clear_history();
    kernel.bus.emit(names::HISTORY_CHANGED, &json!({}));
    ok_json(json!({ "ok": true }))
}

async fn pinned_toggle(State(kernel): State<Arc<Kernel>>, body: Option<Json<Value>>) -> Response {
    let body = body_of(body);
    let Ok(key) = required(body.get("key").and_then(Value::as_str), "key") else {
        return error_json(KernelError::bad_args("key 必填"));
    };

    if kernel.history.is_pinned(key) {
        kernel.history.unpin(key);
        kernel.bus.emit(names::PINNED_CHANGED, &json!({ "key": key, "pinned": false }));
        return ok_json(json!({ "ok": true, "pinned": false }));
    }

    let plugin_id = match required(body.get("pluginId").and_then(Value::as_str), "pluginId") {
        Ok(value) => value.to_string(),
        Err(err) => return error_json(err),
    };
    let command = match required(body.get("command").and_then(Value::as_str), "command") {
        Ok(value) => value.to_string(),
        Err(err) => return error_json(err),
    };
    let title = match required(body.get("title").and_then(Value::as_str), "title") {
        Ok(value) => value.to_string(),
        Err(err) => return error_json(err),
    };

    kernel.history.pin(PinnedEntry {
        key: key.to_string(),
        plugin_id,
        command,
        snapshot: ItemSnapshot {
            title,
            subtitle: body.get("subtitle").and_then(Value::as_str).map(str::to_string),
            icon: body.get("icon").and_then(Value::as_str).map(str::to_string),
            args: body.get("args").cloned(),
            action: body.get("action").cloned(),
        },
    });
    kernel.bus.emit(names::PINNED_CHANGED, &json!({ "key": key, "pinned": true }));
    ok_json(json!({ "ok": true, "pinned": true }))
}

async fn pinned_reorder(State(kernel): State<Arc<Kernel>>, body: Option<Json<Value>>) -> Response {
    let body = body_of(body);
    let Some(keys) = body.get("keys").and_then(Value::as_array) else {
        return error_json(KernelError::bad_args("keys 必须是数组"));
    };
    let keys: Vec<String> = keys.iter().filter_map(Value::as_str).map(str::to_string).collect();
    let list = kernel.history.reorder(&keys);
    kernel.bus.emit(names::PINNED_CHANGED, &json!({ "reordered": true }));
    ok_json(json!({ "ok": true, "pinned": list }))
}

// ── 配置 / UI ───────────────────────────────────────────────────

async fn config_get(State(kernel): State<Arc<Kernel>>) -> Response {
    ok_json(json!({ "ok": true, "config": kernel.config.get() }))
}

async fn config_patch(State(kernel): State<Arc<Kernel>>, body: Option<Json<Value>>) -> Response {
    // 写入收口在 `Kernel::patch_config`（落盘 + 副作用 + 广播 `config/changed`），这里只转发
    let body = body_of(body);
    match kernel.patch_config(body).await {
        Ok(result) => {
            let mut payload = json!({ "ok": true });
            if let Value::Object(object) = result {
                for (key, value) in object {
                    payload[key] = value;
                }
            }
            ok_json(payload)
        }
        Err(err) => error_json(err),
    }
}

async fn ui_theme(State(kernel): State<Arc<Kernel>>, body: Option<Json<Value>>) -> Response {
    let body = body_of(body);
    let theme = body.get("theme").and_then(Value::as_str).unwrap_or_default();
    kernel.host_ui.set_theme(if theme == "light" { "light" } else { "dark" });
    ok_json(json!({ "ok": true }))
}

// ── 插件管理 ────────────────────────────────────────────────────

async fn plugins_list(State(kernel): State<Arc<Kernel>>) -> Response {
    ok_json(json!({ "ok": true, "plugins": kernel.plugins.info() }))
}

async fn plugins_action(State(kernel): State<Arc<Kernel>>, body: Option<Json<Value>>) -> Response {
    let body = body_of(body);
    let Ok(action) = required(body.get("action").and_then(Value::as_str), "action") else {
        return error_json(KernelError::bad_args("action 必填"));
    };
    match kernel.plugin_action(action, &body).await {
        Ok(result) => ok_json(result),
        Err(err) => error_json(err),
    }
}

/// 开发模式：把 dev server 注册到运行中的内核（热更新免重启）。
async fn dev_register(State(kernel): State<Arc<Kernel>>, body: Option<Json<Value>>) -> Response {
    let body = body_of(body);
    let Ok(id) = required(body.get("id").and_then(Value::as_str), "id") else {
        return error_json(KernelError::bad_args("id 必填"));
    };
    let Ok(dev_url) = required(body.get("devUrl").and_then(Value::as_str), "devUrl") else {
        return error_json(KernelError::bad_args("devUrl 必填"));
    };
    if !dev_url.is_empty() {
        // 允许空串 = 取消注册
    }
    let mut config = kernel.config.get();
    let mut dev_plugins = config.dev_plugins.clone();
    if dev_url.is_empty() {
        dev_plugins.remove(id);
    } else {
        dev_plugins.insert(id.to_string(), dev_url.to_string());
    }
    config.dev_plugins = dev_plugins;
    if let Err(err) = kernel.config.patch(&json!({ "devPlugins": config.dev_plugins })) {
        return error_json(KernelError::new("INTERNAL", err.to_string()));
    }
    if let Err(err) = kernel.plugins.reload_or_load(id).await {
        return error_json(err);
    }
    ok_json(json!({ "ok": true }))
}

// ── 插件页桥 / 会话 ─────────────────────────────────────────────

async fn bridge(State(kernel): State<Arc<Kernel>>, body: Option<Json<Value>>) -> Response {
    let body = body_of(body);
    let Ok(sid) = required(body.get("sid").and_then(Value::as_str), "sid") else {
        return error_json(KernelError::bad_args("sid 必填"));
    };
    let Ok(token) = required(body.get("token").and_then(Value::as_str), "token") else {
        return error_json(KernelError::bad_args("token 必填"));
    };
    let Ok(method) = required(body.get("method").and_then(Value::as_str), "method") else {
        return error_json(KernelError::bad_args("method 必填"));
    };
    let result = kernel
        .bridge
        .dispatch(BridgeCall {
            sid: sid.to_string(),
            token: token.to_string(),
            id: body.get("id").and_then(Value::as_i64).unwrap_or(0),
            method: method.to_string(),
            params: body.get("params").cloned(),
        })
        .await;
    ok_json(serde_json::to_value(result).unwrap_or(Value::Null))
}

async fn session_close(State(kernel): State<Arc<Kernel>>, body: Option<Json<Value>>) -> Response {
    let body = body_of(body);
    let Ok(sid) = required(body.get("sid").and_then(Value::as_str), "sid") else {
        return error_json(KernelError::bad_args("sid 必填"));
    };
    let closed = kernel.sessions.close(sid, SessionCloseReason::Ui);
    ok_json(json!({ "ok": closed }))
}

async fn session_crashed(State(kernel): State<Arc<Kernel>>, body: Option<Json<Value>>) -> Response {
    let body = body_of(body);
    let Ok(sid) = required(body.get("sid").and_then(Value::as_str), "sid") else {
        return error_json(KernelError::bad_args("sid 必填"));
    };
    let reason = body.get("reason").and_then(Value::as_str).unwrap_or("插件页崩溃").to_string();
    if let Some(session) = kernel.sessions.get(sid) {
        kernel.plugins.mark_crashed(&session.plugin_id, &reason);
    }
    ok_json(json!({ "ok": true }))
}

// ── 窗口 / 系统 ─────────────────────────────────────────────────

async fn window_show(State(kernel): State<Arc<Kernel>>) -> Response {
    if let Err(err) = kernel.show_window_animated(true).await {
        return error_json(err);
    }
    ok_json(json!({ "ok": true }))
}

async fn window_hide(State(kernel): State<Arc<Kernel>>) -> Response {
    if let Err(err) = kernel.hide_window_animated().await {
        return error_json(err);
    }
    ok_json(json!({ "ok": true }))
}

/// UI 回执：离场动画的最后一帧**已经画出来了** → 现在可以真正隐藏了。
/// 带回来的 `opacity` 是**证据**（必须是 0），这里只记日志。
async fn window_hidden(State(kernel): State<Arc<Kernel>>, body: Option<Json<Value>>) -> Response {
    let body = body_of(body);
    let opacity = body.get("opacity").map(|value| value.to_string()).unwrap_or_else(|| "-".to_string());
    let elapsed = body.get("elapsedMs").map(|value| value.to_string()).unwrap_or_else(|| "-".to_string());
    kernel.log("debug", &format!("[hide-ack] opacity={opacity} elapsed={elapsed}ms"));
    kernel.finish_window_hide().await;
    ok_json(json!({ "ok": true }))
}

async fn window_visible(State(kernel): State<Arc<Kernel>>) -> Response {
    let visible = kernel.primitives.is_visible().await;
    ok_json(json!({ "ok": true, "visible": visible }))
}

async fn window_set_height(State(kernel): State<Arc<Kernel>>, body: Option<Json<Value>>) -> Response {
    let body = body_of(body);
    let Some(height) = body.get("height").and_then(Value::as_f64) else {
        return error_json(KernelError::bad_args("height 必须是数字"));
    };
    if !height.is_finite() {
        return error_json(KernelError::bad_args("height 必须是数字"));
    }
    if let Err(err) = kernel.primitives.set_height(clamp(height, 320, 640) as f64).await {
        return error_json(err);
    }
    ok_json(json!({ "ok": true }))
}

async fn window_set_size(State(kernel): State<Arc<Kernel>>, body: Option<Json<Value>>) -> Response {
    let body = body_of(body);
    let (Some(width), Some(height)) = (body.get("width").and_then(Value::as_f64), body.get("height").and_then(Value::as_f64))
    else {
        return error_json(KernelError::bad_args("width / height 必须是数字"));
    };
    if !width.is_finite() || !height.is_finite() {
        return error_json(KernelError::bad_args("width / height 必须是数字"));
    }
    let safe_width = clamp(width, MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH);
    let safe_height = clamp(height, MIN_WINDOW_HEIGHT, MAX_WINDOW_HEIGHT);
    if let Err(err) = kernel.primitives.set_size(safe_width as f64, safe_height as f64).await {
        return error_json(err);
    }
    ok_json(json!({ "ok": true, "width": safe_width, "height": safe_height }))
}

async fn window_start_drag(State(kernel): State<Arc<Kernel>>) -> Response {
    if let Err(err) = kernel.primitives.start_dragging().await {
        return error_json(err);
    }
    ok_json(json!({ "ok": true }))
}

async fn window_start_resize(State(kernel): State<Arc<Kernel>>, body: Option<Json<Value>>) -> Response {
    let body = body_of(body);
    let Ok(direction) = required(body.get("direction").and_then(Value::as_str), "direction") else {
        return error_json(KernelError::bad_args("direction 必填"));
    };
    if let Err(err) = kernel.primitives.start_resize_dragging(direction).await {
        return error_json(err);
    }
    ok_json(json!({ "ok": true }))
}

async fn system_stats(State(kernel): State<Arc<Kernel>>) -> Response {
    let stats = kernel.stats.read().await;
    ok_json(json!({ "ok": true, "stats": stats }))
}

async fn app_quit(State(kernel): State<Arc<Kernel>>) -> Response {
    // 不 await：`quit()` 会停掉 UI 服务，之后再写响应就来不及了 —— 先让本次响应出去，再收尾
    let kernel = kernel.clone();
    tokio::spawn(async move { kernel.quit(false).await });
    ok_json(json!({ "ok": true }))
}

async fn app_autostart(State(kernel): State<Arc<Kernel>>, body: Option<Json<Value>>) -> Response {
    let body = body_of(body);
    let enabled = body.get("enabled").and_then(Value::as_bool).unwrap_or(false);
    if let Err(err) = kernel.primitives.set_autostart(enabled).await {
        return error_json(err);
    }
    ok_json(json!({ "ok": true }))
}

async fn data_open_dir(State(kernel): State<Arc<Kernel>>) -> Response {
    let data_root = kernel.data_root();
    if let Err(err) = kernel.primitives.shell_open_path("kernel", &data_root).await {
        return error_json(err);
    }
    ok_json(json!({ "ok": true }))
}

// ── 审计 ────────────────────────────────────────────────────────

async fn audit_get(State(kernel): State<Arc<Kernel>>, query: axum::extract::Query<Value>) -> Response {
    let limit = query
        .0
        .get("limit")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(200);
    let records = kernel.audit.query(None, None, None, limit);
    ok_json(json!({ "ok": true, "records": records, "file": "" }))
}

async fn audit_clear(State(kernel): State<Arc<Kernel>>) -> Response {
    kernel.audit.clear();
    ok_json(json!({ "ok": true }))
}

// ── 壳 → 内核（stdio JSON-RPC 通知 + 请求）──────────────────────

/// 注册壳侧调用的方法（v1 `api.ts` 末尾的 `kernel.link.handle(...)`）。
pub fn register_link_handlers(kernel: &Arc<Kernel>) {
    // 先取出 link 句柄：闭包里要 clone 内核，直接 `kernel.link.handle(...)` 会同时借用与移动
    let link = kernel.link.clone();

    // 显隐切换的**结果**（不是「按键」）：壳已经完成了显示/隐藏，内核只广播状态。
    // 这里绝不能自己 isVisible → hide/show 一遍 —— 那会让一次热键被 toggle 两遍。
    {
        let kernel = kernel.clone();
        link.handle("window/toggled", move |params| {
            let kernel = kernel.clone();
            Box::pin(async move {
                let visible = params.get("visible").and_then(Value::as_bool).unwrap_or(false);
                if visible {
                    // 重新唤出要把还排在队里的那次隐藏作废：热键连按不能被上一次隐藏偷走窗口
                    kernel.cancel_pending_hide().await;
                    // 壳在窗口上屏**之前**读到的前台选中文本（读不到自然跳过）
                    kernel.apply_selection(params.get("selection").and_then(Value::as_str));
                    // 显示晚一点广播：等窗口上屏 + webview 恢复绘制，否则入场动画会被吞
                    kernel.emit_visible_animated().await;
                } else {
                    // 壳只报告「该隐藏了」这个意图：真正落地由内核在 UI 回执之后执行
                    // （广播 + 等回执 + 兜底都在 hide_window_animated 里）。这里刻意不等它 ——
                    // 否则热键连按时，显示那条通知会被上一次隐藏的回执拖住。
                    let kernel = kernel.clone();
                    tokio::spawn(async move {
                        let _ = kernel.hide_window_animated().await;
                    });
                }
                Ok(json!({ "ok": true }))
            })
        });
    }
    {
        let kernel = kernel.clone();
        link.handle("tray/menu", move |params| {
            let kernel = kernel.clone();
            Box::pin(async move {
                let id = params.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                kernel.handle_tray_menu(&id).await;
                Ok(json!({ "ok": true }))
            })
        });
    }
    {
        let kernel = kernel.clone();
        link.handle("window/blurred", move |_| {
            let kernel = kernel.clone();
            Box::pin(async move {
                if !kernel.config.get().hide_on_blur {
                    return Ok(json!({ "ok": true }));
                }
                let _ = kernel.hide_window_animated().await;
                Ok(json!({ "ok": true }))
            })
        });
    }
    {
        let kernel = kernel.clone();
        link.handle("kernel/ready", move |_| {
            let kernel = kernel.clone();
            Box::pin(async move {
                kernel.link.mark_connected();
                // 壳在 listen 之前就可能来问：必须显式给出 ready，并统一字段名为 uiPort
                if !kernel.is_ready() {
                    return Ok(json!({ "ok": false, "ready": false }));
                }
                Ok(json!({
                    "ok": true,
                    "ready": true,
                    "uiPort": kernel.ui_port(),
                    "version": kernel.version(),
                    "dataRoot": kernel.data_root(),
                }))
            })
        });
    }
    {
        let kernel = kernel.clone();
        link.handle("app/shutdown", move |_| {
            let kernel = kernel.clone();
            Box::pin(async move {
                // 壳发起的退出：不必回请壳（它自己正在退）
                kernel.quit(false).await;
                Ok(json!({ "ok": true }))
            })
        });
    }
}

fn platform_string() -> String {
    match std::env::consts::OS {
        "macos" => "darwin".to_string(),
        "windows" => "win32".to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_rejects_empty_and_missing() {
        assert_eq!(required(None, "key").unwrap_err().code, "BAD_ARGS");
        assert_eq!(required(Some(""), "key").unwrap_err().code, "BAD_ARGS");
        assert_eq!(required(Some("x"), "key").unwrap(), "x");
    }

    #[test]
    fn clamp_rounds_and_bounds() {
        assert_eq!(clamp(500.4, 320, 640), 500);
        assert_eq!(clamp(100.0, 320, 640), 320);
        assert_eq!(clamp(900.0, 320, 640), 640);
        assert_eq!(clamp(600.6, 320, 640), 601);
    }

    #[test]
    fn body_of_defaults_to_empty_object() {
        assert_eq!(body_of(None), json!({}));
        assert_eq!(body_of(Some(Json(json!({ "a": 1 })))), json!({ "a": 1 }));
    }
}
