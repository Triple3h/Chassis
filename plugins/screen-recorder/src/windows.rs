//! Windows 后端：`ffmpeg -f gdigrab` 录制 + 原生 GDI 截图。
//!
//! **为什么是 ffmpeg 而不是自研 DXGI + Media Foundation**
//! 自研需要 DXGI Desktop Duplication + MF SinkWriter + WASAPI 三套 COM 管线（约 700 行），
//! 而 MF 的 H.264 编码器、音频混流、多屏 / DPI 边界全都得自己趟 —— 这些正是「不稳定」的来源。
//! ffmpeg 的 `gdigrab` 是 Windows 桌面捕获的事实标准（OBS 的 window-capture / 各家录屏工具都在用），
//! 参数面小、行为可预期；代价是运行时要有 ffmpeg（未装时给明确引导，不静默失败）。
//! 参考实现：`ffmpeg` 官方 `gdigrab` / `dshow` 文档、OBS Studio 的 win-capture、`NiiightmareXD/windows-capture`
//! （后者是「将来要彻底去依赖 ffmpeg」时的 DXGI / WGC 路线）。
//!
//! **停止为什么要一个 worker 进程**
//! ffmpeg 收尾靠往它的 stdin 写 `q`（写完 moov 才是能播的 mp4）；而脚本进程 `rec-start` 必须
//! 立刻返回、随即退场 —— 一旦它退出，stdin 管道就没人握着了。所以录制由一个 detach 的
//! 录制子进程（`rec-start --worker …`，就是本文件）持有 ffmpeg，`rec-stop` 用**停止文件**通知它收尾。
//!
//! 平台差异（对 UI 是一致的契约，降级路径写在 `readiness` / `note` 里）：
//! - 鼠标点击高亮 / 窗口录制：Windows 端暂不支持（前者要低级鼠标钩子，后者要 WGC）；
//! - 窗口截图与「截图到剪贴板」交给系统截图工具（`ms-screenclip:`），不自己造窗口枚举 UI。

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, SystemTime};

use windows::core::{w, PCWSTR, PWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateDCW, CreatePen, CreateSolidBrush, DeleteDC,
    DeleteObject, EndPaint, FillRect, GetStockObject, GetSysColorBrush, InvalidateRect, SelectObject,
    SetBkMode, SetTextColor, TextOutW, UpdateWindow, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, COLOR_WINDOW,
    DIB_RGB_COLORS, HGDIOBJ, NULL_BRUSH, PAINTSTRUCT, PS_SOLID, SRCCOPY, TRANSPARENT,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, Thread32First, Thread32Next, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    OpenProcess, OpenThread, QueryFullProcessImageNameW, ResumeThread, SuspendThread, TerminateProcess,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, THREAD_SUSPEND_RESUME,
};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, GetSystemMetrics, KillTimer,
    PostQuitMessage, RegisterClassW, SetLayeredWindowAttributes, SetTimer, ShowWindow, TranslateMessage,
    UnregisterClassW, MSG, SM_CXVIRTUALSCREEN, SM_CXSCREEN, SM_CYSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN, SW_SHOW, WM_DESTROY, WM_ERASEBKGND, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE,
    WM_PAINT, WM_RBUTTONUP, WM_TIMER, WNDCLASSW, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};

use crate::ffmpeg::{self, VideoSource};
use crate::{
    clear_state, clear_stop_request, ensure_dir, file_info, make_file_name, now_millis, read_log_tail, read_state,
    request_stop, stop_requested, write_state, RecordOptions, RecordingState, ShotOptions, LOG_FILE,
};

pub const BACKEND: &str = "ffmpeg";

/// 录制子进程标志（`rec-start --worker --state <file> -- <ffmpeg.exe> <args…>`）
const WORKER_FLAG: &str = "--worker";
const STATE_FLAG: &str = "--state";

/// 等 ffmpeg 真正起来（worker 要把 pid 写回状态文件）
const WORKER_REPORT_MS: u64 = 4_000;
/// 停止时等 ffmpeg 收尾写完 moov
pub const STOP_WAIT_MS: u64 = 15_000;
const POLL_STEP_MS: u64 = 150;

