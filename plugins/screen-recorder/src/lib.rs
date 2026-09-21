//! 录屏助手逻辑层：跨平台共享的纯逻辑（参数组装 / 状态文件 / 进程探活 / 产物清点 / ffmpeg 参数）
//! + 平台后端（`macos` / `windows` / `unsupported`）的编译期分派，胶水在 `src/bin/*`。
//!
//! **两端后端（二选一，编译期决定，对外契约完全一致）**
//!
//! | | macOS | Windows |
//! |---|---|---|
//! | 录制 | 系统 `screencapture -v`（零依赖） | `ffmpeg -f gdigrab`（运行时探测 ffmpeg） |
//! | 停止 | 给 `screencapture` 发 SIGINT（= 终端 Ctrl+C，它会收尾写完文件） | 停止文件通知录制 worker，由它给 ffmpeg 送 `q` 收尾 |
//! | 截图 | 系统 `screencapture` | 原生 GDI BitBlt（全屏 / 区域），窗口与剪贴板交给系统截图工具 |
//! | 权限 | TCC 屏幕录制（CoreGraphics preflight） | 无系统级授权（DRM 窗口录不到，属系统限制） |
//!
//! **设计要点**
//! - 状态文件 `recording.json` **原子写**（temp + rename）：录制途中崩溃也不会留下半截 JSON
//!   —— 半截 JSON = 读不回来 = 录制进程变成没人能停的孤儿。
//! - 停止前**校验进程身份**（macOS `proc_pidpath`）：PID 会被系统复用，凭一个过期的 PID 发 SIGINT
//!   等于往无关进程上捅一刀。
//! - 后端的 stderr 一律落到 `<dataPath>/rec-last.log`：失败时能拿到真实原因，
//!   而不是「没能开始录制」这种查不下去的兜底文案。
//! - 平台限定代码收在后端模块里，对宿主 / UI 的契约两端一致（plugin-spec §3.5 规则 1）。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// 录制状态文件（同一插件数据目录下的不同脚本进程都读它）
pub const STATE_FILE: &str = "recording.json";
/// 后端 stderr 落点：失败诊断的唯一来源
pub const LOG_FILE: &str = "rec-last.log";
/// 停止请求文件（Windows 停止协议：`rec-stop` 建、录制 worker 消费）
pub const STOP_FILE: &str = "stop.request";

// ── 平台后端分派 ─────────────────────────────────────────────────────
//
// 三个模块暴露同一组函数名（backend_name / readiness / permission / start / stop /
// capture / worker_entry），调用点不关心自己站在哪个平台上。

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub mod unsupported;
#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "macos")]
pub use macos as backend;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use unsupported as backend;
#[cfg(target_os = "windows")]
pub use windows as backend;

// ── 入参 ─────────────────────────────────────────────────────────────

/// 录制方式：`full` / `region` / `window`
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordOptions {
    pub mode: String,
    pub delay_sec: u64,
    /// 最长时长（秒）；`None` = 不限时
    pub seconds: Option<u64>,
    pub audio: bool,
    pub clicks: bool,
    /// 录进鼠标指针（macOS 只支持非交互模式；交互式下后端会丢掉它）
    pub cursor: bool,
    pub dir: Option<String>,
    pub file_name: Option<String>,
}

/// 暂停 / 继续的动作（`rec-pause` 的入参 `action`）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseAction {
    Pause,
    Resume,
    Toggle,
}

impl PauseAction {
    pub fn from_args(args: &serde_json::Value) -> Self {
        match args.get("action").and_then(serde_json::Value::as_str) {
            Some("pause") => Self::Pause,
            Some("resume") => Self::Resume,
            _ => Self::Toggle,
        }
    }

    /// 切完之后应该是暂停还是继续（`Toggle` 按当前状态取反）
    pub fn wanted(self, currently_paused: bool) -> bool {
        match self {
            Self::Pause => true,
            Self::Resume => false,
            Self::Toggle => !currently_paused,
        }
    }
}

