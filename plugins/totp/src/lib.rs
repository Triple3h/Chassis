//! 本地图片查找与读取（v1 `src/no-view/find-image.ts` 的 Rust 版）。
//!
//! 为什么需要它：View 插件跑在 iframe 里，浏览器沙箱不允许按路径读文件；
//! 而 `mode: "script"` 的命令能正常访问文件系统。于是「截图存盘 → 按路径读进来」这条路是通的，
//! **解码（zxing-wasm）仍在 View 侧**：这里只负责找到文件、校验、转 base64。
//!
//! 安全约束（这一层能读整块磁盘，必须自己收紧）：
//!   1. 默认只在常见截图/图片目录里**单层**扫描，不递归、不越界；
//!   2. 只有显式传入 path 时才读取其它位置，且必须通过扩展名白名单 + 文件头魔数校验；
//!   3. 单文件大小上限，避免一张巨型图把内存和 IPC 打爆。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;

pub const MAX_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalImageFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime: i64,
    pub mime: String,
    /// base64（不带 `data:` 前缀）
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalImageInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime: i64,
    pub mime: String,
}

fn ext_mime(ext: &str) -> Option<&'static str> {
    match ext {
        ".png" => Some("image/png"),
        ".jpg" | ".jpeg" => Some("image/jpeg"),
        ".webp" => Some("image/webp"),
        ".gif" => Some("image/gif"),
        ".bmp" => Some("image/bmp"),
        ".heic" | ".heif" => Some("image/heic"),
        _ => None,
    }
}

fn home_dir() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/"))
}

/// 常见截图落点（macOS 截图默认在桌面，Windows 在「图片/屏幕截图」）。
pub fn default_scan_dirs() -> Vec<PathBuf> {
    let home = home_dir();
    let mut dirs = vec![
        home.join("Pictures").join("Screenshots"),
        home.join("Pictures"),
        home.join("Desktop"),
        home.join("Downloads"),
    ];
    if cfg!(target_os = "macos") {
        // macOS 中文系统会把目录显示成中文，但磁盘上仍是英文名
        dirs.insert(0, home.join("Desktop"));
    }
    let mut seen: HashSet<PathBuf> = HashSet::new();
    dirs.into_iter().filter(|dir| seen.insert(dir.clone())).collect()
}

/// `path.extname().toLowerCase()` 的等价实现（小写、含前导点）。
pub fn extension_of(file_path: &str) -> String {
    let name = file_path.rsplit('/').next().unwrap_or(file_path);
    match name.rfind('.') {
        Some(index) if index > 0 => name[index..].to_lowercase(),
        _ => String::new(),
    }
}

pub fn is_supported_ext(file_path: &str) -> bool {
    ext_mime(&extension_of(file_path)).is_some()
}

pub fn mime_from_ext(file_path: &str) -> String {
    ext_mime(&extension_of(file_path)).unwrap_or("application/octet-stream").to_string()
}

/// 用文件头判断真实类型，比扩展名可靠（顺便挡掉「改名成 .png 的其它文件」）。
pub fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 12 {
        return None;
    }
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(&[0x47, 0x49, 0x46]) {
        return Some("image/gif");
    }
    if bytes.starts_with(&[0x42, 0x4D]) {
        return Some("image/bmp");
    }
    if bytes.starts_with(&[0x52, 0x49, 0x46, 0x46]) && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    // HEIC/HEIF: ....ftypheic / heix / mif1
    if &bytes[4..8] == b"ftyp" {
        return Some("image/heic");
    }
    None
}

/// 清洗用户粘贴进来的路径：
///  - 去掉首尾空白与包裹的引号（Finder / PowerShell「复制路径」都可能带）
///  - macOS/Linux 下把终端转义出来的 `\ ` 还原成空格
///  - 展开开头的 `~`
pub fn normalize_path_input(input: &str) -> PathBuf {
    let mut text = input.trim().to_string();
    let quoted = (text.starts_with('"') && text.ends_with('"') && text.len() >= 2)
        || (text.starts_with('\'') && text.ends_with('\'') && text.len() >= 2);
    if quoted {
        text = text[1..text.len() - 1].trim().to_string();
    }
    if !cfg!(target_os = "windows") {
        text = text.replace("\\ ", " ");
    }
    if text == "~" {
        return home_dir();
    }
    if let Some(rest) = text.strip_prefix("~/").or_else(|| text.strip_prefix("~\\")) {
        return home_dir().join(rest);
    }
    PathBuf::from(text)
}

