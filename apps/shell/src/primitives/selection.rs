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
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::{CFNumber, CFNumberRef};
    use core_foundation::string::{CFString, CFStringRef};
    use serde_json::Value;
    use std::os::raw::c_char;
    use std::ptr;
    use std::sync::atomic::{AtomicI8, AtomicU64, Ordering};
    use std::sync::mpsc::channel;
    use std::sync::Mutex;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tauri::AppHandle;

    /// 权限状态：-1 未知（首次要带系统引导）/ 0 未授权 / 1 已授权
    static TRUSTED: AtomicI8 = AtomicI8::new(-1);
    static CHECKED_AT_MS: AtomicU64 = AtomicU64::new(0);
    /// 未授权后的静默复核间隔：用户可能刚在系统设置里打开了权限
    const RECHECK_MS: u64 = 60_000;

    /// 已经开过「无障碍增强」的 pid（见 `activate`）；写过一次就不再重复写
    static ACTIVATED: Mutex<Vec<i32>> = Mutex::new(Vec::new());
    /// 已经记过「读不到」日志的 pid：唤出很频繁，同一个 App 只提醒一次
    static LOGGED_MISS: Mutex<Vec<i32>> = Mutex::new(Vec::new());

    /// 读到空之后的等待重试预算：Chromium 系收到增强属性才开始建 AX 树，而建树是异步的
    /// （6 次 × 15ms ≈ 90ms；这段串在窗口上屏之前，不能再长）
    const RETRY_TIMES: u32 = 6;
    const RETRY_INTERVAL_MS: u64 = 15;
    /// AX 跨进程调用的消息超时（秒）：目标 App 无响应时不能把壳一起拖住
    const MESSAGING_TIMEOUT_S: f32 = 0.3;
    /// 预热轮询间隔
    const PREWARM_INTERVAL_MS: u64 = 1_000;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateSystemWide() -> CFTypeRef;
        fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
        fn AXUIElementCopyAttributeValue(element: CFTypeRef, attribute: CFStringRef, value: *mut CFTypeRef) -> i32;
        fn AXUIElementSetAttributeValue(element: CFTypeRef, attribute: CFStringRef, value: CFTypeRef) -> i32;
        fn AXUIElementSetMessagingTimeout(element: CFTypeRef, timeout: f32) -> i32;
        fn AXUIElementGetPid(element: CFTypeRef, pid: *mut i32) -> i32;
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> bool;
    }

    // `proc_name(3)`（libSystem）：日志里要能看出「是哪个 App 读不到」
    extern "C" {
        fn proc_name(pid: i32, buffer: *mut c_char, buffersize: u32) -> i32;
    }

    // `CGWindowListCopyWindowInfo`（CoreGraphics）：AX 焦点问不出前台 App 时的兜底
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relativeToWindow: u32) -> CFTypeRef;
    }

    /// `kCGWindowListOptionOnScreenOnly` | `kCGWindowListExcludeDesktopElements`
    const WINDOW_LIST_OPTION: u32 = 1 | 16;

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

    fn app_name(pid: i32) -> String {
        let mut buffer = [0 as c_char; 256];
        let length = unsafe { proc_name(pid, buffer.as_mut_ptr(), buffer.len() as u32) };
        if length <= 0 {
            return format!("pid {pid}");
        }
        let bytes: Vec<u8> = buffer[..length as usize].iter().map(|byte| *byte as u8).collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn set_bool(element: CFTypeRef, name: &str) -> bool {
        let key = CFString::new(name);
        let value = CFBoolean::true_value();
        unsafe {
            AXUIElementSetAttributeValue(element, key.as_concrete_TypeRef(), value.as_concrete_TypeRef() as CFTypeRef) == 0
        }
    }

    /// 给目标 App 打开「无障碍增强」（只对没开过的 pid 做一次；返回 true = 这次真的新开了，值得等）。
    ///
    /// 原生 App（企微 / 备忘录 / Safari 等）的 `AXSelectedText` 一直都在，用不着这一步；
    /// 但 **Chromium 系**（Chrome、Electron 的 VS Code / ZCode 等）为了省内存默认根本不建 AX 树，
    /// 对外的表现就是「焦点元素拿得到、选区永远读不到」。下面两个私有属性是 Chromium
    /// 专门留给外部工具的开关（写属性动作本身很轻，建树是异步的，所以调用方还要留重试预算）。
    fn activate(pid: i32) -> bool {
        {
            let guard = ACTIVATED.lock().unwrap_or_else(|err| err.into_inner());
            if guard.contains(&pid) {
                return false;
            }
        }
        unsafe {
            let app = AXUIElementCreateApplication(pid);
            if app.is_null() {
                return false;
            }
            // 目标 App 卡住时不能把壳一起拖住（读选区串在窗口上屏之前）
            let _ = AXUIElementSetMessagingTimeout(app, MESSAGING_TIMEOUT_S);
            let enhanced = set_bool(app, "AXEnhancedUserInterface");
            let manual = set_bool(app, "AXManualAccessibility");
            CFRelease(app);
            if let Ok(mut guard) = ACTIVATED.lock() {
                guard.push(pid);
            }
            let name = app_name(pid);
            if enhanced || manual {
                log(&format!("[selection] 为 {name} 开启无障碍增强"));
            } else {
                log(&format!("[selection] {name} 不支持无障碍增强开关（原生 App 无需）"));
            }
            enhanced || manual
        }
    }

    /// 每个 App 只记一次「读不到」：唤出很频繁，同一个 App 不该每次刷一行
    fn log_miss_once(pid: Option<i32>, reason: &str) {
        let key = pid.unwrap_or(0);
        let first = match LOGGED_MISS.lock() {
            Ok(mut guard) => {
                if guard.contains(&key) {
                    false
                } else {
                    guard.push(key);
                    true
                }
            }
            Err(_) => false,
        };
        if !first {
            return;
        }
        match pid {
            Some(pid) => log(&format!("[selection] {} 读不到选中文本（{reason}）", app_name(pid))),
            None => log(&format!("[selection] 取不到前台 App（{reason}）")),
        }
    }

    /// 前台 App 的 pid：先问 AX 焦点应用，**问不出就用屏幕上最前面的普通窗口**反推。
    ///
    /// 为什么必须有兜底：Chromium 系没建 AX 树时 `AXFocusedUIElement` / `AXFocusedApplication`
    /// 都可能问不出东西，而「该给谁开增强」只缺一个 pid —— 于是死锁（越读不到越开不了）。
    /// 窗口列表由窗口服务器维护，不依赖目标 App 的无障碍实现。
    fn frontmost_pid() -> Option<i32> {
        let me = std::process::id() as i32;
        if let Some(pid) = ax_focused_app_pid() {
            if pid != me {
                return Some(pid);
            }
        }
        visible_front_pid()
    }

    fn ax_focused_app_pid() -> Option<i32> {
        unsafe {
            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return None;
            }
            let app = copy_attribute(system, "AXFocusedApplication");
            CFRelease(system);
            let app = app?;
            let mut pid = 0i32;
            let ok = AXUIElementGetPid(app, &mut pid) == 0;
            CFRelease(app);
            (ok && pid > 0).then_some(pid)
        }
    }

    fn dict_number(element: CFTypeRef, key: &str) -> Option<i64> {
        unsafe {
            let dict = CFDictionary::<CFString, CFTypeRef>::wrap_under_get_rule(element as CFDictionaryRef);
            let value = dict.find(CFString::new(key).as_concrete_TypeRef())?;
            CFNumber::wrap_under_get_rule(*value as CFNumberRef).to_i64()
        }
    }

    /// 屏幕上最前面那扇「普通窗口」的主人（layer 0，跳过自己与桌面元素）
    fn visible_front_pid() -> Option<i32> {
        unsafe {
            let list = CGWindowListCopyWindowInfo(WINDOW_LIST_OPTION, 0);
            if list.is_null() {
                return None;
            }
            let array = CFArray::<CFTypeRef>::wrap_under_create_rule(list as CFArrayRef);
            let me = std::process::id() as i32;
            for item in array.iter() {
                if dict_number(*item, "kCGWindowLayer") != Some(0) {
                    continue;
                }
                let pid = dict_number(*item, "kCGWindowOwnerPID")? as i32;
                if pid != me {
                    return Some(pid);
                }
            }
            None
        }
    }

    /// 可以在任何线程调的静默权限判断（不弹系统引导）：预热线程用
    fn trusted_quiet() -> bool {
        let trusted = unsafe { AXIsProcessTrusted() };
        if trusted {
            TRUSTED.store(1, Ordering::Relaxed);
        }
        trusted
    }

    /// 从 system-wide 元素一路读到 `AXSelectedText`；失败给出 reason，
    /// 并**无论成败**都返回焦点元素所属 pid（它是「该增强哪个应用」的唯一线索）。
    fn read_focused_text() -> (Value, Option<i32>) {
        unsafe {
            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return (json!({ "ok": false, "reason": "unavailable" }), None);
            }
            let focused = copy_attribute(system, "AXFocusedUIElement");
            CFRelease(system);
            let Some(focused) = focused else {
                return (json!({ "ok": false, "reason": "no-focus" }), None);
            };
            let mut pid = 0i32;
            let pid = (AXUIElementGetPid(focused, &mut pid) == 0 && pid > 0).then_some(pid);
            let selected = copy_attribute(focused, "AXSelectedText");
            CFRelease(focused);
            let Some(selected) = selected else {
                return (json!({ "ok": false, "reason": "empty" }), pid);
            };
            // wrap_under_create_rule：接管这个 +1 引用，drop 时自动 release
            let text = CFString::wrap_under_create_rule(selected as CFStringRef).to_string();
            if text.trim().is_empty() {
                return (json!({ "ok": false, "reason": "empty" }), pid);
            }
            (json!({ "ok": true, "text": text }), pid)
        }
    }

    pub fn read_selection() -> Value {
        let (value, pid_from_focus) = read_focused_text();
        if value.get("ok").and_then(Value::as_bool) == Some(true) {
            return value;
        }
        // pid 不能只靠焦点元素：Chromium 系没建 AX 树时连焦点元素都问不出来，
        // 而「该给谁开增强」只缺一个 pid —— 只用前者就成了死锁。所以再问一次前台 App。
        let pid = pid_from_focus.or_else(frontmost_pid);
        let reason = value.get("reason").and_then(Value::as_str).unwrap_or("未知");
        let Some(pid) = pid else {
            log_miss_once(None, reason);
            return value;
        };
        // 前台已经是自己（窗口已上屏）时没什么可增强的
        if pid == std::process::id() as i32 {
            return value;
        }
        if !activate(pid) {
            log_miss_once(Some(pid), reason);
            return value;
        }
        for _ in 0..RETRY_TIMES {
            std::thread::sleep(Duration::from_millis(RETRY_INTERVAL_MS));
            let (retry, _) = read_focused_text();
            if retry.get("ok").and_then(Value::as_bool) == Some(true) {
                return retry;
            }
        }
        log_miss_once(Some(pid), &format!("已开增强仍 {reason}"));
        value
    }

    pub fn read(app: &AppHandle, prompt: bool) -> Value {
        if !ensure_trusted(app, prompt) {
            return json!({ "ok": false, "reason": "denied" });
        }
        // 读取本身不要求主线程（要主线程的只有 `ensure_trusted` 里的授权引导）：
        // 放在调用线程上，重试那 ~90ms 就不会把 GUI 事件循环一起拖住
        read_selection()
    }

    /// 前台 App 一换就把它的 AX 增强打开（后台轮询，零依赖）。
    ///
    /// 为什么值得：`read_selection` 里的重试预算只有 ~90ms，而 Chromium 建树常常更慢 ——
    /// 预热之后「第一次在 Chrome / VS Code 里按热键」也不吃这次等待。
    pub fn start_prewarm() {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_millis(PREWARM_INTERVAL_MS));
            if !trusted_quiet() {
                continue;
            }
            let Some(pid) = frontmost_pid() else { continue };
            // 窗口显示时前台是自己；对自己写增强属性毫无意义
            if pid == std::process::id() as i32 {
                continue;
            }
            activate(pid);
        });
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

/// 启动后台预热线程（见 `imp::start_prewarm`）。
///
/// 只有 macOS 需要：那边的「Chromium 系默认不建 AX 树」要靠外部工具主动开开关；
/// 其它平台读选区不依赖任何应用侧开关，直接返回。
pub fn start_prewarm() {
    #[cfg(target_os = "macos")]
    imp::start_prewarm();
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