/// 区域选择框的兜底超时（用户走开了也不至于挂着脚本进程）
const PICK_TIMEOUT_MS: u32 = 20_000;
const PICKER_CLASS: &str = "ChassisScreenRecorderPicker";
const PICK_TIMER_ID: usize = 1;
/// Esc 的虚拟键码（`VK_ESCAPE` 住在 Win32_UI_Input_KeyboardAndMouse，为一个常量不值得多开一个 feature）
const VK_ESCAPE_CODE: usize = 0x1B;

// ── 后端自述 ─────────────────────────────────────────────────────────

pub fn backend_name() -> &'static str {
    BACKEND
}

/// 依赖就绪度：Windows 端录制依赖 ffmpeg（截图不依赖，走原生 GDI）
pub fn readiness() -> (bool, String) {
    if detect_ffmpeg().is_some() {
        return (true, String::new());
    }
    (
        false,
        "Windows 端录制需要 ffmpeg：装一个（winget install Gyan.FFmpeg）后重启启动台即可；截图不受影响".to_string(),
    )
}

pub fn features() -> crate::Features {
    crate::Features {
        audio: true,
        clicks: false,  // 要低级鼠标钩子，暂未实现
        cursor: false,  // gdigrab 默认不录光标
        window_recording: false,
        region_pick: true,
        delegated_shot: true,
        delay_in_interactive: true,
        notes: vec![
            "录制走 ffmpeg(gdigrab)：需要本机装有 ffmpeg（winget install Gyan.FFmpeg）".into(),
            "窗口录制与点击高亮暂不支持；窗口 / 剪贴板截图交给系统截图工具".into(),
        ],
    }
}

/// 找 ffmpeg：先 PATH，再几个常见安装位置
pub fn detect_ffmpeg() -> Option<PathBuf> {
    if let Some(path) = which("ffmpeg.exe") {
        return Some(path);
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        candidates.push(local.join("Microsoft").join("WinGet").join("Links").join("ffmpeg.exe"));
        candidates.push(local.join("Programs").join("ffmpeg").join("bin").join("ffmpeg.exe"));
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        candidates.push(PathBuf::from(profile).join("scoop").join("shims").join("ffmpeg.exe"));
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("ffmpeg").join("bin").join("ffmpeg.exe"));
    }
    candidates.push(PathBuf::from("C:\\ffmpeg\\bin\\ffmpeg.exe"));
    candidates.into_iter().find(|path| path.is_file())
}

fn which(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|dir| dir.join(exe)).find(|candidate| candidate.is_file())
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
    pub detail: String,
    pub retry_without_audio: bool,
}

#[derive(Debug, Clone)]
pub struct StopOutcome {
    pub stopped: bool,
    pub still_alive: bool,
    pub error: Option<String>,
}

