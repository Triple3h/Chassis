//! 剪贴板历史的纯逻辑（跨平台，可单测）。
//!
//! **剪贴板读写不在这里**：`clipboard.rs` 只编 Windows（`platforms: ["windows"]` 的整包声明 +
//! `#[cfg(windows)]` 的后端）；这里只负责「拿到一段内容之后怎么办」—— 去重、过滤、落盘、检索。
//! 这样 macOS 上也能跑这一层的单测（我们无法在 mac 上编译 windows crate）。
//!
//! 落盘布局（`ctx.data_path()`，即 `<dataRoot>/plugins/clipboard-history/`）：
//!  - `history.jsonl`：每条一行，文件顺序 = **旧 → 新**（`record` 只追加，不重写）
//!  - `blobs/<sha1>.png`：图片缩略图（长边 1024）
//!  - `state.json`：暂停开关 / 上次处理过的剪贴板序号 / 自己刚写回的内容 hash
//!
//! 为什么用 JSONL 而不是一个大 JSON：记录是**追加**的，每次复制都要写一次；
//! 只有删除 / 固定 / 清空这类低频操作才整体重写。

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha1::{Digest, Sha1};

/// Windows 剪贴板读写（`CF_UNICODETEXT` / `CF_DIBV5` / `CF_HDROP` + DIB ↔ PNG）。
#[cfg(windows)]
pub mod clipboard;

/// 历史条数上限（设置项可改）。
pub const DEFAULT_MAX_ENTRIES: usize = 500;
/// 单条文本上限：再大就只记「太长不存」这一点事实（避免一条日志把内存和 IPC 打爆）
pub const MAX_TEXT_CHARS: usize = 100_000;
/// 图片缩略图长边（历史存的是缩略图，不是原图 —— 够预览、够贴到多数地方，也控住了容量）
pub const IMAGE_MAX_EDGE: u32 = 1024;
/// 图片 blob 目录总量上限（LRU 淘汰）
pub const BLOBS_MAX_BYTES: u64 = 200 * 1024 * 1024;

const STORE_FILE: &str = "history.jsonl";
const STATE_FILE: &str = "state.json";
const BLOB_DIR: &str = "blobs";
const LOCK_FILE: &str = ".lock";
/// 陈旧锁的抢占阈值：持有者崩了会留下锁文件
const STALE_LOCK_SECS: u64 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Text,
    Image,
    File,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Text => "text",
            Kind::Image => "image",
            Kind::File => "file",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "text" => Some(Kind::Text),
            "image" => Some(Kind::Image),
            "file" => Some(Kind::File),
            _ => None,
        }
    }
}

/// 一条历史（`history.jsonl` 的一行）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// 稳定 id：`kind:hash`（搜索结果项 id 必须稳定，否则固定 / 历史会错位）
    pub id: String,
    pub kind: Kind,
    /// 去重键：同内容只留一条（更新时间与次数）
    pub hash: String,
    pub created_at: i64,
    pub pinned: bool,
    pub uses: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// blob 的相对路径（`blobs/<sha1>.png`）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// `CF_HDROP`：**只存路径引用**，不复制文件内容（文件随时会变 / 被删）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
}

impl Entry {
    pub fn id_of(kind: Kind, hash: &str) -> String {
        format!("{}:{}", kind.as_str(), hash)
    }

    /// 参与搜索的文本（图片 / 文件用它们的「名字」）
    pub fn searchable_text(&self) -> String {
        match self.kind {
            Kind::Text => self.text.clone().unwrap_or_default(),
            Kind::Image => "图片 image screenshot".to_string(),
            Kind::File => match &self.paths {
                Some(paths) => paths.join(" "),
                None => String::new(),
            },
        }
    }
}

/// 插件私有状态（不进历史文件：它是「运行态」，不是记录）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// 暂停记录到这个时间戳（0 = 不暂停；`i64::MAX` = 直到用户手动恢复）
    pub pause_until: i64,
    /// 上次处理过的剪贴板序号（壳每次变化给一个递增序号，同序号不重复处理）
    pub last_change_count: u64,
    /// 自己刚写回剪贴板的内容 hash —— 避免「贴一条历史 → 剪贴板变 → 又被记成新条目」
    pub last_written_hash: String,
}

