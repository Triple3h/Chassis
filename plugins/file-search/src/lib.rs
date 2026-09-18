//! 文件搜索的共享逻辑（v1 `src/core/spotlight.ts` 的 Rust 版 + 跨平台后端）。
//!
//! 视图层仍是 Web（本插件没有 view，只有两个逻辑层命令）；这份是逻辑层实现。
//!
//! **后端契约**（m5 计划 §B2.6：能力按契约定义，后端按平台实现）：
//!  - `FileBackend::search_name` 对宿主 / UI 完全一致，平台差异全在后端实现里；
//!  - macOS：Spotlight（`mdfind`）—— 系统自带、免权限、免常驻服务的全盘文件名索引；
//!  - Windows：**已装 Everything 就复用它**（`everything.rs`：按官方 IPC 协议实现，纯代码、
//!    不随包带 DLL）；探不到 / 查询失败则回退**自建索引**（`index.rs`：全盘扫描 + 落盘 +
//!    读目录变化做增量）；
//!  - 其余平台：空后端（降级，命令不产出贡献）。

use std::collections::HashSet;
#[cfg(windows)]
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use launcher_plugin_sdk::Context;
use tokio::process::Command;

pub mod everything;
pub mod index;
pub mod preview;

// ── 公共：路径处理与打分（两个后端共用，避免漂移）────────────────

/// 家目录：Windows 优先 `USERPROFILE`（Git Bash 之类环境里 `HOME` 可能是 MSYS 风格路径）。
pub fn user_home() -> Option<String> {
    for key in ["USERPROFILE", "HOME"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// 文件名打分（两个后端共用）：精确 1.0 / 前缀 0.85 / 包含 0.65 / 其他 0.45。
pub fn score_of(name_lower: &str, needle_lower: &str) -> f64 {
    if name_lower == needle_lower {
        1.0
    } else if name_lower.starts_with(needle_lower) {
        0.85
    } else if name_lower.contains(needle_lower) {
        0.65
    } else {
        0.45
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FileHit {
    pub path: String,
    pub name: String,
    pub score: f64,
}

/// 异步任务用的 runtime：SDK 是纯 std 线程模型，需要并发/超时的插件自建一份。
///
/// `on_query` 的 handler 跑在 SDK 的 executor 线程里（不在任何 tokio runtime 内），
/// 所以这里 `block_on` 是安全的 —— 不会与外层 runtime 嵌套。
pub fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("创建插件 runtime 失败")
    })
}

/// 跑一个外部命令并收 stdout（v1 `runFile`：超时 / 失败都只回 `ok=false`，不抛）。
///
/// `kill_on_drop`：超时后 Drop 掉子进程会顺手杀掉它，不留孤儿。
pub async fn run_tool(file: &str, args: &[String], timeout: Duration) -> (bool, String) {
    let spawned = Command::new(file)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let Ok(child) = spawned else {
        return (false, String::new());
    };
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => (output.status.success(), String::from_utf8_lossy(&output.stdout).to_string()),
        // 超时 / IO 失败：v1 也是 `ok=false` + 空 stdout
        Ok(Err(_)) | Err(_) => (false, String::new()),
    }
}

const ICON_BY_EXT: [(&str, &str); 19] = [
    ("png", "file-text"),
    ("jpg", "file-text"),
    ("jpeg", "file-text"),
    ("gif", "file-text"),
    ("webp", "file-text"),
    ("svg", "file-text"),
    ("pdf", "file-text"),
    ("md", "file-text"),
    ("txt", "file-text"),
    ("json", "file-text"),
    ("ts", "terminal"),
    ("tsx", "terminal"),
    ("js", "terminal"),
    ("jsx", "terminal"),
    ("py", "terminal"),
    ("sh", "terminal"),
    ("go", "terminal"),
    ("rs", "terminal"),
    ("zip", "folder"),
];

pub fn icon_for(file_path: &str) -> &'static str {
    let ext = extension_of(file_path);
    // dmg / app 也在 v1 的表里，放在这里避免长元组的可读性问题
    match ext.as_str() {
        "dmg" => "folder",
        "app" => "app-window",
        // Windows 的家当（v1 是 macOS 专用表，这里按需增补，取值仍走同一套图标名）
        "exe" | "msi" | "lnk" => "app-window",
        other => ICON_BY_EXT
            .iter()
            .find(|(name, _)| *name == other)
            .map(|(_, icon)| *icon)
            .unwrap_or("file"),
    }
}

