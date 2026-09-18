//! 自建文件索引：Windows 上没有 Spotlight（系统级全盘文件名索引）时的**兜底后端**
//! （m5 计划 §B2.6 步骤 2：能力按契约定义，后端按平台实现）。
//!
//! 为什么需要它：macOS 的 `mdfind` 由系统维护索引；Windows 上要么复用用户已装的
//! Everything（见 `everything.rs`，优先），要么自己建一份 —— 后者就是本模块：
//!  - **纯 std + `notify`，平台无关**，单测在 macOS 上就能跑；
//!  - 内存里一张「小写文件名 → 完整路径」的平表 + 一张「小写路径 → 下标」的反查表
//!    （增量更新 / 删除要按路径定位），搜索时线性扫（50 万条 ≈ 10–30ms）；
//!  - 落盘在插件数据目录（`<dataPath>/file-index.txt`，每行 `小写名\t路径`），
//!    冷启动**先加载上一轮结果**（立刻可搜），后台重建完成后整体替换；
//!  - **增量**：`notify` 监听索引根（Windows 上即 `ReadDirectoryChangesW`），
//!    新建 / 删除 / 改名即时生效 —— 覆盖「重建之后、会话之内」的文件变化。
//!
//! 落盘时机说明：**只有全量重建会写盘**，增量只改内存。理由：worker 是懒启动 + 5 分钟
//! 空闲回收，而索引新鲜度阈值是 10 分钟 ⇒ 每次新会话都会（后台）重建一次，落盘内容
//! 自动覆盖上一次会话的增量；反过来，增量落盘要持锁写几百毫秒，会卡住正在进行的搜索。
//!
//! 规模护栏：条目上限 `MAX_ENTRIES`；超出即停止扫描并在索引里标记 `complete=false`
//! （实机若顶到上限，按 §B2.6 收紧根范围，而不是把上限往上抬）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI8, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use notify::{EventKind, RecursiveMode, Watcher};

use crate::FileHit;

/// 索引条目上限（内存护栏）：50 万条 ≈ 40–60MB
pub const MAX_ENTRIES: usize = 500_000;
/// 落盘文件名（相对插件 dataPath）
pub const INDEX_FILE: &str = "file-index.txt";
/// 索引「够新」的时长：比它新就不重建（worker 是懒启动 + 5 分钟空闲回收，天然限频）
pub const FRESH_MS: u64 = 10 * 60 * 1000;

/// 一个被索引的文件：只留「小写文件名」与「完整路径」
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name_lower: String,
    pub path: String,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// 扫描 / 增量时跳过的目录名（大小写不敏感）。
///
/// 两类：① 系统 / 回收站（量大且没有搜索价值）；② 版本库与构建产物（碎文件多）。
/// 这是**规模控制的主要手段**：跳过 `Windows\` 一个目录就能省掉几十万条。
pub fn should_skip_dir(name: &str) -> bool {
    const SKIP: [&str; 21] = [
        // Windows 系统与回收站
        "Windows",
        "$RECYCLE.BIN",
        "System Volume Information",
        "Recovery",
        "PerfLogs",
        "Windows.old",
        "WpSystem",
        "OneDriveTemp",
        "Temp",
        // 版本库与构建产物
        ".git",
        ".svn",
        ".hg",
        "node_modules",
        "target",
        "__pycache__",
        ".venv",
        "venv",
        ".tox",
        ".gradle",
        ".cargo",
        ".rustup",
    ];
    SKIP.iter().any(|item| name.eq_ignore_ascii_case(item))
}

/// 路径里任何一级目录命中跳过名单 ⇒ 整条路径忽略（增量事件过滤用）
pub fn is_noisy_path(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => should_skip_dir(&name.to_string_lossy()),
        _ => false,
    })
}

#[derive(Debug, Default, Clone)]
pub struct FileIndex {
    pub entries: Vec<Entry>,
    pub scanned_at: i64,
    /// false = 扫描到上限提前收工（索引不完整，日志里会说明）
    pub complete: bool,
    /// `小写路径 → entries 下标`（增量删除 / 去重用；**不落盘**，扫描或加载后重建）
    by_path: HashMap<String, u32>,
}

