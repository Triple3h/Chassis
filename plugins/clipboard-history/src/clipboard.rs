//! Windows 剪贴板读写（`plugin-spec` §8.1 的「内容侧」）。
//!
//! 只编 Windows（插件整包声明 `platforms: ["windows"]`）。三条约定：
//!  1. **一条历史 = 一种内容**：剪贴板常常同时挂着好几种格式（复制文件时既有 `CF_HDROP`
//!     又有路径文本），按 `文件 → 图片 → 文本` 取一种，避免同一件事记两条。
//!  2. **图片存缩略图**（长边 1024）：历史里要的是「认得出是哪张」，不是原图归档 ——
//!     顺带把容量与 IPC 都控住（原图动辄十几 MB）。
//!  3. `OpenClipboard` 是全局独占的，别人在用就会失败 ⇒ 重试几次再说，失败就是这次没抢到，
//!     不报错给用户（下一次复制自然会补上）。

use std::io::Cursor;
use std::slice;
use std::time::Duration;

use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

use crate::{dib_to_bmp, IMAGE_MAX_EDGE, Kind};

const CF_UNICODETEXT: u32 = 13;
const CF_DIB: u32 = 8;
const CF_DIBV5: u32 = 17;
const CF_HDROP: u32 = 15;
/// `DragQueryFileW(hdrop, 0xFFFFFFFF, ..)` = 问「一共几个文件」
const DRAG_QUERY_COUNT: u32 = 0xFFFF_FFFF;
/// `DROPFILES` 结构大小：pFiles(4) + pt(8) + fNC(4) + fWide(4)
const DROPFILES_BYTES: u32 = 20;

/// 从剪贴板读到的内容（**还没入库**：hash / 落盘在 lib 层）。
#[derive(Debug, Clone)]
pub enum Payload {
    Text(String),
    Image { png: Vec<u8>, width: u32, height: u32 },
    Files(Vec<String>),
}

impl Payload {
    pub fn kind(&self) -> Kind {
        match self {
            Payload::Text(_) => Kind::Text,
            Payload::Image { .. } => Kind::Image,
            Payload::Files(_) => Kind::File,
        }
    }
}

/// 读当前剪贴板（`capture_images = false` 时跳过图片，设置项关掉就不再碰图片那一支）。
pub fn read_payload(capture_images: bool) -> Result<Option<Payload>, String> {
    open_clipboard()?;
    let outcome = unsafe { read_formats(capture_images) };
    unsafe { let _ = CloseClipboard(); };
    outcome
}

/// 把一条历史写回剪贴板（用户点「贴回」时的那条路径）。
pub fn write_payload(payload: &Payload) -> Result<(), String> {
    open_clipboard()?;
    let outcome = unsafe {
        match EmptyClipboard() {
            Ok(()) => put_payload(payload),
            Err(err) => Err(format!("清空剪贴板失败：{err}")),
        }
    };
    unsafe { let _ = CloseClipboard(); };
    outcome
}

fn open_clipboard() -> Result<(), String> {
    for _ in 0..8 {
        if unsafe { OpenClipboard(None) }.is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Err("剪贴板正被其它程序占用".to_string())
}

unsafe fn read_formats(capture_images: bool) -> Result<Option<Payload>, String> {
    if IsClipboardFormatAvailable(CF_HDROP).is_ok() {
        if let Some(paths) = read_files() {
            if !paths.is_empty() {
                return Ok(Some(Payload::Files(paths)));
            }
        }
    }
    if capture_images {
        if let Some(image) = read_image()? {
            return Ok(Some(image));
        }
    }
    Ok(read_text().map(Payload::Text))
}

unsafe fn read_text() -> Option<String> {
    let handle = GetClipboardData(CF_UNICODETEXT).ok()?;
    let global = HGLOBAL(handle.0);
    let ptr = GlobalLock(global);
    if ptr.is_null() {
        return None;
    }
    let units = GlobalSize(global) / 2;
    let slice = slice::from_raw_parts(ptr as *const u16, units);
    let end = slice.iter().position(|unit| *unit == 0).unwrap_or(slice.len());
    let text = String::from_utf16_lossy(&slice[..end]);
    let _ = GlobalUnlock(global);
    Some(text)
}

unsafe fn read_files() -> Option<Vec<String>> {
    let handle = GetClipboardData(CF_HDROP).ok()?;
    let drop = HDROP(handle.0);
    let count = DragQueryFileW(drop, DRAG_QUERY_COUNT, None);
    let mut paths = Vec::new();
    for index in 0..count {
        let chars = DragQueryFileW(drop, index, None) as usize;
        if chars == 0 {
            continue;
        }
        let mut buffer = vec![0u16; chars + 1];
        DragQueryFileW(drop, index, Some(&mut buffer));
        let end = buffer.iter().position(|unit| *unit == 0).unwrap_or(buffer.len());
        paths.push(String::from_utf16_lossy(&buffer[..end]));
    }
    Some(paths)
}

/// `CF_DIB(V5)` → PNG 缩略图。
///
/// 剪贴板里的 DIB 是「BITMAPINFOHEADER + 像素」，没有 BMP 文件头；`image` 认的是完整 BMP。
/// 所以先补一个 14 字节的 `BITMAPFILEHEADER`（关键是 `bfOffBits`：调色板 / BI_BITFIELDS 掩码
/// 都要算进去，否则颜色会整体错位）。
unsafe fn read_image() -> Result<Option<Payload>, String> {
    let handle = match GetClipboardData(CF_DIBV5) {
        Ok(handle) => handle,
        Err(_) => match GetClipboardData(CF_DIB) {
            Ok(handle) => handle,
            Err(_) => return Ok(None),
        },
    };
    let global = HGLOBAL(handle.0);
    let ptr = GlobalLock(global);
    if ptr.is_null() {
        return Ok(None);
    }
    let size = GlobalSize(global);
    let dib = slice::from_raw_parts(ptr as *const u8, size).to_vec();
    let _ = GlobalUnlock(global);

    let Some(bmp) = dib_to_bmp(&dib) else {
        return Ok(None);
    };
    let decoded = image::load_from_memory(&bmp).map_err(|err| format!("剪贴板图片解码失败：{err}"))?;
    let scaled = if decoded.width().max(decoded.height()) > IMAGE_MAX_EDGE {
        decoded.thumbnail(IMAGE_MAX_EDGE, IMAGE_MAX_EDGE)
    } else {
        decoded
    };
    let mut png: Vec<u8> = Vec::new();
    scaled
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|err| format!("缩略图编码失败：{err}"))?;
    Ok(Some(Payload::Image { png, width: scaled.width(), height: scaled.height() }))
}

