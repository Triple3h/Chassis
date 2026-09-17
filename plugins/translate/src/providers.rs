//! 各家翻译 API 的 HTTP 调用 —— 全插件唯一联网的地方。
//!
//! - 有道智云 v3：`POST https://openapi.youdao.com/api`
//!   签名 = `sha256(appKey + truncate(q) + salt + curtime + appSecret)`，另带 `signType=v3`
//! - 百度通用文本翻译：`POST https://fanyi-api.baidu.com/api/trans/vip/translate`
//!   签名 = `md5(appid + q + salt + 密钥)`
//! - 百度**大模型**文本翻译：`POST https://fanyi-api.baidu.com/ait/api/aiTextTranslate`
//!   同款签名与响应格式，另带 `model_type=llm` 与可选 `reference`（自定义翻译指令）
//!
//! 参数名、语言码与错误码**以各家控制台文档为准**（这里只做形状固定的表单请求，不带任何厂商 SDK）。
//! 之所以放在逻辑层而不是插件页：插件页的 CSP 只放行 https 且会被 CORS 拦（官方接口不返回 CORS 头），
//! 子进程则没有这些限制，密钥也不必进 WebView。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::{
    baidu_lang, baidu_sign, parse_baidu, parse_baidu_llm, parse_youdao, youdao_lang, youdao_sign,
    Credentials, Translation,
};

/// 单次请求超时
const TIMEOUT: Duration = Duration::from_secs(4);
const YOUDAO_URL: &str = "https://openapi.youdao.com/api";
const BAIDU_URL: &str = "https://fanyi-api.baidu.com/api/trans/vip/translate";
/// 大模型文本翻译（百度文档 §21）：模型由 `model_type` 选，`llm` 即大模型
const BAIDU_LLM_URL: &str = "https://fanyi-api.baidu.com/ait/api/aiTextTranslate";
/// 测试用地址覆盖（照 host-manager 的 `LAUNCHER_HOSTS_PATH` 先例）：供本地假 API 做端到端验证
const YOUDAO_URL_ENV: &str = "LAUNCHER_TRANSLATE_YOUDAO_URL";
const BAIDU_URL_ENV: &str = "LAUNCHER_TRANSLATE_BAIDU_URL";
const BAIDU_LLM_URL_ENV: &str = "LAUNCHER_TRANSLATE_BAIDU_LLM_URL";

fn url(default_url: &str, env_key: &str) -> String {
    std::env::var(env_key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_url.to_string())
}

/// 按生效后端翻一次；`reference` 是自定义翻译指令（仅大模型接口支持，空 = 不带该参数）
pub fn run(
    provider: &str,
    text: &str,
    target: &str,
    creds: &Credentials,
    reference: Option<&str>,
) -> Result<Translation, String> {
    match provider {
        "youdao" => youdao(text, target, creds),
        "baidu" => baidu(text, target, creds),
        "baidu-llm" => baidu_llm(text, target, creds, reference),
        other => Err(format!("未知后端：{other}")),
    }
}

fn youdao(text: &str, target: &str, creds: &Credentials) -> Result<Translation, String> {
    let to = youdao_lang(target).ok_or_else(|| format!("有道不支持目标语言「{target}」"))?;
    let salt = nonce();
    let curtime = now_secs();
    let sign = youdao_sign(&creds.youdao_key, text, &salt, &curtime, &creds.youdao_secret);
    let body = post_form(
        &url(YOUDAO_URL, YOUDAO_URL_ENV),
        &[
            ("q", text),
            ("from", "auto"),
            ("to", to),
            ("appKey", creds.youdao_key.as_str()),
            ("salt", salt.as_str()),
            ("sign", sign.as_str()),
            ("signType", "v3"),
            ("curtime", curtime.as_str()),
        ],
    )?;
    parse_youdao(&body)
}

fn baidu(text: &str, target: &str, creds: &Credentials) -> Result<Translation, String> {
    let to = baidu_lang(target).ok_or_else(|| format!("百度不支持目标语言「{target}」"))?;
    let salt = nonce();
    let sign = baidu_sign(&creds.baidu_id, text, &salt, &creds.baidu_secret);
    let body = post_form(
        &url(BAIDU_URL, BAIDU_URL_ENV),
        &[
            ("q", text),
            ("from", "auto"),
            ("to", to),
            ("appid", creds.baidu_id.as_str()),
            ("salt", salt.as_str()),
            ("sign", sign.as_str()),
        ],
    )?;
    parse_baidu(&body)
}