pub fn pretty_path(file_path: &str) -> String {
    match user_home() {
        Some(home) if file_path.starts_with(&home) => format!("~{}", &file_path[home.len()..]),
        _ => file_path.to_string(),
    }
}

/// `path.dirname` 的等价实现（不做规范化，与 Node 行为一致）。
pub fn parent_of(file_path: &str) -> String {
    match file_path.rfind(['/', '\\']) {
        Some(0) => file_path[..1].to_string(),
        Some(index) => file_path[..index].to_string(),
        None => ".".to_string(),
    }
}

/// 扩展名（小写、不含前导点；`rsplit` 兼容两种路径分隔符）。
pub(crate) fn extension_of(file_path: &str) -> String {
    let name = file_path.rsplit(['/', '\\']).next().unwrap_or(file_path);
    match name.rfind('.') {
        // Node 的 `path.extname` 对 `.gitignore` 这类以点开头的文件名返回空串
        Some(index) if index > 0 => name[index + 1..].to_lowercase(),
        _ => String::new(),
    }
}

// ── 后端契约 ──────────────────────────────────────────────────

/// 文件搜索后端：对宿主 / UI 完全一致的六个动词里，本期落地 `search_name`
/// （`search_content` / `stat` / `preview` 按 §B2.6 / §B2.7 增量补，`open` / `reveal` 走壳原语）。
pub trait FileBackend: Send + Sync {
    /// 文件名搜索（返回**已排序、已截断**的结果）。
    fn search_name(&self, query: &str, limit: usize) -> Vec<FileHit>;
    /// 后端标识（日志用）
    fn kind(&self) -> &'static str;
}

static BACKEND: OnceLock<Box<dyn FileBackend>> = OnceLock::new();

/// 取当前平台的搜索后端（进程内单例；Windows 后端用 `dataPath` 落索引）。
pub fn backend(ctx: &Context) -> &'static dyn FileBackend {
    BACKEND
        .get_or_init(|| {
            #[cfg(target_os = "macos")]
            {
                let _ = ctx;
                Box::new(SpotlightBackend)
            }
            #[cfg(windows)]
            {
                Box::new(NativeIndexBackend::new(ctx.data_path().to_path_buf()))
            }
            #[cfg(not(any(target_os = "macos", windows)))]
            {
                let _ = ctx;
                Box::new(EmptyBackend)
            }
        })
        .as_ref()
}

/// 其余平台：降级为空后端（命令照常注册，只是不产出结果）。
pub struct EmptyBackend;

impl FileBackend for EmptyBackend {
    fn search_name(&self, _query: &str, _limit: usize) -> Vec<FileHit> {
        Vec::new()
    }
    fn kind(&self) -> &'static str {
        "empty"
    }
}

// ── macOS 后端：Spotlight（mdfind）──────────────────────────────

/// 搜索根目录：家目录 + 常见共享位置（v1 `SEARCH_ROOTS`）。
#[cfg(target_os = "macos")]
pub fn spotlight_roots() -> Vec<String> {
    let mut roots = Vec::new();
    if let Some(home) = user_home() {
        roots.push(home);
    }
    roots.push("/Applications".to_string());
    roots.push("/Users/Shared".to_string());
    roots.push("/Library".to_string());
    roots
}

/// 用 Spotlight 的 `mdfind` 查文件名（macOS 自带，无需额外权限）。
#[cfg(target_os = "macos")]
pub async fn search_files(query: &str, limit: usize) -> Vec<FileHit> {
    let trimmed = query.trim();
    // v1 是 `trimmed.length < 2`（UTF-16 长度）；这里按字符数，中文输入更准确
    if trimmed.chars().count() < 2 {
        return Vec::new();
    }

    let mut args: Vec<String> = Vec::new();
    for root in spotlight_roots() {
        args.push("-onlyin".to_string());
        args.push(root);
    }
    args.push("-name".to_string());
    args.push(trimmed.to_string());

    let (_, stdout) = run_tool("mdfind", &args, Duration::from_millis(3000)).await;
    let lower = trimmed.to_lowercase();
    let mut seen: HashSet<String> = HashSet::new();
    let mut hits: Vec<FileHit> = Vec::new();

    for line in stdout.split('\n') {
        let path = line.trim();
        if path.is_empty() || !seen.insert(path.to_string()) {
            continue;
        }
        let name = index::file_name_of(path);
        let name_lower = name.to_lowercase();
        let score = score_of(&name_lower, &lower);
        hits.push(FileHit { path: path.to_string(), name, score });
        if hits.len() >= limit * 3 {
            break;
        }
    }

    // 同分时短名字靠前（v1：`b.score - a.score || a.name.length - b.name.length`）
    index::sort_hits(&mut hits);
    hits.truncate(limit);
    hits
}