impl State {
    pub fn is_paused(&self, now: i64) -> bool {
        self.pause_until > now
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub max_entries: usize,
    pub ignore_sensitive: bool,
    pub capture_images: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { max_entries: DEFAULT_MAX_ENTRIES, ignore_sensitive: true, capture_images: true }
    }
}

/// 从宿主注入的设置快照里读（值缺失 / 非法一律回落默认 —— 设置页改值会重载插件，不存在「半合法」）。
pub fn settings_from(values: &Map<String, Value>) -> Settings {
    let max_entries = values
        .get("max-entries")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (50..=5_000).contains(value))
        .unwrap_or(DEFAULT_MAX_ENTRIES);
    let ignore_sensitive = values.get("ignore-sensitive").and_then(Value::as_bool).unwrap_or(true);
    let capture_images = values.get("capture-images").and_then(Value::as_bool).unwrap_or(true);
    Settings { max_entries, ignore_sensitive, capture_images }
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_millis() as i64).unwrap_or(0)
}

pub fn hash_of(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub fn hash_text(text: &str) -> String {
    hash_of(text.as_bytes())
}

// ── 落盘 ────────────────────────────────────────────────────────

pub fn store_file(dir: &Path) -> PathBuf {
    dir.join(STORE_FILE)
}

pub fn state_file(dir: &Path) -> PathBuf {
    dir.join(STATE_FILE)
}

pub fn blob_dir(dir: &Path) -> PathBuf {
    dir.join(BLOB_DIR)
}

/// 读历史（文件顺序 = 旧 → 新）。坏行跳过 —— 一条写坏了不该让整份历史消失。
pub fn load_entries(dir: &Path) -> Vec<Entry> {
    let Ok(text) = fs::read_to_string(store_file(dir)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<Entry>(line) {
            out.push(entry);
        }
    }
    out
}

pub fn save_entries(dir: &Path, entries: &[Entry]) -> Result<(), String> {
    let mut text = String::new();
    for entry in entries {
        let line = serde_json::to_string(entry).map_err(|err| err.to_string())?;
        text.push_str(&line);
        text.push('\n');
    }
    atomic_write(&store_file(dir), text.as_bytes())
}

/// 先写临时文件再 rename：写一半崩了也不会留下半行 JSONL。
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension("tmp");
    fs::write(&temp, bytes).map_err(|err| err.to_string())?;
    match fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = fs::remove_file(&temp);
            Err(err.to_string())
        }
    }
}

pub fn load_state(dir: &Path) -> State {
    let Ok(text) = fs::read_to_string(state_file(dir)) else {
        return State::default();
    };
    serde_json::from_str::<State>(&text).unwrap_or_default()
}

pub fn save_state(dir: &Path, state: &State) -> Result<(), String> {
    let text = serde_json::to_string(state).map_err(|err| err.to_string())?;
    atomic_write(&state_file(dir), text.as_bytes())
}

