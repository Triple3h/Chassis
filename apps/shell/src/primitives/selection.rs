//! 选中文本原语（requirements §6.1 `selection.read` / §6.2）：
//! 读「此刻前台 App 里选中的那段文本」。
//!
//! 两端都**不碰剪贴板、也不模拟按键**（模拟 ⌘C 会把剪贴板冲掉）：
//!  - macOS：Accessibility API（系统级元素 → 聚焦元素 → `AXSelectedText`）；
//!  - Windows：UI Automation（`GetFocusedElement` → `TextPattern.GetSelection`）。
//!
//! 两条硬约束（踩坑记录见 docs/architecture.md D19）：
//!  - **必须发生在窗口显示之前**：窗口一上屏，前台 App 就变成了自己，
//!    聚焦元素拿到的选区随之消失。顺序由调用方 `window::show` 保证。
//!  - 读不到永远不是错误：`{ ok:false, reason }` 原样回给内核，唤出流程照常继续
//!    （这个原语只负责"带来什么就带来什么"，"要不要用"是内核的决定）。
//!
//! macOS 需要「辅助功能」权限：未授权时 `AXIsProcessTrusted()` 为 false，
//! 首次（状态未知）带 `prompt` 调一次系统引导；已知被拒过就只静默复核，不再打扰。
//! Windows 的 UIA 不需要任何授权，但**只能拿到实现了 TextPattern 的控件**（原生编辑框、
//! 浏览器内容、Office 等）；游戏 / 自绘界面返回 `unsupported`，属正常降级。

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

#[cfg(windows)]
mod imp {
    use super::{json, log};
    use serde_json::Value;
    use tauri::AppHandle;
    use windows::core::Interface;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomation2, IUIAutomationTextPattern, UIA_TextPatternId,
    };

    /// UI Automation 的跨进程调用会等目标应用响应；给一个上限。
    /// 这条链路串在 `window.show` 前面 —— 宁可这次读不到，也不拖住唤出。
    const CONNECTION_TIMEOUT_MS: u32 = 500;
    /// 截断上限：防「全选整篇文档」把 IPC 与搜索框打爆（内核还会再截一道）
    const MAX_CHARS: usize = 4096;

    /// 线程 COM 公寓守卫：本线程没初始化过就初始化，退出时配对释放。
    struct ComApartment {
        owns: bool,
    }

    impl ComApartment {
        fn enter() -> Self {
            // S_FALSE = 本线程此前已初始化（同样要配对 CoUninitialize）；
            // RPC_E_CHANGED_MODE = 本线程已在别的公寓里 —— 不释放也不报错，直接用
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            Self { owns: hr.is_ok() }
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            if self.owns {
                unsafe { CoUninitialize() };
            }
        }
    }

    pub fn read_selection() -> Value {
        let _apartment = ComApartment::enter();
        unsafe {
            let automation: IUIAutomation = match CoCreateInstance(&CUIAutomation, None::<&windows::core::IUnknown>, CLSCTX_INPROC_SERVER) {
                Ok(value) => value,
                Err(_) => return json!({ "ok": false, "reason": "unavailable" }),
            };
            // 连接超时只在 IUIAutomation2（Win8+）上；拿不到就用系统默认（2s），不因此失败
            if let Ok(automation2) = automation.cast::<IUIAutomation2>() {
                let _ = automation2.SetConnectionTimeout(CONNECTION_TIMEOUT_MS);
            }

            let Ok(focused) = automation.GetFocusedElement() else {
                return json!({ "ok": false, "reason": "no-focus" });
            };
            // TextPattern = 能拿到「选区」的那个（原生编辑框 / 浏览器内容 / Office）；
            // 只有 ValuePattern 的控件（没有选区概念）读不到就是读不到，不硬凑
            let Ok(pattern) = focused.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) else {
                return json!({ "ok": false, "reason": "unsupported" });
            };
            let Ok(ranges) = pattern.GetSelection() else {
                return json!({ "ok": false, "reason": "empty" });
            };
            let count = ranges.Length().unwrap_or(0);
            let mut parts: Vec<String> = Vec::new();
            for index in 0..count {
                if let Ok(range) = ranges.GetElement(index) {
                    // maxLength = -1：整段都要
                    if let Ok(text) = range.GetText(-1) {
                        let text = text.to_string();
                        if !text.is_empty() {
                            parts.push(text);
                        }
                    }
                }
            }
            let joined = parts.join("\n");
            let trimmed = joined.trim();
            if trimmed.is_empty() {
                return json!({ "ok": false, "reason": "empty" });
            }
            let text: String = trimmed.chars().take(MAX_CHARS).collect();
            json!({ "ok": true, "text": text })
        }
    }

    /// Windows 上没有权限流程，`app` 只是接口对齐用的。
    pub fn read_for_show(_app: &AppHandle) -> Option<String> {
        let value = read_selection();
        if value.get("ok").and_then(Value::as_bool) != Some(true) {
            return None;
        }
        let text = value.get("text").and_then(Value::as_str)?.to_string();
        if text.trim().is_empty() {
            None
        } else {
            // 只记长度、不记内容（与 macOS 同款口径）
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
    #[cfg(windows)]
    {
        let _ = (app, params);
        Ok(imp::read_selection())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, params);
        Ok(json!({ "ok": false, "reason": "unsupported" }))
    }
}

/// 供 `window::show` 用：带得走就带（返回 `Some(text)`），读不到一律 `None`。
pub fn read_for_show(app: &AppHandle) -> Option<String> {
    #[cfg(any(target_os = "macos", windows))]
    {
        imp::read_for_show(app)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = app;
        None
    }
}
