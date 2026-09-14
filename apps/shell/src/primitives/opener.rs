//! 打开 URL / 文件 / 应用（requirements §6.1）：壳只做系统原语，不做任何业务判断。
//! 协议白名单（http/https/mailto）由内核校验，这里再兜一层。

use serde_json::{json, Value};
use std::process::Command;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

pub fn open_url(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let url = params.get("url").and_then(|v| v.as_str()).unwrap_or("");
    if !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:")) {
        return Err(format!("只允许 http/https/mailto：{url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| format!("打开 URL 失败：{err}"))?;
    Ok(json!(null))
}

pub fn open_path(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.is_empty() {
        return Err("path 不能为空".to_string());
    }
    let _ = app;
    // 「打开应用」= 用系统默认方式打开 .app bundle，`open` 是最稳的原语
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|err| format!("打开失败：{err}"))?;
        return Ok(json!(null));
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.opener()
            .open_path(path, None::<&str>)
            .map_err(|err| format!("打开失败：{err}"))?;
        Ok(json!(null))
    }
}

/// Finder 中显示（macOS `open -R`）
pub fn reveal(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let path = params.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.is_empty() {
        return Err("path 不能为空".to_string());
    }
    let _ = app;
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map_err(|err| format!("显示失败：{err}"))?;
        return Ok(json!(null));
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.opener()
            .reveal_item_in_dir(path)
            .map_err(|err| format!("显示失败：{err}"))?;
        Ok(json!(null))
    }
}
