//! rec-pause：暂停 / 继续当前录制（托盘菜单与面板共用）。
//! 入参 `{ action?: 'pause' | 'resume' }`，不给就是**切换**（托盘一键）。
//!
//! 两端语义（对 UI 一致，差异收在后端）：
//! - macOS = SIGSTOP / SIGCONT 冻结 `screencapture`：画面冻在最后一帧，产物时长含暂停段；
//! - Windows = 状态文件里的 `pausedAt` 驱动录制 worker 挂起 / 恢复 ffmpeg：暂停段不进视频。
//!
//! 计时口径两端一致：**显示的都是有效录制时长**（`activeMs`，扣掉暂停），
//! 所以 macOS 上产物会比计时长一点 —— 这是系统录屏接口的限制，界面上如实说明。

use launcher_plugin_screen_recorder as rec;
use launcher_plugin_sdk::{json, Context, Result};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let Some(state) = rec::read_state(ctx.data_path()) else {
        return ctx.done(json!({ "ok": false, "code": "IDLE", "error": "没有正在进行的录制" }));
    };
    if !state.recording_alive() {
        rec::clear_state(ctx.data_path());
        return ctx.done(json!({ "ok": false, "code": "IDLE", "error": "录制已经结束了" }));
    }

    let target = rec::PauseAction::from_args(ctx.raw_args()).wanted(state.paused());
    match rec::set_paused(&state, ctx.data_path(), target) {
        Ok(next) => ctx.done(json!({
            "ok": true,
            "paused": next.paused(),
            "activeMs": next.active_ms(),
            "elapsedMs": next.elapsed_ms(),
            "path": next.path,
        })),
        Err(error) => ctx.done(json!({
            "ok": false,
            "code": "PAUSE_FAILED",
            "error": error,
            "paused": state.paused(),
        })),
    }
}