/// 拉起录制：探依赖 → 选区（需要时）→ 组装参数 → 派录制子进程 → 等它报回 ffmpeg pid
pub fn start(options: &RecordOptions, out: &Path, data_path: &Path) -> Result<StartInfo, StartError> {
    let Some(ffmpeg) = detect_ffmpeg() else {
        return Err(StartError {
            code: "DEPENDENCY_MISSING".into(),
            message: readiness().1,
            detail: String::new(),
            retry_without_audio: false,
        });
    };
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

    let source = match options.mode.as_str() {
        "region" => match pick_region() {
            Some(rect) => VideoSource::region((rect.right - rect.left) as u32, (rect.bottom - rect.top) as u32, rect.left, rect.top),
            None => {
                return Err(StartError {
                    code: "CANCELLED".into(),
                    message: "取消选区".into(),
                    detail: String::new(),
                    retry_without_audio: false,
                })
            }
        },
        _ => primary_source(),
    };

    // 音频设备：探不到就退回无声（降级，不是失败 —— 用户至少能拿到画面）
    let audio_device = options.audio.then(|| first_audio_device(&ffmpeg)).flatten();
    let args = ffmpeg::record_args(&source, options, audio_device.as_deref(), out);

    let mut state = RecordingState {
        pid: 0,
        worker_pid: None,
        backend: BACKEND.to_string(),
        path: out.to_string_lossy().to_string(),
        started_at: now_millis(),
        mode: options.mode.clone(),
        interactive: options.interactive(),
        seconds: options.seconds,
        audio: audio_device.is_some(),
        clicks: false, // Windows 端暂不支持点击高亮
        paused_at: None,
        paused_total_ms: 0,
    };
    let state_path = crate::state_path(data_path);
    let _ = write_state(data_path, &state);
    clear_stop_request(data_path);

    if let Err(err) = spawn_worker(&state_path, &ffmpeg, &args) {
        clear_state(data_path);
        return Err(StartError {
            code: "SPAWN_FAILED".into(),
            message: format!("拉起录制子进程失败：{err}"),
            detail: String::new(),
            retry_without_audio: false,
        });
    }

    // 等 worker 把 ffmpeg 的 pid 写回状态（它起来后第一件事就是写这个）
    let mut waited = 0;
    let mut reported = 0;
    while waited < WORKER_REPORT_MS {
        reported = read_state(data_path).map(|value| value.pid).unwrap_or(0);
        if reported > 0 {
            break;
        }
        sleep(Duration::from_millis(POLL_STEP_MS));
        waited += POLL_STEP_MS;
    }
    if reported <= 0 {
        clear_state(data_path);
        let detail = read_log_tail(&data_path.join(LOG_FILE), 400);
        return Err(StartError {
            code: "START_FAILED".into(),
            message: if detail.is_empty() {
                "ffmpeg 没能起来（参数被拒或进程被打断）".to_string()
            } else {
                format!("ffmpeg 没能起来：{detail}")
            },
            detail,
            retry_without_audio: options.audio,
        });
    }
    if !pid_alive(reported) {
        clear_state(data_path);
        let detail = read_log_tail(&data_path.join(LOG_FILE), 400);
        return Err(StartError {
            code: "START_FAILED".into(),
            message: format!("ffmpeg 起来后立刻退出了：{detail}"),
            detail,
            retry_without_audio: options.audio,
        });
    }
    state.pid = reported;
    Ok(StartInfo { state, args })
}

/// 主屏几何（物理像素；多屏时主屏原点恒为 0,0）
fn primary_source() -> VideoSource {
    set_dpi_awareness();
    unsafe { VideoSource::primary(GetSystemMetrics(SM_CXSCREEN).max(0) as u32, GetSystemMetrics(SM_CYSCREEN).max(0) as u32) }
}

/// 派录制子进程（detach，不随脚本进程退场而结束）
fn spawn_worker(state_path: &Path, ffmpeg: &Path, args: &[String]) -> std::io::Result<()> {
    let exe = std::env::current_exe()?;
    let mut command = Command::new(exe);
    command
        .arg(WORKER_FLAG)
        .arg(STATE_FLAG)
        .arg(state_path)
        .arg("--")
        .arg(ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // DETACHED_PROCESS：不要控制台窗口；BREAKAWAY_FROM_JOB：壳 / 内核若用了 Job Object，
    // 也不能让它随父进程退出而带走录制（不允许 breakaway 时回落重试，见下）
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    if command
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB)
        .spawn()
        .is_ok()
    {
        return Ok(());
    }
    Command::new(std::env::current_exe()?)
        .arg(WORKER_FLAG)
        .arg(STATE_FLAG)
        .arg(state_path)
        .arg("--")
        .arg(ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
}

/// 停止：写停止请求 → 等录制子进程给 ffmpeg 送 `q` 收尾 → 实在不退才硬杀
pub fn stop(state: &RecordingState, data_path: &Path) -> StopOutcome {
    if !state.recording_alive() {
        clear_state(data_path);
        return StopOutcome { stopped: false, still_alive: false, error: None };
    }
    if request_stop(data_path).is_err() {
        return StopOutcome {
            stopped: false,
            still_alive: true,
            error: Some("写停止请求失败（插件数据目录不可写）".to_string()),
        };
    }

    let mut waited = 0;
    while waited < STOP_WAIT_MS {
        if !pid_alive(state.pid) {
            clear_state(data_path);
            return StopOutcome { stopped: true, still_alive: false, error: None };
        }
        sleep(Duration::from_millis(POLL_STEP_MS));
        waited += POLL_STEP_MS;
    }

    // 录制子进程没反应（可能已被杀）：硬杀 ffmpeg —— 文件大概率没有 moov，播不了，如实说
    let killed = hard_kill(state.pid);
    clear_state(data_path);
    StopOutcome {
        stopped: killed,
        still_alive: pid_alive(state.pid),
        error: Some("录制没能在限期内收尾，已强制结束：文件可能不完整（建议下次用面板上的「停止」）".to_string()),
    }
}

/// 暂停 / 继续：这里**不动手**，只记账 —— 真正的冻结由录制 worker 按状态文件里的
/// `pausedAt` 挂起 / 恢复 ffmpeg 的线程（它能确保「先解冻再送 q」，命令进程保证不了）。
pub fn apply_pause(_state: &RecordingState, _paused: bool) -> Result<(), String> {
    Ok(())
}

/// 挂起 / 恢复某个进程的全部线程（暂停录制的实现：挂起的 ffmpeg 抓不到帧）。
/// 返回「有没有动到线程」；线程数对不上时下次轮询会再试一次。
fn set_suspended(pid: i32, suspended: bool) -> bool {
    if pid <= 0 {
        return false;
    }
    let mut touched = 0;
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) else { return false };
        let mut entry = THREADENTRY32 { dwSize: std::mem::size_of::<THREADENTRY32>() as u32, ..Default::default() };
        if Thread32First(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32OwnerProcessID == pid as u32 {
                    if let Ok(handle) = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) {
                        if suspended {
                            let _ = SuspendThread(handle);
                        } else {
                            let _ = ResumeThread(handle);
                        }
                        touched += 1;
                        let _ = windows::Win32::Foundation::CloseHandle(handle);
                    }
                }
                if Thread32Next(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snapshot);
    }
    touched > 0
}

