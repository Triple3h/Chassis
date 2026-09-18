//! Everything IPC 后端（**可选加速件**，m5 计划 §B2.6 步骤 3）。
//!
//! 定位：用户已经装了 [Everything](https://www.voidtools.com/)（Windows 上最常用的全盘搜索，
//! 索引由它自己维护、走 NTFS USN，毫秒级）⇒ 我们**复用它**，不重复建一份索引。
//! 探不到 / 查询失败 / 超时 ⇒ 静默返回 `None`，调用方回退自建索引（`index.rs`）。
//!
//! ## 为什么是纯代码而不是随包带官方 SDK DLL
//!
//! plugin-spec 的 N2 要求逻辑层产物**自包含**（不得依赖同目录其它文件），而 Everything 的
//! IPC 协议是以 `ipc/everything_ipc.h` 形式**源码级公开**的（窗口类名、消息号、`#pragma pack(1)`
//! 结构全有定义）⇒ 直接按协议实现：不引第三方二进制、不动 spec、不额外加体积。
//!
//! ## 协议摘要（Everything 1.4+）
//!
//! - **探测**：`FindWindowW("EVERYTHING_TASKBAR_NOTIFICATION")`；再 `SendMessageW(hwnd, WM_USER,
//!   EVERYTHING_IPC_IS_DB_LOADED(401), 0)` 确认索引库已就绪（未就绪时查询拿到空结果）。
//! - **查询**：向该窗口发 `WM_COPYDATA`，`dwData = EVERYTHING_IPC_COPYDATAQUERYW (2)`，
//!   `lpData` 指向 `EVERYTHING_IPC_QUERYW`（reply_hwnd + reply_copydata_message + search_flags
//!   + offset + max_results + 变长 UTF-16 搜索词）。**Everything 对同一窗口只认一次未完成的查询**
//!   （再发会取消上一次）⇒ 这里全程串行（`QUERY_LOCK`）。
//! - **回复**：Everything 把 `EVERYTHING_IPC_LISTW`（7 个 u32 头 + items[numitems] + 字符串池）
//!   以 `WM_COPYDATA`（`dwData` = 我们指定的 reply_copydata_message）发到 `reply_hwnd`。
//!   头文件明确要求：**必须在 WndProc 返回前把数据拷走**（`lpData` 随即失效）。
//!
//! 因此 Windows 侧需要一个专用消息窗口（独立线程跑消息循环）+ 一个自动重置事件（查询线程等回复）。
//! 迟到的回复用「每次查询递增的 tag」丢弃，避免上一次超时的回复污染这一次的结果。
//! **解析与应用侧逻辑（`parse_list` / `join_path`）是纯字节运算，跨平台编译、可在 macOS 上单测。**

