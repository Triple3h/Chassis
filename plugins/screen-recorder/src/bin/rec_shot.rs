//! rec-shot：截图（全屏 / 框选 / 窗口 / 直接进剪贴板）。
//! macOS = `screencapture`；Windows = 原生 GDI（全屏 / 框选），窗口与剪贴板交给系统截图工具。
//! 交互式截图要等用户操作，界面侧把超时放宽（见 App.vue 的 SHOT_TIMEOUT）。

use launcher_plugin_screen_recorder as rec;
use launcher_plugin_sdk::{json, Context, Level, Result};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let options = rec::ShotOptions::from_args(ctx.raw_args());
    match rec::backend::shot(&options, ctx.data_path()) {
        Ok(info) => {
            let _ = ctx.log(
                &format!("rec-shot: mode={} delegated={} path={:?}", options.mode, info.delegated, info.path),
                None,
                Level::Info,
            );
            ctx.done(json!({
                "ok": true,
                "mode": options.mode,
                "path": info.path.map(|path| path.to_string_lossy().to_string()),
                "size": info.size,
                "clipboard": info.clipboard,
                "delegated": info.delegated,
                "note": info.note,
                "args": info.args,
            }))
        }
        Err(err) => {
            let _ = ctx.log(&format!("rec-shot 失败：{} {}", err.code, err.message), None, Level::Warn);
            ctx.done(json!({
                "ok": false,
                "code": err.code,
                "cancelled": err.code == "CANCELLED",
                "error": err.message,
                "detail": err.detail,
            }))
        }
    }
}
