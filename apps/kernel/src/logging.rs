//! 日志：一律走 stderr，格式 `[kernel:<level>] ...`（stdout 是壳的 JSON-RPC 通道，不能污染）。
//!
//! 与 v1（`main.ts` 把 console 全重定向到 stderr）等价；日志格式是排障接口，刻意保持稳定。

use std::io::Write;

pub fn emit(level: &str, message: &str) {
    let stderr = std::io::stderr();
    let mut handle = stderr.lock();
    let _ = writeln!(handle, "[kernel:{level}] {message}");
}

#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => { $crate::logging::emit("info", &format!($($arg)*)) };
}

#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => { $crate::logging::emit("warn", &format!($($arg)*)) };
}

#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => { $crate::logging::emit("error", &format!($($arg)*)) };
}

#[macro_export]
macro_rules! log_debug {
    ($($arg:tt)*) => { $crate::logging::emit("debug", &format!($($arg)*)) };
}
