//! macOS 后端：驱动系统 `screencapture`（录制 `-v` / 截图），CoreGraphics 查屏幕录制权限。
//!
//! 为什么继续用 `screencapture` 而不是自己接 ScreenCaptureKit / AVFoundation：
//! 它是系统自带的、随系统升级维护的编码路径（H.264 + 音频 + 点击高亮 + 交互框选全都有），
//! 插件零依赖、零权限申请之外的东西；同类开源实现（如 `screencapture -v` 系脚本、QuickRecorder
//! 之外的多数轻量工具）走的也是它。
//!
//! 停止 = 给录制进程发 **SIGINT**（等价终端 Ctrl+C，`screencapture` 会收尾并写完 moov）。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, SystemTime};

use crate::{
    ensure_dir, file_info, make_file_name, now_millis, read_log_tail, write_state, RecordOptions, RecordingState,
    ShotOptions, LOG_FILE,
};

pub const BACKEND: &str = "screencapture";

/// 启动后的探活窗口：足够覆盖「权限被拒 / 参数不被接受」这类立刻退出的失败。
/// 交互式录制（区域 / 窗口）在这个窗口里是**等用户框选**，进程活着就算成功。
const PROBE_MS: u64 = 1_500;
const PROBE_STEP_MS: u64 = 100;

/// 停止后等录制进程退场（长视频收尾写 moov 会久一点）
pub const STOP_WAIT_MS: u64 = 8_000;

// ── 后端自述 ─────────────────────────────────────────────────────────

pub fn backend_name() -> &'static str {
    BACKEND
}

/// 依赖就绪度：`screencapture` 是系统自带，永远就绪
pub fn readiness() -> (bool, String) {
    (true, String::new())
}

pub fn features() -> crate::Features {
    crate::Features {
        audio: true,
        clicks: true,
        cursor: true,
        window_recording: true,
        region_pick: true,
        delegated_shot: false,
        delay_in_interactive: false,
        notes: vec![
            "区域 / 窗口录制由系统选择框完成：这两个模式下「延迟」与「录进光标」不生效（系统限制）".into(),
            "带麦克风录制需要给 Chassis 麦克风授权：系统设置 → 隐私与安全性 → 麦克风".into(),
        ],
    }
}

// ── 录制 ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct StartInfo {
    pub state: RecordingState,
    pub args: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct StartError {
    pub code: String,
    pub message: String,
    /// 后端原始输出（诊断用）
    pub detail: String,
    /// 建议 UI 提供「改用无声录制」
    pub retry_without_audio: bool,
}

/// `screencapture` 参数（不含可执行文件本身；最后一个参数是输出路径）
pub fn record_args(options: &RecordOptions, out: &Path) -> Vec<String> {
    let mut args: Vec<String> = vec!["-v".into(), "-x".into()];
    match options.mode.as_str() {
        "region" => {
            // -i 交互式 + -s 只允许框选 + -J video 以「录视频」的方式起手
            args.push("-i".into());
            args.push("-s".into());
            args.push("-J".into());
            args.push("video".into());
        }
        "window" => {
            args.push("-i".into());
            args.push("-w".into());
            args.push("-J".into());
            args.push("video".into());
        }
        _ => {
            // 全屏：光标与延迟都只有非交互模式支持
            if options.cursor {
                args.push("-C".into());
            }
            if options.delay_sec > 0 {
                args.push("-T".into());
                args.push(options.delay_sec.to_string());
            }
        }
    }
    if options.audio {
        args.push("-g".into()); // 默认输入（麦克风）
    }
    if options.clicks {
        args.push("-k".into()); // 高亮鼠标点击
    }
    if let Some(seconds) = options.seconds {
        args.push("-V".into()); // 到时自动收尾
        args.push(seconds.to_string());
    }
    args.push(out.to_string_lossy().to_string());
    args
}

