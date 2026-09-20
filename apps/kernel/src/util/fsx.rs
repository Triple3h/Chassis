//! 文件与 JSON 工具（对齐 v1 `util/fsx.ts`）：原子写 / 宽容读 / 目录与路径工具。

use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Serialize;

pub fn ensure_dir(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// 读 JSON；文件不存在 / 解析失败一律回落 fallback（与 v1 的 `catch { return fallback }` 一致）。
pub fn read_json<T: DeserializeOwned>(file: &Path, fallback: T) -> T {
    let Ok(raw) = std::fs::read_to_string(file) else { return fallback };
    serde_json::from_str(&raw).unwrap_or(fallback)
}

/// 原子写：临时文件 + rename（requirements §7.5）；临时文件名格式与 v1 一致（`<file>.<pid>.<ns>.tmp`）。
pub fn write_json_atomic<T: Serialize>(file: &Path, data: &T) -> io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_nanos()).unwrap_or(0);
    let file_name = file.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = file.with_file_name(format!("{file_name}.{}.{nanos}.tmp", std::process::id()));
    let json = serde_json::to_string_pretty(data).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, file)
}

/// 插件唯一可写目录（N2）：`<dataRoot>/plugins/<pluginId>` —— 唯一定义处。
pub fn plugin_data_path(data_root: &Path, plugin_id: &str) -> PathBuf {
    data_root.join("plugins").join(plugin_id)
}

pub fn path_exists(path: &Path) -> bool {
    path.exists()
}

pub fn list_dir_safe(dir: &Path) -> Vec<PathBuf> {
    match std::fs::read_dir(dir) {
        Ok(entries) => entries.flatten().map(|entry| entry.path()).collect(),
        Err(_) => Vec::new(),
    }
}

// ── 重试策略（rename / 目录替换这类易被占用的操作） ─────────────────────────
//
// 平台差异（docs/win-hot-update-research.md §5.1-#1、§5.3-3）：
//  - Windows：杀软实时扫描、句柄释放滞后 ⇒ 「共享冲突 / 访问被拒」是**瞬时**态，值得退避重试；
//  - unix：rename 罕见瞬时失败，`EACCES` / `EXDEV` 基本都是永久错误 ⇒ 立即上报，别让用户白等。
// 所以「退避表」与「什么算瞬时」都按平台取，调用方只消费同一套判定。

/// 重试策略：`backoff_ms` 的**每一项**都是一次重试前的等待（长度 = 可重试次数，空表 = 不重试）。
/// 用显式退避表而不是「基数 + 翻倍」，为了总预算一眼可见。
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub backoff_ms: &'static [u64],
}

/// rename / 目录替换的默认策略（总预算：Windows ~2.3s、unix 150ms）。
#[cfg(windows)]
pub const RENAME_POLICY: RetryPolicy = RetryPolicy { backoff_ms: &[100, 200, 400, 800, 800] };
#[cfg(not(windows))]
pub const RENAME_POLICY: RetryPolicy = RetryPolicy { backoff_ms: &[50, 100] };

/// 值得重试吗？只认「瞬时占用」：
///  - Windows：`PermissionDenied`（`ACCESS_DENIED`，常是映像正被占用）/ `WouldBlock` / 共享冲突 32 / 锁冲突 33；
///  - unix：`EBUSY`(16) / `ETXTBSY`(26)。
/// 其它（`NotFound` / `AlreadyExists` / `EXDEV` / unix 的 `EACCES`）都是永久错误 —— 重试它们只会拖慢失败上报。
#[cfg(windows)]
pub fn is_transient(err: &io::Error) -> bool {
    matches!(err.kind(), io::ErrorKind::PermissionDenied | io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted)
        || matches!(err.raw_os_error(), Some(32) | Some(33))
}

#[cfg(not(windows))]
pub fn is_transient(err: &io::Error) -> bool {
    // 只认 EBUSY / ETXTBSY：EINTR 已由 std 内部重试，EACCES 是永久权限问题
    matches!(err.kind(), io::ErrorKind::Interrupted) || matches!(err.raw_os_error(), Some(16) | Some(26))
}

/// 同步重试（`thread::sleep`；启动早期与非 async 上下文用）。
pub fn retry<T>(policy: RetryPolicy, mut action: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let mut attempt = 0usize;
    loop {
        match action() {
            Ok(value) => return Ok(value),
            Err(err) => {
                if !is_transient(&err) {
                    return Err(err);
                }
                let Some(delay) = policy.backoff_ms.get(attempt) else { return Err(err) };
                if *delay > 0 {
                    std::thread::sleep(Duration::from_millis(*delay));
                }
                attempt += 1;
            }
        }
    }
}

/// 异步重试（`tokio::time::sleep`）—— 与同步版共用策略与判定，只是睡眠原语不同；
/// **async 上下文里必须用这个**（同步版会占住 runtime 线程）。
pub async fn retry_async<T>(policy: RetryPolicy, mut action: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let mut attempt = 0usize;
    loop {
        match action() {
            Ok(value) => return Ok(value),
            Err(err) => {
                if !is_transient(&err) {
                    return Err(err);
                }
                let Some(delay) = policy.backoff_ms.get(attempt) else { return Err(err) };
                if *delay > 0 {
                    tokio::time::sleep(Duration::from_millis(*delay)).await;
                }
                attempt += 1;
            }
        }
    }
}

/// 把 `relative` 解析到 `root` 之内；越界（`..` 逃逸）返回 None（v1 `resolveWithinRoot`）。
///
/// 静态资源服务与插件目录都用它：**这是路径穿越的唯一防线**。
pub fn resolve_within_root(root: &Path, relative: &str) -> Option<PathBuf> {
    let root = normalize(root);
    let relative = relative.trim_start_matches(['/', '\\']);
    if relative.is_empty() {
        return None;
    }
    let candidate = normalize(&root.join(relative));
    // `Path::starts_with` 是组件级比较（`/a/bb` 不以 `/a/b` 开头），不会误放
    candidate.starts_with(&root).then_some(candidate)
}

