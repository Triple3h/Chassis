//! 命令 `reveal`（hidden script）：在文件管理器中显示。
//! macOS = Finder（`open -R`），Windows = 资源管理器（`explorer /select,`）。

use std::path::Path;
#[cfg(target_os = "macos")]
use std::time::Duration;

#[cfg(target_os = "macos")]
use launcher_plugin_file_search::{run_tool, runtime};
use launcher_plugin_sdk::{json, Context, Result, Value};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let target = ctx.raw_args().get("path").and_then(Value::as_str).unwrap_or_default().to_string();
    // 安全：只接受绝对路径（两端口径都用 Path::is_absolute，不接受相对路径或命令串）
    if target.is_empty() || !Path::new(&target).is_absolute() {
        return ctx.fail("reveal 需要绝对路径");
    }

    #[cfg(target_os = "macos")]
    {
        let args = vec!["-R".to_string(), target.clone()];
        let (ok, _) = runtime().block_on(run_tool("open", &args, Duration::from_millis(4000)));
        return ctx.done(json!({ "ok": ok, "path": target }));
    }

    #[cfg(windows)]
    {
        // `explorer /select,<路径>`：打开资源管理器并选中该文件。
        // 不等退出码 —— explorer 即使成功也常返回 1，等它反而会误判成失败。
        use std::process::{Command, Stdio};
        let launched = Command::new("explorer")
            .arg(format!("/select,{target}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok();
        return ctx.done(json!({ "ok": launched, "path": target }));
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        ctx.fail("当前平台不支持 reveal")
    }
}
