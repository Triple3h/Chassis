//! proc-kill（script）：终止指定进程。默认优雅（SIGTERM / 无 `/F` 的 taskkill）。
//!
//! args：`{ pid: number, force?: boolean, elevate?: boolean }`
//!  - `force`：强杀（SIGKILL / `taskkill /F`）—— 界面要先展示「仍在运行」再让用户确认；
//!  - `elevate`：走系统提权对话框（macOS 输密码/指纹，Windows 弹 UAC）。
//! 返回：KillOutcome（`{ ok, alive, notFound, permissionDenied, manualCommand, message, error? }`）
//!
//! 硬底线在 `lib.rs` 的 `kill::execute` 里复检保护名单 —— **提权也绕不过**
//! （界面上的灰按钮只是第一道，这里才是能拦住脚本直调的闸）。

use launcher_plugin_process_manager as pm;
use launcher_plugin_sdk::{json, Context, Level, Result, Value};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let args = ctx.raw_args();
    let Some(pid) = args.get("pid").and_then(Value::as_i64) else {
        return ctx.fail("缺少 pid 参数");
    };
    if pid <= 0 || pid > i32::MAX as i64 {
        return ctx.fail(format!("pid 不合法：{pid}"));
    }
    let request = pm::kill::KillRequest {
        pid: pid as i32,
        force: args.get("force").and_then(Value::as_bool).unwrap_or(false),
        elevate: args.get("elevate").and_then(Value::as_bool).unwrap_or(false),
    };

    let outcome = pm::kill::execute(request);
    ctx.log(
        &format!(
            "proc-kill: pid={pid} force={} elevate={} ok={} alive={} denied={}",
            outcome.force, outcome.elevated, outcome.ok, outcome.alive, outcome.permission_denied
        ),
        None,
        Level::Info,
    )?;
    ctx.done(serde_json::to_value(&outcome).unwrap_or_else(|_| json!({ "ok": false, "message": "结果序列化失败" })))
}
