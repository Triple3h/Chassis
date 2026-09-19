//! 终止进程：默认优雅（SIGTERM / 无 `/F` 的 taskkill），只有显式 `force` 才强杀。
//!
//! 安全边界（这一层是最后一道闸，界面上的灰按钮不算）：
//! 1. **保护名单复检**：`Risk::Blocked` 一律拒绝，**提权也不行**（否则 UI 绕过 = 保护失效）；
//! 2. **不默认强杀**：先发可被应用处理的终止信号，等它自己收尾；用户确认「仍在运行」后才强杀；
//! 3. **提权只走系统对话框**（macOS `osascript … with administrator privileges` /
//!    Windows `Start-Process -Verb RunAs`），不自己存密码、不静默提权；
//! 4. **权限不足时给可操作的两条路**：复制等价命令自行执行 / 点「以管理员身份终止」。
//!
//! 平台差异：
//! - Unix：`kill(2)` 发 SIGTERM / SIGKILL，`kill(pid, 0)` 探活（EPERM 也算活着）；
//! - Windows：`taskkill /PID`（发 WM_CLOSE / 控制台关闭事件）与 `taskkill /PID /F`（TerminateProcess），
//!   退出码 128 = 进程不存在；失败信息原样带出去。

use std::time::{Duration, Instant};

use crate::guard::Risk;
use crate::model::KillOutcome;
use crate::procs;

/// 优雅终止后等它自己退场的时长
const GRACE_MS: u64 = 1500;
/// 强制终止后等它退场的时长
const FORCE_WAIT_MS: u64 = 1000;
/// 探活轮询间隔
const POLL_MS: u64 = 60;

#[derive(Debug, Clone)]
pub struct KillRequest {
    pub pid: i32,
    /// 强制终止（SIGKILL / `taskkill /F`）
    pub force: bool,
    /// 走系统提权对话框
    pub elevate: bool,
}

/// 平台终止的中间结果。
struct Term {
    /// 终止信号成功送达
    sent: bool,
    /// 动作之后进程仍在
    alive: bool,
    not_found: bool,
    permission_denied: bool,
    error: Option<String>,
}

pub fn execute(request: KillRequest) -> KillOutcome {
    let pid = request.pid;
    let force = request.force;
    let manual = manual_command(pid, force);

    // 目标是谁、还在不在（顺带做保护名单复检）
    let info = procs::lookup(&[pid]);
    let Some(target) = info.get(&pid) else {
        return KillOutcome {
            ok: true,
            pid,
            name: String::new(),
            force,
            elevated: false,
            alive: false,
            not_found: true,
            permission_denied: false,
            manual_command: manual,
            message: "进程已不存在（可能刚刚自己退出）".to_string(),
            error: None,
        };
    };
    let name = target.name.clone();

    if target.risk == Risk::Blocked {
        return KillOutcome {
            ok: false,
            pid,
            name: name.clone(),
            force,
            elevated: false,
            alive: true,
            not_found: false,
            permission_denied: false,
            manual_command: manual,
            message: format!("「{name}」属于受保护进程（系统关键组件或启动台自身），已拒绝终止"),
            error: None,
        };
    }

    if request.elevate {
        if let Err(err) = elevate_kill(pid, force) {
            let gone = wait_gone(pid, 300);
            return KillOutcome {
                ok: gone,
                pid,
                name: name.clone(),
                force,
                elevated: true,
                alive: !gone,
                not_found: false,
                permission_denied: false,
                manual_command: manual,
                message: format!("提权终止未完成：{err}"),
                error: Some(err),
            };
        }
        let gone = wait_gone(pid, if force { FORCE_WAIT_MS } else { GRACE_MS });
        return assemble(pid, name, force, true, Term { sent: true, alive: !gone, not_found: false, permission_denied: false, error: None }, manual);
    }

    let term = terminate(pid, force);
    assemble(pid, name, force, false, term, manual)
}