#[cfg(windows)]
mod ipc {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicIsize, AtomicUsize, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM, WAIT_OBJECT_0};
    use windows::Win32::System::DataExchange::COPYDATASTRUCT;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, FindWindowW, GetMessageW, RegisterClassW, SendMessageW, TranslateMessage,
        MSG, WNDCLASSW, WM_COPYDATA, WM_USER, WINDOW_EX_STYLE, WINDOW_STYLE,
    };

    use super::{parse_list, EVERYTHING_WNDCLASS, REPLY_WNDCLASS};

    /// `EVERYTHING_IPC_COPYDATAQUERYW`
    const COPYDATA_QUERY_W: usize = 2;
    /// `EVERYTHING_IPC_IS_DB_LOADED`
    const IPC_IS_DB_LOADED: usize = 401;
    /// 回复 tag 基址（高位固定，低位放查询序号 —— 用于丢弃迟到回复）
    const REPLY_TAG_BASE: usize = 0x4348_5000_0000;
    /// 单次查询的等待上限：Everything 在内存里查，正常是毫秒级
    const QUERY_TIMEOUT_MS: u32 = 3000;
    /// 每次向 Everything 要的结果条数（宿主还会再截，多要一点给打分排序留余地）
    const MAX_RESULTS: u32 = 200;
    /// 搜索词长度软上限（超长查询对 Everything 也没意义）
    pub(super) const MAX_QUERY_CHARS: usize = 200;

    /// 最近一次回复的落点（WndProc 写、查询线程取）
    fn reply_slot() -> &'static Mutex<Option<Vec<super::RawHit>>> {
        static SLOT: OnceLock<Mutex<Option<Vec<super::RawHit>>>> = OnceLock::new();
        SLOT.get_or_init(|| Mutex::new(None))
    }

    /// 本次查询期望的回复 tag（WndProc 比对用）
    static EXPECTED_TAG: AtomicUsize = AtomicUsize::new(0);
    /// 我们消息窗口的句柄（0 = 还没建）
    static REPLY_HWND: AtomicIsize = AtomicIsize::new(0);
    /// 自动重置事件句柄（0 = 还没建）
    static REPLY_EVENT: AtomicIsize = AtomicIsize::new(0);
    /// 查询序号（每次查询 +1，拼进 tag）
    static QUERY_SEQ: AtomicUsize = AtomicUsize::new(0);
    /// 串行化查询（协议限制：Everything 对同一窗口只认一次未完成的查询）
    static QUERY_LOCK: Mutex<()> = Mutex::new(());

    fn to_wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn handle_of(raw: isize) -> HANDLE {
        HANDLE(raw as *mut c_void)
    }

    unsafe extern "system" fn reply_wnd_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if message == WM_COPYDATA {
            let cds = unsafe { &*(lparam.0 as *const COPYDATASTRUCT) };
            // tag 不匹配 = 上一次查询迟到的回复：丢掉，绝不让它污染这一次的结果
            if cds.dwData == EXPECTED_TAG.load(Ordering::SeqCst) {
                let bytes = unsafe { std::slice::from_raw_parts(cds.lpData as *const u8, cds.cbData as usize) };
                let hits = parse_list(bytes);
                *reply_slot().lock().unwrap_or_else(|err| err.into_inner()) = Some(hits);
                let event = REPLY_EVENT.load(Ordering::SeqCst);
                if event != 0 {
                    let _ = unsafe { SetEvent(handle_of(event)) };
                }
                return LRESULT(1); // TRUE = 已处理（协议要求）
            }
        }
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }

    /// 懒创建消息窗口（专用线程 + 消息循环）；失败 = None，调用方降级。
    fn ensure_window() -> Option<HWND> {
        let existing = REPLY_HWND.load(Ordering::SeqCst);
        if existing != 0 {
            return Some(HWND(existing as *mut c_void));
        }

        let (tx, rx) = std::sync::mpsc::channel::<isize>();
        std::thread::spawn(move || unsafe {
            let class = to_wide(REPLY_WNDCLASS);
            let Ok(instance) = GetModuleHandleW(PCWSTR::null()) else {
                let _ = tx.send(0);
                return;
            };
            let wc = WNDCLASSW {
                lpfnWndProc: Some(reply_wnd_proc),
                hInstance: windows::Win32::Foundation::HINSTANCE(instance.0),
                lpszClassName: PCWSTR(class.as_ptr()),
                ..Default::default()
            };
            RegisterClassW(&wc);
            let hwnd = match CreateWindowExW(
                WINDOW_EX_STYLE(0),
                PCWSTR(class.as_ptr()),
                PCWSTR(class.as_ptr()),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                None,
                None,
                Some(windows::Win32::Foundation::HINSTANCE(instance.0)),
                None,
            ) {
                Ok(hwnd) => hwnd,
                Err(_) => {
                    let _ = tx.send(0);
                    return;
                }
            };
            let raw = hwnd.0 as isize;
            REPLY_HWND.store(raw, Ordering::SeqCst);
            let _ = tx.send(raw);

            // 消息循环：只服务这一个隐藏窗口；进程退出时自然回收
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });

        match rx.recv_timeout(Duration::from_millis(2000)) {
            Ok(0) | Err(_) => None,
            Ok(raw) => Some(HWND(raw as *mut c_void)),
        }
    }

    /// 懒创建自动重置事件
    fn ensure_event() -> Option<HANDLE> {
        let existing = REPLY_EVENT.load(Ordering::SeqCst);
        if existing != 0 {
            return Some(handle_of(existing));
        }
        let handle = unsafe { CreateEventW(None, false, false, PCWSTR::null()).ok()? };
        REPLY_EVENT.store(handle.0 as isize, Ordering::SeqCst);
        Some(handle)
    }

    /// Everything 在运行且索引库就绪 ⇒ 返回它的 IPC 窗口。
    pub fn probe() -> Option<HWND> {
        unsafe {
            let class = to_wide(EVERYTHING_WNDCLASS);
            let hwnd = FindWindowW(PCWSTR(class.as_ptr()), PCWSTR::null()).ok()?;
            let loaded = SendMessageW(hwnd, WM_USER, Some(WPARAM(IPC_IS_DB_LOADED)), Some(LPARAM(0)));
            (loaded.0 != 0).then_some(hwnd)
        }
    }

    /// 发一次 WM_COPYDATA 查询并等结果；超时 / 不支持 / 任何异常都返回 None。
    pub fn query_raw(hwnd: HWND, needle: &str) -> Option<Vec<super::RawHit>> {
        let _guard = QUERY_LOCK.lock().unwrap_or_else(|err| err.into_inner());
        let our_hwnd = ensure_window()?;
        let event = ensure_event()?;

        let seq = QUERY_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
        let tag = REPLY_TAG_BASE | (seq & 0xFFFF_FFFF);
        EXPECTED_TAG.store(tag, Ordering::SeqCst);
        *reply_slot().lock().unwrap_or_else(|err| err.into_inner()) = None;
        // 把可能已被上一次置位的事件消费掉，免得这次白等
        unsafe { WaitForSingleObject(event, 0) };

        // ── 拼 EVERYTHING_IPC_QUERYW（#pragma pack(1)：5 个 u32 + 变长 UTF-16 搜索词）──
        let text: String = needle.chars().take(MAX_QUERY_CHARS).collect();
        let mut payload: Vec<u8> = Vec::with_capacity(32 + text.len() * 2);
        payload.extend_from_slice(&(our_hwnd.0 as usize as u32).to_le_bytes()); // reply_hwnd
        payload.extend_from_slice(&(tag as u32).to_le_bytes()); // reply_copydata_message
        payload.extend_from_slice(&0u32.to_le_bytes()); // search_flags（不区分大小写 / 不整词 / 不含路径）
        payload.extend_from_slice(&0u32.to_le_bytes()); // offset
        payload.extend_from_slice(&MAX_RESULTS.to_le_bytes()); // max_results
        for unit in text.encode_utf16() {
            payload.extend_from_slice(&unit.to_le_bytes());
        }
        payload.extend_from_slice(&0u16.to_le_bytes()); // 终止符

        let mut cds = COPYDATASTRUCT {
            dwData: COPYDATA_QUERY_W,
            cbData: payload.len() as u32,
            lpData: payload.as_mut_ptr() as *mut c_void,
        };

        unsafe {
            let sent = SendMessageW(
                hwnd,
                WM_COPYDATA,
                Some(WPARAM(our_hwnd.0 as usize)),
                Some(LPARAM(&mut cds as *mut COPYDATASTRUCT as isize)),
            );
            // Everything 返回 FALSE = 不支持这种查询
            if sent.0 == 0 {
                return None;
            }
            if WaitForSingleObject(event, QUERY_TIMEOUT_MS) != WAIT_OBJECT_0 {
                return None;
            }
        }

        reply_slot().lock().unwrap_or_else(|err| err.into_inner()).take()
    }
}

