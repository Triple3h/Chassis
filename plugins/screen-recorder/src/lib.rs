//! 录屏助手逻辑层：纯逻辑（参数组装 / 状态文件 / 进程探活 / 产物清点）+ 少量平台封装，
//! 胶水在 `src/bin/*`。
//!
//! **本插件整包只在 macOS 上有意义**（清单已声明 `platforms: ["macos"]`，内核扫描期直接跳过），
//! 因为录屏 / 截图全部落在系统 `screencapture` 与 CoreGraphics 的 TCC 权限上；下面的平台分支只是
//! 「万一被手工拉起」时的兜底，不是第二套后端。
//!
//! 设计要点：
//! - 录制 = 拉起系统的 `screencapture`（`-v` 录视频 / `-i -J video` 交互选区域或窗口），
//!   pid 与输出路径写进 `<dataPath>/recording.json`；
//! - 停止 = 给该 pid 发 `SIGINT`（等价于终端里 Ctrl+C，screencapture 会收尾并写完文件），
//!   再等它退场；
//! - 屏幕录制权限（macOS 10.15+ 的 TCC）用 CoreGraphics 的 preflight / request 查询与申请；
//! - 平台限定代码一律 `#[cfg(target_os = "macos")]` 隔离，其它平台给出明确的不支持提示。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const STATE_FILE: &str = "recording.json";

/// 录制进程的状态：写盘后即使在别的脚本进程里也能读到同一段录制
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingState {
    pub pid: i32,
    pub path: String,
    pub started_at: u64,
    pub mode: String,
    pub interactive: bool,
    #[serde(default)]
    pub seconds: Option<u64>,
    pub audio: bool,
    pub clicks: bool,
}

/// `rec-start` / `rec-shot` 的入参（都从 `ctx.raw_args()` 来）
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordOptions {
    /// `full` / `region` / `window`
    pub mode: String,
    pub delay_sec: u64,
    pub seconds: Option<u64>,
    pub audio: bool,
    pub clicks: bool,
    pub cursor: bool,
    pub dir: Option<String>,
    pub file_name: Option<String>,
}

impl RecordOptions {
    pub fn from_args(args: &serde_json::Value) -> Self {
        let mode = args
            .get("mode")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("full")
            .to_string();
        let mode = if ["full", "region", "window"].contains(&mode.as_str()) { mode } else { "full".to_string() };
        Self {
            mode,
            delay_sec: args.get("delaySec").and_then(serde_json::Value::as_u64).unwrap_or(0).min(60),
            seconds: args.get("seconds").and_then(serde_json::Value::as_u64).filter(|value| *value > 0),
            audio: args.get("audio").and_then(serde_json::Value::as_bool).unwrap_or(false),
            clicks: args.get("clicks").and_then(serde_json::Value::as_bool).unwrap_or(false),
            cursor: args.get("cursor").and_then(serde_json::Value::as_bool).unwrap_or(false),
            dir: args.get("dir").and_then(serde_json::Value::as_str).map(str::to_string),
            file_name: args.get("fileName").and_then(serde_json::Value::as_str).map(str::to_string),
        }
    }

    pub fn interactive(&self) -> bool {
        self.mode == "region" || self.mode == "window"
    }
}

