//! proc-detail（script）：单个进程的详情（命令行 / 可执行文件 / 启动时刻 / 占用端口）。
//!
//! args：`{ pid: number }`
//! 返回：`{ ok, detail: ProcDetail }` 或 `{ ok: false, notFound: true }`

use launcher_plugin_process_manager as pm;
use launcher_plugin_sdk::{json, Context, Level, Result, Value};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let Some(pid) = ctx.raw_args().get("pid").and_then(Value::as_i64) else {
        return ctx.fail("缺少 pid 参数");
    };
    if pid <= 0 || pid > i32::MAX as i64 {
        return ctx.fail(format!("pid 不合法：{pid}"));
    }
    let pid = pid as i32;

    match pm::procs::process_detail(pid) {
        Some(detail) => {
            ctx.log(&format!("proc-detail: pid={pid} ports={}", detail.ports.len()), None, Level::Info)?;
            ctx.done(json!({ "ok": true, "detail": detail }))
        }
        None => {
            ctx.log(&format!("proc-detail: pid={pid} 已不存在"), None, Level::Info)?;
            ctx.done(json!({ "ok": false, "notFound": true }))
        }
    }
}
