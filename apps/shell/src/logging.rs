//! 壳的日志：同时写 stderr 与 `<dataRoot>/logs/shell.log`。
//!
//! GUI 启动时 stderr 会被系统丢弃，出问题无法诊断 —— 所以必须落盘（自用排查的第一现场）。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_FILE: Mutex<Option<File>> = Mutex::new(None);
static LOG_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn init(data_root: &Path) {
    let dir = data_root.join("logs");
    if fs::create_dir_all(&dir).is_err() {
        eprintln!("[shell] 无法创建日志目录：{}", dir.display());
        return;
    }
    let path = dir.join("shell.log");
    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(file) => {
            if let Ok(mut slot) = LOG_FILE.lock() {
                *slot = Some(file);
            }
            if let Ok(mut slot) = LOG_PATH.lock() {
                *slot = Some(path.clone());
            }
            log(&format!("──── 启动 ──── shell.log = {}", path.display()));
        }
        Err(err) => eprintln!("[shell] 无法打开日志文件 {}：{err}", path.display()),
    }
}

pub fn log_path() -> Option<PathBuf> {
    LOG_PATH.lock().ok().and_then(|slot| slot.clone())
}

pub fn log(message: &str) {
    let line = format!("{} {message}", timestamp());
    eprintln!("{line}");
    if let Ok(mut guard) = LOG_FILE.lock() {
        if let Some(file) = guard.as_mut() {
            let _ = writeln!(file, "{line}");
            let _ = file.flush();
        }
    }
}

fn timestamp() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    // 用固定格式（本地时区换算交给读日志的人）
    format!("[{secs}.{millis:03}]")
}
