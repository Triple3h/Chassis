//! port-list（script）：扫本机端口占用，并补上进程名 / 用户 / 内存 / 风险级别。
//!
//! args：`{ scope?: 'listen' | 'all' }`（默认 `listen` = TCP LISTEN + UDP bind）
//! 返回：`{ ok, scope, entries: PortEntry[], platform, scannedAt, error? }`
//!
//! 扫描失败（如 lsof 不可用）不是脚本失败 —— 把 `ok: false` 与原因交给界面展示，
//! 这样用户看到的是「这台机器上为什么查不了」，而不是一个干巴巴的超时。

use launcher_plugin_process_manager as pm;
use launcher_plugin_sdk::{json, Context, Level, Result, Value};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let raw_scope = ctx.raw_args().get("scope").and_then(Value::as_str).unwrap_or(pm::SCOPE_LISTEN);
    let scope = pm::scan::normalize_scope(raw_scope);

    match pm::scan::scan_ports(scope) {
        Ok(entries) => {
            ctx.log(&format!("port-list: scope={scope} entries={}", entries.len()), None, Level::Info)?;
            ctx.done(json!({
                "ok": true,
                "scope": scope,
                "entries": entries,
                "platform": pm::platform_string(),
                "scannedAt": pm::now_ms(),
            }))
        }
        Err(err) => {
            ctx.log(&format!("port-list: 扫描失败：{err}"), None, Level::Warn)?;
            ctx.done(json!({
                "ok": false,
                "scope": scope,
                "entries": [],
                "error": err,
                "platform": pm::platform_string(),
                "scannedAt": pm::now_ms(),
            }))
        }
    }
}
