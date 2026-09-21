//! 壳（Shell）：只提供系统原语，零业务逻辑（requirements §2 / §6）。
//!
//! ```text
//!  窗口 · 全局热键 · 托盘 · 单实例 · 通知 · 剪贴板 · open(URL/文件/应用)
//! ```
//!
//! 启动顺序（重要）：日志 → 窗口/托盘 → 原语分发 → **热键** → 内核 → 就绪后导航。
//! 热键**不等待内核**：否则内核起不来时会变成"装了却唤不出来"的死局。

mod ipc;
mod kernel_swap;
mod logging;
mod primitives;
mod sidecar;
mod update;

/// `--hot-probe` 的输出（`main.rs` 用）：自更新链路判断「候选包能不能跑」的入口。
pub use update::probe_report;

use ipc::Link;
use serde_json::json;
use sidecar::Sidecar;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 数据目录 →（接手旧目录）→ 日志 → 自更新守卫：**顺序不能反** ——
    //  ① 接手老目录（应用改名迁移）必须早于 `logging::init`：日志会在数据目录里建 `logs/`，
    //     让「新目录已存在」成立之后，旧目录就再也不会被接手；
    //  ② 自更新守卫要排在 Tauri 装配**之前**：候选包连续两次没走到就绪，就得在这里换回备份并退出
    //     （坏包可能连窗口都建不出来，守卫不能挂在 setup 里）。
    let data_root = sidecar::data_root_best_effort();
    let adopted = sidecar::adopt_legacy_data_dir(&data_root);
    logging::init(&data_root);
    if let Some((legacy, count)) = adopted {
        logging::log(&format!(
            "[shell] 已接手旧数据目录：{} → {}（复制 {count} 个文件，老目录保留可回退）",
            legacy.display(),
            data_root.display()
        ));
    }
    logging::log(&format!("[shell] 启动 v{}，数据目录 {}", update::version(), data_root.display()));

    if let Some(outcome) = update::boot_guard(&data_root) {
        logging::log(&format!("[shell] {}", outcome.detail));
        if outcome.restart {
            // helper 已在等着「换回备份 + 重新 open」：本进程先走，否则新实例抢不到单实例锁
            return;
        }
    }

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

            // ① 数据目录：日志与旧目录接手已在 `run()` 开头完成（自更新启动守卫必须排在最前），
            // 这里再取一次同源路径，供窗口 / 内核 / 原语使用。
            let data_root = sidecar::data_root(&handle);

            // ② macOS：不进 Dock（Accessory）
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // ③ 窗口 + 托盘
            if let Err(err) = create_main_window(&handle) {
                alert_user(
                    "Chassis 无法创建窗口",
                    &format!(
                        "启动台没能创建主窗口：\n{err}\n\n\
                         最常见的原因是这台机器缺少 Microsoft Edge WebView2 运行时\
                         （Windows 11 通常自带，精简版 / LTSC 镜像可能被移除）。\n\
                         装好后再启动即可：https://go.microsoft.com/fwlink/p/?LinkId=2124703\n\n\
                         完整日志：{}",
                        log_hint()
                    ),
                );
            }
            if let Err(err) = primitives::tray::ensure(&handle) {
                // 托盘是「窗口没被唤出时唯一看得见的入口」：连它都没了，用户就真的什么都没有了
                alert_user(
                    "Chassis 托盘图标初始化失败",
                    &format!("{err}\n\n启动台仍可能在运行，但没有任何可点的入口。\n完整日志：{}", log_hint()),
                );
            }

            // ③b 选中文本预热：前台 App 一换就替它把无障碍开关打开
            //（Chromium 系默认不建 AX 树，详见 primitives/selection.rs）
            primitives::selection::start_prewarm();

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
            let ready_data_root = data_root.clone();
            std::thread::spawn(move || match ready_sidecar.wait_ready(Duration::from_secs(30)) {
                Ok(port) => {
                    logging::log(&format!("[shell] 内核就绪：UI 端口 {port}"));
                    // 走到这里才算「本次启动成功」：自更新的待验证台账可以清了（不再回滚）
                    if let Some(note) = update::mark_boot_success(&ready_data_root) {
                        logging::log(&format!("[shell] {note}"));
                    }
                    sidecar::navigate_main_window(&ready_handle, port);
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

/// 日志文件路径（没初始化出来时给一句人话，别给用户一个空字符串）
fn log_hint() -> String {
    logging::log_path()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "（日志未初始化）".to_string())
}

/// 把「起不来」这件事摆到用户眼前 —— Windows 上只能靠原生对话框。
///
/// 为什么必须有：Windows 上壳是 GUI 子系统（没有控制台），日志又躺在数据目录里没人会去翻 ——
/// 主窗口建不出来时（最典型的原因：机器上没有 WebView2 运行时），
/// 用户的全部体验就是「双击了，除了一个黑框什么都没发生」（2026-09-21 实机反馈）。
/// macOS 那边失败路径本来就有窗口错误面板可看，所以这里只在 Windows 上弹。
///
/// 对话框跑在独立线程上：模态等待用户点「确定」的是它，不是启动流程（内核 / 热键该起还得起）。
fn alert_user(title: &str, message: &str) {
    // 非 Windows 上弹不出东西，但失败原因照样要落日志（macOS 的错误面板显示的是同一段话）
    logging::log(&format!("[shell] 启动故障：{title} —— {}", message.replace('\n', " ")));
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MB_SYSTEMMODAL,
        };
        let caption = HSTRING::from(title);
        let body = HSTRING::from(message);
        std::thread::spawn(move || unsafe {
            MessageBoxW(None, &body, &caption, MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_SYSTEMMODAL);
        });
    }
}

/// 内核起不来时显示可操作的错误面板（不许白屏），并把日志路径写进页面
fn show_boot_error(app: &AppHandle, message: &str) {
    let hint = log_hint();
    logging::log(&format!("[shell] 内核启动失败：{message}"));
    // 窗口压根没建出来（多半就是上面那个 `alert_user` 说的原因）：错误面板无处可注入，
    // 只能再弹一次对话框 —— 否则用户在「内核也没起来」时依旧什么都看不到
    let Some(window) = app.get_webview_window("main") else {
        alert_user("Chassis 内核启动失败", &format!("{message}\n\n完整日志：{hint}"));
        return;
    };
    let text = format!("内核启动失败：{message}｜日志：{hint}");
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