impl FileIndex {
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 全量扫描（深度优先，符号链接目录一律不深入 —— 防环）。
    pub fn scan(roots: &[PathBuf], limit: usize) -> FileIndex {
        let mut entries: Vec<Entry> = Vec::new();
        let mut complete = true;
        'outer: for root in roots {
            let mut stack: Vec<PathBuf> = vec![root.clone()];
            while let Some(current) = stack.pop() {
                let Ok(read) = std::fs::read_dir(&current) else { continue };
                for item in read.flatten() {
                    let name = item.file_name().to_string_lossy().to_string();
                    let Ok(kind) = item.file_type() else { continue };
                    if kind.is_symlink() {
                        continue;
                    }
                    if kind.is_dir() {
                        if should_skip_dir(&name) {
                            continue;
                        }
                        stack.push(item.path());
                        continue;
                    }
                    if !kind.is_file() {
                        continue;
                    }
                    entries.push(Entry {
                        name_lower: name.to_lowercase(),
                        path: item.path().to_string_lossy().to_string(),
                    });
                    if entries.len() >= limit {
                        complete = false;
                        break 'outer;
                    }
                }
            }
        }
        let mut index = FileIndex { entries, scanned_at: now_ms(), complete, by_path: HashMap::new() };
        index.rebuild_map();
        index
    }

    /// 重建反查表（扫描 / 加载 / 任何批量改动之后）
    fn rebuild_map(&mut self) {
        self.by_path.clear();
        for (position, entry) in self.entries.iter().enumerate() {
            self.by_path.insert(entry.path.to_lowercase(), position as u32);
        }
    }

    /// 落盘（每行 `小写名\t路径`）。用临时文件 + rename，避免半截文件被下一次冷启动读到。
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp = path.with_extension("txt.tmp");
        {
            let file = std::fs::File::create(&temp)?;
            let mut writer = BufWriter::new(file);
            let header = format!("# scannedAt={} complete={} count={}\n", self.scanned_at, self.complete, self.entries.len());
            writer.write_all(header.as_bytes())?;
            for entry in &self.entries {
                writer.write_all(entry.name_lower.as_bytes())?;
                writer.write_all(b"\t")?;
                writer.write_all(entry.path.as_bytes())?;
                writer.write_all(b"\n")?;
            }
            writer.flush()?;
        }
        std::fs::rename(&temp, path)
    }

    /// 加载上一次落盘的索引；文件不存在 / 版本不符（含旧格式）时返回 `None`。
    pub fn load(path: &Path) -> Option<FileIndex> {
        let file = std::fs::File::open(path).ok()?;
        let mut reader = BufReader::new(file);
        let mut head = String::new();
        reader.read_line(&mut head).ok()?;
        let head = head.trim_end();
        let parsed = parse_header(head)?;

        let mut entries = Vec::with_capacity(parsed.2.min(MAX_ENTRIES));
        let mut line = String::new();
        loop {
            line.clear();
            let read = reader.read_line(&mut line).ok()?;
            if read == 0 {
                break;
            }
            let text = line.trim_end_matches(['\n', '\r']);
            let Some((name_lower, path)) = text.split_once('\t') else { continue };
            if name_lower.is_empty() || path.is_empty() {
                continue;
            }
            entries.push(Entry { name_lower: name_lower.to_string(), path: path.to_string() });
        }
        let mut index = FileIndex { entries, scanned_at: parsed.0, complete: parsed.1, by_path: HashMap::new() };
        index.rebuild_map();
        Some(index)
    }

    /// 文件名搜索：打分与 Spotlight 后端共用 `crate::score_of`，排序规则也一致
    /// （同分时短名字靠前），保证两端结果形态一致。
    pub fn search(&self, query: &str, limit: usize) -> Vec<FileHit> {
        let needle = query.trim().to_lowercase();
        if needle.chars().count() < 2 {
            return Vec::new();
        }
        let mut hits: Vec<FileHit> = Vec::new();
        for entry in &self.entries {
            if !entry.name_lower.contains(&needle) {
                continue;
            }
            let score = crate::score_of(&entry.name_lower, &needle);
            let name = file_name_of(&entry.path);
            hits.push(FileHit { path: entry.path.clone(), name, score });
            if hits.len() >= limit * 8 {
                break;
            }
        }
        sort_hits(&mut hits);
        hits.truncate(limit);
        hits
    }

    // ── 增量（会话内的文件变化）─────────────────────────────────

    /// 新增 / 确认一个文件路径（已存在、不在跳过目录下、不是目录才算）。
    /// 返回「索引是否真的变了」。
    pub fn upsert_path(&mut self, path: &str) -> bool {
        let target = Path::new(path);
        if is_noisy_path(target) {
            return false;
        }
        let key = path.to_lowercase();
        if self.by_path.contains_key(&key) {
            return false; // 已在索引里（内容变化不影响文件名搜索）
        }
        if self.entries.len() >= MAX_ENTRIES {
            return false;
        }
        if !target.is_file() {
            return false; // 目录 / 已经删了
        }
        let name = file_name_of(path);
        if name.is_empty() {
            return false;
        }
        self.by_path.insert(key, self.entries.len() as u32);
        self.entries.push(Entry { name_lower: name.to_lowercase(), path: path.to_string() });
        true
    }

    /// 按路径移除（删除 / 改名 / 移出索引根）。
    pub fn remove_path(&mut self, path: &str) -> bool {
        let key = path.to_lowercase();
        let Some(position) = self.by_path.remove(&key) else { return false };
        let position = position as usize;
        if position >= self.entries.len() {
            return false;
        }
        self.entries.swap_remove(position);
        // swap_remove 把尾元素搬到了 position —— 修正它的反查映射
        if position < self.entries.len() {
            let moved = self.entries[position].path.to_lowercase();
            self.by_path.insert(moved, position as u32);
        }
        true
    }
}

