//! 进程与端口（process-manager）逻辑层：端口占用扫描 / 进程信息 / 安全终止。
//!
//! 形态：**view（Vue 面板）+ 4 个 script 命令**（`port-list` / `proc-list` / `proc-detail` /
//! `proc-kill`），逻辑全在这里，`src/bin/*` 只是 `ctx.done` 胶水。
//!
//! 跨平台（macOS + Windows 一致可用）：
//! - 端口扫描：macOS 走 `lsof -F`（字段模式），Windows 走 `netstat -ano`（见 `scan.rs`）；
//! - 进程信息：`sysinfo`（与内核状态条同款依赖）；
//! - 终止：Unix 走 `kill(2)`，Windows 走 `taskkill`；权限不足时引导复制命令或走系统提权对话框。
//!
//! 调研说明（为什么这么选）：同类开源项目（port-killer 5.1k★ / killport / fkill）都是**独立应用**
//! （原生 UI 或 CLI 交互），没有可直接嵌进启动台插件的库；可复用的是它们验证过的产品设计
//! （保护端口、二次确认、优雅 → 强制两段式）与底层做法（`lsof` / `netstat` + `sysinfo`），
//! 实现按本仓库插件规范重写。

pub mod guard;
pub mod kill;
pub mod model;
pub mod procs;
pub mod scan;

pub use scan::{SCOPE_ALL, SCOPE_LISTEN};

/// 平台标识（与宿主 `HostInfo.platform` 同口径：darwin / win32 / linux）
pub fn platform_string() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    }
}

/// 当前时刻（epoch 毫秒），随响应带回界面做「扫描于 xx:xx」。
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}