/// 百度大模型文本翻译（文档 §21）：与通用文本翻译同签名，另带 `model_type=llm`
/// （`nmt` 才是通用模型，这里固定 llm）；`reference` = 自定义翻译指令（≤ 500 字，空则不传）。
fn baidu_llm(
    text: &str,
    target: &str,
    creds: &Credentials,
    reference: Option<&str>,
) -> Result<Translation, String> {
    let to = baidu_lang(target).ok_or_else(|| format!("百度不支持目标语言「{target}」"))?;
    let salt = nonce();
    let sign = baidu_sign(&creds.baidu_id, text, &salt, &creds.baidu_secret);
    let mut form: Vec<(&str, &str)> = vec![
        ("q", text),
        ("from", "auto"),
        ("to", to),
        ("appid", creds.baidu_id.as_str()),
        ("salt", salt.as_str()),
        ("sign", sign.as_str()),
        ("model_type", "llm"),
    ];
    if let Some(reference) = reference.map(str::trim).filter(|value| !value.is_empty()) {
        form.push(("reference", reference));
    }
    let body = post_form(&url(BAIDU_LLM_URL, BAIDU_LLM_URL_ENV), &form)?;
    parse_baidu_llm(&body)
}

fn post_form(url: &str, form: &[(&str, &str)]) -> Result<String, String> {
    let request = ureq::post(url).timeout(TIMEOUT).set("User-Agent", "Chassis-translate/0.1");
    match request.send_form(form) {
        Ok(response) => response.into_string().map_err(|err| format!("读取响应失败：{err}")),
        // 非 2xx 时厂商也常在响应体里给错误码：先取正文，交给解析层报可操作的提示
        Err(ureq::Error::Status(code, response)) => match response.into_string() {
            Ok(body) if !body.trim().is_empty() => Ok(body),
            _ => Err(format!("HTTP {code}")),
        },
        Err(err) => Err(format!("请求失败：{err}")),
    }
}

/// 业务侧只要求「唯一且够随机」（不是密码学用途）：微秒时间 + 进程内自增
fn nonce() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let micros = SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_micros()).unwrap_or(0);
    format!("{micros}{seq}")
}

fn now_secs() -> String {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_secs()).unwrap_or(0).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonce_is_unique_per_call() {
        let first = nonce();
        let second = nonce();
        assert_ne!(first, second, "salt 必须每次不同（否则同一秒内会撞签名）");
    }

    #[test]
    fn url_honours_env_override() {
        // 测试用覆盖（见 YOUDAO_URL_ENV）：本地假 API 做端到端验证时靠它把请求指到 127.0.0.1
        let key = "LAUNCHER_TRANSLATE_TEST_URL_ONLY";
        std::env::set_var(key, "http://127.0.0.1:1/api");
        assert_eq!(url("https://default", key), "http://127.0.0.1:1/api");
        std::env::set_var(key, "   ");
        assert_eq!(url("https://default", key), "https://default", "空白值按未设置处理");
        std::env::remove_var(key);
        assert_eq!(url("https://default", key), "https://default");
    }

    #[test]
    fn run_rejects_unknown_provider() {
        let err = run("deepl", "hello", "zh", &Credentials::default(), None).unwrap_err();
        assert!(err.contains("未知后端"), "{err}");
    }

    #[test]
    fn run_reports_unsupported_target() {
        let creds = Credentials { youdao_key: "k".into(), youdao_secret: "s".into(), ..Default::default() };
        // 不联网：语言码校验在发请求之前
        let err = run("youdao", "hello", "xx", &creds, None).unwrap_err();
        assert!(err.contains("不支持目标语言"), "{err}");
    }

    #[test]
    fn run_validates_baidu_llm_before_network() {
        let creds = Credentials { baidu_id: "id".into(), baidu_secret: "s".into(), ..Default::default() };
        // 大模型接口与通用接口共用语言码表：非法目标语言在发请求前就被拦下
        let err = run("baidu-llm", "hello", "xx", &creds, Some("用学术风格")).unwrap_err();
        assert!(err.contains("不支持目标语言"), "{err}");
    }
}