pub const RECORD_MODES: [&str; 3] = ["full", "region", "window"];
pub const SHOT_MODES: [&str; 4] = ["full", "region", "window", "clipboard"];
/// 延迟封顶：60s（面板只给到 10s，留余量给脚本调用）
pub const MAX_DELAY_SEC: u64 = 60;

/// 录制产物的容器：macOS `screencapture` 只出 mov，Windows ffmpeg 出 mp4
pub fn video_extension() -> &'static str {
    if cfg!(windows) {
        "mp4"
    } else {
        "mov"
    }
}

/// 当前平台后端的能力矩阵：面板据此决定「哪些开关该灰掉、哪些文案要改」，
/// **不靠视图层猜平台**（plugin-spec §3.5：差异收在后端，对外契约一致）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    /// 能录麦克风
    pub audio: bool,
    /// 能高亮鼠标点击
    pub clicks: bool,
    /// 能把鼠标指针录进视频（非交互模式）
    pub cursor: bool,
    /// 能按窗口录
    pub window_recording: bool,
    /// 有原生区域选择框
    pub region_pick: bool,
    /// 窗口 / 剪贴板截图交给了系统工具（此时不会产出文件）
    pub delegated_shot: bool,
    /// 交互式录制也吃「延迟」这个设置
    pub delay_in_interactive: bool,
    /// 平台注意事项（面板直接展示）
    pub notes: Vec<String>,
}

pub fn features() -> Features {
    backend::features()
}

impl RecordOptions {
    pub fn from_args(args: &serde_json::Value) -> Self {
        let mode = args.get("mode").and_then(serde_json::Value::as_str).unwrap_or("full");
        Self {
            mode: if RECORD_MODES.contains(&mode) { mode.to_string() } else { "full".to_string() },
            delay_sec: args.get("delaySec").and_then(serde_json::Value::as_u64).unwrap_or(0).min(MAX_DELAY_SEC),
            seconds: args.get("seconds").and_then(serde_json::Value::as_u64).filter(|value| *value > 0),
            audio: args.get("audio").and_then(serde_json::Value::as_bool).unwrap_or(false),
            clicks: args.get("clicks").and_then(serde_json::Value::as_bool).unwrap_or(false),
            cursor: args.get("cursor").and_then(serde_json::Value::as_bool).unwrap_or(false),
            dir: args.get("dir").and_then(serde_json::Value::as_str).map(str::to_string),
            file_name: args.get("fileName").and_then(serde_json::Value::as_str).map(str::to_string),
        }
    }

    /// 交互式录制：由用户先框选，录制在选完之后才真正开始
    pub fn interactive(&self) -> bool {
        self.mode == "region" || self.mode == "window"
    }
}

/// 截图入参
#[derive(Debug, Clone)]
pub struct ShotOptions {
    pub mode: String,
    pub delay_sec: u64,
    pub cursor: bool,
    pub dir: Option<String>,
}

impl ShotOptions {
    pub fn from_args(args: &serde_json::Value) -> Self {
        let mode = args.get("mode").and_then(serde_json::Value::as_str).unwrap_or("full");
        Self {
            mode: if SHOT_MODES.contains(&mode) { mode.to_string() } else { "full".to_string() },
            delay_sec: args.get("delaySec").and_then(serde_json::Value::as_u64).unwrap_or(0).min(MAX_DELAY_SEC),
            // 截图默认带光标：教程 / 反馈截图里常用
            cursor: args.get("cursor").and_then(serde_json::Value::as_bool).unwrap_or(true),
            dir: args.get("dir").and_then(serde_json::Value::as_str).map(str::to_string),
        }
    }

    pub fn target_dir(&self) -> PathBuf {
        self.dir.clone().map(PathBuf::from).unwrap_or_else(|| default_dir("image"))
    }
}

// ── 状态文件 ─────────────────────────────────────────────────────────

