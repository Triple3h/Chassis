//! 自身占用原语（requirements §6.1 `app.usage`）：
//! 壳进程当前的**常驻内存**与**累计 CPU 时间**。
//!
//! 状态条要回答的是"启动台一共占了多少"（用户判断轻不轻），而那是两个进程之和：
//! 内核只能报自己那一半，另一半（Tauri 壳）只有壳自己看得见 —— 于是有这个原语。
//!
//! 实现只用一次 `task_info(MACH_TASK_BASIC_INFO)`：
//!  - `resident_size` → 当前常驻内存（bytes），
//!  - `user_time` + `system_time` → 累计 CPU 时间（mach time_value，秒 + 微秒）。
//! CPU 给的是**累计值**，由调用方按墙钟差分（这样任何采样间隔都算得准）。
//!
//! 口径说明：WKWebView 的渲染进程是系统托管的独立进程（不属于壳），这里统计不到；
//! 状态条的 tooltip 会把"不含系统渲染进程"写清楚，避免用户把这个数字当成全部。

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

pub fn usage() -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        match imp::read() {
            Some((rss, cpu_ms)) => Ok(json!({ "ok": true, "rss": rss, "cpuMs": cpu_ms })),
            None => {
                if !WARNED.swap(true, Ordering::Relaxed) {
                    log("[usage] 读自身占用失败（task_info 出错）：状态条只能报内核那一半");
                }
                Ok(json!({ "ok": false, "reason": "unavailable" }))
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(json!({ "ok": false, "reason": "unsupported" }))
    }
}