/// 拉起录制并把状态落盘。失败时返回**能查到原因**的错误（后端 stderr 摘要）。
pub fn start(options: &RecordOptions, out: &Path, data_path: &Path) -> Result<StartInfo, StartError> {
    if let Some(parent) = out.parent() {
        if let Err(err) = ensure_dir(parent) {
            return Err(StartError {
                code: "DIR_FAILED".into(),
                message: format!("创建保存目录失败：{err}"),
                detail: String::new(),
                retry_without_audio: false,
            });
        }
    }
    let args = record_args(options, out);
    let log_path = data_path.join(LOG_FILE);

    // 先写状态（pid 待探活后补）：万一我们在探活里崩了，也不会留下一段没人知道的录制
    let mut state = RecordingState {
        pid: 0,
        worker_pid: None,
        backend: BACKEND.to_string(),
        path: out.to_string_lossy().to_string(),
        started_at: now_millis(),
        mode: options.mode.clone(),
        interactive: options.interactive(),
        seconds: options.seconds,
        audio: options.audio,
        clicks: options.clicks,
        paused_at: None,
        paused_total_ms: 0,
    };
    let _ = write_state(data_path, &state);

    let mut child = match spawn(&args, &log_path) {
        Ok(child) => child,
        Err(err) => return Err(spawn_failed(err)),
    };
    let pid = child.id() as i32;
    state.pid = pid;
    if let Err(err) = write_state(data_path, &state) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(StartError {
            code: "STATE_FAILED".into(),
            message: format!("写录制状态失败：{err}"),
            detail: String::new(),
            retry_without_audio: false,
        });
    }

    // 探活：录制进程当场退场 = 这次没录起来，把后端日志里的真实原因带回去。
    //
    // **必须用 `try_wait` 而不是 `kill(pid, 0)`**：子进程退场后、被 wait 之前是**僵尸**，
    // `kill(pid, 0)` 对它照样返回 0（进程表里还有这一格）——
    // 这正是「麦克风没授权时 screencapture 秒退，界面却报『开始录制』」的根因。
    let mut waited = 0;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Err(failure_from_log(&log_path, options)),
            Ok(None) => {}
            Err(_) => {}
        }
        if waited >= PROBE_MS {
            break;
        }
        sleep(Duration::from_millis(PROBE_STEP_MS));
        waited += PROBE_STEP_MS;
    }
    drop(child); // 不 wait：录制要继续跑，脚本进程先退场
    Ok(StartInfo { state, args })
}

fn spawn(args: &[String], log_path: &Path) -> std::io::Result<std::process::Child> {
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log = std::fs::File::create(log_path)?;
    Command::new("/usr/sbin/screencapture")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .spawn()
}

fn spawn_failed(err: std::io::Error) -> StartError {
    StartError {
        code: "SPAWN_FAILED".into(),
        message: format!("拉起 screencapture 失败：{err}"),
        detail: String::new(),
        retry_without_audio: false,
    }
}

/// 录制进程当场退场：把 screencapture 的 stderr 翻译成可行动的提示
fn failure_from_log(log_path: &Path, options: &RecordOptions) -> StartError {
    let detail = read_log_tail(log_path, 400);
    let lower = detail.to_lowercase();
    // 「could not create image from display」= 屏幕录制权限没给（实测 macOS 26 的原文）
    if lower.contains("could not create image") || lower.contains("not authorized") || lower.contains("denied") {
        return StartError {
            code: "PERMISSION".into(),
            message: "系统没放行屏幕录制：到 系统设置 → 隐私与安全性 → 屏幕录制 里勾选 Chassis，然后重新打开启动台"
                .into(),
            detail,
            retry_without_audio: false,
        };
    }
    if options.audio {
        // 麦克风没授权时 screencapture 会直接收工且不产出文件，日志里未必有可读文案
        return StartError {
            code: "AUDIO_UNAVAILABLE".into(),
            message: "带麦克风录制没能起来：多半是 Chassis 还没有麦克风授权（系统设置 → 隐私与安全性 → 麦克风）"
                .into(),
            detail,
            retry_without_audio: true,
        };
    }
    StartError {
        code: "START_FAILED".into(),
        message: if detail.is_empty() {
            "screencapture 没能开始录制（这组参数不被当前系统接受）".to_string()
        } else {
            format!("screencapture 没能开始录制：{detail}")
        },
        detail,
        retry_without_audio: false,
    }
}

#[derive(Debug, Clone)]
pub struct StopOutcome {
    pub stopped: bool,
    pub still_alive: bool,
    pub error: Option<String>,
}

