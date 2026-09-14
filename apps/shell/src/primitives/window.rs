//! 窗口原语（requirements §6.1 / §6.2）：显隐、可见性、高度，以及「居中于鼠标所在屏」。

use crate::ipc::Link;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, Position, Size, WebviewWindow};

pub const DEFAULT_WIDTH: f64 = 720.0;
pub const MIN_HEIGHT: f64 = 320.0;
pub const MAX_HEIGHT: f64 = 640.0;

/// 唤出后的"防抖窗口"：这段时间内的失焦一律忽略。
/// 原因：窗口从隐藏变可见时会先收到一次 `Focused(false)`（此时 set_focus 还没生效），
/// 不加保护就会"按热键 → 窗口闪一下就消失"。
pub const SHOW_GRACE_MS: u64 = 600;

static LAST_SHOWN_MS: AtomicU64 = AtomicU64::new(0);
static HAS_FOCUSED: AtomicBool = AtomicBool::new(false);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 每次 `window.show` 都会重置：进入新的防抖窗口，并清空"曾获得焦点"标记
pub fn mark_shown() {
    LAST_SHOWN_MS.store(now_ms(), Ordering::Relaxed);
    HAS_FOCUSED.store(false, Ordering::Relaxed);
}

pub fn mark_focused() {
    HAS_FOCUSED.store(true, Ordering::Relaxed);
}

pub fn in_show_grace() -> bool {
    let shown = LAST_SHOWN_MS.load(Ordering::Relaxed);
    shown > 0 && now_ms().saturating_sub(shown) < SHOW_GRACE_MS
}

pub fn has_focused_since_show() -> bool {
    HAS_FOCUSED.load(Ordering::Relaxed)
}

pub fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("main").ok_or_else(|| "主窗口不存在".to_string())
}

/// 多屏：读鼠标坐标 → 选最近屏 → 该屏工作区居中（y 取 1/4 高度处更符合习惯）
pub fn center_on_cursor_screen(app: &AppHandle, window: &WebviewWindow) {
    let Ok(cursor) = app.cursor_position() else { return };
    let monitor = app
        .monitor_from_point(cursor.x, cursor.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };

    let scale = monitor.scale_factor();
    let monitor_pos = monitor.position();
    let monitor_size = monitor.size();
    let Ok(window_size) = window.outer_size() else { return };

    let width = window_size.width as f64;
    let height = window_size.height as f64;
    let monitor_width = monitor_size.width as f64;
    let monitor_height = monitor_size.height as f64;

    let x = monitor_pos.x as f64 + (monitor_width - width) / 2.0;
    let y = monitor_pos.y as f64 + (monitor_height - height) / 4.0;
    let _ = scale;
    let _ = window.set_position(Position::Physical(PhysicalPosition::new(x.round() as i32, y.round() as i32)));
}

pub fn show(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let window = main_window(app)?;
    let focus = params.get("focus").and_then(|v| v.as_bool()).unwrap_or(true);
    mark_shown();
    center_on_cursor_screen(app, &window);
    window.show().map_err(|err| err.to_string())?;
    if focus {
        // macOS：Accessory 应用需要显式抢焦点，否则键盘输入仍留在原来的 app
        let _ = window.set_focus();
        #[cfg(target_os = "macos")]
        {
            let _ = window.unminimize();
        }
    }
    Ok(json!(null))
}

pub fn hide(app: &AppHandle) -> Result<Value, String> {
    let window = main_window(app)?;
    window.hide().map_err(|err| err.to_string())?;
    Ok(json!(null))
}

/// 用户主动切换显隐后，把**结果**告诉内核（内核只广播状态，绝不能再 toggle 一次）。
///
/// 只在用户触发的路径调用：全局热键、托盘左键。
/// 内核自己发起的 `window.show` / `window.hide` 不回报，否则会形成"自己通知自己"的回环。
pub fn notify_toggled(app: &AppHandle, visible: bool) {
    if let Some(link) = app.try_state::<Arc<Link>>() {
        link.notify("window/toggled", json!({ "visible": visible }));
    }
}

pub fn is_visible(app: &AppHandle) -> Result<Value, String> {
    let window = main_window(app)?;
    Ok(json!(window.is_visible().unwrap_or(false)))
}

pub fn set_height(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let window = main_window(app)?;
    let requested = params.get("height").and_then(|v| v.as_f64()).unwrap_or(MIN_HEIGHT);
    let height = requested.clamp(MIN_HEIGHT, MAX_HEIGHT);
    window
        .set_size(Size::Logical(LogicalSize::new(DEFAULT_WIDTH, height)))
        .map_err(|err| err.to_string())?;
    Ok(json!({ "height": height }))
}
