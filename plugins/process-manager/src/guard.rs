//! 保护名单：哪些进程**不许**动、哪些动了要额外警告。
//!
//! 这是进程终止的**硬底线**（后端复检，不只靠界面灰按钮）：
//! - `Blocked`：系统关键进程（launchd / kernel_task / WindowServer / csrss / lsass …）、
//!   PID ≤ 1（0 = 调度器、1 = init/launchd）、启动台自身这条链（壳 `Chassis` / 内核
//!   `launcher-kernel` / 本插件进程）—— 一律拒绝，提权也不行。
//! - `Caution`：系统界面组件（Finder / Dock / explorer / dwm …），允许终止但界面要二次确认
//!   （它们通常会自己重启，但会闪一下、可能丢失未保存状态）。
//! - `Safe`：普通用户进程。

pub const RISK_SAFE: &str = "safe";
pub const RISK_CAUTION: &str = "caution";
pub const RISK_BLOCKED: &str = "blocked";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Risk {
    Safe,
    Caution,
    Blocked,
}

impl Risk {
    pub fn as_str(self) -> &'static str {
        match self {
            Risk::Safe => RISK_SAFE,
            Risk::Caution => RISK_CAUTION,
            Risk::Blocked => RISK_BLOCKED,
        }
    }
}

/// 进程名归一化：取末段路径、去掉 `.exe`、转小写 —— 让两端的名字能对上同一个名单。
pub fn normalize_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let lower = base.to_ascii_lowercase();
    lower.strip_suffix(".exe").map(str::to_string).unwrap_or(lower)
}

/// 任何平台都不许动的 PID：
/// - 0 / 1 = 调度器与 init（launchd）；
/// - Windows 的 4 = System（内核 EPROCESS 的宿主）。
pub fn pid_blocked(pid: i32) -> bool {
    if pid <= 1 {
        return true;
    }
    cfg!(windows) && pid == 4
}

/// 系统关键进程：终止它们会立刻毁掉会话（登录 / 图形栈 / 安全子系统）。
pub fn critical_names() -> &'static [&'static str] {
    if cfg!(target_os = "macos") {
        &["launchd", "kernel_task", "windowserver", "loginwindow", "opendirectoryd"]
    } else if cfg!(windows) {
        &[
            "system",
            "idle",
            "registry",
            "memory compression",
            "secure system",
            "smss",
            "csrss",
            "wininit",
            "services",
            "lsass",
            "winlogon",
            "audiodg",
        ]
    } else {
        &["systemd", "init", "kthreadd"]
    }
}

/// 系统界面组件：允许终止，但界面必须二次确认（会自己重启，期间界面闪断）。
pub fn caution_names() -> &'static [&'static str] {
    if cfg!(target_os = "macos") {
        &["finder", "dock", "systemuiserver", "mds", "mds_stores", "coreaudiod", "cfprefsd"]
    } else if cfg!(windows) {
        &[
            "explorer",
            "dwm",
            "svchost",
            "taskhostw",
            "ctfmon",
            "sihost",
            "fontdrvhost",
            "runtimebroker",
            "searchhost",
            "startmenuexperiencehost",
            "shellexperiencehost",
            "textinputhost",
            "widgets",
            "widgetservice",
        ]
    } else {
        &["gnome-shell", "plasmashell", "Xorg", "pulseaudio"]
    }
}

/// 启动台自身这条链上的进程名（壳与内核；本插件进程另有 PID 比对）。
pub const LAUNCHER_NAMES: &[&str] = &["chassis", "launcher-kernel", "launcher"];

pub fn is_launcher_process(name: &str) -> bool {
    let normalized = normalize_name(name);
    LAUNCHER_NAMES.contains(&normalized.as_str())
}

/// 综合评估：PID 底线 + 自身链 + 名字名单。
///
/// 自身链判两遍：调用方算好的 `self_related`（能覆盖本插件自己的 PID）
/// **以及**这里按名字再查一次 —— 保护判断不能依赖调用方记得传对参数。
pub fn evaluate(pid: i32, name: &str, self_related: bool) -> Risk {
    if pid_blocked(pid) || self_related || is_launcher_process(name) {
        return Risk::Blocked;
    }
    let normalized = normalize_name(name);
    if critical_names().contains(&normalized.as_str()) {
        return Risk::Blocked;
    }
    if caution_names().contains(&normalized.as_str()) {
        return Risk::Caution;
    }
    Risk::Safe
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pid_floor_is_always_blocked() {
        assert!(pid_blocked(0));
        assert!(pid_blocked(1));
        assert!(pid_blocked(-4));
        assert!(!pid_blocked(4242));
    }

    #[test]
    fn launcher_chain_is_blocked() {
        assert_eq!(evaluate(1234, "Chassis", false), Risk::Blocked);
        assert_eq!(evaluate(1234, "launcher-kernel", false), Risk::Blocked);
        assert_eq!(evaluate(1234, "proc-kill", true), Risk::Blocked, "自报自身链一律拒绝");
    }

    #[test]
    fn normalize_strips_path_and_exe() {
        assert_eq!(normalize_name("/usr/sbin/mDNSResponder"), "mdnsresponder");
        assert_eq!(normalize_name("C:\\Windows\\System32\\csrss.exe"), "csrss");
        assert_eq!(normalize_name("node"), "node");
    }

    #[test]
    fn critical_and_caution_are_separated() {
        let critical = if cfg!(target_os = "macos") { "kernel_task" } else { "lsass.exe" };
        assert_eq!(evaluate(99, critical, false), Risk::Blocked);
        let caution = if cfg!(target_os = "macos") { "Finder" } else { "explorer.exe" };
        assert_eq!(evaluate(99, caution, false), Risk::Caution);
        assert_eq!(evaluate(99, "node", false), Risk::Safe);
    }

    #[test]
    fn names_are_case_insensitive() {
        assert_eq!(evaluate(99, "WindowServer", false), Risk::Blocked);
        assert_eq!(evaluate(99, "windowserver", false), Risk::Blocked);
        assert_eq!(evaluate(99, "WINDOWSERVER", false), Risk::Blocked);
    }
}
