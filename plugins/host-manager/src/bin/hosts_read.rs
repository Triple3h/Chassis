//! 命令 `hosts-read`（script）：读取系统 hosts 文件（v1 `src/no-view/hosts-read.ts`）。
//!
//! args:
//!   `{ backups: true }`              → 顺带返回磁盘备份列表
//!   `{ backup: 'hosts-2026-…txt' }`  → 读取指定备份的内容（不读系统文件）

use launcher_plugin_host_manager::{list_backups, platform_string, read_backup, read_hosts_file, resolve_hosts_path};
use launcher_plugin_sdk::{json, Context, Level, Result, Value};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    // 备份目录固定为 <数据目录>/backups（N2：安装目录只读）
    let data_path = ctx.data_path().to_path_buf();
    let args = ctx.raw_args().clone();

    if let Some(name) = args.get("backup").and_then(Value::as_str) {
        return match read_backup(&data_path, name) {
            Ok(content) => {
                let info = list_backups(&data_path).into_iter().find(|entry| entry.name == name);
                ctx.log(
                    &format!("hosts-read: 读取备份 {name}（{} 字节）", content.len()),
                    None,
                    Level::Info,
                )?;
                ctx.done(json!({
                    "ok": true,
                    "path": resolve_hosts_path().to_string_lossy(),
                    "content": content,
                    "size": info.as_ref().map(|entry| entry.size).unwrap_or(content.len() as u64),
                    "mtime": info.map(|entry| entry.mtime).unwrap_or(0),
                    "bom": false,
                    "encoding": "utf8",
                    "writable": false,
                    "platform": platform_string(),
                }))
            }
            Err(message) => {
                ctx.log(&format!("hosts-read: 失败 {message}"), None, Level::Error)?;
                ctx.done(fail_result(&message))
            }
        };
    }

    let mut result = read_hosts_file(None);
    if args.get("backups").and_then(Value::as_bool) == Some(true) {
        result.backups = Some(list_backups(&data_path));
    }
    ctx.log(
        &format!(
            "hosts-read: 完成（path={} size={} writable={} encoding={}）",
            result.path, result.size, result.writable, result.encoding
        ),
        None,
        Level::Info,
    )?;
    ctx.done(serde_json::to_value(&result).unwrap_or(Value::Null))
}

/// 与 v1 的 `fail()` 同形状：读失败也回一份完整的 `HostsReadResult`（调用方只判 `ok`）。
fn fail_result(message: &str) -> Value {
    json!({
        "ok": false,
        "path": resolve_hosts_path().to_string_lossy(),
        "content": "",
        "size": 0,
        "mtime": 0,
        "bom": false,
        "encoding": "utf8",
        "writable": false,
        "platform": platform_string(),
        "error": message,
    })
}
