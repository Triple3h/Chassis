//! rec-start：拉起系统 screencapture 开始录制，并把 pid 记进状态文件。
//! 进程一启动就返回（不阻塞），交互式录制（区域 / 窗口）由系统画选择框。

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, SystemTime};

use launcher_plugin_screen_recorder as rec;
use launcher_plugin_sdk::{json, Context, Level, Result};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    if !rec::platform_supported() {
        return ctx.done(json!({ "ok": false, "error": "录屏助手目前只支持 macOS" }));
    }

    let options = rec::RecordOptions::from_args(ctx.raw_args());

    if rec::screen_capture_granted() == Some(false) {
        return ctx.done(json!({
            "ok": false,
            "needsPermission": true,
            "error": "系统还没给屏幕录制权限：点面板上的「申请权限」，或到 系统设置 → 隐私与安全性 → 屏幕录制 里勾选 Chassis"
        }));
    }

    if let Some(state) = rec::read_state(ctx.data_path()) {
        if rec::pid_alive(state.pid) {
            return ctx.done(json!({ "ok": false, "error": format!("已经有一段录制在进行中：{}", state.path) }));
        }
        rec::clear_state(ctx.data_path());
    }

    let dir = options.dir.clone().map(PathBuf::from).unwrap_or_else(|| rec::default_dir("video"));
    if let Err(err) = rec::ensure_dir(&dir) {
        return ctx.fail(format!("创建保存目录失败：{err}"));
    }
    let name = options
        .file_name
        .clone()
        .unwrap_or_else(|| rec::make_file_name("录屏", "mov", SystemTime::now()));
    let out = dir.join(name);
    let args = rec::record_args(&options, &out);

    let child = match Command::new("screencapture")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(err) => return ctx.fail(format!("拉起 screencapture 失败：{err}")),
    };
    let pid = child.id() as i32;
    // 不 wait：录制要继续跑，我们的脚本进程先退场
    drop(child);

    let state = rec::RecordingState {
        pid,
        path: out.to_string_lossy().to_string(),
        started_at: rec::now_millis(),
        mode: options.mode.clone(),
        interactive: options.interactive(),
        seconds: options.seconds,
        audio: options.audio,
        clicks: options.clicks,
    };
    if let Err(err) = rec::write_state(ctx.data_path(), &state) {
        return ctx.fail(format!("写录制状态失败：{err}"));
    }

    // 给系统一点时间报错（权限被拒 / 参数不被接受时 screencapture 会立刻退出）
    sleep(Duration::from_millis(500));
    if !rec::pid_alive(pid) && rec::file_info(&out).is_none() {
        rec::clear_state(ctx.data_path());
        return ctx.done(json!({
            "ok": false,
            "needsPermission": true,
            "error": "screencapture 没能开始录制：多半是屏幕录制权限没给（也可能这组参数不被当前系统接受）"
        }));
    }

    let _ = ctx.log(
        &format!("rec-start: 开始录制 mode={} path={}", options.mode, out.display()),
        None,
        Level::Info,
    );
    ctx.done(json!({
        "ok": true,
        "pid": pid,
        "path": out.to_string_lossy(),
        "startedAt": state.started_at,
        "interactive": state.interactive,
        "seconds": state.seconds,
        "args": args,
    }))
}