// ── 索引持有者（+ 目录监听）─────────────────────────────────────

/// 监听状态：0 未尝试 / 1 已监听 / 2 建立失败（不再重试）
const WATCH_IDLE: i8 = 0;
const WATCH_ACTIVE: i8 = 1;
const WATCH_FAILED: i8 = 2;

/// 索引持有者：内存一份（`RwLock`），后台线程负责重建 + 落盘，`notify` 负责增量。
///
/// 查询路径**永不阻塞在扫描上**：没有索引就是空结果，扫描完成后自然出现。
pub struct IndexStore {
    data_path: PathBuf,
    inner: Arc<RwLock<Option<FileIndex>>>,
    building: Arc<AtomicBool>,
    /// 目录监听器（持有它 = 保持监听；drop 即停止）
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    watch_state: AtomicI8,
}

impl IndexStore {
    pub fn new(data_path: &Path) -> Self {
        Self {
            data_path: data_path.to_path_buf(),
            inner: Arc::new(RwLock::new(None)),
            building: Arc::new(AtomicBool::new(false)),
            watcher: Mutex::new(None),
            watch_state: AtomicI8::new(WATCH_IDLE),
        }
    }

    fn index_file(&self) -> PathBuf {
        self.data_path.join(INDEX_FILE)
    }

    /// 冷启动：加载上一轮索引（有就立刻可搜）。
    pub fn warm(&self) {
        let Some(index) = FileIndex::load(&self.index_file()) else { return };
        let mut slot = self.inner.write().unwrap_or_else(|err| err.into_inner());
        *slot = Some(index);
    }

    /// 内存里有没有索引（决定要不要在后台重建）
    pub fn has_index(&self) -> bool {
        self.inner.read().unwrap_or_else(|err| err.into_inner()).is_some()
    }

