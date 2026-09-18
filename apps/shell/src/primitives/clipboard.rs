//! 剪贴板（requirements §6.1）：读/写文本 + 变化监听 `clipboard.watch`。
//!
//! `clipboard.watch` 只订阅**变化事件**、不带内容（内容由插件的 `record` 命令自己读，
//! 见 plugin-spec §8.1）：
//!  - Windows：`AddClipboardFormatListener` → `WM_CLIPBOARDUPDATE`，零轮询、无需任何授权；
//!  - 其余平台：`{ ok:false, reason:'unsupported' }` —— macOS 只有轮询 `NSPasteboard.changeCount`
//!    这一条路，而剪贴板历史在 Mac 上刻意不做（m5 计划 §B2.9），所以这里不实现降级版轮询。

use serde_json::{json, Value};
use tauri::AppHandle;

pub fn read_text(app: &AppHandle) -> Result<Value, String> {
    if let Ok(text) = arboard::Clipboard::new().and_then(|mut clipboard| clipboard.get_text()) {
        return Ok(json!({ "text": text }));
    }
    use tauri_plugin_clipboard_manager::ClipboardExt;
    match app.clipboard().read_text() {
        Ok(text) => Ok(json!({ "text": text })),
        Err(err) => Err(format!("读取剪贴板失败：{err}")),
    }
}

pub fn write_text(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let text = params.get("text").and_then(|v| v.as_str()).unwrap_or("");
    if let Ok(mut clipboard) = arboard::Clipboard::new() {
        if clipboard.set_text(text.to_string()).is_ok() {
            return Ok(json!(null));
        }
    }
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(text.to_string())
        .map_err(|err| format!("写入剪贴板失败：{err}"))?;
    Ok(json!(null))
}

/// 订阅 / 取消订阅剪贴板变化（幂等；重复调用返回 `duplicate: true`）。
pub fn watch(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let enabled = params.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
    #[cfg(windows)]
    {
        imp::set_watch(app, enabled)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, enabled);
        Ok(json!({ "ok": false, "reason": "unsupported" }))
    }
}

