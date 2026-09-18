//! 结果项的二级面板内容（`plugin-spec` §9.2 的 `detail`，**纯文本**）：
//! 文本类给前若干行，其余给元数据（类型 / 大小）。
//!
//! 这是 m5 计划 §B2.7 的**第一步**（零契约变更：不新增字段、不新增 capability ——
//! 读文件的权限已由 `exec.spawn`「可读写文件」覆盖）。富预览（图片缩略图 / PDF 首页）
//! 需要新 capability 与结果项字段，另议。
//!
//! 成本约束（很重要）：搜索是热路径，**只对最终要展示的那几条算**（宿主还要走 200ms 预算）：
//!  - 文本判定 = 扩展名白名单 + 大小上限 + 首 8KB 不含 NUL 字节；
//!  - 读盘只读前 `SCAN_BYTES`，读不到（权限 / 被占用 / 不是文件）一律退回元数据，不报错。

use std::io::Read;
use std::path::Path;

/// 文本预览的大小上限（超过就只给元数据）
pub const MAX_TEXT_BYTES: u64 = 512 * 1024;
/// 判定"是不是文本"时看的字节数
const SNIFF_BYTES: usize = 8 * 1024;
/// 真正读进来做预览的字节数
const SCAN_BYTES: usize = 32 * 1024;
/// 最多给前几行
const MAX_LINES: usize = 20;
/// 单行的字符上限（防止一行几千字符把面板撑爆）
const MAX_LINE_CHARS: usize = 200;

/// 生成结果项的 `detail`；拿不到内容时至少给元数据，**文件不存在则返回空串**
/// （调用方据此不带这个字段 —— 二级面板不该显示"未知 · 0 B"这种噪音）。
pub fn detail_of(path: &str) -> String {
    let target = Path::new(path);
    let Ok(metadata) = std::fs::metadata(target) else { return String::new() };
    let size = metadata.len();
    let label = type_label(&crate::extension_of(path));

    let small_enough = size > 0 && size <= MAX_TEXT_BYTES;
    if small_enough && !metadata.is_dir() && is_text_ext(path) {
        if let Some(text) = read_head(target) {
            if !text.trim().is_empty() {
                return text;
            }
        }
    }
    meta_line(label, size)
}

/// 元数据行（二进制 / 读不到内容时）
fn meta_line(label: &str, size: u64) -> String {
    format!("{} · {}", label, human_size(size))
}

/// 读前 `SCAN_BYTES` 并截取前若干行（含 NUL 判定：读到 NUL 就当作二进制）
fn read_head(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut buffer = vec![0u8; SCAN_BYTES];
    let mut limited = std::io::Read::take(file, SCAN_BYTES as u64);
    let read = limited.read(&mut buffer).ok()?;
    let bytes = &buffer[..read];
    if bytes.iter().take(SNIFF_BYTES).any(|byte| *byte == 0) {
        return None; // 二进制，不预览内容
    }
    let text = String::from_utf8_lossy(bytes);
    let mut lines: Vec<String> = Vec::new();
    for line in text.lines().take(MAX_LINES) {
        let mut chars: Vec<char> = line.trim_end().chars().take(MAX_LINE_CHARS).collect();
        if chars.len() == MAX_LINE_CHARS {
            chars.extend("…".chars());
        }
        lines.push(chars.into_iter().collect());
    }
    Some(lines.join("\n"))
}

/// 允许预览内容的扩展名（其余只给元数据）
fn is_text_ext(path: &str) -> bool {
    let ext = crate::extension_of(path);
    matches!(
        ext.as_str(),
        "txt" | "md" | "log" | "csv" | "json" | "toml" | "yaml" | "yml" | "ini" | "ts" | "tsx" | "js"
            | "jsx" | "py" | "go" | "rs" | "sh" | "c" | "h" | "cpp" | "java" | "html" | "css" | "env"
    )
}

/// 展示用类型名（与 `icon_for` 的图标选择同源思路，但这里是给人读的）
fn type_label(ext: &str) -> &'static str {
    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "heic" | "heif" | "bmp" => "图片",
        "mp4" | "mov" | "mkv" | "avi" | "webm" => "视频",
        "mp3" | "wav" | "flac" | "m4a" => "音频",
        "zip" | "7z" | "rar" | "gz" | "tar" => "压缩包",
        "pdf" => "PDF",
        "md" => "Markdown",
        "json" | "toml" | "yaml" | "yml" | "ini" | "env" => "配置",
        "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "rs" | "c" | "h" | "cpp" | "java" | "sh" => "代码",
        "txt" | "log" | "csv" | "html" | "css" => "文本",
        "exe" | "msi" | "lnk" => "程序",
        "" => "文件",
        _ => "文件",
    }
}

/// `12.3 KB` 这种给人读的大小
fn human_size(size: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    let value = size as f64;
    if value >= GB {
        format!("{:.1} GB", value / GB)
    } else if value >= MB {
        format!("{:.1} MB", value / MB)
    } else if value >= KB {
        format!("{:.1} KB", value / KB)
    } else {
        format!("{size} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("file-search-preview-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn text_files_preview_first_lines() {
        let dir = tmp("text");
        let file = dir.join("notes.md");
        std::fs::write(&file, "# 标题\n第一行\n第二行\n第三行\n").unwrap();
        let detail = detail_of(&file.to_string_lossy());
        assert!(detail.contains("# 标题"), "detail = {detail:?}");
        assert!(detail.contains("第一行"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn binary_files_fall_back_to_metadata() {
        let dir = tmp("bin");
        let file = dir.join("shot.png");
        // 带 NUL 的"伪 PNG"：读到 NUL ⇒ 不当文本预览
        let mut bytes = vec![0x89, 0x50, 0x4E, 0x47];
        bytes.extend(std::iter::repeat(0u8).take(64));
        std::fs::write(&file, bytes).unwrap();
        let detail = detail_of(&file.to_string_lossy());
        assert_eq!(detail, "图片 · 68 B", "detail = {detail:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsupported_extensions_show_type_only() {
        assert!(is_text_ext("/a/b/note.md"));
        assert!(!is_text_ext("/a/b/movie.mp4"));
        assert!(!is_text_ext("/a/b/noext"));
        let dir = tmp("other");
        let file = dir.join("clip.mp4");
        std::fs::write(&file, vec![1u8; 2048]).unwrap();
        assert_eq!(detail_of(&file.to_string_lossy()), "视频 · 2.0 KB");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_files_yield_no_detail() {
        assert_eq!(detail_of("/definitely/not/here.txt"), "", "读不到的文件不该带 detail");
    }

    #[test]
    fn human_size_reads_naturally() {
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(2048), "2.0 KB");
        assert_eq!(human_size(3 * 1024 * 1024), "3.0 MB");
    }
}
