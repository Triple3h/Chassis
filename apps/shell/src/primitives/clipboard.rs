//! 剪贴板（requirements §6.1）：优先 arboard，失败回落插件实现。

use serde_json::{json, Value};
use tauri::AppHandle;

pub fn read_text(app: &AppHandle) -> Result<Value, String> {
    if let Ok(text) = arboard::Clipboard::new().and_then(|mut clipboard| clipboard.get_text()) {
        return Ok(json!({ "text": text }));
    }
    use tauri_plugin_clipboard_manager::ClipboardExt;
    match app.clipboard().read_text() {
        Ok(text) => Ok(json!({ "text": text })),
        Err(err) => Err(format!("读取剪贴板失败：{err}")),
    }
}

pub fn write_text(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let text = params.get("text").and_then(|v| v.as_str()).unwrap_or("");
    if let Ok(mut clipboard) = arboard::Clipboard::new() {
        if clipboard.set_text(text.to_string()).is_ok() {
            return Ok(json!(null));
        }
    }
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(text.to_string())
        .map_err(|err| format!("写入剪贴板失败：{err}"))?;
    Ok(json!(null))
}