/// 录制参数 → `screencapture` 命令行参数（不含可执行文件本身；最后一个参数是输出路径）
pub fn record_args(options: &RecordOptions, out: &Path) -> Vec<String> {
    let mut args: Vec<String> = vec!["-v".into(), "-x".into()];
    match options.mode.as_str() {
        "region" => {
            args.push("-i".into());
            args.push("-s".into()); // 只允许框选
            args.push("-J".into());
            args.push("video".into());
        }
        "window" => {
            args.push("-i".into());
            args.push("-w".into()); // 只允许选窗口
            args.push("-J".into());
            args.push("video".into());
        }
        _ => {
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

/// 截图参数 → `screencapture` 参数。`mode`：full / region / window / clipboard
pub fn shot_args(mode: &str, delay_sec: u64, cursor: bool, out: &Path) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    match mode {
        "region" => args.push("-i".into()),
        "window" => args.push("-w".into()),
        "clipboard" => args.push("-c".into()),
        _ => {}
    }
    args.push("-x".into());
    if cursor {
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

// ── 状态文件 ─────────────────────────────────────────────────────────

pub fn state_path(data_path: &Path) -> PathBuf {
    data_path.join(STATE_FILE)
}

pub fn read_state(data_path: &Path) -> Option<RecordingState> {
    let text = std::fs::read_to_string(state_path(data_path)).ok()?;
    serde_json::from_str::<RecordingState>(&text).ok()
}

pub fn write_state(data_path: &Path, state: &RecordingState) -> std::io::Result<()> {
    std::fs::create_dir_all(data_path)?;
    let text = serde_json::to_string_pretty(state).unwrap_or_default();
    std::fs::write(state_path(data_path), text)
}

pub fn clear_state(data_path: &Path) {
    let _ = std::fs::remove_file(state_path(data_path));
}

// ── 时间 / 路径 / 文件 ───────────────────────────────────────────────

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"))
}

/// 默认落盘目录：视频进 `~/Movies/Chassis`，图片进 `~/Pictures/Chassis`
pub fn default_dir(kind: &str) -> PathBuf {
    let home = home_dir();
    if kind == "image" {
        home.join("Pictures").join("Chassis")
    } else {
        home.join("Movies").join("Chassis")
    }
}

pub fn ensure_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// 文件名：`录屏 2026-09-17 15.04.22.mov`（冒号在 Finder 里会被显示成斜杠，换成点）
pub fn make_file_name(prefix: &str, ext: &str, now: SystemTime) -> String {
    let datetime: chrono::DateTime<chrono::Local> = now.into();
    format!("{} {}.{}", prefix, datetime.format("%Y-%m-%d %H.%M.%S"), ext)
}

/// 产物信息：`(字节数, mtime 毫秒)`；文件不存在或还没写完（0 字节）返回 None
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

// ── 进程 ─────────────────────────────────────────────────────────────

#[cfg(unix)]
pub fn pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // kill(pid, 0)：不投递信号，只做存在性/权限检查
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(not(unix))]
pub fn pid_alive(pid: i32) -> bool {
    let _ = pid;
    false
}

/// 请录制进程收尾（等价于终端里 Ctrl+C）
#[cfg(unix)]
pub fn send_interrupt(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    unsafe { libc::kill(pid, libc::SIGINT) == 0 }
}

#[cfg(not(unix))]
pub fn send_interrupt(pid: i32) -> bool {
    let _ = pid;
    false
}

// ── 屏幕录制权限（macOS TCC）─────────────────────────────────────────

#[cfg(target_os = "macos")]
mod cg {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGPreflightScreenCaptureAccess() -> bool;
        pub fn CGRequestScreenCaptureAccess() -> bool;
    }
}

/// `Some(true/false)` = 查到了；`None` = 平台不支持
#[cfg(target_os = "macos")]
pub fn screen_capture_granted() -> Option<bool> {
    Some(unsafe { cg::CGPreflightScreenCaptureAccess() })
}

#[cfg(not(target_os = "macos"))]
pub fn screen_capture_granted() -> Option<bool> {
    None
}

/// 触发系统授权提示（macOS 只会弹一次，之后要去系统设置里手动勾）
#[cfg(target_os = "macos")]
pub fn request_screen_capture() -> bool {
    unsafe { cg::CGRequestScreenCaptureAccess() }
}

#[cfg(not(target_os = "macos"))]
pub fn request_screen_capture() -> bool {
    false
}

pub fn platform_supported() -> bool {
    cfg!(target_os = "macos")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn options(mode: &str) -> RecordOptions {
        RecordOptions {
            mode: mode.to_string(),
            ..Default::default()
        }
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
        assert_eq!(
            args,
            vec!["-v", "-x", "-C", "-T", "3", "-g", "-k", "-V", "120", "/tmp/a.mov"]
        );
    }

    #[test]
    fn region_and_window_use_interactive_video_style() {
        let region = record_args(&options("region"), Path::new("/tmp/r.mov"));
        assert_eq!(region, vec!["-v", "-x", "-i", "-s", "-J", "video", "/tmp/r.mov"]);
        let window = record_args(&options("window"), Path::new("/tmp/w.mov"));
        assert_eq!(window, vec!["-v", "-x", "-i", "-w", "-J", "video", "/tmp/w.mov"]);
    }

    #[test]
    fn interactive_modes_do_not_carry_delay() {
        let mut opts = options("region");
        opts.delay_sec = 10;
        opts.cursor = true;
        assert!(!record_args(&opts, Path::new("/tmp/r.mov")).iter().any(|arg| arg == "-T"));
        assert!(!record_args(&opts, Path::new("/tmp/r.mov")).iter().any(|arg| arg == "-C"));
    }

    #[test]
    fn shot_args_cover_four_modes() {
        assert_eq!(shot_args("full", 0, false, Path::new("/tmp/s.png")), vec!["-x", "/tmp/s.png"]);
        assert_eq!(shot_args("region", 0, true, Path::new("/tmp/s.png")), vec!["-i", "-x", "-C", "/tmp/s.png"]);
        assert_eq!(shot_args("window", 0, false, Path::new("/tmp/s.png")), vec!["-w", "-x", "/tmp/s.png"]);
        assert_eq!(shot_args("clipboard", 5, false, Path::new("/tmp/s.png")), vec!["-c", "-x"]);
        assert_eq!(shot_args("full", 5, false, Path::new("/tmp/s.png")), vec!["-x", "-T", "5", "/tmp/s.png"]);
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
        assert_eq!(opts.delay_sec, 60, "延迟封顶 60 秒");
        assert_eq!(opts.seconds, None, "0 秒等于不限时");
        assert!(opts.audio);
        assert_eq!(opts.dir.as_deref(), Some("/tmp"));
    }

    #[test]
    fn file_name_has_readable_timestamp() {
        let now = UNIX_EPOCH + Duration::from_secs(1_788_000_000);
        let name = make_file_name("录屏", "mov", now);
        assert!(name.starts_with("录屏 "));
        assert!(name.ends_with(".mov"));
        assert_eq!(name.matches('.').count(), 3, "日期里两个点 + 扩展名一个点");
        assert!(!name.contains(':'), "冒号在 Finder 里会显示成斜杠");
    }

    #[test]
    fn state_round_trip() {
        let dir = std::env::temp_dir().join(format!("rec-test-{}", now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = RecordingState {
            pid: 4242,
            path: "/tmp/x.mov".to_string(),
            started_at: 1_788_000_000_000,
            mode: "full".to_string(),
            interactive: false,
            seconds: None,
            audio: true,
            clicks: false,
        };
        write_state(&dir, &state).unwrap();
        let read = read_state(&dir).expect("状态文件应该能读回来");
        assert_eq!(read.pid, 4242);
        assert_eq!(read.path, "/tmp/x.mov");
        assert!(read.audio && !read.clicks);
        clear_state(&dir);
        assert!(read_state(&dir).is_none());
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
        let videos = list_recent(&dir, &["mov"], 10);
        assert_eq!(videos.len(), 1);
        assert_eq!(videos[0].name, "a.mov");
        let all = list_recent(&dir, &["mov", "png"], 10);
        assert_eq!(all.len(), 2);
        assert!(list_recent(&dir, &["mov"], 0).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pid_helpers_are_conservative() {
        assert!(!pid_alive(-1));
        assert!(!pid_alive(0));
        assert!(!send_interrupt(-5));
        // 当前进程一定活着
        assert!(pid_alive(std::process::id() as i32));
    }
}