#[cfg(windows)]
mod imp {
    use super::json;
    use crate::ipc::Link;
    use crate::logging::log;
    use serde_json::Value;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, OnceLock};
    use tauri::{AppHandle, Manager};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::DataExchange::{
        AddClipboardFormatListener, CloseClipboard, EnumClipboardFormats, GetClipboardSequenceNumber,
        OpenClipboard, RemoveClipboardFormatListener,
    };
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, HWND_MESSAGE,
        PostQuitMessage, PostThreadMessageW, RegisterClassW, TranslateMessage, MSG, WINDOW_EX_STYLE,
        WINDOW_STYLE, WM_CLIPBOARDUPDATE, WM_DESTROY, WM_QUIT, WNDCLASSW,
    };

    // 只认这三类（plugin-spec §8.1 的 `kinds`）；未注册的格式一律不通报
    const CF_UNICODETEXT: u32 = 13;
    const CF_DIB: u32 = 8;
    const CF_DIBV5: u32 = 17;
    const CF_HDROP: u32 = 15;

    /// 消息循环是否在跑（壳进程内只有一个订阅者）
    static WATCHING: AtomicBool = AtomicBool::new(false);
    /// 消息循环所在线程：停止时要按线程 id 投递 WM_QUIT（`PostQuitMessage` 只对当前线程有效）
    static THREAD_ID: AtomicU32 = AtomicU32::new(0);
    /// 发通知要用：`Link` 挂在 tauri 的 state 上，只能经 AppHandle 取
    static APP: OnceLock<AppHandle> = OnceLock::new();

    pub fn set_watch(app: &AppHandle, enabled: bool) -> Result<Value, String> {
        if enabled {
            let _ = APP.set(app.clone());
            if WATCHING.swap(true, Ordering::SeqCst) {
                return Ok(json!({ "ok": true, "duplicate": true }));
            }
            std::thread::spawn(listen_loop);
            return Ok(json!({ "ok": true }));
        }
        if !WATCHING.swap(false, Ordering::SeqCst) {
            return Ok(json!({ "ok": true, "duplicate": true }));
        }
        let thread_id = THREAD_ID.swap(0, Ordering::SeqCst);
        if thread_id != 0 {
            unsafe { let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0)); }
        }
        Ok(json!({ "ok": true }))
    }

    /// 自建一个 message-only 窗口跑消息循环：`WM_CLIPBOARDUPDATE` 只会发给注册过的窗口。
    ///
    /// 为什么不用轮询：轮询就要选间隔（300–500ms 才不占 CPU），既丢合并又白耗电；
    /// Windows 这条事件链是系统级的，进程开着就有。
    fn listen_loop() {
        unsafe {
            THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);
            let class_name: Vec<u16> = "ChassisClipboardWatch".encode_utf16().chain(std::iter::once(0)).collect();
            let class = PCWSTR::from_raw(class_name.as_ptr());
            let window_class = WNDCLASSW { lpfnWndProc: Some(wnd_proc), lpszClassName: class, ..Default::default() };
            if RegisterClassW(&window_class) == 0 {
                log("[clipboard] 注册监听窗口类失败，放弃监听");
                stop();
                return;
            }
            let hwnd = match CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class,
                PCWSTR::null(),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            ) {
                Ok(hwnd) => hwnd,
                Err(err) => {
                    log(&format!("[clipboard] 创建监听窗口失败：{err}"));
                    stop();
                    return;
                }
            };
            if AddClipboardFormatListener(hwnd).is_err() {
                log("[clipboard] AddClipboardFormatListener 失败，放弃监听");
                let _ = DestroyWindow(hwnd);
                stop();
                return;
            }
            log("[clipboard] 已开启剪贴板监听");

            let mut message = MSG::default();
            while GetMessageW(&mut message, Some(HWND(std::ptr::null_mut())), 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }

            let _ = RemoveClipboardFormatListener(hwnd);
            let _ = DestroyWindow(hwnd);
            log("[clipboard] 已停止剪贴板监听");
        }
    }

    fn stop() {
        WATCHING.store(false, Ordering::SeqCst);
        THREAD_ID.store(0, Ordering::SeqCst);
    }

    unsafe extern "system" fn wnd_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        match message {
            WM_CLIPBOARDUPDATE => on_clipboard_update(),
            WM_DESTROY => {
                PostQuitMessage(0);
                return LRESULT(0);
            }
            _ => {}
        }
        DefWindowProcW(hwnd, message, wparam, lparam)
    }

    fn on_clipboard_update() {
        if !WATCHING.load(Ordering::SeqCst) {
            return;
        }
        let Some(app) = APP.get() else { return };
        let Some(link) = app.try_state::<Arc<Link>>() else { return };
        // 只记「第几次变化 + 有哪几类内容」，**不记内容**（内容可能是密码 / 私信）
        let payload = json!({ "changeCount": unsafe { GetClipboardSequenceNumber() }, "kinds": clipboard_kinds() });
        link.notify("clipboard/changed", payload);
    }

    /// 枚举剪贴板里现在有哪些**我们关心的**格式。
    /// `OpenClipboard` 被别的程序占着时读不到 —— 那就通报 `unknown`，由插件自己再试一次。
    fn clipboard_kinds() -> Vec<&'static str> {
        let mut kinds: Vec<&'static str> = Vec::new();
        unsafe {
            if OpenClipboard(None).is_err() {
                return vec!["unknown"];
            }
            let mut format = 0u32;
            loop {
                format = EnumClipboardFormats(format);
                if format == 0 {
                    break;
                }
                let kind = match format {
                    CF_UNICODETEXT => "text",
                    CF_DIB | CF_DIBV5 => "image",
                    CF_HDROP => "file",
                    _ => continue,
                };
                if !kinds.contains(&kind) {
                    kinds.push(kind);
                }
            }
            let _ = CloseClipboard();
        }
        if kinds.is_empty() {
            vec!["unknown"]
        } else {
            kinds
        }
    }
}