/// Everything 通知窗口的类名（`EVERYTHING_IPC_WNDCLASSW`）
#[cfg(windows)]
const EVERYTHING_WNDCLASS: &str = "EVERYTHING_TASKBAR_NOTIFICATION";
/// 我们自己的消息窗口类名
#[cfg(windows)]
const REPLY_WNDCLASS: &str = "ChassisFileSearchEverythingIpc";

/// 解析结果用：`(文件名, 所在目录)`
pub type RawHit = (String, String);

/// 用 Everything 搜文件名；返回 `None` = 后端不可用（调用方回退自建索引）。
pub fn search(query: &str, limit: usize) -> Option<Vec<crate::FileHit>> {
    let needle = query.trim().to_lowercase();
    if needle.chars().count() < 2 {
        return Some(Vec::new());
    }

    #[cfg(windows)]
    {
        let hwnd = ipc::probe()?;
        let raw = ipc::query_raw(hwnd, &needle)?;
        let mut hits: Vec<crate::FileHit> = raw
            .into_iter()
            .map(|(name, folder)| {
                let path = join_path(&folder, &name);
                let score = crate::score_of(&name.to_lowercase(), &needle);
                crate::FileHit { path, name, score }
            })
            .collect();
        crate::index::sort_hits(&mut hits);
        hits.truncate(limit);
        Some(hits)
    }
    #[cfg(not(windows))]
    {
        let _ = (needle, limit);
        None
    }
}

// ── 结果解析（纯字节逻辑，跨平台）──────────────────────────────

/// 解析 `EVERYTHING_IPC_LISTW`：
/// ```text
/// [0] totfolders [1] totfiles [2] totitems [3] numfolders [4] numfiles [5] numitems [6] offset
/// items[numitems]: { flags, filename_offset, path_offset }   // 各 u32，相对 list 起点
/// 字符串池：UTF-16LE，以 NUL 结尾
/// ```
pub fn parse_list(bytes: &[u8]) -> Vec<RawHit> {
    const HEADER: usize = 7 * 4;
    const ITEM: usize = 3 * 4;
    if bytes.len() < HEADER {
        return Vec::new();
    }
    let num_items = read_u32(bytes, 20) as usize; // 字段 5 = numitems
    let mut out = Vec::new();
    for index in 0..num_items {
        let at = HEADER + index * ITEM;
        if at + ITEM > bytes.len() {
            break;
        }
        let name = read_utf16_at(bytes, read_u32(bytes, at + 4) as usize);
        let folder = read_utf16_at(bytes, read_u32(bytes, at + 8) as usize);
        if name.is_empty() {
            continue;
        }
        out.push((name, folder));
    }
    out
}

