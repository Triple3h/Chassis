//! 托盘（requirements §3.1）：菜单项由内核提供（便于插件加项），壳只负责渲染与转发点击。

use crate::ipc::Link;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

pub const TRAY_ID: &str = "launcher-tray";

/// 菜单栏图标：编译进二进制，省掉 dev 与 .app 两种资源路径的差异。
/// 由 `scripts/make-icon.mjs` 从 `icons/tray.svg` 生成（透明底单色字形）。
const TRAY_ICON_PNG: &[u8] = include_bytes!("../../icons/tray.png");

pub fn ensure(app: &AppHandle) -> Result<(), String> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let menu = Menu::with_items(app, &[]).map_err(|err| err.to_string())?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            if id == "quit" {
                crate::shutdown(app);
                return;
            }
            if id == "show" {
                // 显隐的**结果**一样要回报（UI 靠它决定播放入场动画还是维持现状），
                // 且与热键走同一条：选区随之带回内核
                super::window::show_and_report(app, true);
                return;
            }
            if let Some(link) = app.try_state::<Arc<Link>>() {
                link.notify("tray/menu", json!({ "id": id }));
            }
        })
        .on_tray_icon_event(|tray, event| {
            // 左键点击 = 唤出/隐藏
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                // 与热键共用同一个 toggle（含"正在演离场时按一次是取消隐藏"的判断）。
                // 不要在这里自己写一遍显隐判断：两条路径的边界会慢慢漂开。
                super::window::toggle(tray.app_handle());
            }
        });

    // 图标分平台：
    //  - macOS：菜单栏用**模板图**（只取 alpha 通道，系统按明暗自动反色）。
    //    直接把彩色应用图标塞进菜单栏会又糊又不对味（系统还会把它压到 18pt）。
    //  - Windows：托盘用**彩色应用图标** —— 模板图是 macOS 的概念，Windows 托盘不做反色，
    //    单色字形在深色任务栏上会糊成一团。
    match tauri::image::Image::from_bytes(TRAY_ICON_PNG) {
        Ok(icon) => {
            #[cfg(target_os = "macos")]
            {
                builder = builder.icon(icon).icon_as_template(true);
            }
            #[cfg(not(target_os = "macos"))]
            {
                let colored = app.default_window_icon().cloned().unwrap_or(icon);
                builder = builder.icon(colored);
            }
        }
        Err(err) => {
            eprintln!("[tray] 菜单栏图标解码失败，回落到默认图标：{err}");
            if let Some(icon) = app.default_window_icon().cloned() {
                builder = builder.icon(icon);
            }
        }
    }
    builder.build(app).map_err(|err| err.to_string())?;
    Ok(())
}

/// 菜单由内核提供（settings / plugins / reload 由内核处理，show / quit 壳自己处理）
pub fn set_menu(app: &AppHandle, params: &Value) -> Result<Value, String> {
    ensure(app)?;
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Err("托盘未初始化".to_string());
    };
    let items = params
        .get("items")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    let mut owned: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();
    for item in items {
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let label = item.get("label").and_then(|v| v.as_str()).unwrap_or("");
        let kind = item.get("type").and_then(|v| v.as_str()).unwrap_or("item");
        if kind == "separator" {
            let separator = PredefinedMenuItem::separator(app).map_err(|err| err.to_string())?;
            owned.push(Box::new(separator));
            continue;
        }
        // `enabled: false` 用于「正在更新应用…」这类进行中的项：可见但不可点
        let enabled = item.get("enabled").and_then(|value| value.as_bool()).unwrap_or(true);
        let entry = MenuItem::with_id(app, id, label, enabled, None::<&str>).map_err(|err| err.to_string())?;
        owned.push(Box::new(entry));
    }

    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = owned.iter().map(|item| item.as_ref()).collect();
    let menu = Menu::with_items(app, &refs).map_err(|err| err.to_string())?;
    tray.set_menu(Some(menu)).map_err(|err| err.to_string())?;
    Ok(json!(null))
}