fn hard_kill(pid: i32) -> bool {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid as u32) else { return false };
        let ok = TerminateProcess(handle, 1).is_ok();
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        ok
    }
}

// ── 录制子进程 ───────────────────────────────────────────────────────

/// `rec-start --worker --state <file> -- <ffmpeg.exe> <args…>`：
/// 持有 ffmpeg 的 stdin（停止 = 写一个 `q`），并把 ffmpeg pid 写回状态文件。
pub fn worker_entry() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|arg| arg == WORKER_FLAG) {
        return None;
    }
    Some(run_worker(&args))
}

fn run_worker(argv: &[String]) -> i32 {
    let Some(state_path) = value_after(argv, STATE_FLAG).map(PathBuf::from) else { return 2 };
    let Some(data_path) = state_path.parent().map(Path::to_path_buf) else { return 2 };
    let Some(rest) = argv.split(|arg| arg == "--").nth(1) else { return 2 };
    let Some((program, args)) = rest.split_first() else { return 2 };

    // 上一轮遗留的停止请求不能毒死这一段录制
    clear_stop_request(&data_path);

    let log = match std::fs::File::create(data_path.join(LOG_FILE)) {
        Ok(file) => file,
        Err(_) => return 3,
    };
    let mut child = match Command::new(program)
        .args(args)
        .stdin(Stdio::piped()) // 收起尾命令的管道，必须留着
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return 4,
    };
    let ffmpeg_pid = child.id() as i32;

    // 把 ffmpeg pid 与自己的 pid 一起写回：rec-start 正等着这个数
    if let Some(mut state) = read_state(&data_path) {
        state.pid = ffmpeg_pid;
        state.worker_pid = Some(std::process::id() as i32);
        let _ = write_state(&data_path, &state);
    }

    let mut frozen = false;
    loop {
        if stop_requested(&data_path) {
            break;
        }
        // 暂停 / 继续：脚本进程把 pausedAt 写进状态文件，这里负责**真的**把 ffmpeg 冻住 / 解冻。
        // 冻结 = 挂起它的全部线程：这段时间抓不到帧，也就不进视频（时长自然不含暂停段）。
        if let Some(want) = read_state(&data_path).map(|state| state.paused()) {
            if want != frozen && set_suspended(ffmpeg_pid, want) {
                frozen = want;
            }
        }
        match child.try_wait() {
            Ok(Some(_)) => break, // ffmpeg 自己退了（到时 / 出错）
            Ok(None) => sleep(Duration::from_millis(POLL_STEP_MS)),
            Err(_) => break,
        }
    }

    // 冻着的 ffmpeg 读不到 stdin 里的 `q`（会一直等到硬杀，文件就没 moov 了）：先解冻
    if frozen {
        set_suspended(ffmpeg_pid, false);
    }

    // 收尾：给 ffmpeg 送 q（写完 moov），再关掉 stdin；等它退场
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(b"q\n");
        let _ = stdin.flush();
        drop(stdin);
    }
    let mut waited = 0;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if waited < STOP_WAIT_MS => {
                sleep(Duration::from_millis(POLL_STEP_MS));
                waited += POLL_STEP_MS;
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    clear_stop_request(&data_path);
    0
}

