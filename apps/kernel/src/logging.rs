//! 日志：一律走 stderr，格式 `[kernel:<level>] ...`（stdout 是壳的 JSON-RPC 通道，不能污染）。
//!
//! 与 v1（`main.ts` 把 console 全重定向到 stderr）等价；日志格式是排障接口，刻意保持稳定。
//!
//! 除 stderr 外，这里还维护两份**内核自己**的日志副本，供设置页「导出日志」使用：
//! - 内存环形缓冲（最近 `RING_SIZE` 条）=「最近一次会话」（本次进程运行期）；
//! - `<dataRoot>/logs/kernel.log`（append，超过 `LOG_FILE_MAX_BYTES` 在启动时轮转成 `kernel.log.1`）
//!   =「全部日志」（跨运行）。
//!
//! 壳另有一份 `shell.log`（内核 stderr 的转发副本 + 壳自身日志），与本模块无关。

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::{Local, TimeZone};

/// 环形缓冲容量（也是「最近一次会话」导出的条数上限）
pub const RING_SIZE: usize = 2000;
/// 单次导出读取日志文件的字节上限（超出只保留尾部）
pub const EXPORT_READ_MAX_BYTES: usize = 2 * 1024 * 1024;
/// `kernel.log` 超过该大小就在启动时轮转成 `kernel.log.1`（只留一代）
const LOG_FILE_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// `logs/exports/` 里保留的导出文件份数（超出按文件名时间序删旧的）
const EXPORT_KEEP: usize = 10;

/// 落盘句柄。`init` 之前为空：日志只走 stderr 与环形缓冲（早于数据目录就绪的日志不能丢）。
struct Sink {
    file: Option<File>,
    dir: Option<PathBuf>,
    path: Option<PathBuf>,
}

static SINK: Mutex<Sink> = Mutex::new(Sink { file: None, dir: None, path: None });
/// 本次进程运行期的日志（「最近一次会话」的导出源）
static RING: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
/// 本次会话的起点（首次写日志的时刻）
static SESSION_START_MS: OnceLock<i64> = OnceLock::new();

/// 打开 `<dataRoot>/logs/kernel.log`（建目录 + 按大小轮转）。
///
/// 调用点：`run()` 在数据目录就绪之后、装配之前；此前的日志只有 stderr 与环形缓冲。
pub fn init(data_root: &Path) {
    let dir = data_root.join("logs");
    if let Err(err) = std::fs::create_dir_all(&dir) {
        eprintln!("[kernel:warn] 无法创建日志目录 {}：{err}", dir.display());
        return;
    }
    let path = dir.join("kernel.log");
    rotate(&path);
    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(file) => {
            let mut sink = SINK.lock().unwrap_or_else(|err| err.into_inner());
            sink.file = Some(file);
            sink.dir = Some(dir);
            sink.path = Some(path.clone());
        }
        Err(err) => eprintln!("[kernel:warn] 无法打开日志文件 {}：{err}", path.display()),
    }
    emit("info", &format!("──── 内核启动 ──── 日志文件：{}", path.display()));
}

fn rotate(path: &Path) {
    let Ok(meta) = std::fs::metadata(path) else { return };
    if meta.len() < LOG_FILE_MAX_BYTES {
        return;
    }
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else { return };
    let _ = std::fs::rename(path, path.with_file_name(format!("{name}.1")));
}

pub fn emit(level: &str, message: &str) {
    let ts = crate::util::now_ms();
    let _ = SESSION_START_MS.set(ts);
    // stderr 保持原格式：壳会连同自己的时间戳一起转发到 shell.log
    {
        let stderr = std::io::stderr();
        let mut handle = stderr.lock();
        let _ = writeln!(handle, "[kernel:{level}] {message}");
    }
    // ring 与文件里一行一条（消息内的换行转义掉，别把一条拆成多条）
    let line = format!("{} [kernel:{level}] {}", format_local(ts), message.replace('\n', "\\n"));
    {
        let mut ring = RING.lock().unwrap_or_else(|err| err.into_inner());
        ring.push_back(line.clone());
        if ring.len() > RING_SIZE {
            let excess = ring.len() - RING_SIZE;
            ring.drain(0..excess);
        }
    }
    let mut sink = SINK.lock().unwrap_or_else(|err| err.into_inner());
    if let Some(file) = sink.file.as_mut() {
        let _ = writeln!(file, "{line}");
        let _ = file.flush();
    }
}

