//! 命令 `calc-eval`（贡献型搜索源）：输入算式时给出「算式 = 结果」推荐项。
//!
//! 宿主每次输入触发一次 `on_query`；不是算式就什么都不回（当作没贡献）。
//! 取值 / 识别 / 构造全在 lib（有单测），这里只做 SDK 接线。

use launcher_plugin_calc_pad::preview::preview;
use launcher_plugin_sdk::{Context, Result};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    ctx.on_query(|query, _token| Ok(preview(query).into_iter().collect()))
}