fn mtime_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Default)]
pub struct ScanOptions {
    /// 只看最近多少分钟内改动过的文件
    pub within_minutes: Option<i64>,
    /// 最多返回几个候选
    pub limit: Option<usize>,
    /// 自定义扫描目录（测试用）
    pub dirs: Option<Vec<PathBuf>>,
    /// 当前时间戳（测试用）
    pub now: Option<i64>,
}

/// 列出最近的候选图片（只读目录元信息，不读文件内容）。
pub fn scan_recent_images(options: &ScanOptions) -> Vec<LocalImageInfo> {
    let within = options.within_minutes.unwrap_or(30) * 60 * 1000;
    let limit = options.limit.unwrap_or(8);
    let dirs = options.dirs.clone().unwrap_or_else(default_scan_dirs);
    let now = options.now.unwrap_or_else(|| SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0));

    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<LocalImageInfo> = Vec::new();

    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            // 目录不存在 / 没权限，跳过就好
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let full = entry.path();
            let full_text = full.to_string_lossy().to_string();
            if seen.contains(&full_text) || !is_supported_ext(&full_text) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else { continue };
            if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_BYTES {
                continue;
            }
            let mtime = mtime_ms(&full);
            if now - mtime > within {
                continue;
            }
            let mime = mime_from_ext(&full_text);
            seen.insert(full_text.clone());
            out.push(LocalImageInfo { path: full_text, name, size: metadata.len(), mtime, mime });
        }
    }
    // 同一毫秒写入的文件很多（连续截图），用路径兜底保证结果稳定可比
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime).then(a.path.cmp(&b.path)));
    out.truncate(limit);
    out
}