fn read_u32(bytes: &[u8], at: usize) -> u32 {
    match bytes.get(at..at + 4) {
        Some(chunk) => u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]),
        None => 0,
    }
}

/// 读 offset 处的 UTF-16LE 字符串（到 NUL 或数据末尾）
fn read_utf16_at(bytes: &[u8], at: usize) -> String {
    if at >= bytes.len() {
        return String::new();
    }
    let mut units: Vec<u16> = Vec::new();
    let mut cursor = at;
    while cursor + 2 <= bytes.len() {
        let unit = u16::from_le_bytes([bytes[cursor], bytes[cursor + 1]]);
        if unit == 0 {
            break;
        }
        units.push(unit);
        cursor += 2;
    }
    String::from_utf16_lossy(&units)
}

/// Everything 的 `path` 通常带尾分隔符（`C:\Users\me\`），但也可能不带 —— 两种都拼对
#[cfg(any(windows, test))]
fn join_path(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        return name.to_string();
    }
    if folder.ends_with('\\') || folder.ends_with('/') {
        format!("{folder}{name}")
    } else {
        format!("{folder}\\{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 手工拼一个 `EVERYTHING_IPC_LISTW`：N 条结果 + 字符串池
    fn build_list(items: &[(&str, &str)]) -> Vec<u8> {
        let mut bytes = vec![0u8; 7 * 4 + items.len() * 12];
        bytes[20..24].copy_from_slice(&(items.len() as u32).to_le_bytes()); // numitems
        for (index, (name, folder)) in items.iter().enumerate() {
            let at = 28 + index * 12;
            let name_off = bytes.len() as u32;
            for unit in name.encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            bytes.extend_from_slice(&0u16.to_le_bytes());
            let folder_off = bytes.len() as u32;
            for unit in folder.encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            bytes.extend_from_slice(&0u16.to_le_bytes());
            // flags = 0（文件）；filename_offset / path_offset 相对 list 起点
            bytes[at..at + 4].copy_from_slice(&0u32.to_le_bytes());
            bytes[at + 4..at + 8].copy_from_slice(&name_off.to_le_bytes());
            bytes[at + 8..at + 12].copy_from_slice(&folder_off.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn parse_list_reads_items_and_strings() {
        let payload = build_list(&[("report.pdf", "C:\\Users\\me\\Docs\\"), ("中文.md", "C:\\Users\\me\\")]);
        let hits = parse_list(&payload);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].0, "report.pdf");
        assert_eq!(hits[0].1, "C:\\Users\\me\\Docs\\");
        assert_eq!(hits[1].0, "中文.md", "UTF-16 中文要能还原");
    }

    #[test]
    fn parse_list_tolerates_truncated_and_empty() {
        assert!(parse_list(&[]).is_empty());
        assert!(parse_list(&[0u8; 12]).is_empty(), "头都不全");
        // 声称有 3 条、实际只有 1 条可读：读得到的先返回，不 panic
        let mut payload = build_list(&[("a.txt", "C:\\x\\")]);
        payload[20..24].copy_from_slice(&3u32.to_le_bytes());
        assert_eq!(parse_list(&payload).len(), 1);
        // 全零偏移不 panic
        assert!(parse_list(&vec![0u8; 7 * 4 + 2 * 12]).is_empty());
    }

    #[test]
    fn join_path_handles_trailing_separator() {
        assert_eq!(join_path("C:\\Users\\me\\", "a.txt"), "C:\\Users\\me\\a.txt");
        assert_eq!(join_path("C:\\Users\\me", "a.txt"), "C:\\Users\\me\\a.txt");
        assert_eq!(join_path("", "a.txt"), "a.txt");
    }

    #[test]
    fn short_queries_do_not_touch_ipc() {
        // <2 字符：不查（与其它后端同一门槛）
        assert_eq!(search("a", 8).map(|hits| hits.len()), Some(0));
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_reports_backend_unavailable() {
        // 非 Windows 平台没有 Everything：后端必须如实报"不可用"，而不是空结果
        assert!(search("report", 8).is_none());
    }
}