unsafe fn put_payload(payload: &Payload) -> Result<(), String> {
    match payload {
        Payload::Text(text) => put_unicode_text(text),
        Payload::Image { png, .. } => put_image(png),
        Payload::Files(paths) => put_files(paths),
    }
}

/// 把一段字节放进 `GlobalAlloc` 的可移动内存并交给剪贴板。
///
/// 成功后**系统拥有这块内存**（不能 `GlobalFree`）；只有 `SetClipboardData` 失败才自己回收。
unsafe fn hand_to_clipboard(format: u32, bytes: &[u8]) -> Result<(), String> {
    let global = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(|err| err.to_string())?;
    let ptr = GlobalLock(global);
    if ptr.is_null() {
        let _ = GlobalFree(Some(global));
        return Err("GlobalLock 失败".to_string());
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
    let _ = GlobalUnlock(global);
    match SetClipboardData(format, Some(HANDLE(global.0))) {
        Ok(_) => Ok(()),
        Err(err) => {
            let _ = GlobalFree(Some(global));
            Err(format!("SetClipboardData 失败：{err}"))
        }
    }
}

unsafe fn put_unicode_text(text: &str) -> Result<(), String> {
    let mut units: Vec<u16> = text.encode_utf16().collect();
    units.push(0);
    let bytes: Vec<u8> = units.iter().flat_map(|unit| unit.to_le_bytes()).collect();
    hand_to_clipboard(CF_UNICODETEXT, &bytes)
}

/// 图片 → `CF_DIB`：让 `image` 编一份 BMP，再去掉 14 字节文件头 —— 剩下的正是剪贴板要的 DIB。
/// （不手写 `BITMAPV5HEADER`：124 字节的结构体全靠手数偏移，错了就是花屏，不值得。）
unsafe fn put_image(png: &[u8]) -> Result<(), String> {
    let decoded = image::load_from_memory(png).map_err(|err| format!("缩略图解码失败：{err}"))?;
    let mut bmp: Vec<u8> = Vec::new();
    decoded
        .write_to(&mut Cursor::new(&mut bmp), image::ImageFormat::Bmp)
        .map_err(|err| format!("BMP 编码失败：{err}"))?;
    if bmp.len() <= 14 {
        return Err("BMP 编码结果异常".to_string());
    }
    hand_to_clipboard(CF_DIB, &bmp[14..])
}

/// 文件 → `CF_HDROP`：`DROPFILES` + 一串以 null 结尾的宽字符串 + 一个额外的 null 收尾。
unsafe fn put_files(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("没有文件路径".to_string());
    }
    let mut bytes: Vec<u8> = Vec::new();
    bytes.extend_from_slice(&DROPFILES_BYTES.to_le_bytes());
    bytes.extend_from_slice(&0i32.to_le_bytes()); // pt.x
    bytes.extend_from_slice(&0i32.to_le_bytes()); // pt.y
    bytes.extend_from_slice(&0u32.to_le_bytes()); // fNC
    bytes.extend_from_slice(&1u32.to_le_bytes()); // fWide
    for path in paths {
        for unit in path.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes.extend_from_slice(&0u16.to_le_bytes());
    }
    bytes.extend_from_slice(&0u16.to_le_bytes()); // 列表结束
    hand_to_clipboard(CF_HDROP, &bytes)
}


