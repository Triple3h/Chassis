//! `launcher-kernel` —— Chassis 内核（Rust，M5 阶段 A1 进行中）。
//!
//! 对外契约（三条协议字段级不变，见 ADR-0005）：
//! 壳 ↔ 内核 stdio JSON-RPC（`link.rs`）/ UI ↔ 内核 HTTP + SSE（`http/*`，A1 待实现）/
//! 插件 ↔ 宿主 postMessage（`services/bridge.rs`，A1 待实现）。

pub mod audit;
pub mod cli;
pub mod config;
pub mod contract;
pub mod error;
pub mod events;
pub mod exec;
pub mod history;
pub mod legacy;
pub mod link;
pub mod logging;
pub mod manifest;
pub mod overrides;
pub mod paths;
pub mod pinyin;
pub mod pipeline;
pub mod plugin_settings;
pub mod registry;
pub mod api;
pub mod bridge;
pub mod http;
pub mod kernel;
pub mod plugin;
pub mod search;
pub mod services;
pub mod session;
pub mod types;
pub mod window_visibility;
pub mod util;

use serde_json::json;

use cli::CliOptions;
use kernel::{Kernel, KernelOptions};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// 内核主入口：解析 CLI → 建数据目录 → 装配内核 → 启动 → 等退出信号 → 收尾。
pub async fn run() -> i32 {
    let options = CliOptions::parse(std::env::args().skip(1));

    if let Err(err) = std::fs::create_dir_all(&options.data_root) {
        crate::log_error!("无法创建数据目录 {}：{err}", options.data_root.display());
        return 1;
    }
    crate::log_info!("数据目录：{}", options.data_root.display());
    let roots = options.builtin_roots.iter().map(|path| path.display().to_string()).collect::<Vec<_>>().join(", ");
    crate::log_info!("出厂插件根：{roots}");
    match (options.ui_dist.as_ref(), options.ui_dev_url.as_ref()) {
        (Some(dir), _) => crate::log_info!("UI 产物：{}", dir.display()),
        (None, Some(url)) => crate::log_info!("UI dev：{url}"),
        (None, None) => crate::log_info!("UI：未配置（--no-ui）"),
    }

    let kernel = Kernel::new(KernelOptions {
        data_root: options.data_root.clone(),
        builtin_roots: options.builtin_roots.clone(),
        ui_dist_dir: options.ui_dist.clone(),
        ui_dev_url: options.ui_dev_url.clone(),
        version: VERSION.to_string(),
        link_writer: link::stdout_output(),
    });

    // 壳连接（stdio JSON-RPC）：standalone 下不接 stdin，只等信号
    let mut eof = None;
    if !options.standalone {
        kernel.link.mark_connected();
        kernel.link.notify("kernel/booting", Some(json!({ "pid": std::process::id() })));
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        eof = Some(rx);
        let reader_link = kernel.link.clone();
        tokio::spawn(async move {
            reader_link.read_loop(tokio::io::BufReader::new(tokio::io::stdin())).await;
            let _ = tx.send(());
        });
    }

    // 壳 → 内核的方法（window/toggled、tray/menu、kernel/ready、app/shutdown…）
    api::register_link_handlers(&kernel);

    if let Err(err) = kernel.start().await {
        crate::log_error!("内核启动失败：{}（{}）", err.message, err.code);
        return 1;
    }
    kernel.mark_ready();
    // 就绪后主动告知壳（壳若先问过，`kernel/ready` 也会拿到同一份答案）
    kernel.link.notify("ready", Some(json!({ "uiPort": kernel.ui_port(), "version": kernel.version() })));

    let reason = match eof {
        Some(eof) => tokio::select! {
            signal = wait_signal() => signal,
            _ = eof => "壳连接已断开",
        },
        None => wait_signal().await,
    };
    crate::log_info!("收到 {reason}，正在退出…");

    // 收尾：关插件子进程 / 关 listener / 落盘；3s 兜底强制退出（防某个子进程卡住）
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        crate::log_error!("收尾超时，强制退出");
        std::process::exit(1);
    });
    kernel.stop().await;
    0
}

async fn wait_signal() -> &'static str {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigint = signal(SignalKind::interrupt()).expect("注册 SIGINT 失败");
        let mut sigterm = signal(SignalKind::terminate()).expect("注册 SIGTERM 失败");
        tokio::select! {
            _ = sigint.recv() => "SIGINT",
            _ = sigterm.recv() => "SIGTERM",
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        "ctrl-c"
    }
}
