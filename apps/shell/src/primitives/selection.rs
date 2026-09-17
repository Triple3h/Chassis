//! 选中文本原语（requirements §6.1 `selection.read` / §6.2）：
//! 读「此刻前台 App 里选中的那段文本」。
//!
//! macOS 走 Accessibility API（系统级元素 → 聚焦元素 → `AXSelectedText`）——
//! 这是唯一既不碰用户剪贴板、也不模拟按键的读法（模拟 ⌘C 会把剪贴板冲掉）。
//!
//! 两条硬约束（踩坑记录见 docs/architecture.md D19）：
//!  - **必须发生在窗口显示之前**：窗口一上屏，前台 App 就变成了自己，
//!    `AXFocusedUIElement` 拿到的选区随之消失。顺序由调用方 `window::show` 保证。
//!  - 需要「辅助功能」权限：未授权时 `AXIsProcessTrusted()` 为 false。
//!    首次（状态未知）带 `prompt` 调一次系统引导；已知被拒过就只静默复核，不再打扰。
//!
//! 读不到永远不是错误：`{ ok:false, reason }` 原样回给内核，唤出流程照常继续
//! （这个原语只负责"带来什么就带来什么"，"要不要用"是内核的决定）。

use crate::logging::log;
use serde_json::{json, Value};
use tauri::AppHandle;

#[cfg(target_os = "macos")]
mod imp {
    use super::{json, log};
    use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::{CFString, CFStringRef};
    use serde_json::Value;
    use std::ptr;
    use std::sync::atomic::{AtomicI8, AtomicU64, Ordering};
    use std::sync::mpsc::channel;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tauri::AppHandle;

    /// 权限状态：-1 未知（首次要带系统引导）/ 0 未授权 / 1 已授权
    static TRUSTED: AtomicI8 = AtomicI8::new(-1);
    static CHECKED_AT_MS: AtomicU64 = AtomicU64::new(0);
    /// 未授权后的静默复核间隔：用户可能刚在系统设置里打开了权限
    const RECHECK_MS: u64 = 60_000;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateSystemWide() -> CFTypeRef;
        fn AXUIElementCopyAttributeValue(element: CFTypeRef, attribute: CFStringRef, value: *mut CFTypeRef) -> i32;
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> bool;
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0)
    }

    /// 把一次调用送到主线程执行：Accessibility 的首次授权引导要在 GUI 线程上弹。
    /// 主线程迟迟不回应（例如事件循环正忙）就放弃 —— 宁可这次读不到，也不拖住唤出
    /// （这个等待串在 `window.show` 前面，上限就是"热键到窗口出现"多出来的延迟）。
    fn on_main<T: Send + 'static>(app: &AppHandle, job: impl FnOnce() -> T + Send + 'static) -> Option<T> {
        let (tx, rx) = channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(job());
        })
        .ok()?;
        rx.recv_timeout(Duration::from_millis(800)).ok()
    }

    fn trusted_now(prompt: bool) -> bool {
        unsafe {
            if !prompt {
                return AXIsProcessTrusted();
            }
            let options: CFDictionary<CFString, CFBoolean> = CFDictionary::from_CFType_pairs(&[(
                CFString::new("AXTrustedCheckOptionPrompt"),
                CFBoolean::true_value(),
            )]);
            AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef() as CFTypeRef)
        }
    }

    fn ensure_trusted(app: &AppHandle, force_prompt: bool) -> bool {
        let state = TRUSTED.load(Ordering::Relaxed);
        let now = now_ms();
        let checked_at = CHECKED_AT_MS.load(Ordering::Relaxed);
        if state == 1 && !force_prompt {
            return true;
        }
        if state == 0 && !force_prompt && now.saturating_sub(checked_at) < RECHECK_MS {
            return false;
        }
        // 未知 = 用户还没被问过：带引导弹一次；已知被拒就不再打扰（只静默复核权限是否已开）
        let want_prompt = force_prompt || state < 0;
        let trusted = on_main(app, move || trusted_now(want_prompt)).unwrap_or(false);
        // 只在「状态真的查过」时才落日志：已授权 / 60 秒内的复核都不打，免得每次唤出都刷一行
        log(&format!(
            "[selection] 辅助功能权限：{}（{}）",
            if trusted { "已授权" } else { "未授权" },
            if want_prompt { "已弹系统引导" } else { "静默复核" }
        ));
        TRUSTED.store(if trusted { 1 } else { 0 }, Ordering::Relaxed);
        CHECKED_AT_MS.store(now, Ordering::Relaxed);
        trusted
    }

    /// `AXUIElementCopyAttributeValue` 是 Copy 规则（+1）：拿到的引用由调用方释放
    fn copy_attribute(element: CFTypeRef, name: &str) -> Option<CFTypeRef> {
        let mut value: CFTypeRef = ptr::null();
        let key = CFString::new(name);
        let err = unsafe { AXUIElementCopyAttributeValue(element, key.as_concrete_TypeRef(), &mut value) };
        if err != 0 || value.is_null() {
            None
        } else {
            Some(value)
        }
    }

    pub fn read_selection() -> Value {
        unsafe {
            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return json!({ "ok": false, "reason": "unavailable" });
            }
            let focused = copy_attribute(system, "AXFocusedUIElement");
            CFRelease(system);
            let Some(focused) = focused else {
                return json!({ "ok": false, "reason": "no-focus" });
            };
            let selected = copy_attribute(focused, "AXSelectedText");
            CFRelease(focused);
            let Some(selected) = selected else {
                return json!({ "ok": false, "reason": "empty" });
            };
            // wrap_under_create_rule：接管这个 +1 引用，drop 时自动 release
            let text = CFString::wrap_under_create_rule(selected as CFStringRef).to_string();
            if text.trim().is_empty() {
                return json!({ "ok": false, "reason": "empty" });
            }
            json!({ "ok": true, "text": text })
        }
    }

    pub fn read(app: &AppHandle, prompt: bool) -> Value {
        if !ensure_trusted(app, prompt) {
            return json!({ "ok": false, "reason": "denied" });
        }
        on_main(app, read_selection).unwrap_or_else(|| json!({ "ok": false, "reason": "timeout" }))
    }

    pub fn read_for_show(app: &AppHandle) -> Option<String> {
        let value = read(app, false);
        if value.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            return None;
        }
        let text = value.get("text").and_then(|v| v.as_str())?.to_string();
        if text.trim().is_empty() {
            None
        } else {
            // 只记长度、不记内容：选中文本可能是任何东西（密码、私信、代码片段）
            log(&format!("[selection] 唤出带入选中文本 {} 字", text.chars().count()));
            Some(text)
        }
    }
}

pub fn read(app: &AppHandle, params: &Value) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let prompt = params.get("prompt").and_then(|v| v.as_bool()).unwrap_or(false);
        Ok(imp::read(app, prompt))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, params);
        Ok(json!({ "ok": false, "reason": "unsupported" }))
    }
}

/// 供 `window::show` 用：带得走就带（返回 `Some(text)`），读不到一律 `None`。
pub fn read_for_show(app: &AppHandle) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        imp::read_for_show(app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        None
    }
}
