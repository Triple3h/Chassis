//! 协议一致性 fixture：复刻 `tests/fixtures/echo-plugin`（v1）的 compute / job / feed 三个命令。
//!
//! 对拍入口：`node scripts/parity-echo.mjs` —— Node 假宿主同时拉起 v1（worker）与 v2（本二进制），
//! 喂同一组输入、回同一套 RPC，断言两侧输出逐字段一致（A0 验收门）。

use launcher_plugin_sdk::{json, Context, Level, Result, Value};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    match ctx.command() {
        "compute" => compute(ctx),
        "job" => job(ctx),
        "feed" => feed(ctx),
        "probe" => probe(ctx),
        other => ctx.fail(format!("未知命令：{other}")),
    }
}

/// 插件设置回显（设置用例的探针）：把宿主注入的 settings 原样写进结果项标题 ——
/// 这样「注入通道」是被真正走了一遍，而不是断言内核内部状态。
fn probe(ctx: &Context) -> Result<()> {
    let flag = ctx
        .settings_bool("flag")
        .map(|value| value.to_string())
        .unwrap_or_else(|| "-".to_string());
    let title = format!(
        "engine={}|flag={}|note={}",
        ctx.settings_str("engine").unwrap_or("-"),
        flag,
        ctx.settings_str("note").unwrap_or("-"),
    );
    ctx.on_query(move |_query, _token| {
        Ok(vec![json!({
            "id": "probe",
            "title": title,
            "action": { "type": "copy", "text": "probe" },
        })])
    })
}

/// script 契约：`ctx.done(x)` 的 x 即调用方 `ctx.exec.run` 的返回值。
fn compute(ctx: &Context) -> Result<()> {
    let input = ctx.raw_args().clone();
    if input.get("fail").and_then(Value::as_bool).unwrap_or(false) {
        return ctx.fail("compute 按要求失败");
    }
    let n = match input.get("n") {
        None | Some(Value::Null) => 1.0,
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        // v1 是 `Number(input.n ?? 1)`：字符串 "21" 也会被转成数字
        Some(Value::String(text)) => text.trim().parse::<f64>().unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    if !n.is_finite() {
        return ctx.fail("n 必须是数字");
    }
    ctx.done(json!({
        "n": number_json(n),
        "doubled": number_json(n * 2.0),
        "pluginId": ctx.plugin_id(),
    }))
}

/// 整数值输出为整数：v1 的 `Number` 在 JSON 里是 `21`，Rust 的 f64 会写成 `21.0`（对拍会差一个字符）。
fn number_json(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// no-view 契约：一次性执行 + storage RPC + log/progress。
fn job(ctx: &Context) -> Result<()> {
    ctx.log(
        "job 开始",
        Some(&json!({
            "command": ctx.command(),
            "dataPath": ctx.data_path().to_string_lossy(),
            "mode": ctx.mode().as_str(),
        })),
        Level::Info,
    )?;
    ctx.progress(0.5, json!({ "step": "halfway" }))?;

    let runs = ctx.storage().get("runs")?.and_then(|value| value.as_i64()).unwrap_or(0) + 1;
    ctx.storage().set("runs", json!(runs))?;

    ctx.done(json!({
        "command": ctx.command(),
        "args": ctx.raw_args(),
        "mode": ctx.mode().as_str(),
        "runs": runs,
        "dataPathEndsWith": ctx.data_path().to_string_lossy().ends_with("echo-plugin"),
        "pluginPathIsReadOnlySource": !ctx.plugin_path().as_os_str().is_empty(),
    }))
}

/// 贡献型搜索源契约：常驻，宿主每次输入下发 query，插件回结果项。
fn feed(ctx: &Context) -> Result<()> {
    ctx.log(&format!("feed 启动：{}", ctx.command()), None, Level::Debug)?;
    ctx.on_query(|query, token| {
        Ok(vec![json!({
            "id": format!("echo:feed:{query}"),
            "title": format!("echo: {query}"),
            "subtitle": format!("token={token}"),
            "icon": "terminal",
            "score": 0.5,
            "action": {
                "type": "command",
                "command": "job",
                "args": { "from": "feed", "query": query },
            },
        })])
    })
}