/// 进程间互斥：多个宿主调用（事件驱动的 `record` 与面板的 `clip-io`）可能同时改历史文件。
///
/// 用「独占创建锁文件 + 陈旧抢占」而不是依赖某个文件锁 crate：这里只需要一把很轻的锁，
/// 且崩溃后必须能自愈（否则用户再也改不动历史）。
pub struct StoreLock {
    path: PathBuf,
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub fn lock_store(dir: &Path) -> Option<StoreLock> {
    let path = dir.join(LOCK_FILE);
    for _ in 0..40 {
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let _ = file.write_all(std::process::id().to_string().as_bytes());
                return Some(StoreLock { path });
            }
            Err(_) => {
                if is_stale(&path) {
                    let _ = fs::remove_file(&path);
                    continue;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }
    None
}

fn is_stale(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else { return false };
    let Ok(modified) = metadata.modified() else { return false };
    modified.elapsed().map(|elapsed| elapsed.as_secs() > STALE_LOCK_SECS).unwrap_or(false)
}

// ── 入库 ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeOutcome {
    /// 新条目（追加了一行）
    Added,
    /// 与最新一条内容相同 → 只刷新时间与次数
    Merged,
    /// 被过滤掉了（太短 / 太敏感 / 太大 / 暂停中）
    Skipped,
}

/// 把一条候选并入历史（**会写盘**）。
///
/// 去重只看**最新一条**：用户连着复制同一段然后去做别的，再复制回来应当是两条。
pub fn append_entry(
    dir: &Path,
    entries: &mut Vec<Entry>,
    candidate: Entry,
    settings: &Settings,
) -> MergeOutcome {
    if let Some(last) = entries.last() {
        if last.hash == candidate.hash {
            let merged = Entry {
                created_at: candidate.created_at,
                uses: last.uses + 1,
                ..last.clone()
            };
            let index = entries.len() - 1;
            entries[index] = merged;
            let _ = save_entries(dir, entries);
            return MergeOutcome::Merged;
        }
    }

    entries.push(candidate);
    trim_entries(entries, settings.max_entries);
    let _ = save_entries(dir, entries);
    MergeOutcome::Added
}

/// 超上限就丢**最旧的**（固定项跳过）；blob 的 LRU 淘汰由调用方在落盘后处理。
pub fn trim_entries(entries: &mut Vec<Entry>, max_entries: usize) {
    if entries.len() <= max_entries {
        return;
    }
    let excess = entries.len() - max_entries;
    let mut doomed: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut marked = 0usize;
    // 文件顺序就是旧 → 新，所以从前往后数够数即可
    for (index, entry) in entries.iter().enumerate() {
        if marked >= excess {
            break;
        }
        if entry.pinned {
            continue;
        }
        doomed.insert(index);
        marked += 1;
    }
    let kept: Vec<Entry> = entries
        .iter()
        .enumerate()
        .filter(|(index, _)| !doomed.contains(index))
        .map(|(_, entry)| entry.clone())
        .collect();
    *entries = kept;
}

/// 淘汰超出容量上限的图片 blob（按历史里的新旧，最旧的先删）。
///
/// 只在**还有条目引用**的前提下删：固定项的图片永远保留。
pub fn prune_blobs(dir: &Path, entries: &[Entry]) -> u64 {
    let blobs = blob_dir(dir);
    let Ok(list) = fs::read_dir(&blobs) else { return 0 };
    let mut total: u64 = 0;
    let mut files: Vec<(PathBuf, u64, i64)> = Vec::new();
    for entry in list.flatten() {
        let Ok(metadata) = entry.metadata() else { continue };
        if !metadata.is_file() {
            continue;
        }
        let modified = metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|value| value.as_millis() as i64).unwrap_or(0);
        total += metadata.len();
        files.push((entry.path(), metadata.len(), modified));
    }
    if total <= BLOBS_MAX_BYTES {
        return 0;
    }

    // 还被引用（且被固定）的不动
    let protected: std::collections::HashSet<String> = entries
        .iter()
        .filter(|entry| entry.pinned)
        .filter_map(|entry| entry.blob.clone())
        .collect();
    files.sort_by(|a, b| a.2.cmp(&b.2));

    let mut freed = 0u64;
    for (path, size, _) in files {
        if total <= BLOBS_MAX_BYTES {
            break;
        }
        let name = path.file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_default();
        if protected.contains(&format!("{BLOB_DIR}/{name}")) || protected.contains(&name) {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            total -= size;
            freed += size;
        }
    }
    freed
}

// ── 检索 ────────────────────────────────────────────────────────

/// 命中打分（与 file-search 同款口径：精确 1.0 / 前缀 0.85 / 包含 0.65）。
pub fn score_entry(entry: &Entry, needle_lower: &str) -> f64 {
    if needle_lower.is_empty() {
        return 0.5;
    }
    let haystack = entry.searchable_text().to_lowercase();
    if haystack.is_empty() {
        return 0.0;
    }
    // 长文本没必要整篇比：前 2000 字符已经覆盖「用户搜的是开头那几个词」的绝大多数情形
    let haystack: String = haystack.chars().take(2000).collect();
    if haystack == needle_lower {
        1.0
    } else if haystack.starts_with(needle_lower) {
        0.85
    } else if haystack.contains(needle_lower) {
        0.65
    } else {
        0.0
    }
}

