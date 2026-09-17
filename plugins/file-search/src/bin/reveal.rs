//! 命令 `reveal`（hidden script）：在 Finder 中显示（v1 `src/no-view/reveal.ts`）。

use std::time::Duration;

use launcher_plugin_file_search::{run_tool, runtime};
use launcher_plugin_sdk::{json, Context, Result, Value};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let target = ctx.raw_args().get("path").and_then(Value::as_str).unwrap_or_default().to_string();
    // 安全：只接受绝对路径（不接受调用方传入的相对路径或命令串）
    if !target.starts_with('/') {
        return ctx.fail("reveal 需要绝对路径");
    }
    let args = vec!["-R".to_string(), target.clone()];
    let (ok, _) = runtime().block_on(run_tool("open", &args, Duration::from_millis(4000)));
    ctx.done(json!({ "ok": ok, "path": target }))
}
