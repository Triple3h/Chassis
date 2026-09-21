//! 托盘（requirements §3.1）：菜单项由内核提供（便于插件加项），壳只负责渲染与转发点击。

use crate::ipc::Link;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

pub const TRAY_ID: &str = "launcher-tray";

/// 托盘图标：编译进二进制，省掉 dev 与 .app 两种资源路径的差异。
/// 由 `scripts/make-icon.mjs` 生成（同一个放大镜字形，透明底，平台配色不同）。
/// macOS 用 `tray.svg` 那版（纯色，模板图）；Windows 用 `tray-win.svg` 那版（彩色）。
#[cfg(target_os = "macos")]
const TRAY_ICON_PNG: &[u8] = include_bytes!("../../icons/tray.png");
#[cfg(not(target_os = "macos"))]
const TRAY_WIN_ICON_PNG: &[u8] = include_bytes!("../../icons/tray-win.png");

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

    // 图标分平台（字形都是放大镜，配色不同）：
    //  - macOS：菜单栏用**模板图**（只取 alpha 通道，系统按明暗自动反色）—— 纯色字形即可。
    //  - Windows：托盘不做反色，模板图在深色任务栏上会糊成一团 ⇒ 用彩色版。
    #[cfg(target_os = "macos")]
    let png: &[u8] = TRAY_ICON_PNG;
    #[cfg(not(target_os = "macos"))]
    let png: &[u8] = TRAY_WIN_ICON_PNG;

    match tauri::image::Image::from_bytes(png) {
        Ok(icon) => {
            builder = builder.icon(icon);
            #[cfg(target_os = "macos")]
            {
                builder = builder.icon_as_template(true);
            }
        }
        Err(err) => {
            eprintln!("[tray] 托盘图标解码失败，回落到默认图标：{err}");
            if let Some(icon) = app.default_window_icon().cloned() {
                builder = builder.icon(icon);
            }
        }
    }
    builder.build(app).map_err(|err| err.to_string())?;
    Ok(())
}

/// 托盘提示（悬停可见）—— 「现在该按什么键唤出」的落点。
///
/// 为什么不只靠系统通知：Windows 上的 toast 对**绿色版**不可靠（没有开始菜单快捷方式 ⇒
/// 没有 AUMID，toast 会被静默丢弃），而热键注册成功 / 回退这件事只说给过 toast ——
/// 用户于是「按了没反应，也不知道该按哪个」（2026-09-21 实机反馈）。
pub fn set_tooltip(app: &AppHandle, text: &str) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(text));
    }
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