/// 过滤 + 排序：**固定项永远在最前**，其余按分数、再按时间（新 → 旧）。
pub fn filter_entries(entries: &[Entry], query: &str, kind: Option<Kind>, limit: usize) -> Vec<Entry> {
    let needle = query.trim().to_lowercase();
    let mut scored: Vec<(f64, Entry)> = entries
        .iter()
        .filter(|entry| kind.map_or(true, |wanted| wanted == entry.kind))
        .filter_map(|entry| {
            let score = score_entry(entry, &needle);
            (score > 0.0).then(|| (score, entry.clone()))
        })
        .collect();
    scored.sort_by(|a, b| {
        b.1.pinned
            .cmp(&a.1.pinned)
            .then(b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal))
            .then(b.1.created_at.cmp(&a.1.created_at))
            .then(a.1.id.cmp(&b.1.id))
    });
    scored.into_iter().take(limit).map(|(_, entry)| entry).collect()
}

/// 搜索结果 / 列表的标题（单行、≤ 80 字符）。
pub fn title_of(entry: &Entry) -> String {
    let raw = match entry.kind {
        Kind::Text => first_line(entry.text.as_deref().unwrap_or("")),
        Kind::Image => match (entry.width, entry.height) {
            (Some(width), Some(height)) => format!("图片 {width}×{height}"),
            _ => "图片".to_string(),
        },
        Kind::File => match &entry.paths {
            Some(paths) if paths.len() > 1 => format!("{} 个文件", paths.len()),
            Some(paths) => file_name_of(paths.first().map(String::as_str).unwrap_or("")),
            None => "文件".to_string(),
        },
    };
    let raw = raw.replace(['\n', '\r', '\t'], " ");
    let raw = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if raw.chars().count() > 80 {
        raw.chars().take(79).collect::<String>() + "…"
    } else if raw.is_empty() {
        "（空）".to_string()
    } else {
        raw
    }
}

/// 副标题：相对时间 + 一点元信息（图片尺寸 / 文件大小 / 文本行数）。
pub fn subtitle_of(entry: &Entry, now: i64) -> String {
    let tail = match entry.kind {
        Kind::Text => {
            let text = entry.text.as_deref().unwrap_or("");
            let chars = text.chars().count();
            let lines = text.lines().count();
            if lines > 1 {
                format!("{chars} 字 · {lines} 行")
            } else {
                format!("{chars} 字")
            }
        }
        Kind::Image => match (entry.width, entry.height) {
            (Some(width), Some(height)) => format!("{width}×{height}"),
            _ => "图片".to_string(),
        },
        Kind::File => match &entry.paths {
            Some(paths) if paths.len() > 1 => paths
                .iter()
                .take(2)
                .map(|path| file_name_of(path))
                .collect::<Vec<_>>()
                .join("、"),
            Some(paths) => paths.first().map(|path| path.to_string()).unwrap_or_default(),
            None => String::new(),
        },
    };
    let time = relative_time(entry.created_at, now);
    if tail.is_empty() {
        time
    } else {
        format!("{time} · {tail}")
    }
}

/// 相对时间（只差毫秒就能算，不需要时区 —— 绝对时间交给 view 侧用 `Date` 渲染）。
pub fn relative_time(ts: i64, now: i64) -> String {
    let diff = now.saturating_sub(ts).max(0);
    let minutes = diff / 60_000;
    if minutes < 1 {
        return "刚刚".to_string();
    }
    if minutes < 60 {
        return format!("{minutes} 分钟前");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours} 小时前");
    }
    let days = hours / 24;
    if days < 30 {
        return format!("{days} 天前");
    }
    format!("{} 个月前", days / 30)
}

pub fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or("").to_string()
}

pub fn file_name_of(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let name = normalized.rsplit('/').next().unwrap_or(path);
    if name.is_empty() {
        path.to_string()
    } else {
        name.to_string()
    }
}

/// 数据目录就位（历史文件、blob 目录都在这里）。
pub fn ensure_dirs(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|err| format!("创建数据目录失败：{err}"))?;
    fs::create_dir_all(blob_dir(dir)).map_err(|err| format!("创建图片目录失败：{err}"))
}

