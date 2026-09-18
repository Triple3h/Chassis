//! 全局热键（requirements §3.1）：注册失败要提示并引导换键。
//!
//! 自用现实：首选键经常被输入法/系统占用，所以失败时**自动回退**到候选键，
//! 并把结果写进日志 + 发系统通知，避免出现"装了却唤不出来"的死局。

use crate::logging::log;
use serde_json::{json, Value};
use std::str::FromStr;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// 默认热键（分平台）：
///  - macOS：`Alt+Space` —— Spotlight / Raycast 一族的肌肉记忆；
///  - Windows：`Alt+Space` 是**系统窗口菜单键**（永远抢不到），改用 `Ctrl+Shift+Space`。
#[cfg(target_os = "macos")]
pub const DEFAULT_ACCELERATOR: &str = "Alt+Space";
#[cfg(target_os = "windows")]
pub const DEFAULT_ACCELERATOR: &str = "Ctrl+Shift+Space";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub const DEFAULT_ACCELERATOR: &str = "Ctrl+Space";

/// 首选之后的回退顺序（越靠前越贴近用户习惯）。
/// `Cmd` 只在 macOS 有意义（Windows 上对应的 Super 键几乎抢不过系统），所以回退链分平台。
#[cfg(target_os = "macos")]
const FALLBACKS: [&str; 6] = [
    "Ctrl+Space",
    "Cmd+Shift+Space",
    "Cmd+Alt+Space",
    "Ctrl+Alt+Space",
    "F1",
    "Shift+F1",
];
#[cfg(not(target_os = "macos"))]
const FALLBACKS: [&str; 4] = ["Ctrl+Space", "Ctrl+Alt+Space", "F1", "Shift+F1"];

pub fn register(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let requested = params
        .get("accelerator")
        .and_then(|v| v.as_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_ACCELERATOR)
        .to_string();

    let mut candidates: Vec<String> = vec![requested.clone()];
    for candidate in FALLBACKS {
        if candidate != requested {
            candidates.push(candidate.to_string());
        }
    }

    let _ = app.global_shortcut().unregister_all();
    let mut last_error = String::new();

    for (index, accelerator) in candidates.iter().enumerate() {
        let shortcut = match Shortcut::from_str(accelerator) {
            Ok(shortcut) => shortcut,
            Err(err) => {
                last_error = format!("无法解析「{accelerator}」：{err}");
                continue;
            }
        };
        let app_handle = app.clone();
        match app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            // 切换逻辑收在 window 原语里（托盘左键走同一个函数），这里只转发按键
            super::window::toggle(&app_handle);
        }) {
            Ok(()) => {
                if index == 0 {
                    log(&format!("[hotkey] 已注册 {accelerator}"));
                } else {
                    log(&format!(
                        "[hotkey] {requested} 注册失败（{last_error}），已回退到 {accelerator}"
                    ));
                    notify_hotkey_fallback(app, &requested, accelerator);
                }
                return Ok(json!({
                    "ok": true,
                    "accelerator": accelerator,
                    "requested": requested,
                    "fallback": index > 0,
                }));
            }
            Err(err) => last_error = err.to_string(),
        }
    }

    log(&format!("[hotkey] 所有候选热键都注册失败：{last_error}"));
    notify_hotkey_failure(app, &last_error);
    Ok(json!({ "ok": false, "reason": last_error }))
}

pub fn unregister(app: &AppHandle) -> Result<Value, String> {
    let _ = app.global_shortcut().unregister_all();
    Ok(json!(null))
}

fn notify_hotkey_fallback(app: &AppHandle, requested: &str, actual: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("启动台热键已回退")
        .body(&format!("{requested} 被其它应用占用，已改用 {actual}（可在设置里修改）"))
        .show();
}

fn notify_hotkey_failure(app: &AppHandle, reason: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("启动台热键注册失败")
        .body(&format!("{reason}\n请从托盘菜单唤出，并在设置里换一个热键"))
        .show();
}