fn value_after(argv: &[String], flag: &str) -> Option<String> {
    let index = argv.iter().position(|arg| arg == flag)?;
    argv.get(index + 1).cloned()
}

/// 列一次 DirectShow 音频设备，取第一个可用的（用不了就返回 None = 无声录制）
fn first_audio_device(ffmpeg: &Path) -> Option<String> {
    let output = Command::new(ffmpeg)
        .args(["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"])
        .creation_flags(0x0800_0000)
        .output()
        .ok()?;
    let log = String::from_utf8_lossy(&output.stderr).to_string();
    ffmpeg::parse_audio_devices(&log).into_iter().next()
}

// ── 截图 ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ShotInfo {
    pub path: Option<PathBuf>,
    pub size: Option<u64>,
    pub clipboard: bool,
    pub args: Vec<String>,
    pub delegated: bool,
    pub note: Option<String>,
}

/// 截图：全屏 / 区域走原生 GDI；窗口 / 剪贴板交给系统截图工具（它有成熟的窗口选择 UI）
pub fn shot(options: &ShotOptions, _data_path: &Path) -> Result<ShotInfo, StartError> {
    if options.mode == "window" || options.mode == "clipboard" {
        open_snip_tool()?;
        return Ok(ShotInfo {
            path: None,
            size: None,
            clipboard: options.mode == "clipboard",
            args: vec!["ms-screenclip:".to_string()],
            delegated: true,
            note: Some(if options.mode == "clipboard" {
                "已交给系统截图工具：选好区域后它会自动复制到剪贴板".to_string()
            } else {
                "已交给系统截图工具：选窗口后保存即可（默认存到 图片\\Screenshots）".to_string()
            }),
        });
    }

    if options.delay_sec > 0 {
        sleep(Duration::from_secs(options.delay_sec));
    }
    let rect = match options.mode.as_str() {
        "region" => pick_region().ok_or_else(|| StartError {
            code: "CANCELLED".into(),
            message: "截图已取消".into(),
            detail: String::new(),
            retry_without_audio: false,
        })?,
        _ => set_dpi_awareness_then(virtual_screen_rect),
    };

    let dir = options.target_dir();
    ensure_dir(&dir).map_err(|err| StartError {
        code: "DIR_FAILED".into(),
        message: format!("创建保存目录失败：{err}"),
        detail: String::new(),
        retry_without_audio: false,
    })?;
    let out = dir.join(make_file_name("截图", "png", SystemTime::now()));
    grab(rect, &out).map_err(|message| StartError {
        code: "CAPTURE_FAILED".into(),
        message,
        detail: String::new(),
        retry_without_audio: false,
    })?;
    let size = file_info(&out).map(|(size, _)| size);
    Ok(ShotInfo {
        path: Some(out),
        size,
        clipboard: false,
        args: vec![],
        delegated: false,
        note: None,
    })
}

fn open_snip_tool() -> Result<(), StartError> {
    unsafe {
        // ShellExecute 要求 COM 已初始化；已经初始化过会返回 RPC_E_CHANGED_MODE，忽略即可
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let result = ShellExecuteW(
            None,
            w!("open"),
            w!("ms-screenclip:"),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOW,
        );
        // ShellExecuteW 的返回值 <= 32 表示失败
        if result.0 as usize <= 32 {
            return Err(StartError {
                code: "SPAWN_FAILED".into(),
                message: "打不开系统截图工具（ms-screenclip:）".into(),
                detail: String::new(),
                retry_without_audio: false,
            });
        }
    }
    Ok(())
}

