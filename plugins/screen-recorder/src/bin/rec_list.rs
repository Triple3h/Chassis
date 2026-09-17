//! rec-list：清点最近产物（默认目录下的视频 / 截图），给面板的「最近录制」用。

use std::path::PathBuf;

use launcher_plugin_screen_recorder as rec;
use launcher_plugin_sdk::{json, Context, Result, Value};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let args = ctx.raw_args().clone();
    let kind = args.get("kind").and_then(Value::as_str).unwrap_or("video");
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(6).clamp(1, 50) as usize;
    let dir = args
        .get("dir")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| if kind == "image" { rec::default_dir("image") } else { rec::default_dir("video") });
    let extensions: &[&str] = if kind == "image" { &["png", "jpg", "jpeg"] } else { &["mov", "mp4"] };
    let files = rec::list_recent(&dir, extensions, limit);
    ctx.done(json!({
        "ok": true,
        "dir": dir.to_string_lossy(),
        "files": files,
    }))
}
