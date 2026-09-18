//! Windows 应用扫描后端（m5 计划 §B2.1）。
//!
//! 扫描面（按覆盖面排序）：
//!  ① **开始菜单**（全用户 `%ProgramData%` + 当前用户 `%APPDATA%`）与**桌面**（用户 + 公共）
//!     里的 `.lnk` / `.exe` / `.appref-ms` —— 覆盖绝大多数会出现在开始菜单里的应用；
//!  ② 注册表 **`App Paths`**（HKLM/HKCU `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths`）
//!     —— 程序自己注册的启动器（浏览器、编辑器等）。
//!
//! 为什么 `path` 存 `.lnk` 本身而不是它的目标 exe：打开 `.lnk` 就是启动该应用
//! （ShellExecute 会解析），**双击即所得**；去找目标反而容易在带参数的快捷方式上出错。
//!
//! 图标：`SHGetFileInfoW` 取 HICON（shell 自己会解析 `.lnk` 与 PE 资源）→ GDI 读位图 → PNG。
//! 走系统图标缓存，不自己解析 PE / ICO。
//!
//! 明确不做（后续增量，文档里记着）：`shell:AppsFolder` 的 UWP 应用（要手写 IDispatch 调用）。

use std::path::{Path, PathBuf};
use std::time::Instant;

use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
    HGDIOBJ,
};
use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

use crate::{home_dir, AppEntry, ScanResult};

// ── COM 公寓（shell 图标 API 需要）──────────────────────────────

/// 线程 COM 公寓守卫：本线程没初始化过就初始化，退出时配对释放。
struct ComApartment {
    owns: bool,
}

impl ComApartment {
    fn enter() -> Self {
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        Self { owns: hr.is_ok() }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.owns {
            unsafe { CoUninitialize() };
        }
    }
}

// ── 扫描面 ──────────────────────────────────────────────────────

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var(key).ok().filter(|value| !value.trim().is_empty()).map(PathBuf::from)
}

/// 开始菜单目录：全用户 + 当前用户。
pub fn start_menu_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(program_data) = env_path("ProgramData") {
        out.push(program_data.join("Microsoft").join("Windows").join("Start Menu").join("Programs"));
    }
    if let Some(appdata) = env_path("APPDATA") {
        out.push(appdata.join("Microsoft").join("Windows").join("Start Menu").join("Programs"));
    }
    out
}

/// 桌面目录：当前用户 + 公共。
pub fn desktop_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let home = home_dir();
    if !home.is_empty() && home != "/" {
        out.push(PathBuf::from(&home).join("Desktop"));
    }
    if let Some(public) = env_path("PUBLIC") {
        out.push(public.join("Desktop"));
    }
    out
}

/// 收集一个目录下的快捷方式（递归，深度上限 3：开始菜单里就是两三层）。
fn collect_shortcuts(dir: &Path, depth: u32, out: &mut Vec<AppEntry>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if depth > 0 && !name.starts_with('.') {
                collect_shortcuts(&path, depth - 1, out);
            }
            continue;
        }
        let lower = name.to_lowercase();
        let is_shortcut = lower.ends_with(".lnk") || lower.ends_with(".exe") || lower.ends_with(".appref-ms");
        if !is_shortcut {
            continue;
        }
        // 卸载器 / 帮助 / 文档之类的入口不该出现在启动台里（与开始菜单的观感一致）
        if is_noise_shortcut(&lower) {
            continue;
        }
        let Some(stem) = Path::new(&name).file_stem().map(|value| value.to_string_lossy().to_string()) else { continue };
        if stem.trim().is_empty() {
            continue;
        }
        let full = path.to_string_lossy().to_string();
        out.push(AppEntry {
            name: stem,
            path: full.clone(),
            aliases: Vec::new(),
            // 图标源 = 快捷方式本身：shell 会解析 .lnk 的目标与自定义图标
            icon_file: Some(full),
            acronym: None,
        });
    }
}

fn is_noise_shortcut(lower_name: &str) -> bool {
    const NOISE: [&str; 8] = [
        "uninstall", "卸载", "help", "readme", "read me", "website", "官网", "manual",
    ];
    NOISE.iter().any(|item| lower_name.contains(item))
}

/// 注册表 `App Paths`：程序自己注册的启动器（键名 = exe 名，默认值 = exe 路径）。
fn app_paths_entries() -> Vec<AppEntry> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    const APP_PATHS: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths";
    let mut out = Vec::new();
    for hive in [RegKey::predef(HKEY_CURRENT_USER), RegKey::predef(HKEY_LOCAL_MACHINE)] {
        let Ok(root) = hive.open_subkey_with_flags(APP_PATHS, KEY_READ) else { continue };
        for key_name in root.enum_keys().flatten() {
            let Ok(key) = root.open_subkey_with_flags(&key_name, KEY_READ) else { continue };
            let Ok(target) = key.get_value::<String, _>("") else { continue };
            let target = target.trim().to_string();
            if target.is_empty() || !Path::new(&target).exists() {
                continue;
            }
            let stem = Path::new(&key_name).file_stem().map(|value| value.to_string_lossy().to_string()).unwrap_or(key_name.clone());
            if stem.trim().is_empty() {
                continue;
            }
            out.push(AppEntry { name: stem, path: target.clone(), aliases: Vec::new(), icon_file: Some(target), acronym: None });
        }
    }
    out
}