    /// 索引是否「够新」（文件 mtime 在 `FRESH_MS` 内）—— 用它决定要不要重建。
    pub fn is_fresh(&self) -> bool {
        let Ok(meta) = std::fs::metadata(self.index_file()) else { return false };
        let Ok(modified) = meta.modified() else { return false };
        let Ok(elapsed) = SystemTime::now().duration_since(modified) else { return false };
        (elapsed.as_millis() as u64) < FRESH_MS
    }

    /// 后台重建（同一时刻只跑一次）。返回 false 表示已有一次在跑。
    pub fn rebuild_async<F>(&self, roots: Vec<PathBuf>, limit: usize, on_done: F) -> bool
    where
        F: FnOnce(&FileIndex) + Send + 'static,
    {
        if self.building.swap(true, Ordering::SeqCst) {
            return false;
        }
        let index_file = self.index_file();
        let inner = Arc::clone(&self.inner);
        let building = Arc::clone(&self.building);
        std::thread::spawn(move || {
            let index = FileIndex::scan(&roots, limit);
            let _ = index.save(&index_file);
            {
                let mut slot = inner.write().unwrap_or_else(|err| err.into_inner());
                *slot = Some(index.clone());
            }
            on_done(&index);
            building.store(false, Ordering::SeqCst);
        });
        true
    }

    pub fn search(&self, query: &str, limit: usize) -> Vec<FileHit> {
        let guard = self.inner.read().unwrap_or_else(|err| err.into_inner());
        match guard.as_ref() {
            Some(index) => index.search(query, limit),
            // 还没扫完（首次运行 / 正在重建）：这一次给空结果，别把查询线程堵在扫描上
            None => Vec::new(),
        }
    }

    /// 开始监听索引根（幂等）。返回是否**已在监听**。
    ///
    /// 监听失败（句柄耗尽 / 权限）不是错误：降级为「只靠重建」，并记一次日志。
    pub fn watch(&self, roots: &[PathBuf]) -> bool {
        match self.watch_state.load(Ordering::SeqCst) {
            WATCH_ACTIVE => return true,
            WATCH_FAILED => return false,
            _ => {}
        }

        let inner = Arc::clone(&self.inner);
        let handler = move |result: notify::Result<notify::Event>| {
            let Ok(event) = result else { return };
            // 事件溢出（缓冲区跟不上）：交给下次重建，这里不做重活
            if event.need_rescan() {
                return;
            }
            let mut guard = inner.write().unwrap_or_else(|err| err.into_inner());
            let Some(index) = guard.as_mut() else { return };
            for path in &event.paths {
                let text = path.to_string_lossy().to_string();
                match event.kind {
                    EventKind::Remove(_) => {
                        index.remove_path(&text);
                    }
                    EventKind::Create(_) => {
                        index.upsert_path(&text);
                    }
                    // 改名：事件给的是 from / to 两条路径 —— 现存的那条补进来，消失的那条删掉
                    EventKind::Modify(notify::event::ModifyKind::Name(_)) => {
                        if path.is_file() {
                            index.upsert_path(&text);
                        } else {
                            index.remove_path(&text);
                        }
                    }
                    // 内容 / 元数据变化不影响文件名搜索
                    _ => {}
                }
            }
        };

        let mut watcher = match notify::recommended_watcher(handler) {
            Ok(watcher) => watcher,
            Err(err) => {
                eprintln!("[file-search] 目录监听不可用（{err}）：索引只在重建时刷新");
                self.watch_state.store(WATCH_FAILED, Ordering::SeqCst);
                return false;
            }
        };
        for root in roots {
            if !root.is_dir() {
                continue;
            }
            if let Err(err) = watcher.watch(root, RecursiveMode::Recursive) {
                eprintln!("[file-search] 监听 {} 失败：{err}", root.display());
            }
        }
        *self.watcher.lock().unwrap_or_else(|err| err.into_inner()) = Some(watcher);
        self.watch_state.store(WATCH_ACTIVE, Ordering::SeqCst);
        true
    }

    /// 监听是否已建立（日志 / 测试用）
    pub fn is_watching(&self) -> bool {
        self.watch_state.load(Ordering::SeqCst) == WATCH_ACTIVE
    }
}