// ── 导出读取（设置页「导出日志」的数据源）────────────────────────

/// 本次会话（进程运行期）的日志行。返回 `(行, 是否被环形容量截断)`。
pub fn session_lines() -> (Vec<String>, bool) {
    let ring = RING.lock().unwrap_or_else(|err| err.into_inner());
    (ring.iter().cloned().collect(), ring.len() >= RING_SIZE)
}

pub fn session_count() -> usize {
    RING.lock().unwrap_or_else(|err| err.into_inner()).len()
}

/// 本次会话的起点（首次写日志的时刻）
pub fn session_start_ms() -> i64 {
    *SESSION_START_MS.get_or_init(crate::util::now_ms)
}

pub fn log_path() -> Option<PathBuf> {
    SINK.lock().unwrap_or_else(|err| err.into_inner()).path.clone()
}

/// 读 `kernel.log`（含轮转的 `kernel.log.1`）内容，最多 `max_bytes` 字节；
/// 超出时只保留**尾部**并按行对齐（首个完整行起）。返回 `(文本, 是否截断)`。
pub fn read_log_file(max_bytes: usize) -> (String, bool) {
    let dir = SINK.lock().unwrap_or_else(|err| err.into_inner()).dir.clone();
    let Some(dir) = dir else { return (String::new(), false) };
    let mut merged = String::new();
    for name in ["kernel.log.1", "kernel.log"] {
        if let Ok(text) = std::fs::read_to_string(dir.join(name)) {
            merged.push_str(&text);
        }
    }
    tail_aligned(&merged, max_bytes)
}

/// 只保留尾部 `max_bytes`，切点落在字符边界上、并从首个完整行起（中文是多字节，裸切会 panic）。
fn tail_aligned(text: &str, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text.to_string(), false);
    }
    let mut cut = text.len() - max_bytes;
    while cut < text.len() && !text.is_char_boundary(cut) {
        cut += 1;
    }
    let tail = &text[cut..];
    let start = tail.find('\n').map(|index| index + 1).unwrap_or(0);
    (tail[start..].to_string(), true)
}

/// 把导出内容写进 `<dataRoot>/logs/exports/<filename>`（顺带清理旧导出），返回写入路径。
pub fn write_export_file(filename: &str, content: &str) -> std::io::Result<PathBuf> {
    let dir = SINK.lock().unwrap_or_else(|err| err.into_inner()).dir.clone();
    let Some(dir) = dir else {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "日志目录未就绪（内核尚未完成启动）"));
    };
    let exports = dir.join("exports");
    std::fs::create_dir_all(&exports)?;
    let path = exports.join(filename);
    std::fs::write(&path, content)?;
    prune_exports(&exports);
    Ok(path)
}

fn prune_exports(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "txt"))
        .collect();
    if files.len() <= EXPORT_KEEP {
        return;
    }
    files.sort(); // 文件名带时间戳 ⇒ 字典序即时间序
    let excess = files.len() - EXPORT_KEEP;
    for path in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(path);
    }
}

/// 本地时间 `2026-09-18 15:30:45.123`（导出文件与人读日志用）
pub fn format_local(ms: i64) -> String {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|datetime| datetime.format("%Y-%m-%d %H:%M:%S%.3f").to_string())
        .unwrap_or_else(|| ms.to_string())
}

