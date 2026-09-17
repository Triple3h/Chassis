//! 网址直达（web-open）逻辑层：命令 `web`（贡献型搜索源）。
//!
//! v1 实现是 `src/no-view/web.ts`（worker + `@launcher/api-node`）；
//! 本 crate 是 v2 的可执行产物（宿主 spawn + NDJSON，plugin-spec §4.4）。

mod parse;

use launcher_plugin_sdk::{json, Context, Level, Result, Value};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    // 设置在**子进程启动时**快照一次；用户在设置页改完会重载插件，新值随新进程生效
    let engine = parse::resolve_engine(ctx.settings_str("engine"));
    ctx.log(&format!("默认搜索引擎：{}", engine.name), None, Level::Debug)?;

    ctx.on_query(move |query, _token| {
        Ok(parse::parse_query(query, engine).into_iter().map(to_result_item).collect())
    })
}

/// 结果项形状与 v1 逐字段一致（plugin-spec §9.2）。
fn to_result_item(hit: parse::UrlHit) -> Value {
    let is_direct = hit.kind == "url";
    json!({
        "id": format!("web:{}", hit.url),
        "title": hit.label,
        "subtitle": if is_direct { "直接打开".to_string() } else { hit.url.clone() },
        "icon": if is_direct { "globe" } else { "search" },
        "score": hit.score,
        "action": { "type": "open", "target": hit.url, "targetKind": "url" },
        "actions": [{ "type": "copy", "text": hit.url }],
    })
}