/// 收尾一段录制：发 SIGINT → 等它把文件写完退场 → 清状态。
/// 进程已经不在（`-V` 到时自动收尾 / 被系统收走）也算停好了 —— 停止要幂等。
pub fn stop(state: &RecordingState, data_path: &Path) -> StopOutcome {
    let alive = crate::pid_alive(state.pid);
    if alive && !is_recorder_process(state.pid) {
        // PID 被系统复用了：录制进程其实早退场，绝不能往这个 pid 上发信号
        crate::clear_state(data_path);
        return StopOutcome { stopped: true, still_alive: false, error: None };
    }
    if alive && !send_interrupt(state.pid) {
        return StopOutcome {
            stopped: false,
            still_alive: true,
            error: Some("停止失败：录制进程已经不在了（或没有权限给它发信号）".to_string()),
        };
    }

    let mut waited = 0;
    while crate::pid_alive(state.pid) && waited < STOP_WAIT_MS {
        sleep(Duration::from_millis(200));
        waited += 200;
    }
    let still_alive = crate::pid_alive(state.pid);
    if !still_alive {
        crate::clear_state(data_path);
        return StopOutcome { stopped: true, still_alive: false, error: None };
    }
    StopOutcome {
        stopped: false,
        still_alive: true,
        error: Some("录制进程还没退场（视频较长时收尾会久一点，稍后再点一次停止）".to_string()),
    }
}

/// 状态文件丢了但系统里还有 screencapture：兜底把它们收掉（否则录制停不下来）
pub fn stop_orphans(_data_path: &Path) -> usize {
    let pids = recorder_processes();
    for pid in &pids {
        send_interrupt(*pid);
    }
    let mut waited = 0;
    while waited < STOP_WAIT_MS && pids.iter().any(|pid| crate::pid_alive(*pid)) {
        sleep(Duration::from_millis(200));
        waited += 200;
    }
    pids.len()
}

/// 暂停 / 继续：`screencapture` 是系统进程，没有暂停接口，只能 SIGSTOP 冻住它。
///
/// 代价要说清：暂停期间画面**冻结在最后一帧**，而且冻结的这段仍会算进产物时长
/// （播放器把最后一帧按住到下一个关键帧）。所以界面上的计时显示的是**有效录制时长**
/// （见 `RecordingState::active_ms`），与产物时长差一个暂停时长。
pub fn apply_pause(state: &RecordingState, paused: bool) -> Result<(), String> {
    let signal = if paused { libc::SIGSTOP } else { libc::SIGCONT };
    if !send_signal(state.pid, signal) {
        return Err(if paused {
            "暂停失败：录制进程已经不在了".to_string()
        } else {
            "继续失败：录制进程已经不在了".to_string()
        });
    }
    Ok(())
}

/// 给录制进程发信号。**先验身份**：PID 会被系统复用，
/// 拿一个过期 PID 发信号等于往无关进程上捅一刀。
fn send_signal(pid: i32, signal: i32) -> bool {
    if pid <= 0 || !is_recorder_process(pid) {
        return false;
    }
    unsafe { libc::kill(pid, signal) == 0 }
}

/// 收尾 = SIGINT（等价终端 Ctrl+C）。**先 SIGCONT**：暂停中的进程收不到 SIGINT
/// （信号会一直挂着），不先解冻就会出现「点了停止但录制永远停不下来」。
pub fn send_interrupt(pid: i32) -> bool {
    if pid <= 0 || !is_recorder_process(pid) {
        return false;
    }
    unsafe {
        libc::kill(pid, libc::SIGCONT);
        libc::kill(pid, libc::SIGINT) == 0
    }
}

/// 这个 PID 现在真的是 `screencapture` 吗
pub fn is_recorder_process(pid: i32) -> bool {
    process_path(pid).is_some_and(|path| path.ends_with("/screencapture"))
}

fn process_path(pid: i32) -> Option<String> {
    if pid <= 0 {
        return None;
    }
    let mut buf = [0_u8; 4096];
    let len = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if len <= 0 {
        return None;
    }
    String::from_utf8(buf[..len as usize].to_vec()).ok()
}

/// 系统里现有的 screencapture 进程（状态文件丢了时的兜底）
pub fn recorder_processes() -> Vec<i32> {
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Vec::new();
    }
    let mut pids = vec![0_i32; count as usize + 16];
    let bytes = unsafe {
        libc::proc_listallpids(pids.as_mut_ptr().cast(), (pids.len() * std::mem::size_of::<i32>()) as i32)
    };
    if bytes <= 0 {
        return Vec::new();
    }
    let n = (bytes as usize) / std::mem::size_of::<i32>();
    pids.truncate(n);
    pids.into_iter().filter(|pid| is_recorder_process(*pid)).collect()
}

// ── 截图 ─────────────────────────────────────────────────────────────

