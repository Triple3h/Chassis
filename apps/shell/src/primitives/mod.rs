//! 原语清单（requirements §6.1，全部，不再多）。
//! 壳不做的事：不做搜索、不读插件目录、不认识「命令」、不做排序、不存历史。

pub mod clipboard;
pub mod hotkey;
pub mod notify;
pub mod opener;
pub mod screenshot;
pub mod selection;
pub mod tray;
pub mod usage;
pub mod window;

use crate::ipc::Outcome;
use serde_json::{json, Value};
use tauri::AppHandle;

/// JSON-RPC 方法分发：内核请求 → 壳执行
pub fn dispatch(app: &AppHandle, method: &str, params: &Value) -> Outcome {
    match method {
        // 交互式截图要等用户操作（拖选区 / 取消，可能几十秒）：执行放独立线程，读循环继续服务
        "screenshot.start" => Outcome::Later(screenshot::start(app, params)),

        "window.show" => Outcome::Now(window::show(app, params)),
        "window.hide" => Outcome::Now(window::hide(app)),
        "window.isVisible" => Outcome::Now(window::is_visible(app)),
        "window.setHeight" => Outcome::Now(window::set_height(app, params)),
        "window.setSize" => Outcome::Now(window::set_size(app, params)),
        "window.startDragging" => Outcome::Now(window::start_dragging(app)),
        "window.startResizeDragging" => Outcome::Now(window::start_resize_dragging(app, params)),

        "selection.read" => Outcome::Now(selection::read(app, params)),

        "hotkey.register" => Outcome::Now(hotkey::register(app, params)),
        "hotkey.unregister" => Outcome::Now(hotkey::unregister(app)),

        "tray.setMenu" => Outcome::Now(tray::set_menu(app, params)),

        "notify.show" => Outcome::Now(notify::show(app, params)),

        "clipboard.readText" => Outcome::Now(clipboard::read_text(app)),
        "clipboard.writeText" => Outcome::Now(clipboard::write_text(app, params)),
        "clipboard.watch" => Outcome::Now(clipboard::watch(app, params)),

        "open.url" => Outcome::Now(opener::open_url(app, params)),
        "open.path" => Outcome::Now(opener::open_path(app, params)),
        "open.reveal" => Outcome::Now(opener::reveal(app, params)),

        "app.setAutostart" => Outcome::Now(set_autostart(app, params)),
        "app.info" => Outcome::Now(app_info(app)),
        "app.usage" => Outcome::Now(usage::usage()),
        // 内核热更新：即将优雅重启（内核二进制可能已被替换）。这是**计划内重启** ——
        // supervise 会照常拉起，但不计入崩溃重启预算，且重启后要把窗口导航到新端口。
        "kernel/restarting" => Outcome::Now({
            crate::sidecar::note_hot_restart(params);
            Ok(json!({ "ok": true }))
        }),
        "app.quit" => Outcome::Now({
            crate::shutdown(app);
            Ok(json!(null))
        }),

        other => Outcome::Now(Err(format!("壳未实现该方法：{other}"))),
    }
}

fn set_autostart(app: &AppHandle, params: &Value) -> Result<Value, String> {
    use tauri_plugin_autostart::ManagerExt;
    let enabled = params.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let manager = app.autolaunch();
    let result = if enabled { manager.enable() } else { manager.disable() };
    match result {
        Ok(()) => Ok(json!({ "ok": true, "enabled": enabled })),
        Err(err) => Ok(json!({ "ok": false, "reason": err.to_string() })),
    }
}

fn app_info(app: &AppHandle) -> Result<Value, String> {
    let version = app.package_info().version.to_string();
    // 数据目录只认 `sidecar::data_root` 这一个来源。
    // 这里原先自己拼了一份路径常量 —— 应用改名（Launcher → Chassis）时就成了漏改点：
    // 报告给插件的 dataRoot 与真实数据目录会分叉，插件按它去找文件会找不到。
    let data_root = crate::sidecar::data_root(app).to_string_lossy().to_string();
    Ok(json!({
        "version": version,
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "dataRoot": data_root,
    }))
}