#[cfg(target_os = "macos")]
pub struct SpotlightBackend;

#[cfg(target_os = "macos")]
impl FileBackend for SpotlightBackend {
    fn search_name(&self, query: &str, limit: usize) -> Vec<FileHit> {
        runtime().block_on(search_files(query, limit))
    }
    fn kind(&self) -> &'static str {
        "spotlight"
    }
}

// ── Windows 后端：Everything（若已装）→ 自建索引（兜底）──────────

/// 索引根：所有**固定盘** + 用户目录（去重）。
///
/// 用 A–Z 探测盘符（`<盘符>:\` 存在即可），不引 Win32 调用：
/// 这样这段逻辑在 macOS 上也能编（单测里恒为空），平台分支只剩"盘符存在性"一个事实。
#[cfg(windows)]
pub fn candidate_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    if let Some(home) = user_home() {
        if seen.insert(home.clone()) {
            roots.push(PathBuf::from(home));
        }
    }
    for letter in b'A'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        if Path::new(&root).exists() && seen.insert(root.clone()) {
            roots.push(PathBuf::from(root));
        }
    }
    roots
}

/// 查询失败后的冷却时长：Everything 出问题时别让每次搜索都卡满 3s 超时
#[cfg(windows)]
const EVERYTHING_COOLDOWN_MS: i64 = 60_000;

#[cfg(windows)]
pub struct NativeIndexBackend {
    store: index::IndexStore,
    /// 冷却截止时间戳（ms；0 = 可以尝试 Everything）
    everything_cooldown_until: std::sync::atomic::AtomicI64,
    /// Everything 可用性状态：0 未知 / 1 可用 / 2 不可用（只在变化时打日志，避免刷屏）
    everything_state: std::sync::atomic::AtomicI8,
}

#[cfg(windows)]
impl NativeIndexBackend {
    pub fn new(data_path: PathBuf) -> Self {
        let store = index::IndexStore::new(&data_path);
        store.warm();
        if !store.has_index() {
            eprintln!("[file-search] 还没有文件索引，首次搜索后会返回空结果（后台正在建索引）");
        }
        Self {
            store,
            everything_cooldown_until: std::sync::atomic::AtomicI64::new(0),
            everything_state: std::sync::atomic::AtomicI8::new(0),
        }
    }

    /// 已装 Everything 就复用它（索引由它维护、毫秒级）；否则返回 None 让调用方走自建索引。
    ///
    /// - 探测本身（`FindWindow` + 一次 `SendMessage`）是微秒级本地调用 ⇒ 未安装时每次试也无所谓；
    /// - 查询失败（超时 / 不支持）会**熔断 60s** —— 装了但不可用时不能每次都卡满 3s 超时。
    fn search_via_everything(&self, query: &str, limit: usize) -> Option<Vec<FileHit>> {
        use std::sync::atomic::Ordering;
        let now = index::now_ms();
        if now < self.everything_cooldown_until.load(Ordering::Relaxed) {
            return None;
        }
        match everything::search(query, limit) {
            Some(hits) => {
                self.everything_cooldown_until.store(0, Ordering::Relaxed);
                self.note_everything_state(1, "已接管文件搜索（复用 Everything 的索引）");
                Some(hits)
            }
            None => {
                self.everything_cooldown_until.store(now + EVERYTHING_COOLDOWN_MS, Ordering::Relaxed);
                self.note_everything_state(2, "Everything 不可用，本次起回退自建索引（60s 后再探）");
                None
            }
        }
    }

    /// 状态只在**变化**时打日志：这个函数每次搜索都会被调用
    fn note_everything_state(&self, state: i8, message: &str) {
        use std::sync::atomic::Ordering;
        if self.everything_state.swap(state, Ordering::Relaxed) != state {
            eprintln!("[file-search] {message}");
        }
    }