fn assemble(pid: i32, name: String, force: bool, elevated: bool, term: Term, manual: String) -> KillOutcome {
    let message = if term.not_found {
        "进程已不存在（可能刚刚自己退出）".to_string()
    } else if term.permission_denied {
        format!("权限不足：「{name}」不属于当前用户，需要管理员权限")
    } else if let Some(err) = &term.error {
        format!("终止失败：{err}")
    } else if term.sent && term.alive {
        format!("已发送{}终止信号，但「{name}」仍在运行", if force { "强制" } else { "优雅" })
    } else if term.sent {
        format!("已终止「{name}」")
    } else {
        "未知结果".to_string()
    };
    KillOutcome {
        ok: term.sent || term.not_found,
        pid,
        name,
        force,
        elevated,
        alive: term.alive,
        not_found: term.not_found,
        permission_denied: term.permission_denied,
        manual_command: manual,
        message,
        error: term.error,
    }
}

/// 需要用户手动执行时的等价命令（干净的可复制文本）。
pub fn manual_command(pid: i32, force: bool) -> String {
    if cfg!(windows) {
        if force {
            format!("taskkill /PID {pid} /F")
        } else {
            format!("taskkill /PID {pid}")
        }
    } else if force {
        format!("sudo kill -9 {pid}")
    } else {
        format!("sudo kill -TERM {pid}")
    }
}

fn wait_gone(pid: i32, timeout_ms: u64) -> bool {
    let started = Instant::now();
    let deadline = started + Duration::from_millis(timeout_ms);
    // 先给应用一点时间自己收尾（正常路径下这里就返回了），随后叠加「僵尸」判定：
    // 已终止、等着被父进程回收的进程，`kill(pid, 0)` 仍返回 0 —— 但对用户来说它就是死了。
    let mut next_zombie_check = started + Duration::from_millis(200);
    loop {
        if !pid_alive(pid) {
            return true;
        }
        let now = Instant::now();
        if now >= next_zombie_check {
            if is_zombie(pid) {
                return true;
            }
            next_zombie_check = now + Duration::from_millis(400);
        }
        if now >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(POLL_MS));
    }
}

/// 僵尸进程（已终止、等待父进程回收）。`None` = 查不到，同样按「已经不在」处理。
#[cfg(unix)]
fn is_zombie(pid: i32) -> bool {
    use sysinfo::{Pid, ProcessStatus, ProcessesToUpdate, System};
    let target = Pid::from_u32(pid.max(0) as u32);
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[target]), true);
    match sys.process(target).map(|process| process.status()) {
        Some(ProcessStatus::Zombie) | None => true,
        Some(_) => false,
    }
}

/// Windows 没有僵尸状态（进程对象随最后一个句柄关闭而消失），不需要这条修正。
#[cfg(not(unix))]
fn is_zombie(_pid: i32) -> bool {
    false
}

// ── Unix（macOS / Linux）─────────────────────────────────────────────

#[cfg(unix)]
fn send_signal(pid: i32, signal: i32) -> Result<(), i32> {
    let result = unsafe { libc::kill(pid, signal) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(-1))
    }
}

/// 探活：`kill(pid, 0)` 不投递信号，只做存在性 / 权限检查。
/// `EPERM` 说明「进程在、但你没权限」—— 也算活着。
#[cfg(unix)]
pub fn pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid, 0) };
    if result == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(unix)]
fn terminate(pid: i32, force: bool) -> Term {
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    match send_signal(pid, signal) {
        Ok(()) => {
            let gone = wait_gone(pid, if force { FORCE_WAIT_MS } else { GRACE_MS });
            Term { sent: true, alive: !gone, not_found: false, permission_denied: false, error: None }
        }
        Err(errno) if errno == libc::ESRCH => {
            Term { sent: false, alive: false, not_found: true, permission_denied: false, error: None }
        }
        Err(errno) if errno == libc::EPERM => {
            Term { sent: false, alive: true, not_found: false, permission_denied: true, error: None }
        }
        Err(errno) => Term {
            sent: false,
            alive: true,
            not_found: false,
            permission_denied: false,
            error: Some(format!("kill 系统调用失败（errno {errno}）")),
        },
    }
}