/// 一段录制的状态：写盘后即使在别的脚本进程里也能读到同一段录制
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingState {
    /// 录制进程（macOS = screencapture；Windows = ffmpeg）
    pub pid: i32,
    /// Windows：持有 ffmpeg stdin 的录制 worker
    #[serde(default)]
    pub worker_pid: Option<i32>,
    /// 后端标识（"screencapture" / "ffmpeg"），停止前用它挑身份校验口径
    #[serde(default)]
    pub backend: String,
    pub path: String,
    pub started_at: u64,
    pub mode: String,
    pub interactive: bool,
    #[serde(default)]
    pub seconds: Option<u64>,
    pub audio: bool,
    pub clicks: bool,
    /// 这次暂停的起点（毫秒时间戳）；`None` = 正在录
    #[serde(default)]
    pub paused_at: Option<u64>,
    /// 之前几段暂停累计的时长（多次暂停累加）
    #[serde(default)]
    pub paused_total_ms: u64,
}

impl RecordingState {
    pub fn elapsed_ms(&self) -> u64 {
        now_millis().saturating_sub(self.started_at)
    }

    pub fn paused(&self) -> bool {
        self.paused_at.is_some()
    }

    /// **有效录制时长**（扣掉暂停）：托盘 / 面板显示的计时口径。
    /// 暂停期间画面冻结（macOS `screencapture` 是系统进程，只能停它），
    /// 所以产物时长 = 有效时长 + 暂停时长，这个差额在界面上如实说明。
    pub fn active_ms(&self) -> u64 {
        let pending = self.paused_at.map(|at| now_millis().saturating_sub(at)).unwrap_or(0);
        self.elapsed_ms().saturating_sub(self.paused_total_ms).saturating_sub(pending)
    }

    /// 记账：切到暂停记起点，切回继续把这一段累加进 `paused_total_ms`
    pub fn mark_pause(&mut self, paused: bool) {
        if paused == self.paused() {
            return;
        }
        if paused {
            self.paused_at = Some(now_millis());
        } else if let Some(at) = self.paused_at.take() {
            self.paused_total_ms += now_millis().saturating_sub(at);
        }
    }

    pub fn path_buf(&self) -> PathBuf {
        PathBuf::from(&self.path)
    }

    /// 录制进程还活着 **且** 身份对得上（PID 会被复用，只有存活性是不够的）
    pub fn recording_alive(&self) -> bool {
        pid_alive(self.pid) && backend::is_recorder_process(self.pid)
    }
}

pub fn state_path(data_path: &Path) -> PathBuf {
    data_path.join(STATE_FILE)
}

pub fn read_state(data_path: &Path) -> Option<RecordingState> {
    let text = std::fs::read_to_string(state_path(data_path)).ok()?;
    serde_json::from_str::<RecordingState>(&text).ok()
}

/// 原子写：先写临时文件再 rename —— 中途崩溃只会留下「旧内容」或「新内容」，
/// 不会留下读不回来的半截 JSON（那会让录制进程变成没人能停的孤儿）。
pub fn write_state(data_path: &Path, state: &RecordingState) -> std::io::Result<()> {
    std::fs::create_dir_all(data_path)?;
    let text = serde_json::to_string_pretty(state).map_err(std::io::Error::other)?;
    let tmp = data_path.join(format!("{STATE_FILE}.tmp"));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, state_path(data_path))
}

pub fn clear_state(data_path: &Path) {
    let _ = std::fs::remove_file(state_path(data_path));
}

/// 暂停 / 继续当前录制：平台动作（macOS 停进程 / Windows 交 worker）→ 记账写盘。
/// 返回切完的新状态；进程已经不在或身份不符时给一句能看懂的原因。
pub fn set_paused(state: &RecordingState, data_path: &Path, target: bool) -> Result<RecordingState, String> {
    if target == state.paused() {
        return Ok(state.clone());
    }
    backend::apply_pause(state, target)?;
    let mut next = state.clone();
    next.mark_pause(target);
    // Windows 后端靠状态文件里的 `pausedAt` 驱动 worker 冻结 ffmpeg，写盘就是发号施令
    write_state(data_path, &next).map_err(|err| format!("写录制状态失败：{err}"))?;
    Ok(next)
}

// ── 停止协议（Windows 用；macOS 走信号，但保留同名接口方便读代码）────

pub fn stop_path(data_path: &Path) -> PathBuf {
    data_path.join(STOP_FILE)
}

