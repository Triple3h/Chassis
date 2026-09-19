//! proc-list（script）：全量进程快照（按 CPU 降序），带内存总量与核心数供界面算占比。
//!
//! args：无
//! 返回：`{ ok, entries: ProcEntry[], totalMemory, cores, platform, scannedAt }`
//!
//! CPU 需要两次采样（sysinfo 的硬要求），这次调用会比想象中慢 ~200ms —— 这是正常的。

use launcher_plugin_process_manager as pm;
use launcher_plugin_sdk::{json, Context, Level, Result};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let snapshot = pm::procs::snapshot();
    ctx.log(
        &format!("proc-list: entries={} cores={}", snapshot.entries.len(), snapshot.cores),
        None,
        Level::Info,
    )?;
    ctx.done(json!({
        "ok": true,
        "entries": snapshot.entries,
        "totalMemory": snapshot.total_memory,
        "cores": snapshot.cores,
        "platform": pm::platform_string(),
        "scannedAt": pm::now_ms(),
    }))
}