/// 交给 view / 搜索结果的展示形态。
///
/// 标题与副标题**只在这里算一次**：view 与贡献型搜索共用它，避免两边各写一份摘要逻辑
/// （双份实现漂移的经典事故：一处改了截断长度，另一处没改）。
pub fn entry_to_value(entry: &Entry, now: i64) -> Value {
    let mut item = serde_json::json!({
        "id": entry.id,
        "kind": entry.kind.as_str(),
        "title": title_of(entry),
        "subtitle": subtitle_of(entry, now),
        "createdAt": entry.created_at,
        "pinned": entry.pinned,
        "uses": entry.uses,
    });
    if let Some(text) = &entry.text {
        item["text"] = Value::String(text.clone());
    }
    if let Some(width) = entry.width {
        item["width"] = Value::from(width);
    }
    if let Some(height) = entry.height {
        item["height"] = Value::from(height);
    }
    if let Some(paths) = &entry.paths {
        item["paths"] = Value::Array(paths.iter().map(|path| Value::String(path.clone())).collect());
    }
    item["hasBlob"] = Value::Bool(entry.blob.is_some());
    item
}

/// 给裸 DIB 补上 BMP 文件头（剪贴板的 `CF_DIB` 只有 `BITMAPINFOHEADER + 像素`，
/// 而 `image` 认的是完整 BMP —— 差的就是这 14 字节）。
///
/// 放在这一层而不是 `clipboard.rs`：它是纯字节操作，放在这里 macOS 上也能跑单测
/// （Windows 那一整支在 mac 上根本不编译）。
pub fn dib_to_bmp(dib: &[u8]) -> Option<Vec<u8>> {
    if dib.len() < 40 {
        return None;
    }
    let le32 = |range: std::ops::Range<usize>| -> Option<u32> { Some(u32::from_le_bytes(dib.get(range)?.try_into().ok()?)) };
    let header_size = le32(0..4)? as usize;
    if header_size < 40 || header_size > dib.len() {
        return None;
    }
    let bit_count = u16::from_le_bytes(dib.get(14..16)?.try_into().ok()?);
    let compression = le32(16..20)?;
    let clr_used = le32(32..36)?;

    // 头后面依次是调色板（低色深）与 BI_BITFIELDS 的三个颜色掩码 ——
    // 漏算它们 `bfOffBits` 就短了，解出来的图会整体偏色
    let palette = if clr_used > 0 {
        clr_used as usize * 4
    } else if bit_count <= 8 {
        (1usize << bit_count) * 4
    } else {
        0
    };
    let masks = if compression == 3 && (bit_count == 16 || bit_count == 32) { 12 } else { 0 };
    let offset = 14 + header_size + palette + masks;

    let mut out = Vec::with_capacity(offset + dib.len());
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&((14 + dib.len()) as u32).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(offset as u32).to_le_bytes());
    out.extend_from_slice(dib);
    Some(out)
}

// ── 隐私过滤 ────────────────────────────────────────────────────

/// 疑似密码 / 卡号 / 私钥 ⇒ 不入库。
///
/// 判定刻意偏保守（宁可漏记一条，也不要把口令写进明文历史）：
///  - Luhn 校验通过且长度像卡号；
///  - 含私钥 / token / password 等**上下文词**（只对不太长的文本判定，长文档不因此被整段拒收）；
///  - 高熵且无空格的短串（密码的典型长相）。
pub fn is_sensitive(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    if luhn_ok(trimmed) {
        return true;
    }
    if trimmed.chars().count() <= 5_000 {
        let lower = trimmed.to_lowercase();
        for marker in [
            "begin private key",
            "begin rsa private key",
            "begin openssh private key",
            "begin ec private key",
            "api key",
            "apikey",
            "api-key",
            "access token",
            "access_token",
            "auth token",
            "refresh token",
            "bearer ",
            "password",
            "passwd",
            "secret",
        ] {
            if lower.contains(marker) {
                return true;
            }
        }
    }
    looks_like_password(trimmed)
}

/// Luhn 校验（信用卡号 / 部分证件号的自校验位）。
pub fn luhn_ok(text: &str) -> bool {
    let digits: String = text.chars().filter(|char| char.is_ascii_digit()).collect();
    if digits.len() < 13 || digits.len() > 19 {
        return false;
    }
    let bytes = digits.as_bytes();
    let mut sum = 0u32;
    for (index, byte) in bytes.iter().enumerate() {
        let mut digit = (byte - b'0') as u32;
        // 从右往左数第二位起加倍：长度奇偶决定哪些下标要加倍
        if (bytes.len() - index) % 2 == 0 {
            digit *= 2;
            if digit > 9 {
                digit -= 9;
            }
        }
        sum += digit;
    }
    sum % 10 == 0
}