/// 从完整路径取文件名（两端路径分隔符都认）
pub fn file_name_of(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

/// 命中排序：分数降序，同分时短名字靠前（与 Spotlight 后端一致）
pub fn sort_hits(hits: &mut [FileHit]) {
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.name.chars().count().cmp(&b.name.chars().count()))
    });
}

/// 解析索引文件头：`# scannedAt=<ms> complete=<bool> count=<n>`
fn parse_header(line: &str) -> Option<(i64, bool, usize)> {
    let rest = line.strip_prefix("# ")?;
    let mut scanned_at = 0i64;
    let mut complete = true;
    let mut count = 0usize;
    for field in rest.split_whitespace() {
        let Some((key, value)) = field.split_once('=') else { continue };
        match key {
            "scannedAt" => scanned_at = value.parse().ok()?,
            "complete" => complete = value == "true",
            "count" => count = value.parse().unwrap_or(0),
            _ => {}
        }
    }
    Some((scanned_at, complete, count))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        // 落点必须**不命中噪声名单**：Windows 的 %TEMP% 位于 `AppData\Local\Temp\` 下，
        // 路径段 `Temp` 在 should_skip_dir 里 ⇒ is_noisy_path 整条过滤，增量事件收不到
        // （upsert 永远 false、watcher 用例必然超时；首次 CI 抓到的就是这两条）。
        // 统一放仓库内 `.dev/`（已 gitignore）：两平台一致，也不触噪声过滤。
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(".dev")
            .join(format!("file-search-index-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 回归：夹具落点不得命中噪声过滤（`std::env::temp_dir()` 在 Windows 上正相反）。
    #[test]
    fn tmp_fixture_is_not_noisy() {
        let dir = tmp("guard");
        assert!(!is_noisy_path(&dir), "夹具落点不得命中跳过名单：{}", dir.display());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn skip_list_covers_system_and_build_dirs() {
        assert!(should_skip_dir("Windows"));
        assert!(should_skip_dir("$RECYCLE.BIN"));
        assert!(should_skip_dir("node_modules"));
        assert!(should_skip_dir("NODE_MODULES"), "大小写不敏感");
        assert!(should_skip_dir(".git"));
        assert!(!should_skip_dir("Documents"));
        assert!(!should_skip_dir("WindowsApps2"), "只精确匹配目录名");
        // 路径级过滤：任何一级命中就整条忽略（用 `/` 写法 —— 两个平台都把 `/` 当分隔符）
        assert!(is_noisy_path(Path::new("/x/Windows/System32/a.dll")));
        assert!(is_noisy_path(Path::new("/home/me/proj/node_modules/a.js")));
        assert!(!is_noisy_path(Path::new("/Users/me/a.txt")));
        // Windows 上 `\` 同样被拆分（这条只在 Windows 上有意义）
        #[cfg(windows)]
        assert!(is_noisy_path(Path::new("C:\\x\\Windows\\System32\\a.dll")));
    }

    #[test]
    fn scan_collects_files_and_skips_noise() {
        let dir = tmp("scan");
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(dir.join("Windows/System32")).unwrap();
        std::fs::write(dir.join("report.pdf"), "x").unwrap();
        std::fs::write(dir.join("docs/note.md"), "x").unwrap();
        std::fs::write(dir.join("node_modules/pkg/index.js"), "x").unwrap();
        std::fs::write(dir.join("Windows/System32/kernel32.dll"), "x").unwrap();

        let index = FileIndex::scan(&[dir.clone()], 1000);
        let mut names: Vec<&str> = index.entries.iter().map(|entry| entry.name_lower.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["note.md", "report.pdf"], "只收正常文件，系统/依赖目录整体跳过");
        assert!(index.complete);

        let hits = index.search("report", 8);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "report.pdf");
        assert_eq!(hits[0].score, 0.85, "前缀命中");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_stops_at_limit_and_marks_incomplete() {
        let dir = tmp("limit");
        for index in 0..20 {
            std::fs::write(dir.join(format!("file-{index}.txt")), "x").unwrap();
        }
        let index = FileIndex::scan(&[dir.clone()], 5);
        assert_eq!(index.len(), 5);
        assert!(!index.complete, "顶到上限要标记不完整");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = tmp("persist");
        let target = dir.join("nested").join(INDEX_FILE);
        let mut index = FileIndex { entries: Vec::new(), scanned_at: 12345, complete: false, by_path: HashMap::new() };
        index.entries.push(Entry { name_lower: "a.txt".to_string(), path: "/x/A.txt".to_string() });
        index.entries.push(Entry { name_lower: "中文.md".to_string(), path: "C:\\y\\中文.md".to_string() });
        index.rebuild_map();
        index.save(&target).unwrap();

        let loaded = FileIndex::load(&target).expect("应能加载");
        assert_eq!(loaded.scanned_at, 12345);
        assert!(!loaded.complete);
        assert_eq!(loaded.entries, index.entries);
        // 加载后反查表必须是重建好的：删得掉
        let mut loaded = loaded;
        assert!(loaded.remove_path("/x/A.txt"));
        assert_eq!(loaded.len(), 1);
        assert!(!dir.join("nested").join("file-index.txt.tmp").exists(), "临时文件要改名掉");

        // 不存在的文件 / 垃圾文件都返回 None，不 panic
        assert!(FileIndex::load(&dir.join("nope.txt")).is_none());
        std::fs::write(dir.join("bad.txt"), "not a header\n").unwrap();
        assert!(FileIndex::load(&dir.join("bad.txt")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_scores_and_orders_like_spotlight_backend() {
        let mut index = FileIndex { entries: Vec::new(), scanned_at: now_ms(), complete: true, by_path: HashMap::new() };
        for (name, path) in [
            ("report", "/d/report"),
            ("report.pdf", "/d/report.pdf"),
            ("annual-report.pdf", "/d/annual-report.pdf"),
            ("myreport-notes.md", "/d/deep/myreport-notes.md"),
            ("unrelated.txt", "/d/unrelated.txt"),
        ] {
            index.entries.push(Entry { name_lower: name.to_string(), path: path.to_string() });
        }
        index.rebuild_map();
        let hits = index.search("report", 8);
        assert_eq!(hits.len(), 4, "不含 report 的不进结果");
        assert_eq!(hits[0].name, "report", "精确命中第一");
        assert_eq!(hits[0].score, 1.0);
        assert_eq!(hits[1].name, "report.pdf", "前缀第二");
        assert_eq!(hits[1].score, 0.85);
        assert_eq!(hits[2].name, "annual-report.pdf", "包含第三（同分时短名字靠前）");
        assert_eq!(hits[2].score, 0.65);
        assert_eq!(hits[3].name, "myreport-notes.md");
        assert!(index.search("r", 8).is_empty(), "单字符不搜（与 Spotlight 后端同门槛）");

        // Windows 路径也能取到文件名
        assert_eq!(file_name_of("C:\\Users\\me\\Desktop\\a.txt"), "a.txt");
        assert_eq!(file_name_of("/Users/me/a.txt"), "a.txt");
    }

    #[test]
    fn incremental_upsert_and_remove_keep_index_consistent() {
        let dir = tmp("incr");
        let first = dir.join("first.txt");
        let second = dir.join("second.txt");
        std::fs::write(&first, "x").unwrap();
        std::fs::write(&second, "x").unwrap();

        let mut index = FileIndex::scan(&[dir.clone()], 100);
        assert_eq!(index.len(), 2);

        // 新建文件 → upsert 生效，且能搜到
        let third = dir.join("Third-Report.md");
        std::fs::write(&third, "x").unwrap();
        assert!(index.upsert_path(&third.to_string_lossy()));
        assert_eq!(index.search("third", 8).len(), 1);
        assert!(!index.upsert_path(&third.to_string_lossy()), "重复 upsert 不算变化");

        // 目录 / 不存在的路径 / 跳过目录下的文件都不进索引
        assert!(!index.upsert_path(&dir.to_string_lossy()));
        assert!(!index.upsert_path(&dir.join("ghost.txt").to_string_lossy()));
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        let noise = dir.join("node_modules/pkg.js");
        std::fs::write(&noise, "x").unwrap();
        assert!(!index.upsert_path(&noise.to_string_lossy()), "跳过目录下的文件不进索引");

        // 删除 → 反查表与结果都要一致（swap_remove 后映射不串位）
        assert!(index.remove_path(&first.to_string_lossy()));
        assert!(!index.remove_path(&first.to_string_lossy()), "重复删除不算变化");
        assert_eq!(index.len(), 2);
        assert!(index.search("first", 8).is_empty());
        assert_eq!(index.search("second", 8).len(), 1, "删掉一个不能影响别人");
        assert_eq!(index.search("third", 8).len(), 1, "被 swap 搬动的元素也要找得到");

        // 改名 = 删除旧 + 新增新
        let renamed = dir.join("renamed-notes.txt");
        std::fs::rename(&second, &renamed).unwrap();
        assert!(index.remove_path(&second.to_string_lossy()));
        assert!(index.upsert_path(&renamed.to_string_lossy()));
        assert_eq!(index.search("renamed", 8).len(), 1, "新名字可搜");
        assert!(index.search("second.txt", 8).is_empty(), "旧的全名不再命中");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn upsert_respects_entry_limit() {
        let dir = tmp("cap");
        let file = dir.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let mut index = FileIndex { entries: Vec::new(), scanned_at: now_ms(), complete: true, by_path: HashMap::new() };
        for position in 0..MAX_ENTRIES {
            index.entries.push(Entry { name_lower: "x".to_string(), path: format!("/x/{position}") });
        }
        index.rebuild_map();
        assert!(!index.upsert_path(&file.to_string_lossy()), "顶到上限后不再新增");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_serves_loaded_index_without_blocking_on_rebuild() {
        let dir = tmp("store");
        let store = IndexStore::new(&dir);
        assert!(store.search("anything", 8).is_empty(), "还没索引：空结果而不是阻塞");
        assert!(!store.has_index());
        assert!(!store.is_fresh(), "没有索引文件 → 不新鲜");

        let mut index = FileIndex { entries: Vec::new(), scanned_at: now_ms(), complete: true, by_path: HashMap::new() };
        index.entries.push(Entry { name_lower: "alpha.txt".to_string(), path: "/d/Alpha.txt".to_string() });
        index.rebuild_map();
        index.save(&dir.join(INDEX_FILE)).unwrap();
        assert!(store.is_fresh());

        store.warm();
        assert!(store.has_index());
        let hits = store.search("alpha", 8);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "Alpha.txt");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 真监听一遍：写文件 → 事件到达 → 索引里出现（跨平台，notify 支持三平台）
    #[test]
    fn watcher_picks_up_new_files() {
        let dir = tmp("watch");
        let store = IndexStore::new(&dir);
        // 先给一份空索引（事件要有地方落）
        store.warm();
        {
            let mut slot = store.inner.write().unwrap_or_else(|err| err.into_inner());
            *slot = Some(FileIndex { entries: Vec::new(), scanned_at: now_ms(), complete: true, by_path: HashMap::new() });
        }
        if !store.watch(std::slice::from_ref(&dir)) {
            return; // 环境不支持监听（容器 / 权限）：跳过，不误报失败
        }
        assert!(store.is_watching());

        let created = dir.join("brand-new-report.txt");
        std::fs::write(&created, "x").unwrap();

        // 事件是异步的：轮询等一会儿（上限 3s，正常几十毫秒）
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if !store.search("brand-new", 8).is_empty() {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "3s 内没收到创建事件");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        // 删除也要被捕捉
        std::fs::remove_file(&created).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if store.search("brand-new", 8).is_empty() {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "3s 内没收到删除事件");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