pub fn scan_applications() -> ScanResult {
    let started = Instant::now();
    let mut scanned_dirs: Vec<String> = Vec::new();
    let mut apps: Vec<AppEntry> = Vec::new();

    for dir in start_menu_dirs().into_iter().chain(desktop_dirs()) {
        if !dir.is_dir() {
            continue;
        }
        scanned_dirs.push(dir.to_string_lossy().to_string());
        collect_shortcuts(&dir, 3, &mut apps);
    }
    apps.extend(app_paths_entries());

    // 去重（同一个应用可能在开始菜单与桌面各有一个快捷方式）+ 稳定排序
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    apps.retain(|app| seen.insert(app.path.to_lowercase()));
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.path.cmp(&b.path)));

    ScanResult { apps, scanned_dirs, duration_ms: started.elapsed().as_millis() as i64 }
}

// ── 图标提取（HICON → PNG）──────────────────────────────────────

fn to_wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 用 shell 的图标缓存取 `source`（.lnk / .exe）的图标，缩放到 `size` 并编码 PNG。
pub fn icon_png(source: &str, size: u32) -> Option<Vec<u8>> {
    let _apartment = ComApartment::enter();
    unsafe {
        let wide = to_wide(source);
        let mut info = SHFILEINFOW::default();
        let ok = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if ok == 0 || info.hIcon.is_invalid() {
            return None;
        }
        let png = hicon_to_png(info.hIcon, size);
        let _ = DestroyIcon(info.hIcon);
        png
    }
}

unsafe fn hicon_to_png(icon: HICON, size: u32) -> Option<Vec<u8>> {
    let mut info = ICONINFO::default();
    GetIconInfo(icon, &mut info).ok()?;
    let color = info.hbmColor;
    let mask = info.hbmMask;

    let rgba = hbitmap_to_rgba(color);
    // 两个位图都要还（GetIconInfo 把引用交给了调用方）
    let _ = DeleteObject(HGDIOBJ(mask.0));
    let _ = DeleteObject(HGDIOBJ(color.0));

    let (width, height, mut pixels) = rgba?;
    // GDI 给的是 BGRA；RGBA 才是 PNG 的字节序
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    let image = image::RgbaImage::from_raw(width, height, pixels)?;
    let image = if width != size || height != size {
        image::imageops::resize(&image, size, size, image::imageops::FilterType::Lanczos3)
    } else {
        image
    };
    let mut out: Vec<u8> = Vec::new();
    image.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).ok()?;
    Some(out)
}

/// HBITMAP → RGBA 像素（32bpp、自上而下）。
unsafe fn hbitmap_to_rgba(bitmap: HBITMAP) -> Option<(u32, u32, Vec<u8>)> {
    if bitmap.is_invalid() {
        return None;
    }
    let mut header = BITMAP::default();
    let read = GetObjectW(
        HGDIOBJ(bitmap.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut header as *mut BITMAP as *mut core::ffi::c_void),
    );
    if read == 0 {
        return None;
    }
    let width = header.bmWidth.max(1) as u32;
    let height = header.bmHeight.abs().max(1) as u32;

    let mut info = BITMAPINFO::default();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: header.bmWidth,
        // 负高度 = 自上而下（与 PNG 的行序一致，省掉一次翻转）
        biHeight: -header.bmHeight.abs(),
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };

    let mut pixels = vec![0u8; (width * height * 4) as usize];
    let dc = GetDC(None);
    let lines = GetDIBits(dc, bitmap, 0, height, Some(pixels.as_mut_ptr() as *mut core::ffi::c_void), &mut info, DIB_RGB_COLORS);
    ReleaseDC(None, dc);
    if lines == 0 {
        return None;
    }
    Some((width, height, pixels))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_shortcuts_are_filtered() {
        assert!(is_noise_shortcut("uninstall.exe"));
        assert!(is_noise_shortcut("卸载 MyApp.lnk"));
        assert!(is_noise_shortcut("readme.txt"));
        assert!(!is_noise_shortcut("chrome.exe"));
        assert!(!is_noise_shortcut("visual studio code.lnk"));
    }

    #[test]
    fn scan_dirs_use_env_paths() {
        // 环境变量在测试进程里由系统提供（Windows 上恒有 ProgramData / APPDATA）
        let menus = start_menu_dirs();
        assert!(menus.iter().all(|dir| dir.is_absolute()), "开始菜单目录必须是绝对路径");
        let desktops = desktop_dirs();
        assert!(desktops.iter().all(|dir| dir.is_absolute()));
    }

    #[test]
    fn icon_png_returns_none_for_missing_source() {
        // 不存在的文件：SHGetFileInfoW 拿不到图标 → 安静回落（调用方会退化成通用图标）
        assert!(icon_png("C:\\definitely\\not\\here-xyz.exe", 64).is_none());
    }
}
