//! 系统通知（requirements §6.1）：权限被拒时返回 `{ ok:false, reason:'denied' }`。

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

pub fn show(app: &AppHandle, params: &Value) -> Result<Value, String> {
    let title = params.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let body = params.get("body").and_then(|v| v.as_str()).unwrap_or("");
    match app.notification().builder().title(title).body(body).show() {
        Ok(()) => Ok(json!({ "ok": true })),
        Err(err) => {
            let text = err.to_string();
            let denied = text.to_lowercase().contains("denied") || text.to_lowercase().contains("permission");
            Ok(json!({ "ok": false, "reason": if denied { "denied" } else { text.as_str() } }))
        }
    }
}
