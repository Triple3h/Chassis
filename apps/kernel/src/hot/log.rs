//! 热更新日志：一行一条 JSON（JSONL），落在 `<dataRoot>/hot/hot-update.log`。
//!
//! 每行都带 `ts`（本地时间，毫秒精度）与 `hotVersion`（0.1.0）——
//! 「时间 + 版本号 + 变更模块 + 结果」四项在每一行里都能读出来（`type` 区分记录种类）。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{Local, SecondsFormat};
use serde_json::{json, Value};

use crate::hot::spec::HOT_UPDATE_VERSION;

pub const LOG_FILE: &str = "hot-update.log";

#[derive(Clone)]
pub struct HotLog {
    inner: Arc<Inner>,
}

struct Inner {
    path: PathBuf,
    file: Mutex<Option<File>>,
}

impl HotLog {
    pub fn new(dir: &Path) -> Self {
        Self {
            inner: Arc::new(Inner {
                path: dir.join(LOG_FILE),
                file: Mutex::new(None),
            }),
        }
    }

    pub fn path(&self) -> &Path {
        &self.inner.path
    }

    /// 追加一行；调用方给的 `entry` 会自动补 `ts` / `hotVersion`。
    ///
    /// 日志写失败**不能**影响热更新本身（返回 ()，错误只进 stderr）——
    /// 日志是观测手段，不是业务前置条件。
    pub fn append(&self, mut entry: Value) {
        if let Value::Object(ref mut map) = entry {
            map.insert("ts".to_string(), json!(now_rfc3339()));
            map.entry("hotVersion".to_string()).or_insert_with(|| json!(HOT_UPDATE_VERSION));
        }
        let line = match serde_json::to_string(&entry) {
            Ok(line) => line,
            Err(err) => {
                eprintln!("[kernel] 热更新日志序列化失败：{err}");
                return;
            }
        };
        let mut guard = self.inner.file.lock().unwrap_or_else(|err| err.into_inner());
        if guard.is_none() {
            if let Some(parent) = self.inner.path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            match OpenOptions::new().create(true).append(true).open(&self.inner.path) {
                Ok(file) => *guard = Some(file),
                Err(err) => {
                    eprintln!("[kernel] 热更新日志打开失败（{}）：{err}", self.inner.path.display());
                    return;
                }
            }
        }
        if let Some(file) = guard.as_mut() {
            if let Err(err) = writeln!(file, "{line}") {
                eprintln!("[kernel] 热更新日志写入失败：{err}");
                *guard = None; // 下次重新打开
            }
        }
    }

    /// 读最近 `limit` 条（旧 → 新）；文件不存在返回空。
    pub fn read_tail(&self, limit: usize) -> Vec<Value> {
        let Ok(text) = fs::read_to_string(&self.inner.path) else {
            return Vec::new();
        };
        let mut entries: Vec<Value> = text
            .lines()
            .rev()
            .take(limit)
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        entries.reverse();
        entries
    }
}

fn now_rfc3339() -> String {
    Local::now().to_rfc3339_opts(SecondsFormat::Millis, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_and_reads_back_with_version_and_timestamp() {
        let dir = std::env::temp_dir().join(format!("hot-log-test-{}", crate::util::now_ms()));
        let log = HotLog::new(&dir);
        log.append(json!({ "type": "apply", "result": "applied", "modules": ["routes"] }));
        log.append(json!({ "type": "rollback", "result": "rolled-back" }));

        let tail = log.read_tail(10);
        assert_eq!(tail.len(), 2);
        assert_eq!(tail[0]["type"], "apply");
        assert_eq!(tail[0]["hotVersion"], HOT_UPDATE_VERSION, "每行都要带机制版本");
        assert!(tail[0]["ts"].as_str().unwrap_or_default().len() >= 19, "每行都要带 ISO 时间戳");
        assert_eq!(tail[1]["type"], "rollback");

        assert_eq!(log.read_tail(1).len(), 1, "limit 生效");
        let _ = fs::remove_dir_all(&dir);
    }
}
