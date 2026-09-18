//! 自身占用原语（requirements §6.1 `app.usage`）：
//! 壳进程当前的**常驻内存**与**累计 CPU 时间**。
//!
//! 状态条要回答的是"启动台一共占了多少"（用户判断轻不轻），而那是两个进程之和：
//! 内核只能报自己那一半，另一半（壳这一侧）只有壳自己看得见 —— 于是有这个原语。
//!
//! **macOS**：一次 `task_info(MACH_TASK_BASIC_INFO)` 拿到常驻内存与累计 CPU。
//! 口径说明：WKWebView 的渲染进程是系统托管的独立进程（不属于壳），这里统计不到；
//! 状态条的 tooltip 会把"不含系统渲染进程"写清楚，避免用户把这个数字当成全部。
//!
//! **Windows**：`GetProcessMemoryInfo` + `GetProcessTimes` 读自己，再把挂在壳下面的
//! 整棵 `msedgewebview2.exe` 进程子树一起求和 —— WebView2 是**系统托管的独立进程组**，
//! 对用户来说就是"启动台那个窗口"，漏掉它这一侧的内存会被严重低估（渲染是大头）。
//!
//! CPU 给的都是**累计值**，由调用方按墙钟差分（这样任何采样间隔都算得准）。

use crate::logging::log;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};

/// 读失败只报一次：这个原语每 3 秒被问一次，刷屏比没有日志更糟
static WARNED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
mod imp {
    /// mach 的 `MACH_TASK_BASIC_INFO`（flavor 20）与其字段数
    const MACH_TASK_BASIC_INFO: u32 = 20;
    /// `sizeof(mach_task_basic_info_data_t) / sizeof(natural_t)` = 48 / 4 = 12。
    /// **写错这一项 task_info 直接报错**（实测填 10 ⇒ 拿不到任何数据、状态条里壳那一半恒为 0）。
    const MACH_TASK_BASIC_INFO_COUNT: u32 = 12;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct TimeValue {
        seconds: i32,
        microseconds: i32,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct MachTaskBasicInfo {
        virtual_size: u64,
        resident_size: u64,
        resident_size_max: u64,
        user_time: TimeValue,
        system_time: TimeValue,
        policy: i32,
        suspend_count: i32,
    }

    extern "C" {
        /// libSystem 里的 mach 端口变量（`mach_task_self_`，注意结尾下划线）
        static mach_task_self_: u32;
        fn task_info(task: u32, flavor: u32, info: *mut i32, count: *mut u32) -> i32;
    }

    pub fn read() -> Option<(u64, u64)> {
        unsafe {
            let mut info = MachTaskBasicInfo::default();
            let mut count = MACH_TASK_BASIC_INFO_COUNT;
            let ret = task_info(
                mach_task_self_,
                MACH_TASK_BASIC_INFO,
                &mut info as *mut MachTaskBasicInfo as *mut i32,
                &mut count,
            );
            // 只看 kern_return_t：有的系统版本会写回一个"字段更多"的 count，不该因此判失败
            if ret != 0 {
                return None;
            }
            let cpu_ms = (info.user_time.seconds as u64 + info.system_time.seconds as u64) * 1000
                + (info.user_time.microseconds.max(0) as u64 + info.system_time.microseconds.max(0) as u64) / 1000;
            Some((info.resident_size, cpu_ms))
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::collections::{HashMap, HashSet};

    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    /// WebView2 的进程名（browser / renderer / gpu / utility 都叫这个）
    const WEBVIEW_PROCESS: &str = "msedgewebview2.exe";

    fn filetime_ms(value: FILETIME) -> u64 {
        (((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64) / 10_000
    }

    fn rss_of(process: HANDLE) -> Option<u64> {
        let mut counters = PROCESS_MEMORY_COUNTERS::default();
        unsafe {
            GetProcessMemoryInfo(process, &mut counters, std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32).ok()?;
        }
        Some(counters.WorkingSetSize as u64)
    }

    fn exe_name(entry: &PROCESSENTRY32W) -> String {
        let end = entry.szExeFile.iter().position(|unit| *unit == 0).unwrap_or(entry.szExeFile.len());
        String::from_utf16_lossy(&entry.szExeFile[..end])
    }

    /// 进程表快照：pid → (父 pid, 进程名)。表很小（几百条），每次采样重取一遍最省心。
    fn process_table() -> HashMap<u32, (u32, String)> {
        let mut table = HashMap::new();
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return table;
            };
            let mut entry = PROCESSENTRY32W::default();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snapshot, &mut entry).is_ok();
            while ok {
                table.insert(entry.th32ProcessID, (entry.th32ParentProcessID, exe_name(&entry)));
                ok = Process32NextW(snapshot, &mut entry).is_ok();
            }
            let _ = CloseHandle(snapshot);
        }
        table
    }

    /// 挂在壳下面的整棵 WebView2 子树的内存之和（读不到的进程静默跳过）。
    fn webview_tree_rss(self_pid: u32, table: &HashMap<u32, (u32, String)>) -> u64 {
        // 从壳出发一层层往下认：browser 进程的父进程是壳，renderer / gpu 的父进程又是 browser
        let mut owned: HashSet<u32> = HashSet::new();
        owned.insert(self_pid);
        loop {
            let mut grown = false;
            for (pid, (parent, name)) in table {
                if owned.contains(pid) || name != WEBVIEW_PROCESS {
                    continue;
                }
                if owned.contains(parent) {
                    owned.insert(*pid);
                    grown = true;
                }
            }
            if !grown {
                break;
            }
        }

        let mut total = 0u64;
        for pid in owned.iter().filter(|pid| **pid != self_pid) {
            unsafe {
                // 只读内存用量：QUERY_LIMITED + VM_READ 就够（同用户进程可读）
                if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, *pid) {
                    if let Some(rss) = rss_of(handle) {
                        total += rss;
                    }
                    let _ = CloseHandle(handle);
                }
            }
        }
        total
    }

    pub fn read() -> Option<(u64, u64)> {
        unsafe {
            let current = GetCurrentProcess();
            let mut counters = PROCESS_MEMORY_COUNTERS::default();
            GetProcessMemoryInfo(current, &mut counters, std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32).ok()?;

            let mut creation = FILETIME::default();
            let mut exit = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            GetProcessTimes(current, &mut creation, &mut exit, &mut kernel, &mut user).ok()?;
            let cpu_ms = filetime_ms(kernel) + filetime_ms(user);

            let self_pid = GetCurrentProcessId();
            let table = process_table();
            let rss = counters.WorkingSetSize as u64 + webview_tree_rss(self_pid, &table);
            Some((rss, cpu_ms))
        }
    }
}

pub fn usage() -> Result<Value, String> {
    #[cfg(any(target_os = "macos", windows))]
    {
        match imp::read() {
            Some((rss, cpu_ms)) => Ok(json!({ "ok": true, "rss": rss, "cpuMs": cpu_ms })),
            None => {
                if !WARNED.swap(true, Ordering::Relaxed) {
                    log("[usage] 读自身占用失败：状态条只能报内核那一半");
                }
                Ok(json!({ "ok": false, "reason": "unavailable" }))
            }
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Ok(json!({ "ok": false, "reason": "unsupported" }))
    }
}