/// GDI 抓一块屏幕矩形 → PNG
fn grab(rect: RECT, out: &Path) -> Result<(), String> {
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width <= 0 || height <= 0 {
        return Err("选区太小，没有可截的内容".to_string());
    }
    unsafe {
        let hdc_screen = CreateDCW(w!("DISPLAY"), PCWSTR::null(), PCWSTR::null(), None);
        if hdc_screen.is_invalid() {
            return Err("拿不到屏幕 DC（可能被安全桌面挡住）".to_string());
        }
        let hdc_mem = CreateCompatibleDC(Some(hdc_screen));
        let bitmap = CreateCompatibleBitmap(hdc_screen, width, height);
        let old = SelectObject(hdc_mem, HGDIOBJ(bitmap.0));
        // CAPTUREBLT：把分层窗口（悬浮提示、录制指示）也一起截进来
        let blit = BitBlt(hdc_mem, 0, 0, width, height, Some(hdc_screen), rect.left, rect.top, SRCCOPY | CAPTUREBLT);

        let mut info = BITMAPINFO::default();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // 负高度 = 自顶向下
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut pixels = vec![0_u8; (width as usize) * (height as usize) * 4];
        let lines = windows::Win32::Graphics::Gdi::GetDIBits(
            hdc_mem,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        );

        SelectObject(hdc_mem, old);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(hdc_mem);
        let _ = DeleteDC(hdc_screen);
        blit.map_err(|err| format!("BitBlt 失败：{err}"))?;
        if lines == 0 {
            return Err("读不出屏幕像素".to_string());
        }

        // BGRA → RGBA，并补上 alpha（GDI 不填 alpha 通道）
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
            chunk[3] = 255;
        }
        let image = image::RgbaImage::from_raw(width as u32, height as u32, pixels)
            .ok_or_else(|| "像素缓冲尺寸不对".to_string())?;
        image.save(out).map_err(|err| format!("写 PNG 失败：{err}"))?;
    }
    Ok(())
}

// ── 区域选择框 ───────────────────────────────────────────────────────
//
// 一个铺满虚拟屏幕的半透明置顶窗口：拖拽画框，松开即定，Esc / 右键 / 20s 超时取消。

#[derive(Clone, Copy, Default)]
struct PickState {
    dragging: bool,
    /// 拖完松开了（这次选择算数）
    done: bool,
    start: (i32, i32),
    current: (i32, i32),
}

thread_local! {
    static PICK: std::cell::Cell<PickState> = const { std::cell::Cell::new(PickState { dragging: false, done: false, start: (0, 0), current: (0, 0) }) };
}

fn pick_region() -> Option<RECT> {
    set_dpi_awareness();
    unsafe {
        let instance = GetModuleHandleW(None).ok()?;
        let class = wide(PICKER_CLASS);
        let wnd_class = WNDCLASSW {
            hInstance: instance.into(),
            lpszClassName: PCWSTR(class.as_ptr()),
            lpfnWndProc: Some(picker_proc),
            hbrBackground: GetSysColorBrush(COLOR_WINDOW),
            ..Default::default()
        };
        let atom = RegisterClassW(&wnd_class);
        if atom == 0 {
            return None;
        }
        let virtual_rect = virtual_screen_rect();
        let title = wide("选择录制区域");
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED,
            PCWSTR(class.as_ptr()),
            PCWSTR(title.as_ptr()),
            WS_POPUP,
            virtual_rect.left,
            virtual_rect.top,
            virtual_rect.right - virtual_rect.left,
            virtual_rect.bottom - virtual_rect.top,
            None,
            None,
            Some(instance.into()),
            None,
        )
        .ok()?;
        // 整窗压暗；选区用亮色描边示意
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 110, windows::Win32::UI::WindowsAndMessaging::LWA_ALPHA);
        PICK.with(|state| state.set(PickState::default()));
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = UpdateWindow(hwnd);
        let _ = windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);
        SetTimer(Some(hwnd), PICK_TIMER_ID, PICK_TIMEOUT_MS, None);

        // 消息循环：WM_QUIT 由 wndproc 在「选中 / 取消 / 超时」时投递
        let mut message = MSG::default();
        loop {
            let got = GetMessageW(&mut message, None, 0, 0);
            if got.0 <= 0 {
                break; // 0 = WM_QUIT，-1 = 出错
            }
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        // 只有「拖完松开」才算选中（done=true）；Esc / 右键 / 超时都是 done=false
        let state = PICK.with(|cell| cell.get());
        let rect = state.done.then(|| rect_of(state)).flatten();
        let _ = KillTimer(Some(hwnd), PICK_TIMER_ID);
        let _ = DestroyWindow(hwnd);
        let _ = UnregisterClassW(PCWSTR(class.as_ptr()), Some(instance.into()));
        rect.filter(|rect| rect.right - rect.left >= 4 && rect.bottom - rect.top >= 4)
    }
}