/// 词法规范化：消掉 `.` 与 `..`（不碰文件系统，不做符号链接解析）。
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `%XX` 解码（URL 路径；非法序列原样保留，v1 是 decodeURIComponent）。
pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(byte) = hex {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_json_falls_back_on_missing_or_garbage() {
        let dir = std::env::temp_dir().join(format!("fsx-test-{}", std::process::id()));
        let missing = dir.join("nope.json");
        assert_eq!(read_json::<i64>(&missing, 7), 7);

        let garbage = dir.join("garbage.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&garbage, "{not json").unwrap();
        assert_eq!(read_json::<i64>(&garbage, 7), 7);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_json_atomic_round_trips() {
        let dir = std::env::temp_dir().join(format!("fsx-atomic-{}", std::process::id()));
        let file = dir.join("x.json");
        write_json_atomic(&file, &serde_json::json!({ "a": 1 })).unwrap();
        assert_eq!(read_json::<serde_json::Value>(&file, serde_json::Value::Null)["a"], 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_within_root_blocks_traversal() {
        // 用真实临时目录（平台无关）：路径比较在 Windows 上对 `/tmp/...` 这种字面量不成立
        let base = std::env::temp_dir();
        let root = base.join("ui-dist");
        assert_eq!(resolve_within_root(&root, "index.html").unwrap(), root.join("index.html"));
        assert_eq!(resolve_within_root(&root, "/assets/a.js").unwrap(), root.join("assets").join("a.js"));
        assert_eq!(resolve_within_root(&root, "a/../b.js").unwrap(), root.join("b.js"));
        assert!(resolve_within_root(&root, "../etc/passwd").is_none());
        assert!(resolve_within_root(&root, "assets/../../etc/passwd").is_none());
        assert!(resolve_within_root(&root, "").is_none());
        // 组件级比较：兄弟目录不能冒充
        assert!(resolve_within_root(&base.join("ui"), "../ui-dist/x").is_none());
    }

    #[test]
    fn percent_decode_handles_escapes_and_garbage() {
        assert_eq!(percent_decode("/a%20b/c.js"), "/a b/c.js");
        assert_eq!(percent_decode("/%E4%B8%AD%E6%96%87"), "/中文");
        assert_eq!(percent_decode("/bad%zz"), "/bad%zz", "非法序列原样保留");
        assert_eq!(percent_decode("/plain"), "/plain");
    }

    #[test]
    fn retry_stops_immediately_on_permanent_error() {
        let mut calls = 0;
        let err = retry(RetryPolicy { backoff_ms: &[0, 0, 0] }, || {
            calls += 1;
            Err::<(), _>(io::Error::new(io::ErrorKind::NotFound, "gone"))
        })
        .expect_err("永久错误必须原样返回");
        assert_eq!(calls, 1, "永久错误一次都不重试（重试只会拖慢失败上报）");
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn retry_uses_budget_then_reports_last_error() {
        let mut calls = 0;
        let err = retry(RetryPolicy { backoff_ms: &[0, 0] }, || {
            calls += 1;
            Err::<(), _>(io::Error::new(io::ErrorKind::Interrupted, "busy"))
        })
        .expect_err("预算用尽仍失败");
        assert_eq!(calls, 3, "1 次首试 + 2 次重试");
        assert_eq!(err.kind(), io::ErrorKind::Interrupted);

        let mut calls = 0;
        let recovered = retry(RetryPolicy { backoff_ms: &[0, 0] }, || {
            calls += 1;
            if calls < 3 { Err(io::Error::new(io::ErrorKind::Interrupted, "busy")) } else { Ok(7) }
        });
        assert_eq!(recovered.unwrap(), 7, "中途恢复 ⇒ 成功");
        assert_eq!(calls, 3);
    }

    #[tokio::test]
    async fn retry_async_shares_policy_and_short_circuits() {
        let mut calls = 0;
        let err = retry_async(RetryPolicy { backoff_ms: &[0] }, || {
            calls += 1;
            Err::<(), _>(io::Error::new(io::ErrorKind::NotFound, "gone"))
        })
        .await
        .expect_err("永久错误必须原样返回");
        assert_eq!(calls, 1);
        assert_eq!(err.kind(), io::ErrorKind::NotFound);

        let mut calls = 0;
        let err = retry_async(RetryPolicy { backoff_ms: &[0] }, || {
            calls += 1;
            Err::<(), _>(io::Error::new(io::ErrorKind::Interrupted, "busy"))
        })
        .await
        .expect_err("预算用尽仍失败");
        assert_eq!(calls, 2, "1 次首试 + 1 次重试");
        assert_eq!(err.kind(), io::ErrorKind::Interrupted);
    }

    #[test]
    fn transient_classification_follows_platform_semantics() {
        assert!(is_transient(&io::Error::new(io::ErrorKind::Interrupted, "eintr")), "两个平台都算瞬时");
        for kind in [io::ErrorKind::NotFound, io::ErrorKind::AlreadyExists, io::ErrorKind::InvalidInput] {
            assert!(!is_transient(&io::Error::new(kind, "permanent")), "{kind:?} 不该重试");
        }
        // 平台语义相反的典型：EACCES 在 unix 是永久权限问题，在 Windows 常是「映像正被占用」
        let denied = io::Error::new(io::ErrorKind::PermissionDenied, "denied");
        assert_eq!(is_transient(&denied), cfg!(windows), "PermissionDenied 只在 Windows 算瞬时");
    }
}