/// `screencapture` 截图参数。`mode`：full / region / window / clipboard
pub fn shot_args(mode: &str, delay_sec: u64, cursor: bool, out: &Path) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    match mode {
        "region" => args.push("-i".into()),
        "window" => args.push("-w".into()),
        "clipboard" => args.push("-c".into()),
        _ => {}
    }
    args.push("-x".into());
    // -C 只允许非交互模式：交互式带光标是系统明确不支持的组合
    if cursor && mode == "full" {
        args.push("-C".into());
    }
    if delay_sec > 0 && mode != "clipboard" {
        args.push("-T".into());
        args.push(delay_sec.to_string());
    }
    if mode != "clipboard" {
        args.push(out.to_string_lossy().to_string());
    }
    args
}

#[derive(Debug, Clone)]
pub struct ShotInfo {
    pub path: Option<PathBuf>,
    pub size: Option<u64>,
    pub clipboard: bool,
    pub args: Vec<String>,
    /// 交给系统工具做（Windows 的窗口 / 剪贴板截图）；macOS 一律自己抓
    pub delegated: bool,
    pub note: Option<String>,
}

/// 录制子进程入口（只有 Windows 需要）
pub fn worker_entry() -> Option<i32> {
    None
}

pub fn shot(options: &ShotOptions, data_path: &Path) -> Result<ShotInfo, StartError> {
    let dir = options.target_dir();
    let clipboard = options.mode == "clipboard";
    if !clipboard {
        if let Err(err) = ensure_dir(&dir) {
            return Err(StartError {
                code: "DIR_FAILED".into(),
                message: format!("创建保存目录失败：{err}"),
                detail: String::new(),
                retry_without_audio: false,
            });
        }
    }
    let out = dir.join(make_file_name("截图", "png", SystemTime::now()));
    let args = shot_args(&options.mode, options.delay_sec, options.cursor, &out);
    let log_path = data_path.join(LOG_FILE);
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log = std::fs::File::create(&log_path).map_err(spawn_failed)?;

    let status = Command::new("/usr/sbin/screencapture")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .status()
        .map_err(spawn_failed)?;

    if clipboard {
        if status.success() {
            return Ok(ShotInfo { path: None, size: None, clipboard: true, args, delegated: false, note: None });
        }
        return Err(failure_from_log(&log_path, &RecordOptions::default()));
    }

    let info = file_info(&out);
    // 交互式截图被用户按 Esc 取消 = screencapture 非零退出且没有文件：这是正常操作，不是错误
    if info.is_none() {
        let mut err = failure_from_log(&log_path, &RecordOptions::default());
        if options.mode != "full" {
            err.code = "CANCELLED".into();
            err.message = "截图已取消".into();
        }
        return Err(err);
    }
    Ok(ShotInfo {
        path: Some(out),
        size: info.map(|(size, _)| size),
        clipboard: false,
        args,
        delegated: false,
        note: None,
    })
}

// ── 屏幕录制权限（macOS TCC）─────────────────────────────────────────

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[derive(Debug, Clone)]
pub struct Permission {
    pub supported: bool,
    pub granted: bool,
    pub requested: bool,
    pub needs_manual: bool,
    pub hint: String,
    /// 打开系统设置里对应面板的 deep link（UI 直接 shell.openUrl）
    pub settings_url: String,
}

pub fn screen_capture_granted() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

/// 触发系统授权提示（macOS 只弹一次，之后要去系统设置里手动勾）
pub fn request_screen_capture() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}

pub fn permission(request: bool) -> Permission {
    let before = screen_capture_granted();
    let mut requested = false;
    let mut granted = before;
    if request && !before {
        requested = true;
        // 系统提示是异步的：立刻再查一次，多数情况仍是 false，需要用户去设置里勾
        granted = request_screen_capture() || screen_capture_granted();
    }
    Permission {
        supported: true,
        granted,
        requested,
        needs_manual: requested && !granted,
        hint: if granted {
            String::new()
        } else {
            "到 系统设置 → 隐私与安全性 → 屏幕录制 里勾选 Chassis（勾完请退出并重新打开启动台）".into()
        },
        settings_url: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture".into(),
    }
}