/// 请求停止：建一个标记文件，录制 worker 轮询到就会收尾
pub fn request_stop(data_path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(data_path)?;
    std::fs::write(stop_path(data_path), b"stop\n")
}

pub fn stop_requested(data_path: &Path) -> bool {
    stop_path(data_path).exists()
}

pub fn clear_stop_request(data_path: &Path) {
    let _ = std::fs::remove_file(stop_path(data_path));
}

// ── 时间 / 路径 / 文件 ───────────────────────────────────────────────

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

/// 用户主目录：macOS/Linux `$HOME`，Windows `%USERPROFILE%`
pub fn home_dir() -> PathBuf {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var_os(key).map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

/// 默认落盘目录：视频 `~/Movies/Chassis`（Windows `~/Videos/Chassis`）、图片 `~/Pictures/Chassis`
/// （Windows 用 `~/Pictures/Screenshots` —— 那是系统截图工具的落地目录，
/// 面板里的「最近截图」因此也能看到 Win+Shift+S 存的图）
pub fn default_dir(kind: &str) -> PathBuf {
    let home = home_dir();
    if kind == "image" {
        #[cfg(windows)]
        return home.join("Pictures").join("Screenshots");
        #[cfg(not(windows))]
        return home.join("Pictures").join("Chassis");
    }
    #[cfg(windows)]
    let videos = home.join("Videos");
    #[cfg(not(windows))]
    let videos = home.join("Movies");
    videos.join("Chassis")
}

pub fn ensure_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// 文件名：`录屏 2026-09-17 15.04.22.mov`
/// （冒号在 Finder 里会被显示成斜杠；Windows 上 `:` 干脆是非法字符 —— 统一换成点）
pub fn make_file_name(prefix: &str, ext: &str, now: SystemTime) -> String {
    let datetime: chrono::DateTime<chrono::Local> = now.into();
    format!("{} {}.{}", prefix, datetime.format("%Y-%m-%d %H.%M.%S"), ext)
}

/// 产物信息：`(字节数, mtime 毫秒)`；文件不存在或还是 0 字节（没写完）返回 None
pub fn file_info(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 {
        return None;
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0);
    Some((meta.len(), mtime))
}

/// 读日志尾部（失败诊断）：日志可能很大，只取最后一段
pub fn read_log_tail(path: &Path, max_chars: usize) -> String {
    let Ok(text) = std::fs::read_to_string(path) else { return String::new() };
    let text = text.trim();
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().skip(text.chars().count() - max_chars).collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub mtime_ms: u64,
}

/// 清点目录里最近修改过的产物（扩展名过滤，按 mtime 倒序）
pub fn list_recent(dir: &Path, extensions: &[&str], limit: usize) -> Vec<RecentFile> {
    if limit == 0 {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut files: Vec<RecentFile> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let ext = path.extension()?.to_string_lossy().to_lowercase();
            if !extensions.contains(&ext.as_str()) {
                return None;
            }
            let (size, mtime_ms) = file_info(&path)?;
            Some(RecentFile {
                name: path.file_name()?.to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                size,
                mtime_ms,
            })
        })
        .collect();
    files.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    files.truncate(limit);
    files
}

/// 视频 / 图片产物的扩展名（两端统一的收网口径）
pub fn extensions_for(kind: &str) -> &'static [&'static str] {
    if kind == "image" {
        &["png", "jpg", "jpeg"]
    } else {
        &["mov", "mp4", "mkv"]
    }
}

// ── 进程 ─────────────────────────────────────────────────────────────

/// 进程存活（不含身份判断）
#[cfg(unix)]
pub fn pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // kill(pid, 0)：不投递信号，只做存在性 / 权限检查
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(windows)]
pub fn pid_alive(pid: i32) -> bool {
    windows::pid_alive(pid)
}

#[cfg(not(any(unix, windows)))]
pub fn pid_alive(pid: i32) -> bool {
    let _ = pid;
    false
}

/// 还有没有别的录制进程在跑（清点用：`rec-status` 兜底发现状态文件没记上的进程）
pub fn recorder_processes() -> Vec<i32> {
    backend::recorder_processes()
}

