//! rec-status：面板轮询用 —— 还在录吗？录了多久？产物多大了？
//! 进程已经退场时顺手清掉状态，并把最后一段产物回报给界面；
//! 连状态文件都没了但系统里还挂着录制进程时，把 `orphan` 标出来（界面好提示「先停止」）。

use launcher_plugin_screen_recorder as rec;
use launcher_plugin_sdk::{json, Context, Result, Value};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let Some(state) = rec::read_state(ctx.data_path()) else {
        let orphan = !rec::backend::recorder_processes().is_empty();
        return ctx.done(json!({ "recording": false, "active": false, "last": Value::Null, "orphan": orphan }));
    };

    if state.recording_alive() {
        let size = rec::file_info(&state.path_buf()).map(|(size, _)| size);
        return ctx.done(json!({
            // `active` / `activeMs` / `paused` 是**托盘会话契约**的三个字段（plugin-spec §3.6）：
            // 内核按它们决定托盘里显示什么、能不能暂停；`recording` / `elapsedMs` 给面板。
            "active": true,
            "recording": true,
            "paused": state.paused(),
            "activeMs": state.active_ms(),
            // 托盘状态行的词（内核不认识「录屏」，词由插件给）
            "state": if state.paused() { "已暂停" } else { "录制中" },
            "path": state.path,
            "startedAt": state.started_at,
            "elapsedMs": state.elapsed_ms(),
            "mode": state.mode,
            "interactive": state.interactive,
            "seconds": state.seconds,
            "size": size,
            "backend": state.backend,
            "audio": state.audio,
            "clicks": state.clicks,
            "orphan": false,
        }));
    }

    // 进程没了：可能是限时到点自动收尾，也可能是被系统收走 —— 交回最后状态再清盘
    rec::clear_state(ctx.data_path());
    let last = rec::file_info(&state.path_buf())
        .map(|(size, mtime_ms)| json!({ "path": state.path, "size": size, "mtimeMs": mtime_ms }));
    let detail = rec::read_log_tail(&ctx.data_path().join(rec::LOG_FILE), 300);
    ctx.done(json!({
        "recording": false,
        "active": false,
        "last": last,
        "interactive": state.interactive,
        "detail": if detail.is_empty() { Value::Null } else { Value::String(detail) },
        "orphan": false,
    }))
}
