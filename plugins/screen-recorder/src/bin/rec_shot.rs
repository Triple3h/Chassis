//! rec-shot：截图（全屏 / 框选 / 窗口 / 直接进剪贴板）。
//! 交互式截图要等用户框选，所以在界面侧把超时放宽（见 App.vue 的 SHOT_TIMEOUT）。

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::SystemTime;

use launcher_plugin_screen_recorder as rec;
use launcher_plugin_sdk::{json, Context, Level, Result, Value};

const MODES: [&str; 4] = ["full", "region", "window", "clipboard"];

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    if !rec::platform_supported() {
        return ctx.done(json!({ "ok": false, "error": "截图目前只支持 macOS" }));
    }

    let args = ctx.raw_args().clone();
    let mode = args.get("mode").and_then(Value::as_str).unwrap_or("full");
    let mode = if MODES.contains(&mode) { mode } else { "full" };
    let delay_sec = args.get("delaySec").and_then(Value::as_u64).unwrap_or(0).min(60);
    // 截图默认带上光标：教程/反馈截图里常用
    let cursor = args.get("cursor").and_then(Value::as_bool).unwrap_or(true);
    let dir = args
        .get("dir")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| rec::default_dir("image"));

    if mode != "clipboard" {
        if let Err(err) = rec::ensure_dir(&dir) {
            return ctx.fail(format!("创建保存目录失败：{err}"));
        }
    }
    let out = dir.join(rec::make_file_name("截图", "png", SystemTime::now()));
    let cmd_args = rec::shot_args(mode, delay_sec, cursor, &out);

    let status = Command::new("screencapture")
        .args(&cmd_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let Ok(status) = status else {
        return ctx.fail("拉起 screencapture 失败");
    };

    if mode == "clipboard" {
        return ctx.done(json!({
            "ok": status.success(),
            "clipboard": true,
            "error": if status.success() { Value::Null } else { Value::String("截图没能进剪贴板（多半是屏幕录制权限没给）".into()) },
        }));
    }

    let info = rec::file_info(&out);
    let ok = status.success() && info.is_some();
    let _ = ctx.log(
        &format!("rec-shot: mode={mode} ok={ok} path={}", out.display()),
        None,
        Level::Info,
    );
    ctx.done(json!({
        "ok": ok,
        "path": out.to_string_lossy(),
        "size": info.map(|(size, _)| size),
        "args": cmd_args,
        "error": if ok { Value::Null } else { Value::String("没有拿到截图文件：多半是屏幕录制权限没给".into()) },
    }))
}