/// 麦克风面板的 deep link（录制带音频失败时给用户一键跳转）
pub fn microphone_settings_url() -> &'static str {
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(mode: &str) -> RecordOptions {
        RecordOptions { mode: mode.to_string(), ..Default::default() }
    }

    #[test]
    fn full_mode_args_carry_delay_audio_clicks() {
        let mut opts = options("full");
        opts.delay_sec = 3;
        opts.audio = true;
        opts.clicks = true;
        opts.cursor = true;
        opts.seconds = Some(120);
        let args = record_args(&opts, Path::new("/tmp/a.mov"));
        assert_eq!(args, vec!["-v", "-x", "-C", "-T", "3", "-g", "-k", "-V", "120", "/tmp/a.mov"]);
    }

    #[test]
    fn region_and_window_use_interactive_video_style() {
        let region = record_args(&options("region"), Path::new("/tmp/r.mov"));
        assert_eq!(region, vec!["-v", "-x", "-i", "-s", "-J", "video", "/tmp/r.mov"]);
        let window = record_args(&options("window"), Path::new("/tmp/w.mov"));
        assert_eq!(window, vec!["-v", "-x", "-i", "-w", "-J", "video", "/tmp/w.mov"]);
    }

    #[test]
    fn interactive_modes_do_not_carry_delay_or_cursor() {
        let mut opts = options("region");
        opts.delay_sec = 10;
        opts.cursor = true;
        let args = record_args(&opts, Path::new("/tmp/r.mov"));
        assert!(!args.iter().any(|arg| arg == "-T"), "交互式不支持延迟");
        assert!(!args.iter().any(|arg| arg == "-C"), "交互式不支持光标（系统明确不支持）");
    }

    #[test]
    fn shot_args_cover_four_modes() {
        assert_eq!(shot_args("full", 0, true, Path::new("/tmp/s.png")), vec!["-x", "-C", "/tmp/s.png"]);
        assert_eq!(shot_args("region", 0, true, Path::new("/tmp/s.png")), vec!["-i", "-x", "/tmp/s.png"]);
        assert_eq!(shot_args("window", 0, false, Path::new("/tmp/s.png")), vec!["-w", "-x", "/tmp/s.png"]);
        assert_eq!(shot_args("clipboard", 5, false, Path::new("/tmp/s.png")), vec!["-c", "-x"]);
        assert_eq!(shot_args("full", 5, false, Path::new("/tmp/s.png")), vec!["-x", "-T", "5", "/tmp/s.png"]);
    }

    /// 根因回归：**探活不能用「PID 还在不在」**。
    /// 子进程退场后、被 wait 回收之前是僵尸，`kill(pid, 0)` 对它照样返回成功 ——
    /// 这正是「麦克风没授权时 screencapture 秒退，界面却报『开始录制』」的由来。
    #[test]
    fn zombie_child_fools_liveness_check_so_the_probe_needs_try_wait() {
        let mut child = Command::new("/bin/sh").arg("-c").arg("exit 7").spawn().expect("拉起 sh");
        let pid = child.id() as i32;
        sleep(Duration::from_millis(250));
        assert!(crate::pid_alive(pid), "僵尸在进程表里还占着一格：只看存活性必然误判");
        let status = child.try_wait().expect("try_wait 不该出错").expect("进程已经退场了");
        assert_eq!(status.code(), Some(7), "try_wait 才是权威判定");
    }

    #[test]
    fn interrupt_requires_the_right_process_identity() {
        // 自己不是 screencapture ⇒ 身份校验必须挡住
        assert!(!is_recorder_process(std::process::id() as i32), "本进程不是 screencapture");
        assert!(!send_interrupt(std::process::id() as i32), "身份不符时绝不发信号");
        assert!(!send_interrupt(0));
        assert!(!send_interrupt(-1));
        // pid 1（launchd）一定存在但不是 screencapture
        assert!(!send_interrupt(1));
    }

    #[test]
    fn process_path_of_self_is_a_real_path() {
        let path = process_path(std::process::id() as i32).expect("自己的可执行路径应该读得到");
        assert!(path.starts_with('/'), "proc_pidpath 返回绝对路径：{path}");
        assert!(process_path(-3).is_none());
        assert!(process_path(999_999).is_none());
    }

    #[test]
    fn recorder_processes_excludes_this_test_binary() {
        let pids = recorder_processes();
        assert!(!pids.contains(&(std::process::id() as i32)), "测试进程不该被当成录制进程");
    }

    #[test]
    fn permission_reports_a_deep_link() {
        let state = permission(false);
        assert!(state.supported);
        assert!(!state.requested, "不请求时不该动系统提示");
        assert!(state.settings_url.contains("Privacy_ScreenCapture"));
        assert!(microphone_settings_url().contains("Privacy_Microphone"));
    }
}