// ── Windows ──────────────────────────────────────────────────────────

#[cfg(windows)]
pub fn pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let target = Pid::from_u32(pid as u32);
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[target]), true);
    sys.process(target).is_some()
}

#[cfg(windows)]
fn terminate(pid: i32, force: bool) -> Term {
    let mut command = std::process::Command::new("taskkill");
    command.args(["/PID", &pid.to_string()]);
    if force {
        command.arg("/F");
    }
    let output = match command.output() {
        Ok(output) => output,
        Err(err) => {
            return Term {
                sent: false,
                alive: true,
                not_found: false,
                permission_denied: false,
                error: Some(format!("无法执行 taskkill：{err}")),
            }
        }
    };
    if output.status.success() {
        let gone = wait_gone(pid, if force { FORCE_WAIT_MS } else { GRACE_MS });
        return Term { sent: true, alive: !gone, not_found: false, permission_denied: false, error: None };
    }

    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = format!("{} {}", stdout.trim(), stderr.trim()).trim().to_string();
    if code == 128 || text.contains("not found") || text.contains("没有找到") {
        return Term { sent: false, alive: false, not_found: true, permission_denied: false, error: None };
    }
    let alive = pid_alive(pid);
    Term {
        sent: false,
        alive,
        not_found: false,
        // taskkill 失败的常见原因就是权限（其它情况把原始信息带出去，界面照常给提权入口）
        permission_denied: true,
        error: Some(if text.is_empty() { format!("taskkill 退出码 {code}") } else { text }),
    }
}

// ── 提权（系统自带对话框）────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn elevate_kill(pid: i32, force: bool) -> Result<(), String> {
    let flag = if force { "-9" } else { "-TERM" };
    let shell = format!("/bin/kill {flag} {pid}");
    // `serde_json` 的字符串字面量恰好是合法的 AppleScript 字符串（与 host-manager 同款技巧）
    let script = format!(
        "do shell script {} with administrator privileges",
        serde_json::to_string(&shell).unwrap_or_default()
    );
    let output = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|err| format!("无法调起 osascript：{err}"))?;
    if output.status.success() {
        return Ok(());
    }
    let text = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(describe_macos_elevation_error(&text))
}

#[cfg(target_os = "macos")]
fn describe_macos_elevation_error(text: &str) -> String {
    if text.contains("User canceled") || text.contains("-128") {
        "已取消系统授权".to_string()
    } else if text.is_empty() {
        "系统授权失败".to_string()
    } else {
        text.to_string()
    }
}

#[cfg(windows)]
fn elevate_kill(pid: i32, force: bool) -> Result<(), String> {
    let mut list = format!("'/PID','{pid}'");
    if force {
        list.push_str(",'/F'");
    }
    let script = format!(
        "$p = Start-Process -FilePath 'taskkill.exe' -Verb RunAs -Wait -PassThru -ArgumentList {list}; exit $p.ExitCode"
    );
    let encoded = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(utf16le_bytes(&script))
    };
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-EncodedCommand", &encoded])
        .output()
        .map_err(|err| format!("无法调起 powershell：{err}"))?;
    if output.status.success() {
        return Ok(());
    }
    let text = format!(
        "{} {}",
        String::from_utf8_lossy(&output.stdout).trim(),
        String::from_utf8_lossy(&output.stderr).trim()
    )
    .trim()
    .to_string();
    if text.contains("canceled") || text.contains("取消") {
        Err("已取消系统授权".to_string())
    } else if text.is_empty() {
        Err(format!("提权后执行失败（退出码 {}）", output.status.code().unwrap_or(-1)))
    } else {
        Err(text)
    }
}