/// 文件名用的紧凑时间 `20260918-153045`
pub fn format_stamp(ms: i64) -> String {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|datetime| datetime.format("%Y%m%d-%H%M%S").to_string())
        .unwrap_or_else(|| ms.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    // ⚠️ 这些用例共享进程级的 SINK / RING / SESSION_START_MS（cargo test 默认多线程）：
    // 断言一律用「包含」而不是「等于」，且只有下面这一个用例碰 `init`（其余只碰环形缓冲）。

    #[test]
    fn formats_local_times() {
        // 2026-09-18 00:00:00 UTC+8 附近：只断言形状（本地时区随机器）
        let text = format_local(1_787_000_000_000);
        assert_eq!(text.len(), 23, "{text}");
        assert_eq!(&text[4..5], "-");
        assert_eq!(&text[10..11], " ");
        let stamp = format_stamp(1_787_000_000_000);
        assert_eq!(stamp.len(), 15, "{stamp}");
        assert_eq!(&stamp[8..9], "-");
    }

    #[test]
    fn emit_feeds_session_ring() {
        let marker = format!("session-probe-{}", crate::util::now_ms());
        emit("info", &marker);
        let (lines, _) = session_lines();
        assert!(lines.iter().any(|line| line.contains(&marker)), "会话缓冲应包含刚写入的行");
        assert!(session_count() >= 1);
    }

    #[test]
    fn session_ring_drops_oldest_beyond_capacity() {
        emit("info", "ring-probe-first");
        for index in 0..RING_SIZE + 100 {
            emit("debug", &format!("ring-probe-{index}"));
        }
        let (lines, truncated) = session_lines();
        assert_eq!(lines.len(), RING_SIZE, "环形缓冲不得超过容量");
        assert!(truncated, "写满即视为截断");
        assert!(!lines.iter().any(|line| line.contains("ring-probe-first")), "最早的日志应被挤出");
    }

    #[test]
    fn tail_alignment_keeps_whole_lines() {
        let text = "第一行\n第二行-中文\n";
        let (tail, truncated) = tail_aligned(text, 20);
        assert!(truncated);
        assert_eq!(tail, "第二行-中文\n", "应从完整行起");
        assert!(tail.len() <= 20);

        let (whole, truncated) = tail_aligned(text, 1024);
        assert_eq!(whole, text);
        assert!(!truncated);

        // 切点落在多字节字符中间：回退到字符边界，不能 panic
        let (partial, truncated) = tail_aligned("中文中文中文", 7);
        assert!(truncated);
        assert_eq!(partial, "中文");
    }

    #[test]
    fn export_file_roundtrip_truncate_and_prune() {
        let dir = std::env::temp_dir().join(format!("kernel-log-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        init(&dir);

        // 写入 → 读回（含轮转文件与当前文件两支）
        let marker = format!("export-probe-{}", crate::util::now_ms());
        emit("info", &marker);
        let (text, truncated) = read_log_file(EXPORT_READ_MAX_BYTES);
        assert!(!truncated);
        assert!(text.contains(&marker), "日志文件应包含刚写入的行");
        assert!(log_path().is_some_and(|path| path.ends_with("kernel.log")));

        // 轮转：超过阈值 → 启动时改名 kernel.log.1
        let big = "x".repeat((LOG_FILE_MAX_BYTES + 16) as usize);
        std::fs::write(dir.join("logs").join("kernel.log"), &big).unwrap();
        init(&dir);
        let rotated = dir.join("logs").join("kernel.log.1");
        assert!(rotated.exists(), "超过阈值应轮转成 kernel.log.1");
        assert!(std::fs::metadata(&rotated).unwrap().len() >= LOG_FILE_MAX_BYTES);
        // 用足够大的上限读：确认连轮转文件一起读，且从最老的一段开始
        let (merged, truncated) = read_log_file(8 * 1024 * 1024);
        assert!(!truncated);
        assert!(merged.starts_with(&big[..64]), "「全部日志」应连同轮转文件一起读");

        // 导出文件写入 + 只保留最近 EXPORT_KEEP 份
        for index in 0..EXPORT_KEEP + 2 {
            write_export_file(&format!("chassis-logs-session-2026091{index}-000000.txt"), "x").unwrap();
        }
        let exported: Vec<String> = std::fs::read_dir(dir.join("logs").join("exports"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(exported.len(), EXPORT_KEEP, "旧导出应被清理：{exported:?}");
        assert!(exported.iter().all(|name| name.ends_with(".txt")));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
