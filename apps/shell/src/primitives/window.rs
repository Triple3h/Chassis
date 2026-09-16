//! 窗口原语（requirements §6.1 / §6.2）：显隐、可见性、高度，以及「居中于鼠标所在屏」。

use crate::ipc::Link;
use crate::logging::log;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, Position, Size, WebviewWindow};

pub const DEFAULT_WIDTH: f64 = 720.0;
pub const MIN_HEIGHT: f64 = 320.0;
pub const MAX_HEIGHT: f64 = 640.0;

/// 唤出后的"防抖窗口"：这段时间内的失焦一律忽略。
/// 原因：窗口从隐藏变可见时会先收到一次 `Focused(false)`（此时 set_focus 还没生效），
/// 不加保护就会"按热键 → 窗口闪一下就消失"。
pub const SHOW_GRACE_MS: u64 = 600;

/// 壳自己发起的隐藏（热键 / 托盘 / ⌘W）**只报告、不落地**：真正的 `hide()` 由内核在
/// UI 回执「离场动画的最后一帧已经画出来了」之后发起（`window/hide`）。
///
/// 为什么壳不能自己定时落地：隐藏广播要穿过 壳 → 内核 → SSE → webview 才会变成 CSS 的起点，
/// 这段延迟不可控；任何固定时长都可能砍在淡出中途 —— 被砍掉的那一帧（半透明面板）
/// 会被 webview 留成「最后一帧」，下次唤出时合成器先亮它：用户看到「闪一下，像打开了两次」。
///
/// 这里只排一个兜底：内核没起来 / 失联时没人会来回执，窗口不能永远赖着不走。
pub const HIDE_FALLBACK_MS: u64 = 800;

static LAST_SHOWN_MS: AtomicU64 = AtomicU64::new(0);
static HAS_FOCUSED: AtomicBool = AtomicBool::new(false);
/// 排队的隐藏计划落地时间（ms 时间戳；0 = 没有排队的隐藏）
static HIDE_AT_MS: AtomicU64 = AtomicU64::new(0);

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
    // 唤出要把还排在队里的那次隐藏作废（热键连按不能被上一次隐藏偷走窗口）
    cancel_pending_hide();
    center_on_cursor_screen(app, &window);
    window.show().map_err(|err| err.to_string())?;
    // 诊断（临时）：唤起时窗口的真实尺寸 vs 页面自报视口
    let (w, h, scale) = match (window.inner_size(), window.scale_factor()) {
        (Ok(size), Ok(scale)) if scale > 0.0 => (
            size.width as f64 / scale,
            size.height as f64 / scale,
            scale,
        ),
        _ => (0.0, 0.0, 0.0),
    };
    log(&format!(
        "[window] show 实测窗口 {w:.1}x{h:.1} @{scale} scale，页面自报：{}",
        window.title().unwrap_or_default()
    ));
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
    // 落地了就没有「排队中的隐藏」了：不清的话，热键下一次按会被当成「取消隐藏」
    // （而窗口其实早藏了），表现是「按了热键没反应」。
    cancel_pending_hide();
    Ok(json!(null))
}

/// 是否有排队的隐藏还没落地（窗口正在演离场）
pub fn has_pending_hide() -> bool {
    let at = HIDE_AT_MS.load(Ordering::Relaxed);
    at > 0 && at > now_ms()
}

/// 作废排队中的隐藏（重新唤出时用：热键连按不能被上一次隐藏偷走窗口）
pub fn cancel_pending_hide() {
    HIDE_AT_MS.store(0, Ordering::Relaxed);
}

/// 排一个「万一没人来回执」的兜底隐藏（`HIDE_FALLBACK_MS` 之后落地）。
///
/// 调用方必须**先** `notify_toggled(app, false)`：正常路径是内核收到 UI 的回执后调
/// `window/hide` 落地，这里只负责「内核没起来 / 失联」时窗口不会永远赖着不走。
pub fn arm_hide_fallback(app: &AppHandle) {
    let at = now_ms() + HIDE_FALLBACK_MS;
    HIDE_AT_MS.store(at, Ordering::Relaxed);
    let handle = app.clone();
    std::thread::spawn(move || {
        let now = now_ms();
        if at > now {
            std::thread::sleep(Duration::from_millis(at - now));
        }
        // 被取消 / 已被新的一次取代：什么都不动，状态归当前那一次管
        if HIDE_AT_MS.load(Ordering::Relaxed) != at {
            return;
        }
        HIDE_AT_MS.store(0, Ordering::Relaxed);
        // 这行日志 = 「内核 / UI 的回执没回来」。看到它就说明回执链路断了
        // （内核没起来、SSE 断了、或 UI 里那次离场被别的东西吞了）。
        log("[window] 隐藏兜底到点（没等到回执），直接落地");
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.hide();
        }
    });
}

/// 热键 / 托盘左键共用的显隐切换 —— **全仓库唯一的 toggle 入口**。
///
/// 第一件事是处理「正在演离场的窗口仍然可见」：这时再按一次要**取消隐藏**
/// （否则用户会觉得"按了没反应，窗口还是没了"）。这个判断必须排在最前面。
///
/// **显隐的裁决者只有壳这一处**：内核只接收切换结果（`window/toggled`），
/// 绝不能再自己 toggle 一次 —— 否则一次按键会被 toggle 两遍（壳先显示、内核随即隐藏），
/// 表现就是"按热键窗口闪一下就消失"。
pub fn toggle(app: &AppHandle) {
    if has_pending_hide() {
        cancel_pending_hide();
        notify_toggled(app, true);
        log("[window] toggle → 取消排队中的隐藏");
        return;
    }
    let visible = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if visible {
        // 先报告、再排兜底：内核收到 UI 的回执后调 `window/hide` 落地；
        // 这里只保证「内核没起来 / 失联」时窗口不会永远赖着不走
        notify_toggled(app, false);
        arm_hide_fallback(app);
    } else {
        let _ = show(app, &json!({ "focus": true }));
        notify_toggled(app, true);
    }
    log(&format!("[window] toggle → visible={}", !visible));
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
    // 诊断（临时）：窗口尺寸 vs 页面自报的视口（UI 把它写在窗口标题里）
    log(&format!(
        "[window] set_height 请求 {height:.0}，页面自报：{}",
        window.title().unwrap_or_default()
    ));
    Ok(json!({ "height": height }))
}