// ── ffmpeg（Windows 后端；纯参数组装放这里是为了在任意平台都能单测）────

pub mod ffmpeg {
    use super::{RecordOptions, MAX_DELAY_SEC};
    use std::path::Path;

    /// 录制画面的几何：Windows 上由 `GetSystemMetrics` 填，这里是纯数据
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct VideoSource {
        pub width: u32,
        pub height: u32,
        pub x: i32,
        pub y: i32,
        pub fps: u32,
    }

    impl VideoSource {
        pub fn primary(width: u32, height: u32) -> Self {
            Self { width, height, x: 0, y: 0, fps: 30 }
        }

        pub fn region(width: u32, height: u32, x: i32, y: i32) -> Self {
            Self { width, height, x, y, fps: 30 }
        }
    }

    /// `ffmpeg -list_devices true -f dshow -i dummy` 的 stderr → 音频设备名清单。
    /// 只认「DirectShow audio devices」那一段，跳过 `Alternative name` 这类别名行。
    pub fn parse_audio_devices(log: &str) -> Vec<String> {
        let mut devices = Vec::new();
        let mut in_audio = false;
        for line in log.lines() {
            if line.contains("DirectShow audio devices") {
                in_audio = true;
                continue;
            }
            if line.contains("DirectShow video devices") {
                in_audio = false;
                continue;
            }
            if !in_audio || line.contains("Alternative name") {
                continue;
            }
            if let Some(name) = first_quoted(line) {
                devices.push(name);
            }
        }
        devices
    }

    fn first_quoted(line: &str) -> Option<String> {
        let start = line.find('"')? + 1;
        let rest = &line[start..];
        let end = rest.find('"')?;
        let name = rest[..end].trim();
        (!name.is_empty()).then(|| name.to_string())
    }