    /// 需要时触发一次后台重建（同一时刻只跑一次）。
    ///
    /// 触发条件：还没有索引，或落盘索引超过 `index::FRESH_MS`。
    /// **查询路径不等待扫描** —— 这一次先给旧索引 / 空结果。
    ///
    /// 顺带（幂等）建立目录监听：让「重建之后、会话之内」的新建 / 删除 / 改名即时生效 ——
    /// 只靠定期重建的话，刚存的文件要等下一轮重建才搜得到。
    fn ensure_index(&self) {
        let roots = candidate_roots();
        if !self.store.is_watching() {
            self.store.watch(&roots);
        }
        if self.store.has_index() && self.store.is_fresh() {
            return;
        }
        let started = std::time::Instant::now();
        self.store.rebuild_async(roots.clone(), index::MAX_ENTRIES, move |index| {
            eprintln!(
                "[file-search] 索引重建完成：{} 条{}（{} 个根，{:.1}s）",
                index.len(),
                if index.complete { "" } else { "（达到上限，已截断）" },
                roots.len(),
                started.elapsed().as_secs_f64()
            );
        });
    }
}

#[cfg(windows)]
impl FileBackend for NativeIndexBackend {
    /// 优先级：**已装 Everything**（复用它维护的全盘索引）→ 自建索引（兜底）。
    fn search_name(&self, query: &str, limit: usize) -> Vec<FileHit> {
        if let Some(hits) = self.search_via_everything(query, limit) {
            return hits;
        }
        self.ensure_index();
        self.store.search(query, limit)
    }
    fn kind(&self) -> &'static str {
        "everything+index"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icons_follow_v1_table() {
        assert_eq!(icon_for("/a/b/photo.PNG"), "file-text");
        assert_eq!(icon_for("/a/b/main.rs"), "terminal");
        assert_eq!(icon_for("/a/b/archive.zip"), "folder");
        assert_eq!(icon_for("/a/b/App.app"), "app-window");
        assert_eq!(icon_for("C:\\Apps\\Tool.exe"), "app-window", "Windows 可执行文件");
        assert_eq!(icon_for("C:\\Users\\me\\Desktop\\Shortcut.lnk"), "app-window");
        assert_eq!(icon_for("/a/b/notes"), "file", "没有扩展名");
        assert_eq!(icon_for("/a/b/.gitignore"), "file", "以点开头不算扩展名");
    }

    #[test]
    fn parent_and_extension_edges() {
        assert_eq!(parent_of("/a/b/c.txt"), "/a/b");
        assert_eq!(parent_of("/c.txt"), "/");
        assert_eq!(parent_of("c.txt"), ".");
        assert_eq!(extension_of("/a/b.tar.gz"), "gz");
        assert_eq!(extension_of("/a/b."), "", "尾点不算扩展名（Node 同款）");

        // Windows 路径：分隔符与盘符都要认
        assert_eq!(parent_of("C:\\Users\\me\\a.txt"), "C:\\Users\\me");
        assert_eq!(parent_of("C:\\a.txt"), "C:");
        assert_eq!(extension_of("C:\\Users\\me\\Report.PDF"), "pdf");
        assert_eq!(index::file_name_of("C:\\Users\\me\\a.txt"), "a.txt");
        assert_eq!(index::file_name_of("/Users/me/a.txt"), "a.txt");
    }

    #[test]
    fn pretty_path_collapses_home() {
        let home = user_home().unwrap_or_else(|| "/Users/nobody".to_string());
        assert_eq!(pretty_path(&format!("{home}/Documents/a.txt")), "~/Documents/a.txt");
        assert_eq!(pretty_path("/opt/other/a.txt"), "/opt/other/a.txt");
    }

    #[test]
    fn score_matches_spotlight_weights() {
        assert_eq!(score_of("report.pdf", "report.pdf"), 1.0);
        assert_eq!(score_of("report.pdf", "report"), 0.85);
        assert_eq!(score_of("annual-report.pdf", "report"), 0.65);
        assert_eq!(score_of("unrelated.txt", "report"), 0.45);
    }

    #[test]
    fn empty_backend_produces_nothing() {
        let backend = EmptyBackend;
        assert!(backend.search_name("anything", 8).is_empty());
        assert_eq!(backend.kind(), "empty");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn short_queries_do_not_shell_out() {
        // <2 个字符直接返回空，连 mdfind 都不调用
        let hits = runtime().block_on(search_files("a", 8));
        assert!(hits.is_empty());
        let hits = runtime().block_on(search_files("   ", 8));
        assert!(hits.is_empty());
        assert_eq!(SpotlightBackend.kind(), "spotlight");
        assert!(spotlight_roots().iter().any(|root| root == "/Applications"));
    }

    #[test]
    fn run_tool_reports_failure_without_panicking() {
        let (ok, stdout) = runtime().block_on(run_tool("definitely-not-a-real-binary-xyz", &[], Duration::from_millis(500)));
        assert!(!ok);
        assert!(stdout.is_empty());
    }
}
