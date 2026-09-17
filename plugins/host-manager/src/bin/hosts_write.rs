//! 命令 `hosts-write`（script）：把托管区写回系统 hosts（v1 `src/no-view/hosts-write.ts`）。
//!
//! args:
//!   `{ region: string, remove?: string[], mode?: 'auto' | 'direct' | 'privileged', backup?: boolean }`
//!
//! `region` 是**托管区文本**（含首尾标记），不是整份文件：区外的行归系统与别的程序管，
//! 我们不碰（见 lib.rs 的 `splice_region`）。`remove` 只用于「区外条目收进块」时把那几行从区外摘掉。
//!
//! 注意：目标路径**不接收调用方传参**，只由 `resolve_hosts_path()` 的平台规则决定，
//! 否则这个「能提权写文件」的脚本就变成了任意文件写入的跳板。

use launcher_plugin_host_manager::{platform_string, resolve_hosts_path, write_hosts_file, WriteOptions};
use launcher_plugin_sdk::{Context, Level, Result, Value};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    // 备份与待生效文件都落在数据目录（N2：安装目录只读，升级会被覆盖）
    let data_path = ctx.data_path().to_path_buf();
    let mut options: WriteOptions = match ctx.args::<WriteOptions>() {
        Ok(options) => options,
        Err(err) => {
            ctx.log(&format!("hosts-write: 入参不合法：{}", err.message), None, Level::Error)?;
            return ctx.done(serde_json::json!({
                "ok": false,
                "method": "none",
                "path": resolve_hosts_path().to_string_lossy(),
                "platform": platform_string(),
                "error": err.message,
            }));
        }
    };
    options.data_path = data_path;

    let result = write_hosts_file(&options);
    ctx.log(
        &format!(
            "hosts-write: 完成（ok={} method={} changed={:?} backup={:?} verified={:?} error={:?}）",
            result.ok, result.method, result.changed, result.backup, result.verified, result.error
        ),
        None,
        Level::Info,
    )?;
    ctx.done(serde_json::to_value(&result).unwrap_or(Value::Null))
}