    /// 录制命令行（**不含可执行文件本身**；输出路径在最后）。
    ///
    /// 收尾靠 worker 往 stdin 写 `q`，所以**不能**加 `-nostdin`。
    pub fn record_args(
        source: &VideoSource,
        options: &RecordOptions,
        audio_device: Option<&str>,
        out: &Path,
    ) -> Vec<String> {
        let mut args: Vec<String> = vec![
            "-y".into(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "warning".into(),
            "-f".into(),
            "gdigrab".into(),
            "-framerate".into(),
            source.fps.to_string(),
            "-offset_x".into(),
            source.x.to_string(),
            "-offset_y".into(),
            source.y.to_string(),
            "-video_size".into(),
            format!("{}x{}", source.width, source.height),
            "-i".into(),
            "desktop".into(),
        ];
        if let Some(device) = audio_device {
            args.push("-f".into());
            args.push("dshow".into());
            args.push("-i".into());
            args.push(format!("audio={device}"));
        }
        args.push("-c:v".into());
        args.push("libx264".into());
        args.push("-preset".into());
        args.push("veryfast".into());
        // 屏幕录制是「大块静止 + 少量变化」，crf 20 + veryfast 体积 / CPU 都合适
        args.push("-crf".into());
        args.push("20".into());
        args.push("-pix_fmt".into());
        args.push("yuv420p".into());
        if audio_device.is_some() {
            args.push("-c:a".into());
            args.push("aac".into());
            args.push("-b:a".into());
            args.push("128k".into());
        }
        if let Some(seconds) = options.seconds {
            args.push("-t".into());
            args.push(seconds.to_string());
        }
        args.push(out.to_string_lossy().to_string());
        args
    }

    /// 截图命令行不在这里：Windows 截图走原生 GDI（见 `windows.rs`），不依赖 ffmpeg
    pub fn max_delay() -> u64 {
        MAX_DELAY_SEC
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn options(mode: &str) -> RecordOptions {
        RecordOptions { mode: mode.to_string(), ..Default::default() }
    }

    #[test]
    fn options_from_args_sanitize() {
        let opts = RecordOptions::from_args(&serde_json::json!({
            "mode": "teleport",
            "delaySec": 999,
            "seconds": 0,
            "audio": true,
            "dir": "/tmp"
        }));
        assert_eq!(opts.mode, "full", "非法模式回落 full");
        assert_eq!(opts.delay_sec, MAX_DELAY_SEC, "延迟封顶");
        assert_eq!(opts.seconds, None, "0 秒等于不限时");
        assert!(opts.audio);
        assert_eq!(opts.dir.as_deref(), Some("/tmp"));
    }

    #[test]
    fn interactive_modes_are_region_and_window() {
        assert!(options("region").interactive());
        assert!(options("window").interactive());
        assert!(!options("full").interactive());
    }

    #[test]
    fn shot_options_default_to_cursor() {
        let shot = ShotOptions::from_args(&serde_json::json!({ "mode": "region" }));
        assert_eq!(shot.mode, "region");
        assert!(shot.cursor, "截图默认带光标");
        let shot = ShotOptions::from_args(&serde_json::json!({ "mode": "nope", "cursor": false }));
        assert_eq!(shot.mode, "full");
        assert!(!shot.cursor);
    }

    #[test]
    fn file_name_has_readable_timestamp() {
        let now = UNIX_EPOCH + Duration::from_secs(1_788_000_000);
        let name = make_file_name("录屏", "mov", now);
        assert!(name.starts_with("录屏 "));
        assert!(name.ends_with(".mov"));
        assert_eq!(name.matches('.').count(), 3, "日期里两个点 + 扩展名一个点");
        assert!(!name.contains(':'), "冒号在 Finder 里会显示成斜杠，Windows 上是非法字符");
    }

    #[test]
    fn state_round_trip_keeps_backend_and_worker() {
        let dir = std::env::temp_dir().join(format!("rec-test-{}", now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = RecordingState {
            pid: 4242,
            worker_pid: Some(4243),
            backend: "ffmpeg".to_string(),
            path: "/tmp/x.mov".to_string(),
            started_at: 1_788_000_000_000,
            mode: "full".to_string(),
            interactive: false,
            seconds: None,
            audio: true,
            clicks: false,
            paused_at: Some(1_788_000_005_000),
            paused_total_ms: 1_000,
        };
        write_state(&dir, &state).unwrap();
        let read = read_state(&dir).expect("状态文件应该能读回来");
        assert_eq!(read.pid, 4242);
        assert_eq!(read.worker_pid, Some(4243));
        assert_eq!(read.backend, "ffmpeg");
        assert_eq!(read.path, "/tmp/x.mov");
        assert!(read.audio && !read.clicks);
        assert!(read.paused(), "暂停态要跨进程读得回来：托盘 / 面板在不同进程里看它");
        clear_state(&dir);
        assert!(read_state(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn state_written_atomically_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("rec-atomic-{}", now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut state = RecordingState {
            pid: 1,
            worker_pid: None,
            backend: "screencapture".to_string(),
            path: "/tmp/a.mov".to_string(),
            started_at: 1,
            mode: "full".to_string(),
            interactive: false,
            seconds: None,
            audio: false,
            clicks: false,
            paused_at: None,
            paused_total_ms: 0,
        };
        write_state(&dir, &state).unwrap();
        state.pid = 2;
        write_state(&dir, &state).unwrap();
        assert_eq!(read_state(&dir).unwrap().pid, 2, "覆盖写要生效");
        assert!(!dir.join(format!("{STATE_FILE}.tmp")).exists(), "临时文件不该留下");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_state_file_is_ignored() {
        let dir = std::env::temp_dir().join(format!("rec-bad-{}", now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(state_path(&dir), "{ not json").unwrap();
        assert!(read_state(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 暂停的账要算对：暂停期间计时停住、继续之后接着走、来回切不重复扣。
    /// 这个数直接显示在托盘图标菜单上，算错用户第一眼就看见。
    #[test]
    fn pause_math_excludes_paused_time() {
        let mut state = RecordingState {
            pid: 1,
            worker_pid: None,
            backend: "screencapture".to_string(),
            path: "/tmp/a.mov".to_string(),
            started_at: now_millis() - 10_000,
            mode: "full".to_string(),
            interactive: false,
            seconds: None,
            audio: false,
            clicks: false,
            paused_at: None,
            paused_total_ms: 0,
        };
        assert!(!state.paused());
        assert_eq!(state.active_ms() / 1_000, 10, "没暂停时有效时长 = 墙钟");

        state.paused_at = Some(now_millis() - 4_000); // 相当于 4s 前按下的暂停
        assert!(state.paused());
        assert_eq!(state.active_ms() / 1_000, 6, "暂停期间计时停住");

        state.mark_pause(false);
        assert!(!state.paused());
        assert!((4_000..4_500).contains(&state.paused_total_ms), "累计到 {}", state.paused_total_ms);
        assert_eq!(state.active_ms() / 1_000, 6, "继续之后接着走（不把暂停算进去）");

        let total = state.paused_total_ms;
        state.mark_pause(false);
        assert_eq!(state.paused_total_ms, total, "重复「继续」是幂等的（不会重复扣时间）");
        let again = RecordingState { paused_at: Some(now_millis()), ..state.clone() };
        assert_eq!(again.active_ms(), state.active_ms(), "刚暂停的一瞬间不该跳字");
    }

    #[test]
    fn pause_action_resolves_from_names_and_toggles() {
        use serde_json::json;
        assert_eq!(PauseAction::from_args(&json!({ "action": "pause" })), PauseAction::Pause);
        assert_eq!(PauseAction::from_args(&json!({ "action": "resume" })), PauseAction::Resume);
        assert_eq!(PauseAction::from_args(&json!({})), PauseAction::Toggle, "缺省 = 切换（托盘一键用）");
        assert_eq!(PauseAction::from_args(&json!({ "action": "nonsense" })), PauseAction::Toggle);
        assert!(PauseAction::Pause.wanted(false) && PauseAction::Pause.wanted(true), "pause 幂等");
        assert!(!PauseAction::Resume.wanted(false) && !PauseAction::Resume.wanted(true));
        assert!(PauseAction::Toggle.wanted(false));
        assert!(!PauseAction::Toggle.wanted(true));
    }

    #[test]
    fn stop_request_is_a_file_handshake() {
        let dir = std::env::temp_dir().join(format!("rec-stop-{}", now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!stop_requested(&dir));
        request_stop(&dir).unwrap();
        assert!(stop_requested(&dir), "worker 靠它判断该收尾了");
        clear_stop_request(&dir);
        assert!(!stop_requested(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_info_skips_empty_and_missing() {
        let dir = std::env::temp_dir().join(format!("rec-file-{}", now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let empty = dir.join("empty.mov");
        std::fs::write(&empty, b"").unwrap();
        assert!(file_info(&empty).is_none(), "0 字节 = 还没写完");
        let full = dir.join("full.mov");
        std::fs::write(&full, b"hello").unwrap();
        let info = file_info(&full).expect("有内容的文件应该能读到");
        assert_eq!(info.0, 5);
        assert!(info.1 > 0);
        assert!(file_info(&dir.join("nope.mov")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_recent_filters_extensions_and_sorts() {
        let dir = std::env::temp_dir().join(format!("rec-list-{}", now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.mov"), b"aa").unwrap();
        std::fs::write(dir.join("b.png"), b"bb").unwrap();
        std::fs::write(dir.join("note.txt"), b"cc").unwrap();
        let videos = list_recent(&dir, extensions_for("video"), 10);
        assert_eq!(videos.len(), 1);
        assert_eq!(videos[0].name, "a.mov");
        let all = list_recent(&dir, &["mov", "png"], 10);
        assert_eq!(all.len(), 2);
        assert!(list_recent(&dir, &["mov"], 0).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn log_tail_is_truncated_from_the_left() {
        let dir = std::env::temp_dir().join(format!("rec-log-{}", now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("rec-last.log");
        assert_eq!(read_log_tail(&log, 10), "", "没有日志不该炸");
        std::fs::write(&log, "abcdefghij\n").unwrap();
        assert_eq!(read_log_tail(&log, 4), "ghij", "留最后几个字符（报错通常在末尾）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_dirs_are_under_home() {
        assert!(default_dir("video").starts_with(home_dir()));
        assert!(default_dir("image").starts_with(home_dir()));
        assert!(default_dir("video").ends_with("Chassis"));
        if cfg!(windows) {
            assert!(default_dir("image").ends_with("Screenshots"), "Windows 与系统截图工具同目录");
        } else {
            assert!(default_dir("image").ends_with("Chassis"));
        }
    }

    #[test]
    fn pid_helpers_are_conservative() {
        assert!(!pid_alive(-1));
        assert!(!pid_alive(0));
        // 当前进程一定活着 —— 仅 Unix 实现成立；非 unix 是显式的「不支持 ⇒ false」桩
        #[cfg(unix)]
        assert!(pid_alive(std::process::id() as i32));
    }
}

#[cfg(test)]
mod ffmpeg_tests {
    use super::ffmpeg::*;
    use super::*;
    use std::path::Path;

    #[test]
    fn record_args_start_with_global_flags_and_end_with_output() {
        let args = record_args(
            &VideoSource::primary(2560, 1440),
            &options_full(),
            None,
            Path::new("C:\\out\\a.mp4"),
        );
        assert_eq!(args[0], "-y");
        assert_eq!(args[args.len() - 1], "C:\\out\\a.mp4", "输出路径必须最后");
        assert!(!args.iter().any(|arg| arg == "-nostdin"), "worker 靠 stdin 里的 q 收尾");
        let joined = args.join(" ");
        assert!(joined.contains("-f gdigrab -framerate 30 -offset_x 0 -offset_y 0 -video_size 2560x1440 -i desktop"));
        assert!(joined.contains("-c:v libx264"));
        assert!(joined.contains("-pix_fmt yuv420p"));
    }

    #[test]
    fn record_args_add_audio_dshow_and_duration_limit() {
        let mut opts = options_full();
        opts.audio = true;
        opts.seconds = Some(90);
        let args = record_args(&VideoSource::region(800, 600, -100, 20), &opts, Some("麦克风 (USB)"), Path::new("a.mp4"));
        let joined = args.join(" ");
        assert!(joined.contains("-video_size 800x600"), "区域录制 = 偏移 + 尺寸");
        assert!(joined.contains("-offset_x -100"), "多屏时偏移可以为负");
        assert!(joined.contains("-f dshow -i audio=麦克风 (USB)"), "dshow 设备名按原样拼");
        assert!(joined.contains("-c:a aac -b:a 128k"));
        assert!(joined.contains("-t 90"), "限时是输出选项");
    }

    #[test]
    fn record_args_without_audio_have_no_audio_stream() {
        let args = record_args(&VideoSource::primary(1920, 1080), &options_full(), None, Path::new("a.mp4"));
        assert!(!args.iter().any(|arg| arg == "aac"));
        assert!(!args.iter().any(|arg| arg == "dshow"));
    }

    #[test]
    fn parse_audio_devices_reads_only_the_audio_section() {
        let log = r#"
[dshow @ 0x1] "USB Camera" (video)
[dshow @ 0x1]   Alternative name "@device_pnp_\\?\usb#vid"
[dshow @ 0x1] DirectShow video devices (some may be both video and audio devices)
[dshow @ 0x1] "FaceTime HD Camera"
[dshow @ 0x1] DirectShow audio devices
[dshow @ 0x1] "麦克风阵列 (Realtek(R) Audio)"
[dshow @ 0x1]   Alternative name "@device_cm_{33D9A762}"
[dshow @ 0x1] "USB Audio"
"#;
        assert_eq!(parse_audio_devices(log), vec!["麦克风阵列 (Realtek(R) Audio)".to_string(), "USB Audio".to_string()]);
    }

    #[test]
    fn parse_audio_devices_is_empty_without_a_section() {
        assert!(parse_audio_devices("[dshow @ 0x1] \"USB Camera\" (video)").is_empty());
    }

    fn options_full() -> RecordOptions {
        RecordOptions { mode: "full".to_string(), ..Default::default() }
    }
}