/// 读取指定图片并转成 base64（含魔数校验）。
pub fn read_image_file(input_path: &str) -> Result<LocalImageFile, String> {
    let resolved = normalize_path_input(input_path);
    let resolved_text = resolved.to_string_lossy().to_string();
    if !is_supported_ext(&resolved_text) {
        let ext = extension_of(&resolved_text);
        let shown = if ext.is_empty() { "（无扩展名）".to_string() } else { ext };
        return Err(format!("不支持的图片格式：{shown}，请给 .png / .jpg / .webp 等图片文件"));
    }
    if !resolved.exists() {
        return Err(format!("文件不存在：{resolved_text}"));
    }
    let metadata = std::fs::metadata(&resolved).map_err(|err| err.to_string())?;
    if !metadata.is_file() {
        return Err("这不是一个文件".to_string());
    }
    if metadata.len() == 0 {
        return Err("文件是空的".to_string());
    }
    if metadata.len() > MAX_BYTES {
        return Err(format!("图片太大（{:.1}MB），请压缩到 20MB 以内", metadata.len() as f64 / 1_048_576.0));
    }
    let bytes = std::fs::read(&resolved).map_err(|err| err.to_string())?;
    let Some(mime) = sniff_mime(&bytes) else {
        return Err("这个文件不是能被识别的图片（文件头校验失败）".to_string());
    };
    let name = resolved.file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_default();
    Ok(LocalImageFile {
        path: resolved_text,
        name,
        size: bytes.len() as u64,
        mtime: mtime_ms(&resolved),
        mime: mime.to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("totp-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const PNG: [u8; 12] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
    const JPEG: [u8; 12] = [0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1];
    const WEBP: [u8; 12] = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
    const HEIC: [u8; 12] = [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63];

    #[test]
    fn sniff_recognises_headers() {
        assert_eq!(sniff_mime(&PNG), Some("image/png"));
        assert_eq!(sniff_mime(&JPEG), Some("image/jpeg"));
        assert_eq!(sniff_mime(&WEBP), Some("image/webp"));
        assert_eq!(sniff_mime(&HEIC), Some("image/heic"));
        assert_eq!(sniff_mime(&[0x47, 0x49, 0x46, 0x38, 0, 0, 0, 0, 0, 0, 0, 0]), Some("image/gif"));
        assert_eq!(sniff_mime(&[0x42, 0x4D, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Some("image/bmp"));
        assert_eq!(sniff_mime(b"not an image at all"), None);
        assert_eq!(sniff_mime(&PNG[..8]), None, "太短不给判定");
    }

    #[test]
    fn ext_mapping_covers_aliases() {
        assert_eq!(mime_from_ext("/a/b/photo.JPEG"), "image/jpeg");
        assert_eq!(mime_from_ext("/a/b/shot.heif"), "image/heic");
        assert_eq!(mime_from_ext("/a/b/archive.zip"), "application/octet-stream");
        assert!(is_supported_ext("/a/b/x.png"));
        assert!(!is_supported_ext("/a/b/.png"), "以点开头的文件名不算扩展名");
    }

    #[test]
    fn normalizes_user_pasted_paths() {
        let home = home_dir();
        assert_eq!(normalize_path_input("  /tmp/a.png  "), PathBuf::from("/tmp/a.png"));
        assert_eq!(normalize_path_input("\"/tmp/a b.png\""), PathBuf::from("/tmp/a b.png"));
        assert_eq!(normalize_path_input("/tmp/a\\ b.png"), PathBuf::from("/tmp/a b.png"));
        assert_eq!(normalize_path_input("~/Desktop/s.png"), home.join("Desktop/s.png"));
        assert_eq!(normalize_path_input("~"), home);
    }

    #[test]
    fn read_image_returns_base64_and_mime() {
        let dir = tmp("read");
        let file = dir.join("shot.png");
        let mut bytes = PNG.to_vec();
        bytes.extend_from_slice(b"payload");
        std::fs::write(&file, &bytes).unwrap();

        let result = read_image_file(&file.to_string_lossy()).unwrap();
        assert_eq!(result.mime, "image/png");
        assert_eq!(result.name, "shot.png");
        assert_eq!(result.size, bytes.len() as u64);
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(&result.data).unwrap(), bytes);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_image_rejects_bad_inputs() {
        let dir = tmp("reject");
        let text_file = dir.join("notes.txt");
        std::fs::write(&text_file, "hello").unwrap();
        assert!(read_image_file(&text_file.to_string_lossy()).unwrap_err().contains("不支持的图片格式"));

        let fake_png = dir.join("fake.png");
        std::fs::write(&fake_png, "definitely not a png").unwrap();
        assert!(read_image_file(&fake_png.to_string_lossy()).unwrap_err().contains("文件头校验失败"));

        let empty = dir.join("empty.png");
        std::fs::write(&empty, b"").unwrap();
        assert!(read_image_file(&empty.to_string_lossy()).unwrap_err().contains("文件是空的"));

        assert!(read_image_file(&dir.join("missing.png").to_string_lossy()).unwrap_err().contains("文件不存在"));
        assert!(read_image_file(&dir.to_string_lossy()).unwrap_err().contains("不支持的图片格式"), "目录没有扩展名");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_filters_by_age_ext_and_size() {
        let dir = tmp("scan");
        let fresh = dir.join("fresh.png");
        std::fs::write(&fresh, PNG).unwrap();
        let old = dir.join("old.png");
        std::fs::write(&old, PNG).unwrap();
        let hidden = dir.join(".hidden.png");
        std::fs::write(&hidden, PNG).unwrap();
        let other = dir.join("notes.txt");
        std::fs::write(&other, "x").unwrap();
        let empty = dir.join("empty.png");
        std::fs::write(&empty, b"").unwrap();

        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
        let hits = scan_recent_images(&ScanOptions {
            within_minutes: Some(30),
            limit: Some(8),
            dirs: Some(vec![dir.clone()]),
            now: Some(now),
        });
        let names: Vec<String> = hits.iter().map(|hit| hit.name.clone()).collect();
        assert!(names.contains(&"fresh.png".to_string()));
        assert!(!names.contains(&"notes.txt".to_string()), "扩展名白名单");
        assert!(!names.contains(&".hidden.png".to_string()), "点开头的文件跳过");
        assert!(!names.contains(&"empty.png".to_string()), "空文件跳过");

        // 时间窗：把 now 推到 2 小时后，fresh 也过期了
        let future = now + 2 * 60 * 60 * 1000;
        let later = scan_recent_images(&ScanOptions {
            within_minutes: Some(30),
            limit: Some(8),
            dirs: Some(vec![dir.clone()]),
            now: Some(future),
        });
        assert!(later.is_empty(), "超出时间窗的文件不该出现");

        // limit 生效
        for index in 0..5 {
            std::fs::write(dir.join(format!("shot-{index}.png")), PNG).unwrap();
        }
        let limited = scan_recent_images(&ScanOptions {
            within_minutes: Some(30),
            limit: Some(3),
            dirs: Some(vec![dir.clone()]),
            now: Some(now),
        });
        assert_eq!(limited.len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
