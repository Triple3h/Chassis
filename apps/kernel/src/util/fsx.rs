//! 文件与 JSON 工具（对齐 v1 `util/fsx.ts`）：原子写 / 宽容读 / 目录与路径工具。

use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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
        let root = Path::new("/tmp/ui-dist");
        assert_eq!(resolve_within_root(root, "index.html").unwrap(), Path::new("/tmp/ui-dist/index.html"));
        assert_eq!(resolve_within_root(root, "/assets/a.js").unwrap(), Path::new("/tmp/ui-dist/assets/a.js"));
        assert_eq!(resolve_within_root(root, "a/../b.js").unwrap(), Path::new("/tmp/ui-dist/b.js"));
        assert!(resolve_within_root(root, "../etc/passwd").is_none());
        assert!(resolve_within_root(root, "assets/../../etc/passwd").is_none());
        assert!(resolve_within_root(root, "").is_none());
        // 组件级比较：兄弟目录不能冒充
        assert!(resolve_within_root(Path::new("/tmp/ui"), "../ui-dist/x").is_none());
    }

    #[test]
    fn percent_decode_handles_escapes_and_garbage() {
        assert_eq!(percent_decode("/a%20b/c.js"), "/a b/c.js");
        assert_eq!(percent_decode("/%E4%B8%AD%E6%96%87"), "/中文");
        assert_eq!(percent_decode("/bad%zz"), "/bad%zz", "非法序列原样保留");
        assert_eq!(percent_decode("/plain"), "/plain");
    }
}
