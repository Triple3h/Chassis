//! rec-stop：给录制进程发 SIGINT（= 终端里 Ctrl+C），等它把文件收尾写完再回报产物信息。

use std::path::Path;
use std::thread::sleep;
use std::time::Duration;

use launcher_plugin_screen_recorder as rec;
use launcher_plugin_sdk::{json, Context, Level, Result};

/// 收尾等待上限：长视频落盘会久一点，但也不能把宿主挂在这儿
const WAIT_LIMIT_MS: u64 = 8_000;
const STEP_MS: u64 = 200;

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let Some(state) = rec::read_state(ctx.data_path()) else {
        return ctx.done(json!({ "ok": false, "error": "没有正在进行的录制" }));
    };

    if rec::pid_alive(state.pid) && !rec::send_interrupt(state.pid) {
        return ctx.done(json!({ "ok": false, "error": "停止失败：录制进程已经不在了（或没有权限给它发信号）" }));
    }

    let mut waited = 0_u64;
    while rec::pid_alive(state.pid) && waited < WAIT_LIMIT_MS {
        sleep(Duration::from_millis(STEP_MS));
        waited += STEP_MS;
    }
    let still_alive = rec::pid_alive(state.pid);
    if !still_alive {
        rec::clear_state(ctx.data_path());
    }

    let info = rec::file_info(Path::new(&state.path));
    let duration_ms = rec::now_millis().saturating_sub(state.started_at);
    let ok = info.is_some() && !still_alive;
    let error = if still_alive {
        Some("录制进程还没退场（视频较长时收尾会久一点，稍后再点一次停止）")
    } else if info.is_none() {
        Some("没找到录制文件：可能被系统权限拦下，或录制刚开始就中断了")
    } else {
        None
    };

    let _ = ctx.log(
        &format!("rec-stop: ok={ok} path={} waited={waited}ms", state.path),
        None,
        Level::Info,
    );
    ctx.done(json!({
        "ok": ok,
        "path": state.path,
        "size": info.map(|(size, _)| size),
        "durationMs": duration_ms,
        "stillAlive": still_alive,
        "error": error,
    }))
}
