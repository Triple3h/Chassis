//! 壳（Shell）：只提供系统原语，零业务逻辑（requirements §2 / §6）。
//!
//! ```text
//!  窗口 · 全局热键 · 托盘 · 单实例 · 通知 · 剪贴板 · open(URL/文件/应用)
//! ```
//!
//! 启动顺序（重要）：日志 → 窗口/托盘 → 原语分发 → **热键** → 内核 → 就绪后导航。
//! 热键**不等待内核**：否则内核起不来时会变成"装了却唤不出来"的死局。

mod ipc;
mod logging;
mod primitives;
mod sidecar;

use ipc::Link;
use serde_json::json;
use sidecar::Sidecar;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let link = Link::new();
    let sidecar = Arc::new(Sidecar::new(Arc::clone(&link)));

    let builder = tauri::Builder::default()
        // 单实例：第二次启动只唤起已运行实例
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 这条路径以前只 show 不回报：UI 若停在"已隐藏"的透明态，窗口唤出来会是空的。
            // 走 `show_and_report` 与热键同一条路：结果 + 选中文本一起回报给内核
            primitives::window::show_and_report(app, true);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::clone(&link))
        .manage(Arc::clone(&sidecar));

    let sidecar_setup = Arc::clone(&sidecar);
    let link_setup = Arc::clone(&link);

    builder
        .setup(move |app| {
            let handle = app.handle().clone();

            // ① 数据目录 + 日志：GUI 启动时 stderr 会被丢弃，必须落盘才能排查
            // 顺序不能反：接手老目录（应用改名迁移）必须早于 `logging::init`，
            // 因为日志初始化会在数据目录下建 `logs/`，让「新目录已存在」成立后就再也不迁了。
            let data_root = sidecar::data_root(&handle);
            let adopted = sidecar::adopt_legacy_data_dir(&data_root);
            logging::init(&data_root);
            if let Some((legacy, count)) = adopted {
                logging::log(&format!(
                    "[shell] 已接手旧数据目录：{} → {}（复制 {count} 个文件，老目录保留可回退）",
                    legacy.display(),
                    data_root.display()
                ));
            }
            logging::log(&format!("[shell] 启动，数据目录 {}", data_root.display()));

            // ② macOS：不进 Dock（Accessory）
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // ③ 窗口 + 托盘
            if let Err(err) = create_main_window(&handle) {
                logging::log(&format!("[shell] 创建窗口失败：{err}"));
            }
            if let Err(err) = primitives::tray::ensure(&handle) {
                logging::log(&format!("[shell] 托盘初始化失败：{err}"));
            }

            // ④ 内核请求 → 壳原语
            link_setup.set_handler(primitives::dispatch);

            // ⑤ 热键：不等内核（内核没起来也要能唤出窗口看错误）
            match primitives::hotkey::register(&handle, &json!({})) {
                Ok(value) => {
                    logging::log(&format!("[shell] 热键：{value}"));
                    // 告知"已就绪 + 实际热键"，避免用户以为没反应（窗口初始是隐藏的）
                    if value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                        let accelerator = value
                            .get("accelerator")
                            .and_then(|v| v.as_str())
                            .unwrap_or("热键")
                            .to_string();
                        let notify_handle = handle.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(1500));
                            use tauri_plugin_notification::NotificationExt;
                            let _ = notify_handle
                                .notification()
                                .builder()
                                .title("启动台已在菜单栏运行")
                                .body(&format!("按 {accelerator} 唤出（也可点菜单栏图标）"))
                                .show();
                        });
                    }
                }
                Err(err) => logging::log(&format!("[shell] 热键注册异常：{err}")),
            }

            // ⑥ 拉起内核（sidecar）
            if let Err(err) = sidecar_setup.start(&handle) {
                show_boot_error(&handle, &err);
                return Ok(());
            }

            // ⑦ 内核就绪后把窗口导航到内核托管的启动台 UI（ADR-0001）
            let ready_handle = handle.clone();
            let ready_sidecar = Arc::clone(&sidecar_setup);
            std::thread::spawn(move || match ready_sidecar.wait_ready(Duration::from_secs(30)) {
                Ok(port) => {
                    logging::log(&format!("[shell] 内核就绪：UI 端口 {port}"));
                    let url = format!("http://127.0.0.1:{port}");
                    if let Some(window) = ready_handle.get_webview_window("main") {
                        match url.parse() {
                            Ok(parsed) => {
                                let _ = window.navigate(parsed);
                            }
                            Err(err) => logging::log(&format!("[shell] URL 解析失败：{err}")),
                        }
                    }
                }
                Err(err) => show_boot_error(&ready_handle, &err),
            });

            // ⑧ 内核崩溃监督（§6.2：不许白屏）
            sidecar_setup.supervise(handle.clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::Focused(true) => {
                    primitives::window::mark_focused();
                }
                // 失焦隐藏：延迟 120ms 再问内核（避免点击自身子窗口时误隐）
                WindowEvent::Focused(false) => {
                    let handle = window.app_handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(120));
                        // 只显示不要"闪一下就消失"：唤出防抖窗口内 / 从未获得过焦点时都不隐藏
                        if primitives::window::in_show_grace() {
                            logging::log("[shell] 忽略失焦（唤出防抖窗口内）");
                            return;
                        }
                        if !primitives::window::has_focused_since_show() {
                            logging::log("[shell] 忽略失焦（本次显示后从未获得焦点）");
                            return;
                        }
                        logging::log("[shell] 失焦 → 通知内核隐藏");
                        if let Some(link) = handle.try_state::<Arc<Link>>() {
                            link.notify("window/blurred", json!({}));
                        }
                    });
                }
                // 关窗 = 隐藏（退出只能走托盘 / 内核指令）
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    // 与热键 / 托盘同一条规矩：**先报告、等 UI 演完离场，内核再落地**。
                    // 立刻 hide 会让 webview 冻结在「半透明面板」那一帧，下次唤出先闪一下旧画面；
                    // 同时谁真正改了显隐，谁就把结果报给内核。
                    primitives::window::notify_toggled(window.app_handle(), false, None);
                    primitives::window::arm_hide_fallback(window.app_handle());
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("壳初始化失败")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = &event {
                // 没有显式退出码时不退出（窗口隐藏不应结束进程）
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            if let RunEvent::Exit = event {
                if let Some(sidecar) = app.try_state::<Arc<Sidecar>>() {
                    sidecar.shutdown();
                }
            }
        });
}

fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    // `resizable(true)` + `min_inner_size`：无边框窗口要能拖动 / 缩放（requirements §6.2）。
    // 无边框 ⇒ 系统没有可抓的标题栏与边框，拖动与四边/四角缩放都由 UI 画把手、
    // 调 `window.startDragging` / `window.startResizeDragging` 交给系统接管；
    // maximizable/minimizable 仍然关掉（启动台不做最大化/最小化，面板形态是靠拖的）。
    let builder = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
        .title("Chassis")
        .inner_size(720.0, 480.0)
        .min_inner_size(480.0, 240.0)
        .resizable(true)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false);
    // 阴影分平台：
    //  - macOS：系统给无边框窗口画阴影（观感就是系统面板）；
    //  - Windows：DWM 的阴影会给透明无边框窗口描一圈不透明边（透明窗口的已知观感问题），
    //    所以关掉系统阴影，阴影交给 CSS 画（面板自身带柔和外扩）。
    //    实机若发现面板边缘仍有硬边，再回调这一项（B1.8）。
    #[cfg(target_os = "macos")]
    let builder = builder.shadow(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.shadow(false);
    let window = builder.build()?;
    let _ = window.set_always_on_top(true);
    Ok(())
}

/// 内核起不来时显示可操作的错误面板（不许白屏），并把日志路径写进页面
fn show_boot_error(app: &AppHandle, message: &str) {
    let log_hint = logging::log_path()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    logging::log(&format!("[shell] 内核启动失败：{message}"));
    let Some(window) = app.get_webview_window("main") else { return };
    let text = format!("内核启动失败：{message}｜日志：{log_hint}");
    let escaped = text.replace('\\', "\\\\").replace('\'', "\\'").replace('\n', " ");
    let script = format!(
        "(function () {{ var el = document.getElementById('text'); if (el) {{ el.textContent = '{escaped}'; }} \
         else {{ document.body.textContent = '{escaped}'; }} document.title = 'Chassis — 内核错误'; }})();"
    );
    if let Err(err) = window.eval(&script) {
        logging::log(&format!("[shell] 错误面板注入失败：{err}"));
    }
    let _ = primitives::window::show(app, &json!({ "focus": true }));
}

/// 退出：先让内核 flush 落盘，再结束进程
pub fn shutdown(app: &AppHandle) {
    logging::log("[shell] 退出");
    if let Some(sidecar) = app.try_state::<Arc<Sidecar>>() {
        sidecar.shutdown();
    }
    app.exit(0);
}