#[cfg(windows)]
fn utf16le_bytes(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(|unit| unit.to_le_bytes()).collect()
}

#[cfg(not(any(target_os = "macos", windows)))]
fn elevate_kill(_pid: i32, _force: bool) -> Result<(), String> {
    Err("当前平台不支持提权终止".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_command_matches_platform() {
        let graceful = manual_command(4242, false);
        let forced = manual_command(4242, true);
        if cfg!(windows) {
            assert_eq!(graceful, "taskkill /PID 4242");
            assert_eq!(forced, "taskkill /PID 4242 /F");
        } else {
            assert_eq!(graceful, "sudo kill -TERM 4242");
            assert_eq!(forced, "sudo kill -9 4242");
        }
    }

    #[test]
    fn missing_process_reports_not_found() {
        let outcome = execute(KillRequest { pid: 999_999, force: false, elevate: false });
        assert!(outcome.not_found, "不存在的 PID 按已达成目的处理");
        assert!(outcome.ok);
        assert!(!outcome.alive);
    }

    #[test]
    fn own_process_is_refused_even_with_force_and_elevation() {
        let pid = procs::current_pid();
        for force in [false, true] {
            for elevate in [false, true] {
                let outcome = execute(KillRequest { pid, force, elevate });
                assert!(!outcome.ok, "自己（或启动台链）一律拒绝：force={force} elevate={elevate}");
                assert!(outcome.message.contains("受保护"), "消息要说清拒绝原因：{}", outcome.message);
            }
        }
    }

    #[test]
    fn pid_alive_is_accurate_for_self_and_missing() {
        assert!(pid_alive(procs::current_pid()));
        assert!(!pid_alive(999_999));
        assert!(!pid_alive(0));
    }

    #[test]
    fn wait_gone_returns_immediately_for_missing_pid() {
        let started = Instant::now();
        assert!(wait_gone(999_999, 5_000));
        assert!(started.elapsed() < Duration::from_millis(500), "不存在的进程不该等满超时");
    }

    #[cfg(unix)]
    #[test]
    fn terminate_stops_a_real_child_process() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().expect("spawn sleep");
        let pid = child.id() as i32;
        let outcome = execute(KillRequest { pid, force: false, elevate: false });
        assert!(outcome.ok, "信号应送达：{}", outcome.message);
        assert!(!outcome.alive, "sleep 收到 SIGTERM 会立即退场");
        assert!(is_zombie(pid), "此刻它是僵尸（等测试进程回收）—— 探活把它算作已终止");
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn zombie_child_counts_as_gone() {
        // 子进程被杀后我们是「不回收的父进程」，它变成僵尸（kill(pid,0) 仍返回 0）。
        // 探活必须把它算作「已经走了」，否则界面永远停在「仍在运行」。
        let mut child = std::process::Command::new("sleep").arg("30").spawn().expect("spawn sleep");
        let pid = child.id() as i32;
        let outcome = execute(KillRequest { pid, force: true, elevate: false });
        assert!(outcome.ok, "{}", outcome.message);
        assert!(!outcome.alive, "僵尸进程 = 已终止");
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn force_terminate_stops_a_stubborn_process() {
        // 忽略 SIGTERM 的进程：优雅终止时它还在，强杀才走
        let mut child = std::process::Command::new("sh")
            .args(["-c", "trap '' TERM; sleep 30"])
            .spawn()
            .expect("spawn sh");
        let pid = child.id() as i32;
        // trap 生效需要一点时间，等它进入 sleep
        std::thread::sleep(Duration::from_millis(250));

        let graceful = execute(KillRequest { pid, force: false, elevate: false });
        assert!(graceful.ok);
        assert!(graceful.alive, "忽略 SIGTERM 的进程应仍在运行");

        let forced = execute(KillRequest { pid, force: true, elevate: false });
        assert!(forced.ok);
        assert!(!forced.alive, "SIGKILL 之后进程必须消失");
        let _ = child.wait();
    }
}
