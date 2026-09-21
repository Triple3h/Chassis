//! rec-stop：收尾当前录制并回报产物信息。
//! macOS = 给 `screencapture` 发 SIGINT；Windows = 通知录制子进程给 ffmpeg 送 `q`。
//! 停止是**幂等**的：进程已经自己退场（到时自动收尾 / 被系统收走）也照样交回产物。

use launcher_plugin_screen_recorder as rec;
use launcher_plugin_sdk::{json, Context, Level, Result, Value};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let Some(state) = rec::read_state(ctx.data_path()) else {
        // 状态文件没了：可能还有孤儿录制在跑，兜底收一把
        let orphans = rec::backend::stop_orphans(ctx.data_path());
        return ctx.done(json!({
            "ok": false,
            "code": if orphans > 0 { "ORPHAN_STOPPED" } else { "IDLE" },
            "orphans": orphans,
            "error": if orphans > 0 {
                format!("没有录制记录，但系统里还有 {orphans} 段录制 —— 已经收掉了，产物在保存目录里")
            } else {
                "没有正在进行的录制".to_string()
            },
        }));
    };

    let outcome = rec::backend::stop(&state, ctx.data_path());
    let info = rec::file_info(&state.path_buf());
    let duration_ms = state.elapsed_ms();
    let ok = !outcome.still_alive && info.is_some();
    let error = match (outcome.error, info.is_some()) {
        (Some(error), _) => Some(error),
        (None, true) => None,
        (None, false) => Some("没找到录制文件：可能刚开始就被中断，或被系统权限拦下".to_string()),
    };
    let detail = if ok { String::new() } else { rec::read_log_tail(&ctx.data_path().join(rec::LOG_FILE), 300) };

    let _ = ctx.log(
        &format!("rec-stop: ok={ok} path={} size={:?}", state.path, info.map(|(size, _)| size)),
        None,
        Level::Info,
    );
    ctx.done(json!({
        "ok": ok,
        "path": state.path,
        "size": info.map(|(size, _)| size),
        "durationMs": duration_ms,
        "stillAlive": outcome.still_alive,
        "error": error,
        "detail": if detail.is_empty() { Value::Null } else { Value::String(detail) },
    }))
}
