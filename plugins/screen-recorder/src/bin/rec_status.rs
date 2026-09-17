//! rec-status：面板每秒轮询一次 —— 还在录吗？录了多久？产物多大了？
//! 进程已经退场时顺手清掉过期状态，并把最后一段产物回报给界面。

use std::path::Path;

use launcher_plugin_screen_recorder as rec;
use launcher_plugin_sdk::{json, Context, Result, Value};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let Some(state) = rec::read_state(ctx.data_path()) else {
        return ctx.done(json!({ "recording": false, "last": Value::Null }));
    };

    if rec::pid_alive(state.pid) {
        let size = rec::file_info(Path::new(&state.path)).map(|(size, _)| size);
        return ctx.done(json!({
            "recording": true,
            "path": state.path,
            "startedAt": state.started_at,
            "elapsedMs": rec::now_millis().saturating_sub(state.started_at),
            "mode": state.mode,
            "interactive": state.interactive,
            "seconds": state.seconds,
            "size": size,
        }));
    }

    // 进程没了：可能是 -V 到时自动收尾，也可能是被系统干掉；把最后状态交回界面再清盘
    rec::clear_state(ctx.data_path());
    let last = rec::file_info(Path::new(&state.path)).map(|(size, mtime_ms)| {
        json!({ "path": state.path, "size": size, "mtimeMs": mtime_ms })
    });
    ctx.done(json!({ "recording": false, "last": last }))
}