fn looks_like_password(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() < 12 || chars.len() > 64 {
        return false;
    }
    // 密码几乎没有空格；有空格的通常是句子 / 命令行
    if text.contains(' ') || text.contains('\n') {
        return false;
    }
    // URL 与路径是高熵无空格串里最常见的误伤（复制网址极其高频），先挡掉
    if text.contains(['/', '\\', ':', '@']) {
        return false;
    }
    let mut counts: HashMap<char, usize> = HashMap::new();
    for char in &chars {
        *counts.entry(*char).or_insert(0) += 1;
    }
    let total = chars.len() as f64;
    let entropy: f64 = counts.values().map(|count| {
        let p = *count as f64 / total;
        -p * p.log2()
    }).sum();
    // 13 个互不相同的字符 ≈ 3.70；再往下就会把普通单词也吞掉
    if entropy <= 3.6 {
        return false;
    }
    let classes = (text.chars().any(|c| c.is_ascii_lowercase()) as u8)
        + (text.chars().any(|c| c.is_ascii_uppercase()) as u8)
        + (text.chars().any(|c| c.is_ascii_digit()) as u8)
        + (text.chars().any(|c| !c.is_alphanumeric()) as u8);
    classes >= 3
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("clipboard-history-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn text_entry(text: &str, at: i64) -> Entry {
        let hash = hash_text(text);
        Entry {
            id: Entry::id_of(Kind::Text, &hash),
            kind: Kind::Text,
            hash,
            created_at: at,
            pinned: false,
            uses: 1,
            text: Some(text.to_string()),
            blob: None,
            width: None,
            height: None,
            paths: None,
        }
    }

    #[test]
    fn kind_round_trips_through_json() {
        assert_eq!(Kind::parse("text"), Some(Kind::Text));
        assert_eq!(Kind::parse("nope"), None);
        let entry = text_entry("hello", 1);
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"kind\":\"text\""), "{json}");
        let back: Entry = serde_json::from_str(&json).unwrap();
        assert_eq!(back.kind, Kind::Text);
        assert_eq!(back.id, "text:".to_string() + &hash_text("hello"));
    }

    #[test]
    fn store_round_trips_and_skips_bad_lines() {
        let dir = tmp("roundtrip");
        let mut entries = vec![text_entry("第一条", 100), text_entry("第二条", 200)];
        save_entries(&dir, &entries).unwrap();
        entries.push(text_entry("第三条", 300));
        save_entries(&dir, &entries).unwrap();

        let loaded = load_entries(&dir);
        assert_eq!(loaded.len(), 3);
        assert_eq!(loaded[2].text.as_deref(), Some("第三条"));

        // 一行写坏了：跳过它，其余照读
        let mut text = fs::read_to_string(store_file(&dir)).unwrap();
        text.push_str("{not json}\n");
        fs::write(store_file(&dir), text).unwrap();
        assert_eq!(load_entries(&dir).len(), 3);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_merges_consecutive_duplicates_and_trims() {
        let dir = tmp("merge");
        let settings = Settings { max_entries: 3, ..Settings::default() };
        let mut entries: Vec<Entry> = Vec::new();

        assert_eq!(append_entry(&dir, &mut entries, text_entry("a", 1), &settings), MergeOutcome::Added);
        assert_eq!(append_entry(&dir, &mut entries, text_entry("a", 2), &settings), MergeOutcome::Merged);
        assert_eq!(entries.len(), 1, "连续重复必须合并成一条");
        assert_eq!(entries[0].uses, 2);
        assert_eq!(entries[0].created_at, 2, "合并要刷新时间，否则条目会一直沉底");

        // 中间夹了别的内容再复制回来 → 两条
        append_entry(&dir, &mut entries, text_entry("b", 3), &settings);
        assert_eq!(append_entry(&dir, &mut entries, text_entry("a", 4), &settings), MergeOutcome::Added);
        assert_eq!(entries.len(), 3);

        // 超上限：丢最旧的（[a, b, a] → 加 c → [b, a, c] → 加 d → [a, c, d]）
        append_entry(&dir, &mut entries, text_entry("c", 5), &settings);
        append_entry(&dir, &mut entries, text_entry("d", 6), &settings);
        assert_eq!(load_entries(&dir).len(), 3);
        let texts: Vec<String> = load_entries(&dir).iter().map(|e| e.text.clone().unwrap()).collect();
        assert_eq!(texts, vec!["a".to_string(), "c".to_string(), "d".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pinned_entries_survive_trim() {
        let mut entries = vec![text_entry("old", 1), text_entry("keep", 2)];
        entries[0].pinned = true;
        trim_entries(&mut entries, 1);
        // 当前实现把「最旧的非固定项」整批丢掉；固定项必须留下
        assert!(entries.iter().any(|entry| entry.pinned), "固定项不该被上限淘汰");
    }

    #[test]
    fn filter_ranks_pinned_first_then_score_then_time() {
        let mut entries = vec![text_entry("alpha", 100), text_entry("alphabet", 200), text_entry("beta", 300)];
        entries[2].pinned = true;
        let hits = filter_entries(&entries, "alpha", None, 10);
        assert_eq!(hits[0].text.as_deref(), Some("alpha"), "精确命中优先");
        assert_eq!(hits[1].text.as_deref(), Some("alphabet"));

        let all = filter_entries(&entries, "", None, 10);
        assert_eq!(all[0].text.as_deref(), Some("beta"), "固定项永远在最前");

        let only_text = filter_entries(&entries, "", Some(Kind::Text), 10);
        assert_eq!(only_text.len(), 3);
        assert!(filter_entries(&entries, "", Some(Kind::Image), 10).is_empty());
    }

    #[test]
    fn search_looks_at_paths_and_tolerates_case() {
        let entry = Entry {
            id: Entry::id_of(Kind::File, "h"),
            kind: Kind::File,
            hash: "h".to_string(),
            created_at: 1,
            pinned: false,
            uses: 1,
            text: None,
            blob: None,
            width: None,
            height: None,
            paths: Some(vec!["C:\\Users\\me\\Desktop\\报告.docx".to_string()]),
        };
        assert!(score_entry(&entry, "报告") > 0.0);
        assert_eq!(score_entry(&entry, "不存在的东西"), 0.0);
        assert_eq!(title_of(&entry), "报告.docx");
    }

    #[test]
    fn sensitive_text_is_skipped() {
        assert!(is_sensitive("4111111111111111"), "Luhn 通过的卡号");
        assert!(is_sensitive("BEGIN PRIVATE KEY\nMIIEvgIBADAN"));
        assert!(is_sensitive("password = hunter2"));
        assert!(is_sensitive("x7Qa!2Zp9$Lm4"), "高熵无空格短串");
        assert!(!is_sensitive("今天天气不错，适合出门"));
        assert!(!is_sensitive("npm install -g pnpm"), "命令行有空格，不当密码");
        assert!(!is_sensitive("https://example.com/a/b?token=abc"), "URL 是高熵无空格串，但不能当密码");
        assert!(!is_sensitive("C:\\Users\\me\\notes.txt"), "路径同理");
        assert!(!is_sensitive("12345678901234"), "Luhn 不通过就不是卡号");
    }

    #[test]
    fn luhn_checksum_matches_known_cards() {
        assert!(luhn_ok("4111 1111 1111 1111"));
        assert!(luhn_ok("5500005555555559"));
        assert!(!luhn_ok("5500005555555558"));
        assert!(!luhn_ok("123"));
    }

    #[test]
    fn relative_time_reads_naturally() {
        assert_eq!(relative_time(0, 30_000), "刚刚");
        assert_eq!(relative_time(0, 5 * 60_000), "5 分钟前");
        assert_eq!(relative_time(0, 3 * 3_600_000), "3 小时前");
        assert_eq!(relative_time(0, 2 * 86_400_000), "2 天前");
        assert_eq!(relative_time(0, 60 * 86_400_000), "2 个月前");
    }

    #[test]
    fn settings_fall_back_to_defaults() {
        let mut values = Map::new();
        let settings = settings_from(&values);
        assert_eq!(settings.max_entries, DEFAULT_MAX_ENTRIES);
        assert!(settings.ignore_sensitive);

        values.insert("max-entries".to_string(), Value::String("1000".to_string()));
        values.insert("ignore-sensitive".to_string(), Value::Bool(false));
        values.insert("capture-images".to_string(), Value::Bool(false));
        let settings = settings_from(&values);
        assert_eq!(settings.max_entries, 1000);
        assert!(!settings.ignore_sensitive);
        assert!(!settings.capture_images);

        // 非法值回落到默认（越界 / 非数字）
        let mut bad = Map::new();
        bad.insert("max-entries".to_string(), Value::String("99999".to_string()));
        assert_eq!(settings_from(&bad).max_entries, DEFAULT_MAX_ENTRIES);
    }

    #[test]
    fn state_pause_is_time_based() {
        let mut state = State::default();
        assert!(!state.is_paused(100));
        state.pause_until = 200;
        assert!(state.is_paused(100));
        assert!(!state.is_paused(300), "到点自动恢复，不需要用户再操作一次");

        let dir = tmp("state");
        save_state(&dir, &state).unwrap();
        assert_eq!(load_state(&dir).pause_until, 200);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 40 字节 BITMAPINFOHEADER + 4×4 的 32bpp 像素（bottom-up）
    fn sample_dib(bit_count: u16, compression: u32) -> Vec<u8> {
        let mut dib = vec![0u8; 40];
        dib[0..4].copy_from_slice(&40u32.to_le_bytes());
        dib[4..8].copy_from_slice(&4i32.to_le_bytes()); // width
        dib[8..12].copy_from_slice(&4i32.to_le_bytes()); // height
        dib[12..14].copy_from_slice(&1u16.to_le_bytes()); // planes
        dib[14..16].copy_from_slice(&bit_count.to_le_bytes());
        dib[16..20].copy_from_slice(&compression.to_le_bytes());
        dib.extend_from_slice(&[0u8; 4 * 4 * 4]);
        dib
    }

    #[test]
    fn dib_header_is_padded_into_a_valid_bmp() {
        let dib = sample_dib(32, 0);
        let bmp = dib_to_bmp(&dib).expect("32bpp 应当能补出 BMP");
        assert_eq!(&bmp[..2], b"BM");
        assert_eq!(u32::from_le_bytes(bmp[2..6].try_into().unwrap()) as usize, 14 + dib.len());
        // 32bpp BI_RGB：既没有调色板也没有掩码
        assert_eq!(u32::from_le_bytes(bmp[10..14].try_into().unwrap()), 54);
    }

    #[test]
    fn palette_and_masks_are_counted() {
        let mut dib = sample_dib(8, 0);
        dib[32..36].copy_from_slice(&256u32.to_le_bytes()); // biClrUsed
        let bmp = dib_to_bmp(&dib).unwrap();
        assert_eq!(u32::from_le_bytes(bmp[10..14].try_into().unwrap()), (14 + 40 + 256 * 4) as u32);

        let dib = sample_dib(32, 3); // BI_BITFIELDS
        let bmp = dib_to_bmp(&dib).unwrap();
        assert_eq!(u32::from_le_bytes(bmp[10..14].try_into().unwrap()), (14 + 40 + 12) as u32);
    }

    #[test]
    fn rejects_truncated_or_bogus_dib_headers() {
        assert!(dib_to_bmp(&[0u8; 10]).is_none(), "太短");
        let mut dib = sample_dib(32, 0);
        dib[0..4].copy_from_slice(&12u32.to_le_bytes()); // header 比 40 还小
        assert!(dib_to_bmp(&dib).is_none());
        let mut dib = sample_dib(32, 0);
        dib[0..4].copy_from_slice(&4096u32.to_le_bytes()); // header 比整块还大
        assert!(dib_to_bmp(&dib).is_none());
    }

    #[test]
    fn lock_is_mutually_exclusive_and_self_heals() {
        let dir = tmp("lock");
        let first = lock_store(&dir);
        assert!(first.is_some());
        assert!(dir.join(LOCK_FILE).exists());
        drop(first);
        assert!(!dir.join(LOCK_FILE).exists(), "正常释放要删掉锁文件");

        let stale = dir.join(LOCK_FILE);
        fs::write(&stale, "dead").unwrap();
        // 把 mtime 推到 20 秒前，模拟持有者崩溃
        let past = SystemTime::now() - Duration::from_secs(20);
        let file = fs::File::options().write(true).open(&stale).unwrap();
        file.set_modified(past).unwrap();
        drop(file);
        assert!(lock_store(&dir).is_some(), "陈旧锁必须能被抢占");
        let _ = fs::remove_dir_all(&dir);
    }
}
