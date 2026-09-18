//! 统一审计（对齐 v1 `apps/kernel/src/audit.ts`；requirements §7.7 / P6）。
//!
//! 所有「插件 → 宿主」的调用都必须经过这里，没有旁路；
//! 唯一例外是底座基础能力（`essential` 出厂插件）—— `set_exempt` 豁免，不进环形缓冲与日志文件
//! （它们不可禁用、调用量大得多，记进来只会把真正需要追溯的记录淹掉）。
//!
//! 落盘：`<dataRoot>/logs/audit-YYYY-MM-DD.jsonl`（本地日期），滚动保留 7 天。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use chrono::{Datelike, Local, NaiveDate, TimeZone};
use serde_json::Value;

use crate::contract::{AuditRecord, ErrorShape};
use crate::util::now_ms;
use crate::util::text::truncate_for_audit;

/// 内存环形缓冲容量（设置页「最近审计」与「导出日志」的会话范围都取它）
pub const RING_SIZE: usize = 500;
const KEEP_DAYS: i64 = 7;

#[derive(Debug, Clone)]
pub struct AuditInput {
    pub plugin_id: String,
    pub channel: &'static str,
    pub method: String,
    pub ok: bool,
    pub ms: i64,
    pub capability: Option<String>,
    pub error: Option<ErrorShape>,
    pub args: Option<Value>,
}

pub struct AuditLog {
    dir: PathBuf,
    ring: Mutex<Vec<AuditRecord>>,
    persist_lock: Mutex<()>,
    ready: AtomicBool,
    exempt: Mutex<Box<dyn Fn(&str) -> bool + Send + Sync>>,
}

