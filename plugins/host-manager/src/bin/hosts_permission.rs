//! 命令 `hosts-permission`（script）：免授权写入的开关。
//!
//! 背景：macOS 的 `/etc/hosts` 属 root，每写一次弹一次系统授权框。
//! 一次性把文件的写权限授给当前账户（POSIX ACL），之后保存就直接写、不再弹窗；
//! 随时可以撤销、恢复系统默认。uTools / SwitchHosts 走的也是这条路
//! （Windows 上对应「文件属性 → 安全 → 勾写入」）。原理与安全边界见 lib.rs 同名小节。
//!
//! args:
//!   `{ action?: 'status' | 'grant' | 'revoke' }`（默认 status）
//!
//! 返回（`HostsPermissionResult`，UI 侧 `core/script-types.ts` 同形状）：
//!   `{ ok, action, granted, writable, path, platform, username?, method, command?, error? }`
//!
//! 注意：目标路径**不接收调用方传参**（与 hosts-write 同一条安全边界）——
//! 只认 `resolve_hosts_path()`，否则这个「能提权改权限」的脚本就成了任意文件改权限的跳板。

use launcher_plugin_host_manager::{
    apply_write_acl, current_username, has_write_acl, is_writable, permission_command, platform_string,
    resolve_hosts_path,
};
use launcher_plugin_sdk::{json, Context, Level, Result, Value};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let action = ctx
        .raw_args()
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("status")
        .to_string();
    let target = resolve_hosts_path();
    let username = current_username();

    let mut ok = true;
    // none = 只查询；direct = 目标状态已经达成（没弹框）；privileged = 真的走了系统授权
    let mut method = "none";
    let mut error: Option<String> = None;

    match action.as_str() {
        "status" => {}
        "grant" | "revoke" => match apply_write_acl(&target, action == "grant") {
            Ok(true) => method = "privileged",
            Ok(false) => method = "direct",
            Err(detail) => {
                ok = false;
                error = Some(detail);
            }
        },
        other => {
            ok = false;
            error = Some(format!("未知 action：{other}（可用：status / grant / revoke）"));
        }
    }

    let granted = username
        .as_deref()
        .map(|name| has_write_acl(&target, name))
        .unwrap_or(false);
    let writable = is_writable(&target);

    ctx.log(
        &format!(
            "hosts-permission: action={action} ok={ok} method={method} granted={granted} writable={writable} user={:?} error={error:?}",
            username
        ),
        None,
        Level::Info,
    )?;

    let command = username.as_deref().map(|name| {
        // 展示用：告诉用户「手敲的话是这条」（granted 时给出撤销命令，反之亦然）
        let show_grant = match action.as_str() {
            "grant" => false,
            "revoke" => true,
            _ => !granted,
        };
        permission_command(&target, show_grant, name)
    });

    let mut payload = json!({
        "ok": ok,
        "action": action,
        "granted": granted,
        "writable": writable,
        "path": target.to_string_lossy(),
        "platform": platform_string(),
        "method": method,
    });
    if let (Some(user), Some(cmd)) = (username, command) {
        payload["username"] = json!(user);
        payload["command"] = json!(cmd);
    }
    if let Some(message) = error {
        payload["error"] = json!(message);
    }
    ctx.done(payload)
}