fn rect_of(state: PickState) -> Option<RECT> {
    if state.current == (0, 0) {
        return None;
    }
    Some(RECT {
        left: state.start.0.min(state.current.0),
        top: state.start.1.min(state.current.1),
        right: state.start.0.max(state.current.0),
        bottom: state.start.1.max(state.current.1),
    })
}

unsafe extern "system" fn picker_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_ERASEBKGND => LRESULT(1), // 背景在 WM_PAINT 里一次画完，避免闪烁
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut paint);
            let mut client = RECT::default();
            let _ = windows::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &mut client);
            let dark = CreateSolidBrush(COLORREF(0));
            FillRect(hdc, &client, dark);
            let state = PICK.with(|cell| cell.get());
            if let Some(rect) = rect_of(state) {
                // 屏幕坐标 → 客户区坐标（窗口铺满虚拟屏幕，原点即虚拟左上角）
                let origin = virtual_screen_rect();
                let pen = CreatePen(PS_SOLID, 3, COLORREF(0x00333BFF)); // 亮红（COLORREF 是 0x00BBGGRR）
                let old_pen = SelectObject(hdc, HGDIOBJ(pen.0));
                let old_brush = SelectObject(hdc, GetStockObject(NULL_BRUSH));
                let _ = windows::Win32::Graphics::Gdi::Rectangle(
                    hdc,
                    rect.left - origin.left,
                    rect.top - origin.top,
                    rect.right - origin.left,
                    rect.bottom - origin.top,
                );
                SelectObject(hdc, old_brush);
                SelectObject(hdc, old_pen);
                let _ = DeleteObject(HGDIOBJ(pen.0));
            }
            let _ = SetBkMode(hdc, TRANSPARENT);
            let _ = SetTextColor(hdc, COLORREF(0x00F0F0F0));
            let hint = wide("拖拽框选录制区域 · 松开开始 · Esc 取消");
            let _ = TextOutW(hdc, 24, 24, &hint[..hint.len() - 1]);
            let _ = EndPaint(hwnd, &paint);
            LRESULT(0)
        }
        WM_LBUTTONDOWN => {
            let point = cursor_point();
            PICK.with(|cell| {
                cell.set(PickState { dragging: true, done: false, start: point, current: point });
            });
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            if PICK.with(|cell| cell.get().dragging) {
                let point = cursor_point();
                PICK.with(|cell| {
                    let mut state = cell.get();
                    state.current = point;
                    cell.set(state);
                });
                let _ = InvalidateRect(Some(hwnd), None, false);
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            PICK.with(|cell| {
                let mut state = cell.get();
                state.dragging = false;
                state.done = true;
                state.current = cursor_point();
                cell.set(state);
            });
            PostQuitMessage(1);
            LRESULT(0)
        }
        // Esc / 右键 / 超时 = 取消（done 保持 false，用最后落下的矩形也不认）
        WM_KEYDOWN if wparam.0 == VK_ESCAPE_CODE => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        WM_RBUTTONUP | WM_TIMER => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn cursor_point() -> (i32, i32) {
    let mut point = windows::Win32::Foundation::POINT::default();
    let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut point) };
    (point.x, point.y)
}

// ── 进程 ─────────────────────────────────────────────────────────────

