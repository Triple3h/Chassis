//! 文件搜索的共享逻辑（v1 `src/core/spotlight.ts` 的 Rust 版，逐条对齐）。
//!
//! 视图层仍是 Web（本插件没有 view，只有两个逻辑层命令）；这份是逻辑层实现。

use std::collections::HashSet;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use tokio::process::Command;

/// 搜索根目录：家目录 + 常见共享位置（v1 `SEARCH_ROOTS`）。
pub fn search_roots() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut roots = Vec::new();
    if !home.is_empty() {
        roots.push(home);
    }
    roots.push("/Applications".to_string());
    roots.push("/Users/Shared".to_string());
    roots.push("/Library".to_string());
    roots
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

#[derive(Debug, Clone, PartialEq)]
pub struct FileHit {
    pub path: String,
    pub name: String,
    pub score: f64,
}

/// 用 Spotlight 的 `mdfind` 查文件名（macOS 自带，无需额外权限）。
pub async fn search_files(query: &str, limit: usize) -> Vec<FileHit> {
    let trimmed = query.trim();
    // v1 是 `trimmed.length < 2`（UTF-16 长度）；这里按字符数，中文输入更准确
    if trimmed.chars().count() < 2 {
        return Vec::new();
    }

    let mut args: Vec<String> = Vec::new();
    for root in search_roots() {
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
        let name = path.rsplit('/').next().unwrap_or(path).to_string();
        let name_lower = name.to_lowercase();
        let score = if name_lower == lower {
            1.0
        } else if name_lower.starts_with(&lower) {
            0.85
        } else if name_lower.contains(&lower) {
            0.65
        } else {
            0.45
        };
        hits.push(FileHit { path: path.to_string(), name, score });
        if hits.len() >= limit * 3 {
            break;
        }
    }

    // 同分时短名字靠前（v1：`b.score - a.score || a.name.length - b.name.length`）
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.name.chars().count().cmp(&b.name.chars().count()))
    });
    hits.truncate(limit);
    hits
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
        other => ICON_BY_EXT
            .iter()
            .find(|(name, _)| *name == other)
            .map(|(_, icon)| *icon)
            .unwrap_or("file"),
    }
}

pub fn pretty_path(file_path: &str) -> String {
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() && file_path.starts_with(&home) => format!("~{}", &file_path[home.len()..]),
        _ => file_path.to_string(),
    }
}

/// `path.dirname` 的等价实现（不做规范化，与 Node 行为一致）。
pub fn parent_of(file_path: &str) -> String {
    match file_path.rfind('/') {
        Some(0) => "/".to_string(),
        Some(index) => file_path[..index].to_string(),
        None => ".".to_string(),
    }
}

fn extension_of(file_path: &str) -> String {
    let name = file_path.rsplit('/').next().unwrap_or(file_path);
    match name.rfind('.') {
        // Node 的 `path.extname` 对 `.gitignore` 这类以点开头的文件名返回空串
        Some(index) if index > 0 => name[index + 1..].to_lowercase(),
        _ => String::new(),
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
    }

    #[test]
    fn pretty_path_collapses_home() {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/nobody".to_string());
        assert_eq!(pretty_path(&format!("{home}/Documents/a.txt")), "~/Documents/a.txt");
        assert_eq!(pretty_path("/opt/other/a.txt"), "/opt/other/a.txt");
    }

    #[test]
    fn short_queries_do_not_shell_out() {
        // <2 个字符直接返回空，连 mdfind 都不调用
        let hits = runtime().block_on(search_files("a", 8));
        assert!(hits.is_empty());
        let hits = runtime().block_on(search_files("   ", 8));
        assert!(hits.is_empty());
    }

    #[test]
    fn run_tool_reports_failure_without_panicking() {
        let (ok, stdout) = runtime().block_on(run_tool("definitely-not-a-real-binary-xyz", &[], Duration::from_millis(500)));
        assert!(!ok);
        assert!(stdout.is_empty());
    }
}