impl AuditLog {
    pub fn new(data_root: &Path) -> Self {
        Self {
            dir: data_root.join("logs"),
            ring: Mutex::new(Vec::new()),
            persist_lock: Mutex::new(()),
            ready: AtomicBool::new(false),
            exempt: Mutex::new(Box::new(|_| false)),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 底座基础能力（essential）的调用等价于底座自身的行为，不记审计。
    pub fn set_exempt(&self, predicate: impl Fn(&str) -> bool + Send + Sync + 'static) {
        *self.exempt.lock().unwrap_or_else(|err| err.into_inner()) = Box::new(predicate);
    }

    pub fn init(&self) {
        let _ = std::fs::create_dir_all(&self.dir);
        self.ready.store(true, Ordering::SeqCst);
        self.rotate();
    }

    pub fn record(&self, input: AuditInput) -> AuditRecord {
        let mut record = AuditRecord {
            ts: now_ms(),
            plugin_id: input.plugin_id.clone(),
            channel: input.channel.to_string(),
            method: input.method,
            ok: input.ok,
            ms: input.ms.max(0),
            capability: input.capability.unwrap_or_default(),
            error: input.error,
            truncated_args: None,
        };

        let exempt = {
            let predicate = self.exempt.lock().unwrap_or_else(|err| err.into_inner());
            predicate(&record.plugin_id)
        };
        if exempt {
            return record;
        }

        if let Some(args) = &input.args {
            let text = truncate_for_audit(args, 200);
            if !text.is_empty() {
                record.truncated_args = Some(text);
            }
        }

        {
            let mut ring = self.ring.lock().unwrap_or_else(|err| err.into_inner());
            ring.push(record.clone());
            if ring.len() > RING_SIZE {
                let excess = ring.len() - RING_SIZE;
                ring.drain(0..excess);
            }
        }
        self.persist(&record);
        record
    }

    /// 最近的记录在前（环形缓冲反序），支持 pluginId / method 子串 / ok 过滤。
    pub fn query(&self, plugin_id: Option<&str>, method: Option<&str>, ok: Option<bool>, limit: usize) -> Vec<AuditRecord> {
        let ring = self.ring.lock().unwrap_or_else(|err| err.into_inner());
        let mut list: Vec<AuditRecord> = ring.iter().rev().cloned().collect();
        if let Some(plugin_id) = plugin_id {
            list.retain(|record| record.plugin_id == plugin_id);
        }
        if let Some(method) = method {
            list.retain(|record| record.method.contains(method));
        }
        if let Some(ok) = ok {
            list.retain(|record| record.ok == ok);
        }
        list.truncate(limit);
        list
    }

    /// 滚动保留 7 天。
    pub fn rotate(&self) {
        let cutoff_ms = now_ms() - KEEP_DAYS * 24 * 3600 * 1000;
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(date) = parse_audit_name(&name) else { continue };
            let Some(day_start) = NaiveDate::parse_from_str(&date, "%Y-%m-%d")
                .ok()
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|naive| naive.and_utc().timestamp_millis())
            else {
                continue;
            };
            if day_start < cutoff_ms {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    pub fn clear(&self) {
        self.ring.lock().unwrap_or_else(|err| err.into_inner()).clear();
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().ends_with(".jsonl") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    fn persist(&self, record: &AuditRecord) {
        if !self.ready.load(Ordering::SeqCst) {
            return;
        }
        let Ok(line) = serde_json::to_string(record) else { return };
        let file = self.dir.join(format!("audit-{}.jsonl", day_key(record.ts)));
        let _guard = self.persist_lock.lock().unwrap_or_else(|err| err.into_inner());
        if let Ok(mut handle) = OpenOptions::new().create(true).append(true).open(file) {
            let _ = writeln!(handle, "{line}");
        }
    }
}

fn day_key(ts: i64) -> String {
    Local
        .timestamp_millis_opt(ts)
        .single()
        .map(|datetime| format!("{:04}-{:02}-{:02}", datetime.year(), datetime.month(), datetime.day()))
        .unwrap_or_else(|| "1970-01-01".to_string())
}

fn parse_audit_name(name: &str) -> Option<String> {
    let rest = name.strip_prefix("audit-")?.strip_suffix(".jsonl")?;
    let bytes = rest.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| rest.get(range).is_some_and(|part| part.chars().all(|ch| ch.is_ascii_digit()));
    (digits(0..4) && digits(5..7) && digits(8..10)).then(|| rest.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input(plugin_id: &str, method: &str, ok: bool) -> AuditInput {
        AuditInput {
            plugin_id: plugin_id.to_string(),
            channel: "ui",
            method: method.to_string(),
            ok,
            ms: 3,
            capability: Some("storage".to_string()),
            error: None,
            args: None,
        }
    }

    #[test]
    fn records_into_ring_and_filters() {
        let log = AuditLog::new(Path::new("/tmp/nowhere-audit"));
        log.record(input("a", "storage.get", true));
        log.record(input("a", "storage.set", false));
        log.record(input("b", "clipboard.writeText", true));

        assert_eq!(log.query(None, None, None, 10).len(), 3);
        assert_eq!(log.query(Some("a"), None, None, 10).len(), 2);
        assert_eq!(log.query(None, Some("storage"), None, 10).len(), 2);
        assert_eq!(log.query(None, None, Some(false), 10).len(), 1);
        assert_eq!(log.query(None, None, None, 1).len(), 1, "limit 生效");
    }

    #[test]
    fn exempt_plugins_skip_ring_and_disk() {
        let dir = std::env::temp_dir().join(format!("audit-exempt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let log = AuditLog::new(&dir);
        log.init();
        log.set_exempt(|plugin_id| plugin_id.starts_with("internal-") || plugin_id == "app-launcher");

        let record = log.record(input("app-launcher", "search", true));
        assert_eq!(record.ok, true);
        assert!(log.query(None, None, None, 10).is_empty(), "豁免插件不进环形缓冲");

        log.record(input("third-party", "storage.get", true));
        assert_eq!(log.query(None, None, None, 10).len(), 1);
        let files: Vec<String> = std::fs::read_dir(dir.join("logs"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(files.len(), 1, "只有非豁免记录落盘");

        // 打码与截断
        let masked = log.record(AuditInput { args: Some(json!({ "token": "secret-value" })), ..input("third-party", "storage.set", true) });
        assert!(masked.truncated_args.as_deref().unwrap_or_default().contains("***"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotate_removes_old_files_and_clear_wipes() {
        let dir = std::env::temp_dir().join(format!("audit-rotate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // 审计文件落在 `<dataRoot>/logs/`（AuditLog 自己拼子目录）
        let logs = dir.join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("audit-2000-01-01.jsonl"), "old\n").unwrap();
        std::fs::write(logs.join("audit-notes.txt"), "keep\n").unwrap();

        let log = AuditLog::new(&dir);
        log.init();
        assert!(!logs.join("audit-2000-01-01.jsonl").exists(), "过期文件被滚动清理");
        assert!(logs.join("audit-notes.txt").exists(), "非审计文件不动");

        log.record(input("a", "x", true));
        log.clear();
        let remaining: Vec<String> = std::fs::read_dir(&logs)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".jsonl"))
            .collect();
        assert!(remaining.is_empty(), "clear 删掉全部 jsonl");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn day_key_is_local_date() {
        let key = day_key(now_ms());
        assert_eq!(key.len(), 10);
        assert_eq!(&key[4..5], "-");
        assert!(parse_audit_name(&format!("audit-{key}.jsonl")).is_some());
        assert!(parse_audit_name("audit-nope.jsonl").is_none());
    }
}