pub fn pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid as u32) {
            Ok(handle) => {
                let mut code = 0_u32;
                let alive = windows::Win32::System::Threading::GetExitCodeProcess(handle, &mut code).is_ok()
                    && code == 259; // STILL_ACTIVE
                let _ = windows::Win32::Foundation::CloseHandle(handle);
                alive
            }
            Err(_) => false,
        }
    }
}

/// 这个 PID 现在真的是 ffmpeg 吗（PID 会被系统复用，停止前必须验身份）
pub fn is_recorder_process(pid: i32) -> bool {
    image_name(pid).is_some_and(|name| name.eq_ignore_ascii_case("ffmpeg.exe") || name.eq_ignore_ascii_case("ffmpeg"))
}

fn image_name(pid: i32) -> Option<String> {
    if pid <= 0 {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid as u32).ok()?;
        let mut buffer = [0_u16; 1024];
        let mut len = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut len).is_ok();
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&buffer[..len as usize]);
        path.rsplit('\\').next().map(str::to_string)
    }
}

/// 录制子进程的镜像名：`commands[].name` = 产物文件名（plugin-spec §2.2 的 N1 铁律），
/// Windows 上一律带 `.exe`，所以这里可以写死 —— **不能**拿 `current_exe()` 反推：
/// `rec-stop` 也会来扫孤儿，按自己的名字扫就永远扫不到录制 worker。
const WORKER_IMAGE: &str = "rec-start.exe";

/// 我们自己派出的录制子进程（`rec-start.exe --worker`）。
/// 只认这个镜像名 —— **不能**按 ffmpeg.exe 扫，用户手动跑的 ffmpeg 绝不能被误伤。
pub fn recorder_processes() -> Vec<i32> {
    let mut pids = Vec::new();
    let own = WORKER_IMAGE.to_string();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return pids };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let name = String::from_utf16_lossy(
                    &entry.szExeFile[..entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len())],
                );
                let pid = entry.th32ProcessID as i32;
                if name.eq_ignore_ascii_case(&own) && pid != std::process::id() as i32 {
                    pids.push(pid);
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snapshot);
    }
    pids
}

/// 状态文件丢了但录制还在跑：请录制子进程收尾（它握着 ffmpeg 的 stdin）
pub fn stop_orphans(data_path: &Path) -> usize {
    let workers = recorder_processes();
    if workers.is_empty() {
        return 0;
    }
    if request_stop(data_path).is_err() {
        return 0;
    }
    let mut waited = 0;
    while waited < STOP_WAIT_MS && recorder_processes().iter().any(|pid| pid_alive(*pid)) {
        sleep(Duration::from_millis(POLL_STEP_MS));
        waited += POLL_STEP_MS;
    }
    clear_stop_request(data_path);
    workers.len()
}

// ── 权限 ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Permission {
    pub supported: bool,
    pub granted: bool,
    pub requested: bool,
    pub needs_manual: bool,
    pub hint: String,
    pub settings_url: String,
}

/// Windows 没有 macOS 那种「屏幕录制」授权：普通窗口随便抓，
/// 只有受保护内容（DRM / 安全桌面）抓不到 —— 这是系统限制，不是权限问题。
pub fn permission(_request: bool) -> Permission {
    Permission {
        supported: true,
        granted: true,
        requested: false,
        needs_manual: false,
        hint: "Windows 不需要屏幕录制授权".to_string(),
        settings_url: String::new(),
    }
}

pub fn microphone_settings_url() -> &'static str {
    "ms-settings:privacy-microphone"
}

// ── 杂项 ─────────────────────────────────────────────────────────────

fn set_dpi_awareness() {
    unsafe {
        // 失败通常意味着已经设过（或清单里固定了）：忽略
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

fn set_dpi_awareness_then(rect: fn() -> RECT) -> RECT {
    set_dpi_awareness();
    rect()
}

/// 全部显示器组成的虚拟桌面（物理像素）
fn virtual_screen_rect() -> RECT {
    unsafe {
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        RECT {
            left: x,
            top: y,
            right: x + GetSystemMetrics(SM_CXVIRTUALSCREEN),
            bottom: y + GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}
