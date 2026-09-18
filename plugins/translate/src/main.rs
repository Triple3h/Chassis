//! 聚合翻译（`translate`）逻辑层：命令 `translate` —— 贡献型搜索源（常驻，宿主按需启停）。
//!
//! 两条链路：
//! - `mode=search`（搜索条）：只产出**翻译入口**（[`logic::open_item`]）—— 搜索条不翻译、不联网，
//!   点击入口才带着原文打开工作台（`panel`）；
//! - `mode=run`（插件页 `exec.run`）：真正调后端翻一次，并把命名风格变体一起给出去。
//!
//! 联网全在这个子进程里：没有 CORS、没有插件页 CSP 限制，也不需要任何高风险能力
//! （声明里只有 `clipboard.write`，供宿主执行 `copy` 动作）。

use launcher_plugin_sdk::{json, Context, Level, Mode, Result, Value};

use launcher_plugin_translate as logic;
use logic::{Credentials, Intent};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    // 设置在子进程启动时快照一次；用户在设置页改完，宿主会重载插件，新值随新进程生效
    let provider = logic::normalize_provider(ctx.settings_str("provider"));
    let target = logic::normalize_target(ctx.settings_str("target-lang"));
    let trigger = logic::normalize_trigger(ctx.settings_str("trigger"));
    let reference = logic::normalize_reference(ctx.settings_str("baidu-reference"));
    let creds = Credentials {
        youdao_key: setting(ctx, "youdao-app-key"),
        youdao_secret: setting(ctx, "youdao-app-secret"),
        baidu_id: setting(ctx, "baidu-app-id"),
        baidu_secret: setting(ctx, "baidu-app-secret"),
    };
    ctx.log(
        &format!(
            "翻译就绪：后端={}（{}）目标语言={target} 触发={trigger}",
            provider,
            match creds.resolve(provider) {
                Some("youdao") => "有道",
                Some("baidu") => "百度",
                Some("baidu-llm") => "百度大模型",
                _ => "未配置凭据",
            }
        ),
        None,
        Level::Info,
    )?;

    if ctx.mode() == Mode::Run {
        return run_once(ctx, &creds, provider, target, &reference);
    }

    let handle_ctx = ctx.clone();
    ctx.on_query(move |query, _token| Ok(handle(&handle_ctx, trigger, query)))
}

/// `mode=run`（插件页用 `exec.run` 调用）：
/// - 空参数 = 问状态：插件页打开时取生效设置与选项表（视图层不再抄一份语言/引擎清单）
/// - `{ text, target?, provider? }` = 翻一次，并把命名风格变体一起给出去
fn run_once(
    ctx: &Context,
    creds: &Credentials,
    provider: &str,
    target_default: &'static str,
    reference: &str,
) -> Result<()> {
    let args = ctx.raw_args().clone();
    let raw = args.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let target = args
        .get("target")
        .and_then(Value::as_str)
        .map(|raw| logic::normalize_target(Some(raw)))
        .unwrap_or(target_default);
    let provider = args
        .get("provider")
        .and_then(Value::as_str)
        .map(|raw| logic::normalize_provider(Some(raw)))
        .unwrap_or(provider);

    // 没有正文 = 插件页在问状态（生效设置 + 选项表）
    if raw.is_empty() {
        return ctx.done(json!({
            "ok": true,
            "configured": creds.resolve(provider).is_some(),
            "provider": provider,
            "providerTitle": logic::provider_title(creds.resolve(provider).unwrap_or(provider)),
            "target": target,
            "targets": logic::TARGETS
                .iter()
                .map(|&(value, label)| json!({ "value": value, "label": label }))
                .collect::<Vec<_>>(),
            "providers": logic::PROVIDER_OPTIONS
                .iter()
                .map(|&(value, label)| json!({ "value": value, "label": label }))
                .collect::<Vec<_>>(),
        }));
    }

    // `{ variantsOnly: true, text }`：只算命名风格变体 —— 不联网、不看凭据、也不剥触发词
    // （传进来的是**译文**，不是搜索词）。历史翻译面板要按风格复制某条旧译文，走的就是这条路。
    if args.get("variantsOnly").and_then(Value::as_bool).unwrap_or(false) {
        return ctx.done(json!({ "ok": true, "text": raw, "variants": variants_json(&raw) }));
    }

    // 带触发词的正文（`翻译 你好`）要剥掉；只剩触发词本身 ⇒ 空结果，插件页据此停在空态
    let text = match logic::strip_trigger(&raw) {
        Some(rest) => rest.to_string(),
        None => raw,
    };
    if text.is_empty() {
        return ctx.done(json!({ "ok": true, "text": "", "translation": "", "variants": [] }));
    }

    let Some(active) = creds.resolve(provider) else {
        return ctx.done(json!({
            "ok": false,
            "provider": provider,
            "target": target,
            "text": text,
            "error": "未配置翻译 API：去「设置 → 插件 → 聚合翻译」填一家凭据（有道 AppKey/AppSecret，或百度 AppID/密钥）",
        }));
    };

    // 目标语言 `auto` 在这里落地成真实语言码（中文 ⇒ en，其余 ⇒ zh）；
    // 返回给插件页的 `target` 仍是模式本身，方向由 `direction` 体现
    let to = logic::resolve_target(&text, target);

    let started = std::time::Instant::now();
    match logic::providers::run(active, &text, to, creds, Some(reference)) {
        Ok(translation) => {
            ctx.log(
                &format!(
                    "{active} 翻译成功（{} 字 → {to}，{}ms）",
                    text.chars().count(),
                    started.elapsed().as_millis()
                ),
                None,
                Level::Debug,
            )?;
            ctx.done(json!({
                "ok": true,
                "provider": translation.provider,
                "providerTitle": translation.provider_title,
                "target": target,
                "direction": translation.direction(to),
                "elapsedMs": started.elapsed().as_millis() as u64,
                "text": text,
                "translation": translation.text,
                "variants": variants_json(&translation.text),
            }))
        }
        Err(message) => {
            ctx.log(&format!("翻译失败：{message}"), None, Level::Warn)?;
            ctx.done(json!({
                "ok": false,
                "provider": active,
                "target": target,
                "text": text,
                "error": message,
            }))
        }
    }
}

/// 命名风格变体的 JSON 形态（翻译成功与 `variantsOnly` 两条路共用）
fn variants_json(text: &str) -> Vec<Value> {
    logic::naming_variants(text)
        .iter()
        .map(|variant| {
            json!({
                "id": variant.id,
                "label": variant.label,
                "value": variant.value,
            })
        })
        .collect()
}

/// 搜索条：只给「翻译入口」，**不发任何请求**（额度留给用户真正点进工作台的那一次）。
fn handle(ctx: &Context, trigger: &str, query: &str) -> Vec<Value> {
    match logic::detect_intent(query, trigger) {
        Intent::Translate(text) => {
            ctx.log(&format!("搜索给出翻译入口（{} 字）", text.chars().count()), None, Level::Debug).ok();
            // 单个英文词略低分：它也可能是应用名 / 命令，明确命中标题的结果仍然排在前面
            vec![logic::open_item(&text, logic::entry_score(&text))]
        }
        Intent::Skip => Vec::new(),
    }
}

fn setting(ctx: &Context, key: &str) -> String {
    ctx.settings_str(key).unwrap_or("").trim().to_string()
}
