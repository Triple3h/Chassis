//! 区域截图 → 系统剪贴板（requirements §6.1 / §8.6，architecture D18）。
//!
//! 截图是**系统调用**，在壳里执行（内核不再直接 exec：本原语就是 D18 说的「下沉」）。
//! 两个平台都交给系统完成截图交互，结果**直接进系统剪贴板** —— 调用方只拿到
//! `{ ok }`（有没有成功截到并放进剪贴板），既不需要也拿不到图像数据。
//!
//! **执行必须放到独立线程**：`screencapture -i` 会一直等到用户完成或取消（可能几十秒），
//! 而 `ipc::Link` 的读循环是单线程串行的 —— 在这里内联等待会把内核的其它请求
//! （热键唤出、窗口控制…）全部堵住。所以返回的是「完成信号」，由读循环之外的
//! 线程等它并应答（见 `ipc::Outcome::Later`）。

use serde_json::{json, Value};
use std::sync::mpsc::{channel, Receiver};
use tauri::AppHandle;

/// 触发区域截图。立刻返回完成信号（结果在 `Receiver` 里）。
pub fn start(_app: &AppHandle, _params: &Value) -> Receiver<Result<Value, String>> {
    let (sender, receiver) = channel();
    std::thread::spawn(move || {
        let _ = sender.send(run());
    });
    receiver
}

fn run() -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("screencapture")
            .args(["-i", "-c"])
            .status()
            .map_err(|err| format!("screencapture 启动失败：{err}"))?;
        return Ok(json!({ "ok": status.success() }));
    }
    #[cfg(windows)]
    {
        // explorer 处理 `ms-screenclip:` 协议：直接拉出截图覆盖层，不经过 cmd 窗口。
        // 与 macOS 不同，这条命令**不等**用户截完（唤起即返回）—— `ok` 的含义是「成功唤起」。
        let status = std::process::Command::new("explorer")
            .arg("ms-screenclip:")
            .status()
            .map_err(|err| format!("explorer 启动失败：{err}"))?;
        return Ok(json!({ "ok": status.success() }));
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Ok(json!({ "ok": false, "reason": "unsupported" }))
    }
}
