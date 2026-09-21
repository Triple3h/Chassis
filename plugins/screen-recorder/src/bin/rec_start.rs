//! rec-start：开始录制。
//! macOS = 拉起 `screencapture -v`（交互式模式由系统画选择框）；
//! Windows = 派一个持有 ffmpeg stdin 的录制子进程。
//!
//! 进程一启动就返回（不阻塞）；成功与否以**后端探活结果**为准 ——
//! 不能像以前那样「拉起来就当成功」（麦克风没授权时 screencapture 会立刻退场且不产文件）。

use std::path::PathBuf;
use std::time::SystemTime;

use launcher_plugin_screen_recorder as rec;
use launcher_plugin_sdk::{json, Context, Level, Result};

fn main() {
    // Windows 的录制子进程入口（`rec-start --worker …`）：不跟宿主说话，直接跑录制循环
    if let Some(code) = rec::backend::worker_entry() {
        std::process::exit(code);
    }
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let options = rec::RecordOptions::from_args(ctx.raw_args());

    let (ready, ready_hint) = rec::backend::readiness();
    if !ready {
        return ctx.done(json!({ "ok": false, "code": "DEPENDENCY_MISSING", "error": ready_hint }));
    }

    let permission = rec::backend::permission(false);
    if permission.supported && !permission.granted {
        return ctx.done(json!({
            "ok": false,
            "code": "PERMISSION",
            "needsPermission": true,
            "settingsUrl": permission.settings_url,
            "error": "系统还没给屏幕录制权限：点面板上的「申请权限」，或到 系统设置 → 隐私与安全性 → 屏幕录制 里勾选 Chassis",
        }));
    }

    // 已经在录：状态文件说在录，或状态文件丢了但系统里还挂着录制进程
    if let Some(state) = rec::read_state(ctx.data_path()) {
        if state.recording_alive() {
            return ctx.done(json!({
                "ok": false,
                "code": "BUSY",
                "error": format!("已经有一段录制在进行中：{}", state.path),
            }));
        }
    }
    rec::clear_state(ctx.data_path());
    if !rec::backend::recorder_processes().is_empty() {
        return ctx.done(json!({
            "ok": false,
            "code": "ORPHAN",
            "error": "系统里还有一段录制在跑（这份记录丢了）：先点「停止」把它收掉，再开始新的",
        }));
    }

    let dir = options.dir.clone().map(PathBuf::from).unwrap_or_else(|| rec::default_dir("video"));
    let name = options
        .file_name
        .clone()
        .unwrap_or_else(|| rec::make_file_name("录屏", rec::video_extension(), SystemTime::now()));
    let out = dir.join(name);

    match rec::backend::start(&options, &out, ctx.data_path()) {
        Ok(info) => {
            let _ = ctx.log(
                &format!(
                    "rec-start: backend={} mode={} audio={} path={}",
                    rec::backend::backend_name(),
                    options.mode,
                    info.state.audio,
                    info.state.path
                ),
                None,
                Level::Info,
            );
            ctx.done(json!({
                "ok": true,
                "backend": rec::backend::backend_name(),
                "pid": info.state.pid,
                "path": info.state.path,
                "startedAt": info.state.started_at,
                "interactive": info.state.interactive,
                "seconds": info.state.seconds,
                "audio": info.state.audio,
                "args": info.args,
            }))
        }
        Err(err) => {
            let _ = ctx.log(&format!("rec-start 失败：{} {}", err.code, err.message), None, Level::Warn);
            ctx.done(json!({
                "ok": false,
                "code": err.code,
                "error": err.message,
                "detail": err.detail,
                "needsPermission": err.code == "PERMISSION",
                "retryWithoutAudio": err.retry_without_audio,
                "micSettingsUrl": rec::backend::microphone_settings_url(),
            }))
        }
    }
}
