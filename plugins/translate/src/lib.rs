//! 聚合翻译（`translate`）的纯逻辑：语言码映射、触发判定、签名、响应解析、结果项组装。
//!
//! 这一层没有网络、没有宿主依赖 —— 全部能在 `cargo test -p launcher-plugin-translate` 下断言。
//! 真正发请求的是 [`providers`]，SDK 胶水在 `src/main.rs`。
//!
//! 搜索侧只产「翻译入口」（[`open_item`]）：搜索条**不翻译**，点击入口才带着原文进插件页翻。

pub mod providers;

use serde_json::{json, Value};

/// 目标语言（设置 `target-lang`）：规范码 → 展示名
///
/// `auto` 不是语言而是一种**方向**：按原文判断 —— 中文（含 CJK）译英文、其余译中文，
/// 也就是「中 ⇄ 英 互译」；真正发请求前由 [`resolve_target`] 落地成 `zh` / `en`。
pub const TARGETS: [(&str, &str); 11] = [
    ("auto", "自动（中 ⇄ 英）"),
    ("zh", "中文"),
    ("en", "英语"),
    ("ja", "日语"),
    ("ko", "韩语"),
    ("fr", "法语"),
    ("es", "西班牙语"),
    ("de", "德语"),
    ("it", "意大利语"),
    ("ru", "俄语"),
    ("pt", "葡萄牙语"),
];

/// 单次翻译的文本上限：与内核「唤出时带入选中文本」的 `SELECTION_MAX_CHARS` 一致
/// （更长的文本不该塞进搜索框，也不该走贡献型链路 —— 留给将来的插件页）
pub const MAX_TEXT_CHARS: usize = 400;

/// 结果项 title 上限（plugin-spec §9.3：≤ 80 字符）
const TITLE_MAX: usize = 80;

/// 大模型文本翻译的自定义指令上限（百度文档 §21：`reference` ≤ 500 字符）
pub const REFERENCE_MAX_CHARS: usize = 500;

/// 显式前缀触发词：用户明确要翻译，与「自动模式」的启发式无关
const PREFIXES: [&str; 10] =
    ["fy ", "fy:", "翻译 ", "翻译:", "tr ", "tr:", "translate ", "translate:", "fanyi ", "译 "];

/// 光秃秃的触发词（没有正文）：用户是在**找这个插件**，不是在翻译这个词本身
const TRIGGER_WORDS: [&str; 6] = ["fy", "翻译", "tr", "translate", "fanyi", "译"];

/// 一眼就不是"待译文本"的后缀（文件名的场景比句子的场景常见得多）
const FILE_EXTS: [&str; 16] = [
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".png", ".jpg", ".jpeg", ".gif", ".zip", ".tar", ".gz", ".mp4", ".txt",
];

/// 一次翻译的产物
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Translation {
    pub provider: &'static str,
    pub provider_title: &'static str,
    pub text: String,
    /// 后端回传的源语言（规范码）；拿不到就是 `None`
    pub source: Option<&'static str>,
}

impl Translation {
    /// `英语 → 中文` / `译为中文`
    pub fn direction(&self, target: &str) -> String {
        match self.source.map(language_title) {
            Some(source) => format!("{source} → {}", language_title(target)),
            None => format!("译为{}", language_title(target)),
        }
    }
}

pub fn language_title(code: &str) -> &'static str {
    TARGETS.iter().find(|(value, _)| *value == code).map(|(_, title)| *title).unwrap_or("其它语言")
}

/// 设置 `provider`：`auto` = 谁配全凭据就用谁（有道优先）
pub fn normalize_provider(raw: Option<&str>) -> &'static str {
    match raw.map(str::trim) {
        Some("youdao") => "youdao",
        Some("baidu") => "baidu",
        Some("baidu-llm") => "baidu-llm",
        _ => "auto",
    }
}

pub fn normalize_target(raw: Option<&str>) -> &'static str {
    let value = raw.map(str::trim).unwrap_or("");
    TARGETS.iter().find(|(code, _)| *code == value).map(|(code, _)| *code).unwrap_or("auto")
}

/// 目标语言 `auto` 的落地：原文含 CJK（中文 / 日文 / 韩文）⇒ 译英文，其余 ⇒ 译中文。
///
/// 显式选了语言就原样返回（`auto` 之外的取值都是真实语言码）。
pub fn resolve_target(text: &str, target: &str) -> &'static str {
    if target != "auto" {
        return normalize_target(Some(target));
    }
    if text.chars().any(is_cjk) {
        "en"
    } else {
        "zh"
    }
}

pub fn normalize_trigger(raw: Option<&str>) -> &'static str {
    match raw.map(str::trim) {
        Some("prefix") => "prefix",
        Some("off") => "off",
        _ => "auto",
    }
}

/// 引擎选项（插件页的下拉直接用这一份，视图层不再抄一遍）
///
/// `baidu` 与 `baidu-llm` 共用同一对 AppID / 密钥，区别只在调哪条接口：
/// 通用文本翻译（NMT，`/api/trans/vip/translate`）与**大模型文本翻译**
/// （`/ait/api/aiTextTranslate`，`model_type=llm`，支持自定义翻译指令）。
/// 大模型服务要在控制台**单独开通**，因此 `auto` 不会替用户选它。
pub const PROVIDER_OPTIONS: [(&str, &str); 4] = [
    ("auto", "自动（有道优先）"),
    ("youdao", "有道智云"),
    ("baidu", "百度通用文本翻译"),
    ("baidu-llm", "百度大模型文本翻译"),
];

/// 引擎展示名（日志与状态用）
pub fn provider_title(provider: &str) -> &'static str {
    match provider {
        "youdao" => "有道",
        "baidu" => "百度",
        "baidu-llm" => "百度大模型",
        _ => "自动",
    }
}

/// 凭据（四把 key 明文存 `<dataRoot>/plugin-settings.json`，见 README 的隐私说明）
#[derive(Debug, Clone, Default)]
pub struct Credentials {
    pub youdao_key: String,
    pub youdao_secret: String,
    pub baidu_id: String,
    pub baidu_secret: String,
}

impl Credentials {
    pub fn has_youdao(&self) -> bool {
        !self.youdao_key.trim().is_empty() && !self.youdao_secret.trim().is_empty()
    }

    pub fn has_baidu(&self) -> bool {
        !self.baidu_id.trim().is_empty() && !self.baidu_secret.trim().is_empty()
    }

    /// 生效后端。显式选了某家但没配全 ⇒ `None`（给「未配置」提示，**不偷偷换一家**）
    ///
    /// `baidu` 与 `baidu-llm` 共用百度凭据；`auto` 只在两者里选**通用**那条
    /// （大模型服务未开通时会报 58002 / 90107，不该由自动模式替用户踩）。
    pub fn resolve(&self, provider: &str) -> Option<&'static str> {
        match provider {
            "youdao" => self.has_youdao().then_some("youdao"),
            "baidu" => self.has_baidu().then_some("baidu"),
            "baidu-llm" => self.has_baidu().then_some("baidu-llm"),
            _ if self.has_youdao() => Some("youdao"),
            _ if self.has_baidu() => Some("baidu"),
            _ => None,
        }
    }
}

/// 设置 `baidu-reference`：大模型翻译的自定义指令（≤ 500 字符，空 = 不带该参数）
pub fn normalize_reference(raw: Option<&str>) -> String {
    let value = raw.map(str::trim).unwrap_or("");
    value.chars().take(REFERENCE_MAX_CHARS).collect()
}

/// 一次查询的意图
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Intent {
    /// 不翻译（默认：静默，不打扰搜索）
    Skip,
    /// 翻译这段文本
    Translate(String),
}

/// 触发判定：`off` 完全安静；其余情况显式前缀永远认；`auto` 再吃启发式
pub fn detect_intent(query: &str, trigger: &str) -> Intent {
    let trimmed = query.trim();
    if trimmed.is_empty() || trigger == "off" {
        return Intent::Skip;
    }
    if let Some(text) = strip_trigger(trimmed) {
        if text.is_empty() {
            return Intent::Skip;
        }
        return Intent::Translate(text.to_string());
    }
    if trigger == "auto" && looks_translatable(trimmed) {
        return Intent::Translate(trimmed.to_string());
    }
    Intent::Skip
}

/// 剥掉显式触发词：`"fy 你好"` → `Some("你好")`；**只有触发词本身**（`"翻译"`）→ `Some("")`；
/// 没有触发词 → `None`。
///
/// 插件页也用它：从搜索框带进来的文本往往是「触发词 + 正文」（比如打了 `翻译` 才找到工作台）。
pub fn strip_trigger(text: &str) -> Option<&str> {
    let trimmed = text.trim();
    for prefix in PREFIXES {
        // 用 `get` 切片：非字符边界或太短都返回 None（直接按字节切会 panic）
        let Some(head) = trimmed.get(..prefix.len()) else { continue };
        if head.eq_ignore_ascii_case(prefix) {
            return Some(trimmed.get(prefix.len()..).unwrap_or("").trim());
        }
    }
    if TRIGGER_WORDS.iter().any(|word| trimmed.eq_ignore_ascii_case(word)) {
        return Some("");
    }
    None
}

/// 自动模式的启发式：拦掉一眼不是「待译文本」的东西（网址 / 路径 / 文件名 / 版本号）。
///
/// **单个英文词也给入口**（2026-09-18 放宽）：它最常见的来源是「在别处选中一个英文词再唤出」
/// —— 那时用户就是要翻译它，而按"像不像句子"一刀切会让这个场景彻底消失（实测：选中
/// `AXEnhancedUserInterface` 唤出，列表里只剩一条 Bing 搜索）。放宽的代价（搜应用名时
/// 多一条翻译）由 [`entry_score`] 给"单词"打略低的分来化解（明确命中的命令 / 应用仍然在前），
/// 嫌吵可以把设置里的触发方式调成 `prefix` / `off`。
pub fn looks_translatable(text: &str) -> bool {
    let trimmed = text.trim();
    let count = trimmed.chars().count();
    if count < 2 || count > MAX_TEXT_CHARS {
        return false;
    }
    if is_noise(trimmed) {
        return false;
    }
    trimmed.chars().any(|ch| ch.is_alphanumeric() || is_cjk(ch))
}

/// 翻译入口的自评分（plugin-spec §9.3 `score`；内核按 `0.6 × 插件自评 + 0.4 × 内核匹配分` 混合）。
///
/// 像句子 / 含 CJK 的输入 = 用户多半真要翻译，给 0.9。
/// **单个英文 token** 略低一点（0.85）：它也可能是应用名（`safari`）/ 命令名（`todo`），
/// 而内核分里"明确命中标题"的那些（前缀命中 1.0）会自然压过这里 ——
/// 实测：搜 `safari` ⇒ Safari 应用 0.94 > 翻译 0.79；搜 `AXEnhancedUserInterface`
/// ⇒ 翻译 0.79 > web-open 的"用 Bing 搜索" 0.76，正好是"选中英文标识符再唤出"想要的排序。
pub fn entry_score(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.chars().any(char::is_whitespace) || trimmed.chars().any(is_cjk) {
        0.9
    } else {
        0.85
    }
}

fn is_cjk(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x3040..=0x30FF | 0xAC00..=0xD7AF
    )
}

fn is_noise(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if lower.contains("://") || lower.starts_with("www.") {
        return true;
    }
    if text.starts_with('/') || text.starts_with('~') {
        return true;
    }
    if !text.chars().any(char::is_whitespace) {
        // 单个 token：邮箱 / 路径 / 域名都按"不翻"处理
        if text.contains('@') || text.contains('/') || text.contains('\\') {
            return true;
        }
    }
    if FILE_EXTS.iter().any(|ext| lower.ends_with(ext)) {
        return true;
    }
    // 纯数字 / 版本号 / 日期
    text.chars().all(|ch| ch.is_ascii_digit() || matches!(ch, '.' | '-' | '_' | ' ' | ':'))
}

/// 有道 v3 的 `truncate(q)`：≤ 20 字符原样返回；否则「前 10 + 字符数 + 后 10」
pub fn youdao_truncate(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= 20 {
        return text.to_string();
    }
    let head: String = chars[..10].iter().collect();
    let tail: String = chars[chars.len() - 10..].iter().collect();
    format!("{head}{}{tail}", chars.len())
}

/// 有道 v3 签名：`sha256(appKey + truncate(q) + salt + curtime + appSecret)`
pub fn youdao_sign(app_key: &str, text: &str, salt: &str, curtime: &str, app_secret: &str) -> String {
    let mut hasher = sha2::Sha256::new();
    use sha2::Digest;
    hasher.update(format!("{app_key}{}{salt}{curtime}{app_secret}", youdao_truncate(text)).as_bytes());
    hex_lower(&hasher.finalize())
}

/// 百度通用文本翻译签名：`md5(appid + q + salt + 密钥)`
pub fn baidu_sign(app_id: &str, text: &str, salt: &str, secret: &str) -> String {
    use md5::Digest;
    let mut hasher = md5::Md5::new();
    hasher.update(format!("{app_id}{text}{salt}{secret}").as_bytes());
    hex_lower(&hasher.finalize())
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 规范码 → 有道语言码（源语言恒用 `auto`）
pub fn youdao_lang(canonical: &str) -> Option<&'static str> {
    Some(match canonical {
        "zh" => "zh-CHS",
        "en" => "en",
        "ja" => "ja",
        "ko" => "ko",
        "fr" => "fr",
        "es" => "es",
        "de" => "de",
        "it" => "it",
        "ru" => "ru",
        "pt" => "pt",
        _ => return None,
    })
}

/// 规范码 → 百度语言码（注意百度用 `jp` / `kor` / `fra` / `spa` 这套写法）
pub fn baidu_lang(canonical: &str) -> Option<&'static str> {
    Some(match canonical {
        "zh" => "zh",
        "en" => "en",
        "ja" => "jp",
        "ko" => "kor",
        "fr" => "fra",
        "es" => "spa",
        "de" => "de",
        "it" => "it",
        "ru" => "ru",
        "pt" => "pt",
        _ => return None,
    })
}

fn from_youdao_lang(raw: &str) -> Option<&'static str> {
    Some(match raw.to_ascii_lowercase().as_str() {
        "en" => "en",
        "zh" | "zh-chs" | "zh-cht" => "zh",
        "ja" => "ja",
        "ko" => "ko",
        "fr" => "fr",
        "es" => "es",
        "de" => "de",
        "it" => "it",
        "ru" => "ru",
        "pt" => "pt",
        _ => return None,
    })
}

fn from_baidu_lang(raw: &str) -> Option<&'static str> {
    Some(match raw.to_ascii_lowercase().as_str() {
        "en" => "en",
        "zh" => "zh",
        "jp" => "ja",
        "kor" => "ko",
        "fra" => "fr",
        "spa" => "es",
        "de" => "de",
        "it" => "it",
        "ru" => "ru",
        "pt" => "pt",
        _ => return None,
    })
}

/// 有道响应：`{errorCode, translation[], l}`（`l` 形如 `en2zh-CHS`）
pub fn parse_youdao(body: &str) -> Result<Translation, String> {
    let value: Value = serde_json::from_str(body).map_err(|err| format!("响应不是合法 JSON：{err}"))?;
    let code = value.get("errorCode").map(value_to_string).unwrap_or_default();
    if code != "0" {
        return Err(youdao_error(&code));
    }
    let text = join_translation(value.get("translation"), "");
    if text.trim().is_empty() {
        return Err("有道返回了空译文".to_string());
    }
    let source = value
        .get("l")
        .and_then(Value::as_str)
        .and_then(|pair| pair.split('2').next())
        .and_then(from_youdao_lang);
    Ok(Translation { provider: "youdao", provider_title: "有道", text, source })
}

/// 百度通用文本翻译响应：`{from, to, trans_result[{src,dst}]}`（错误码在 `error_code`）
pub fn parse_baidu(body: &str) -> Result<Translation, String> {
    parse_baidu_body(body, "baidu", "百度")
}

/// 百度**大模型**文本翻译响应：与通用接口同构（`/ait/api/aiTextTranslate`），只是后端标签不同
pub fn parse_baidu_llm(body: &str) -> Result<Translation, String> {
    parse_baidu_body(body, "baidu-llm", "百度大模型")
}

fn parse_baidu_body(
    body: &str,
    provider: &'static str,
    provider_title: &'static str,
) -> Result<Translation, String> {
    let value: Value = serde_json::from_str(body).map_err(|err| format!("响应不是合法 JSON：{err}"))?;
    if let Some(raw) = value.get("error_code") {
        let code = value_to_string(raw);
        if !code.is_empty() && code != "0" {
            return Err(baidu_error(&code));
        }
    }
    let text = join_translation(value.get("trans_result"), "\n");
    if text.trim().is_empty() {
        return Err("百度返回了空译文".to_string());
    }
    let source = value.get("from").and_then(Value::as_str).and_then(from_baidu_lang);
    Ok(Translation { provider, provider_title, text, source })
}

fn join_translation(value: Option<&Value>, separator: &str) -> String {
    let Some(items) = value.and_then(Value::as_array) else { return String::new() };
    let parts: Vec<String> = items
        .iter()
        .filter_map(|item| match item {
            Value::String(text) => Some(text.clone()),
            Value::Object(_) => item.get("dst").and_then(Value::as_str).map(str::to_string),
            _ => None,
        })
        .collect();
    parts.join(separator)
}

fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

/// 有道错误码 → 可操作的中文提示（错误码表以控制台文档为准，这里只收口最常见的几个）
pub fn youdao_error(code: &str) -> String {
    let hint = match code {
        "101" => "缺少必填参数",
        "102" => "不支持的语言类型",
        "108" => "应用 ID 无效（检查 AppKey）",
        "110" => "无相关翻译服务（控制台未开通文本翻译）",
        "202" => "签名校验失败（检查 AppSecret）",
        "203" => "访问 IP 不在白名单",
        "205" => "请求长度超过限制",
        "207" => "不支持该语言方向的翻译",
        "401" => "账户已欠费",
        "411" => "访问频率受限（稍后再试，或调低频率）",
        "421" => "IP 已被封禁",
        _ => "未知错误",
    };
    format!("有道翻译失败（{code}）：{hint}")
}

/// 百度错误码 → 可操作的中文提示
pub fn baidu_error(code: &str) -> String {
    let hint = match code {
        "52001" => "请求超时（重试）",
        "52002" => "系统错误（重试）",
        "52003" => "未授权用户（检查 AppID）",
        "54000" => "必填参数为空",
        "54001" => "签名错误（检查密钥）",
        "54003" => "访问频率受限（调低频率）",
        "54004" => "账户余额不足",
        "54005" => "长 query 请求频繁",
        "58000" => "客户端 IP 非法（控制台若配了 IP 白名单需放行）",
        "58001" => "译文语言方向不支持",
        "58002" => "服务当前已关闭（大模型翻译需在控制台单独开通）",
        "58004" => "模型参数错误",
        "59002" => "自定义翻译指令过长（上限 500 字）",
        "59003" => "请求文本过长（大模型接口上限 6000 字）",
        "59004" => "QPS 超限（稍后再试）",
        "59005" => "标签参数非法",
        "59006" => "标签解析失败",
        "59007" => "指定不翻译的标签过多（上限 20 个）",
        "90107" => "认证未通过或未生效（大模型翻译需先完成开发者认证并开通服务）",
        "20003" => "内容存在安全风险，已拒绝翻译",
        _ => "未知错误",
    };
    format!("百度翻译失败（{code}）：{hint}")
}

/// 搜索结果的「翻译入口」（plugin-spec §9.3）：搜索条只导航，**不翻译**。
///
/// 点击 = 打开工作台 `panel` 并把原文交过去（`action.args.text`，插件页自动翻一次）。
/// 之所以不在列表里直接翻译：
/// - 搜索条里每次输入都发请求等于烧额度，且用户往往只是路过（想找的是别的结果）；
/// - 翻一次只有结果项一行，长文本、换引擎、按命名风格复制都在工作台里，不如一步到位。
///
/// `score` 由 [`entry_score`] 给：单个英文词略低于句子，让"搜应用名"时翻译排在应用之后。
pub fn open_item(text: &str, score: f64) -> Value {
    let source = one_line(text);
    let title = format!("翻译「{}」", shorten(&source, TITLE_MAX - 4));
    json!({
        "id": format!("translate:open:{}", short_hash(text)),
        "title": title,
        "subtitle": "在翻译工作台里翻译 · 可换引擎 / 目标语言 / 按命名风格复制",
        "icon": "languages",
        "score": score,
        "action": { "type": "command", "command": "panel", "args": { "text": text } },
    })
}

/// 稳定短哈希（结果项 id 用：同一段原文 + 同一后端/语言 ⇒ 同一 id，历史与固定项不会错位）
pub fn short_hash(text: &str) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(text.as_bytes());
    hex_lower(&hasher.finalize())[..12].to_string()
}

/// 命名风格变体（插件页的「多种复制方式」）：id → 展示名。
///
/// 顺序即插件页里的 chip 顺序，也是 `⌘1`–`⌘9` 的编号顺序；
/// **只在这里实现一份**（视图层不重写命名转换，避免两版漂移）。
pub const VARIANT_STYLES: [(&str, &str); 9] = [
    ("camel", "camelCase"),
    ("pascal", "PascalCase"),
    ("snake", "snake_case"),
    ("constant", "CONSTANT_CASE"),
    ("kebab", "kebab-case"),
    ("lower", "lower case"),
    ("upper", "UPPER CASE"),
    ("title", "Title Case"),
    ("dot", "dot.case"),
];

/// 一种命名风格的产物
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Variant {
    pub id: &'static str,
    pub label: &'static str,
    pub value: String,
}

/// 译文 → 各种命名风格（给 `变量名` 之类场景一键复制）
///
/// 例：`Get user list` → `getUserList` / `GetUserList` / `get_user_list` /
/// `GET_USER_LIST` / `get-user-list` / `get user list` / `GET USER LIST` /
/// `Get User List` / `get.user.list`
pub fn naming_variants(text: &str) -> Vec<Variant> {
    let words = split_words(text);
    if words.is_empty() {
        return VARIANT_STYLES
            .iter()
            .map(|&(id, label)| Variant { id, label, value: String::new() })
            .collect();
    }
    let capitalize = |word: &str| capitalize_word(word);
    VARIANT_STYLES
        .iter()
        .map(|&(id, label)| {
            let value = match id {
                "camel" => {
                    let mut out = lower_first(&words[0]);
                    for word in &words[1..] {
                        out.push_str(&capitalize(word));
                    }
                    out
                }
                "pascal" => words.iter().map(|word| capitalize(word)).collect::<String>(),
                "snake" => join_lower(&words, "_"),
                "constant" => join_upper(&words, "_"),
                "kebab" => join_lower(&words, "-"),
                "dot" => join_lower(&words, "."),
                "lower" => join_lower(&words, " "),
                "upper" => join_upper(&words, " "),
                // title：每个词首字母大写
                _ => words.iter().map(|word| capitalize(word)).collect::<Vec<_>>().join(" "),
            };
            Variant { id, label, value }
        })
        .collect()
}

fn join_lower(words: &[String], separator: &str) -> String {
    words.iter().map(|word| word.to_lowercase()).collect::<Vec<_>>().join(separator)
}

fn join_upper(words: &[String], separator: &str) -> String {
    words.iter().map(|word| word.to_uppercase()).collect::<Vec<_>>().join(separator)
}

/// 拆词：按非字母数字切分，再拆三种内部边界 ——
/// `get`|`User`（小写→大写）、`HTTP`|`Request`（缩略词后面跟大写+小写）、`line2`|`Item`（数字→大写）。
fn split_words(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    for (index, ch) in chars.iter().copied().enumerate() {
        if !ch.is_alphanumeric() {
            push_word(&mut out, &mut current);
            continue;
        }
        let boundary = match index.checked_sub(1).map(|prev| chars[prev]) {
            None => false,
            Some(prev) => {
                let camel = prev.is_lowercase() && ch.is_uppercase();
                let acronym_end = prev.is_uppercase()
                    && ch.is_uppercase()
                    && chars.get(index + 1).is_some_and(|next| next.is_lowercase());
                let digit_to_upper = prev.is_ascii_digit() && ch.is_uppercase();
                camel || acronym_end || digit_to_upper
            }
        };
        if boundary {
            push_word(&mut out, &mut current);
        }
        current.push(ch);
    }
    push_word(&mut out, &mut current);
    out
}

fn push_word(out: &mut Vec<String>, current: &mut String) {
    let word = current.trim();
    if !word.is_empty() {
        out.push(word.to_string());
    }
    current.clear();
}

/// 首字母大写：全大写词（`HTTP`）先整体小写，免得拼出 `HTTPRequest` 这种
fn capitalize_word(word: &str) -> String {
    let chars: Vec<char> = word.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    let base = if chars.len() > 1 && chars.iter().all(|ch| ch.is_uppercase()) {
        word.to_lowercase()
    } else {
        word.to_string()
    };
    let mut out = String::new();
    for (index, ch) in base.chars().enumerate() {
        if index == 0 {
            out.extend(ch.to_uppercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// 首字母小写（camel 的第一个词）：保留 `iPhone` 这种内部大小写，只压首字母
fn lower_first(word: &str) -> String {
    let chars: Vec<char> = word.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    if chars.len() > 1 && chars.iter().all(|ch| ch.is_uppercase()) {
        return word.to_lowercase();
    }
    if chars[0].is_uppercase() && chars[1..].iter().all(|ch| !ch.is_uppercase()) {
        let mut out = String::new();
        out.extend(chars[0].to_lowercase());
        out.extend(&chars[1..]);
        return out;
    }
    word.to_string()
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn shorten(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return text.to_string();
    }
    let head: String = chars[..max.saturating_sub(1)].iter().collect();
    format!("{}…", head.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youdao_truncate_follows_official_rule() {
        assert_eq!(youdao_truncate("hello world"), "hello world");
        assert_eq!(youdao_truncate(&"字".repeat(20)).chars().count(), 20, "20 字符是边界，原样返回");
        let long = format!("{}{}", "a".repeat(10), "b".repeat(11));
        assert_eq!(long.chars().count(), 21);
        assert_eq!(youdao_truncate(&long), format!("{}{}{}", "a".repeat(10), 21, "b".repeat(10)));
    }

    #[test]
    fn signatures_match_node_crypto() {
        // 期望值由 Node 的 crypto 独立算出（跨实现对拍；签名不符时优先核截断规则与编码）
        assert_eq!(
            youdao_sign("test-key", "hello world", "12345", "1700000000", "test-secret"),
            "8a1969adf32edec669e558357951599ef587bbd139d352dc198a0ede4772215b"
        );
        assert_eq!(baidu_sign("2024", "hello", "1", "s"), "0f44619c35bbf0db9ce7d604a98292da");
    }

    #[test]
    fn youdao_signature_ignores_middle_of_long_text() {
        // truncate 语义的直接体现：中段不同、头尾与长度相同 ⇒ 签名相同
        let left = format!("{}AAAA{}", "a".repeat(10), "b".repeat(10));
        let right = format!("{}BBBB{}", "a".repeat(10), "b".repeat(10));
        assert_eq!(left.chars().count(), 24);
        assert_eq!(youdao_sign("k", &left, "1", "2", "s"), youdao_sign("k", &right, "1", "2", "s"));
    }

    #[test]
    fn language_maps_follow_each_vendor() {
        assert_eq!(youdao_lang("zh"), Some("zh-CHS"));
        assert_eq!(baidu_lang("zh"), Some("zh"));
        assert_eq!(baidu_lang("ja"), Some("jp"));
        assert_eq!(baidu_lang("ko"), Some("kor"));
        assert_eq!(baidu_lang("fr"), Some("fra"));
        assert_eq!(baidu_lang("es"), Some("spa"));
        assert_eq!(from_baidu_lang("jp"), Some("ja"));
        assert_eq!(from_youdao_lang("zh-CHS"), Some("zh"));
        assert_eq!(youdao_lang("xx"), None);
        assert_eq!(normalize_target(Some("jp")), "auto", "写错就回落默认（中英互译），不静默改成别的语言");
    }

    #[test]
    fn resolve_target_switches_direction() {
        // 中文 ⇒ 译英文；英文 / 其它语言 ⇒ 译中文（「中 ⇄ 英」互译）
        assert_eq!(resolve_target("测试", "auto"), "en");
        assert_eq!(resolve_target("hello world", "auto"), "zh");
        assert_eq!(resolve_target("Bonjour", "auto"), "zh");
        assert_eq!(resolve_target("测试 test", "auto"), "en", "中英混排按中文处理");
        assert_eq!(resolve_target("こんにちは", "auto"), "en", "假名也是 CJK");
        // 显式选了语言就照办，不做方向判断
        assert_eq!(resolve_target("测试", "ja"), "ja");
        assert_eq!(resolve_target("hello world", "zh"), "zh");
        assert_eq!(resolve_target("hello", "en"), "en");
        assert_eq!(resolve_target("hello", "写错的值"), "auto", "非法值回落默认，不是中文");
        // 目标语言表里的 `auto` 必须与 normalize_target 对得上（设置页的选项靠同一份）
        assert!(TARGETS.iter().any(|(code, _)| *code == "auto"));
    }

    #[test]
    fn resolve_provider_prefers_youdao_when_auto() {
        let mut creds = Credentials::default();
        assert_eq!(creds.resolve("auto"), None);
        creds.baidu_id = "id".into();
        creds.baidu_secret = "secret".into();
        assert_eq!(creds.resolve("auto"), Some("baidu"));
        assert_eq!(creds.resolve("youdao"), None, "显式选了没配全的后端 ⇒ 不偷偷换一家");
        creds.youdao_key = "key".into();
        creds.youdao_secret = "secret".into();
        assert_eq!(creds.resolve("auto"), Some("youdao"));
        assert_eq!(creds.resolve("baidu"), Some("baidu"));
        assert_eq!(creds.resolve("baidu-llm"), Some("baidu-llm"), "大模型与通用共用百度凭据");
        assert_eq!(creds.resolve("auto"), Some("youdao"), "auto 不替用户选需要单独开通的大模型服务");
    }

    #[test]
    fn baidu_llm_needs_baidu_credentials() {
        let creds = Credentials::default();
        assert_eq!(creds.resolve("baidu-llm"), None, "没配百度凭据 ⇒ 明确报未配置，不偷偷换一家");
    }

    #[test]
    fn detect_intent_handles_prefix_and_auto() {
        assert_eq!(detect_intent("fy hello", "prefix"), Intent::Translate("hello".into()));
        assert_eq!(detect_intent("FY: hello ", "prefix"), Intent::Translate("hello".into()));
        assert_eq!(detect_intent("fy", "auto"), Intent::Skip, "只有前缀词、没有正文");
        assert_eq!(detect_intent("hello world", "prefix"), Intent::Skip);
        assert_eq!(detect_intent("hello world", "auto"), Intent::Translate("hello world".into()));
        assert_eq!(detect_intent("你好世界", "auto"), Intent::Translate("你好世界".into()));
        // 单个英文词也给入口（2026-09-18 放宽）：选中英文标识符再唤出是主要场景（实测遗漏）。
        // 它也可能只是应用名 ⇒ 交给 `entry_score` 降分沉底，而不是在这里一刀切掉
        assert_eq!(
            detect_intent("AXEnhancedUserInterface", "auto"),
            Intent::Translate("AXEnhancedUserInterface".into())
        );
        assert_eq!(detect_intent("safari", "auto"), Intent::Translate("safari".into()));
    }

    #[test]
    fn detect_intent_off_is_silent() {
        // `off` = 搜索里彻底不出现（连前缀也不认）；要前缀但不要启发式用 `prefix`
        assert_eq!(detect_intent("fy hello", "off"), Intent::Skip);
        assert_eq!(detect_intent("翻译 今天天气不错", "off"), Intent::Skip);
        assert_eq!(detect_intent("你好世界", "off"), Intent::Skip);
    }

    #[test]
    fn strip_trigger_handles_bare_words_and_bodies() {
        assert_eq!(strip_trigger("fy hello"), Some("hello"));
        assert_eq!(strip_trigger(" 翻译 你好 "), Some("你好"));
        assert_eq!(strip_trigger("FY: hello"), Some("hello"));
        assert_eq!(strip_trigger("翻译"), Some(""), "只剩触发词 ⇒ 空正文（用户还在找入口）");
        assert_eq!(strip_trigger("translate"), Some(""));
        assert_eq!(strip_trigger("译"), Some(""));
        assert_eq!(strip_trigger("hello world"), None);
        // 光秃秃的触发词不再被 auto 模式当成待译文本（否则搜「翻译」会白发一次请求）
        assert_eq!(detect_intent("翻译", "auto"), Intent::Skip);
    }

    #[test]
    fn looks_translatable_skips_noise() {
        for text in [
            "https://example.com/a",
            "www.example.com",
            "/Users/me/notes.txt",
            "~/Documents/a.md",
            "someone@example.com",
            "2026-09-17",
            "1.2.3",
            "readme.pdf",
        ] {
            assert!(!looks_translatable(text), "不该翻译：{text}");
        }
        // 单个英文词也可译：选中的英文标识符必须先过这一关，否则搜索里什么都不会出现
        for text in ["hello world", "你好世界", "读一下这一段", "safari", "AXEnhancedUserInterface"] {
            assert!(looks_translatable(text), "应当翻译：{text}");
        }
        let long = "字".repeat(MAX_TEXT_CHARS + 1);
        assert!(!looks_translatable(&long), "超长文本留给插件页/剪贴板");
    }

    #[test]
    fn parse_youdao_reads_translation_and_source() {
        let body = r#"{"errorCode":"0","query":"hello","l":"en2zh-CHS","translation":["你好","世界"]}"#;
        let translation = parse_youdao(body).expect("应能解析");
        assert_eq!(translation.text, "你好世界");
        assert_eq!(translation.source, Some("en"));
        assert_eq!(translation.direction("zh"), "英语 → 中文");
        assert_eq!(parse_youdao(r#"{"errorCode":"202"}"#).unwrap_err(), youdao_error("202"));
    }

    #[test]
    fn parse_baidu_joins_segments_and_reports_errors() {
        let body = r#"{"from":"en","to":"zh","trans_result":[{"src":"a","dst":"甲"},{"src":"b","dst":"乙"}]}"#;
        let translation = parse_baidu(body).expect("应能解析");
        assert_eq!(translation.text, "甲\n乙", "多段译文换行分隔");
        assert_eq!(translation.source, Some("en"));
        let err = parse_baidu(r#"{"error_code":"54003","error_msg":"Invalid Access Limit"}"#).unwrap_err();
        assert!(err.contains("54003") && err.contains("频率"), "{err}");
    }

    #[test]
    fn parse_rejects_empty_and_broken_bodies() {
        assert!(parse_youdao("not json").is_err());
        assert!(parse_youdao(r#"{"errorCode":"0","translation":[]}"#).is_err());
        assert!(parse_baidu(r#"{"trans_result":[]}"#).is_err());
        assert!(parse_baidu("").is_err());
    }

    #[test]
    fn parse_baidu_llm_shares_shape_and_labels_the_model() {
        let body = r#"{"from":"en","to":"zh","trans_result":[{"src":"a","dst":"甲"}]}"#;
        let translation = parse_baidu_llm(body).expect("大模型接口响应同构");
        assert_eq!(translation.text, "甲");
        assert_eq!(translation.provider, "baidu-llm");
        assert_eq!(translation.provider_title, "百度大模型", "结果里要能分辨是哪条接口");
        let err = parse_baidu_llm(r#"{"error_code":"58004","error_msg":"Invalid Model"}"#).unwrap_err();
        assert!(err.contains("58004") && err.contains("模型"), "{err}");
    }

    #[test]
    fn baidu_error_covers_llm_only_codes() {
        for (code, keyword) in [
            ("58002", "单独开通"),
            ("59002", "500"),
            ("59003", "6000"),
            ("59004", "QPS"),
            ("90107", "认证"),
            ("20003", "安全风险"),
        ] {
            let message = baidu_error(code);
            assert!(message.contains(keyword), "{code} ⇒ {message} 应含「{keyword}」");
        }
    }

    #[test]
    fn open_item_navigates_instead_of_translating() {
        let item = open_item("hello world", entry_score("hello world"));
        assert_eq!(item["id"], json!(format!("translate:open:{}", short_hash("hello world"))));
        assert_eq!(item["title"], json!("翻译「hello world」"));
        assert_eq!(item["action"]["type"], json!("command"), "搜索条不翻译，只导航");
        assert_eq!(item["action"]["command"], json!("panel"));
        assert_eq!(item["action"]["args"]["text"], json!("hello world"), "原文交给工作台");
        assert_eq!(item["icon"], json!("languages"));
        assert_eq!(item["score"], json!(0.9), "句子照旧高分");
        assert!(item.get("detail").is_none(), "入口项没有译文可看");
        // 同一段文本 ⇒ 同一 id（历史 / 固定项不会错位）
        assert_eq!(open_item("hello world", 0.9)["id"], item["id"]);
        assert_ne!(open_item("hello worlds", 0.9)["id"], item["id"]);
    }

    #[test]
    fn entry_score_keeps_bare_english_tokens_slightly_below_sentences() {
        // 句子 / 中文 ⇒ 0.9；单个英文 token ⇒ 0.85（略低，给"明确命中的命令 / 应用"留位置）
        assert_eq!(entry_score("hello world"), 0.9);
        assert_eq!(entry_score("你好世界"), 0.9);
        assert_eq!(entry_score("读一下这一段"), 0.9);
        assert_eq!(entry_score("AXEnhancedUserInterface"), 0.85);
        assert_eq!(entry_score("safari"), 0.85);
        assert_eq!(open_item("safari", entry_score("safari"))["score"], json!(0.85));
        assert!(
            entry_score("safari") < entry_score("hello world"),
            "单词必须低于句子：选中一个英文标识符时它才能排到前面的同时不压过明确命中"
        );
    }

    #[test]
    fn open_item_folds_whitespace_and_bounds_title() {
        let item = open_item("hello   world\nagain", 0.9);
        assert_eq!(item["title"], json!("翻译「hello world again」"), "多行 / 连续空白折成一行");
        let long = open_item(&"字".repeat(MAX_TEXT_CHARS), 0.9);
        let title = long["title"].as_str().unwrap();
        assert!(title.chars().count() <= TITLE_MAX, "title 不得超过 {TITLE_MAX} 字：{title}");
        assert!(title.starts_with("翻译「") && title.ends_with('」'), "{title}");
        assert!(title.contains('…'), "超长原文要在标题里截断：{title}");
        assert_eq!(long["action"]["args"]["text"], json!("字".repeat(MAX_TEXT_CHARS)), "交给工作台的仍是全文");
    }

    #[test]
    fn normalize_reference_trims_and_caps() {
        assert_eq!(normalize_reference(None), "");
        assert_eq!(normalize_reference(Some("  ")), "");
        assert_eq!(normalize_reference(Some(" 使用学术风格 ")), "使用学术风格");
        assert_eq!(normalize_reference(Some(&"字".repeat(REFERENCE_MAX_CHARS + 10))).chars().count(), REFERENCE_MAX_CHARS);
        assert_eq!(normalize_reference(Some(&"a".repeat(REFERENCE_MAX_CHARS))).len(), REFERENCE_MAX_CHARS);
    }

    fn variant_value(text: &str, id: &str) -> String {
        naming_variants(text).into_iter().find(|variant| variant.id == id).expect("变体存在").value
    }

    #[test]
    fn naming_variants_cover_the_usual_styles() {
        let text = "Get user list";
        assert_eq!(variant_value(text, "camel"), "getUserList");
        assert_eq!(variant_value(text, "pascal"), "GetUserList");
        assert_eq!(variant_value(text, "snake"), "get_user_list");
        assert_eq!(variant_value(text, "constant"), "GET_USER_LIST");
        assert_eq!(variant_value(text, "kebab"), "get-user-list");
        assert_eq!(variant_value(text, "lower"), "get user list");
        assert_eq!(variant_value(text, "upper"), "GET USER LIST");
        assert_eq!(variant_value(text, "title"), "Get User List");
        assert_eq!(variant_value(text, "dot"), "get.user.list");
        assert_eq!(naming_variants(text).len(), VARIANT_STYLES.len(), "每种风格都给一条");
    }

    #[test]
    fn naming_variants_split_inside_words() {
        // camel 边界
        assert_eq!(variant_value("getUserList", "snake"), "get_user_list");
        assert_eq!(variant_value("getUserList", "camel"), "getUserList");
        // 缩略词：HTTP 不能拼成 HTTPRequest
        assert_eq!(variant_value("HTTP request timeout", "camel"), "httpRequestTimeout");
        assert_eq!(variant_value("HTTP request timeout", "pascal"), "HttpRequestTimeout");
        assert_eq!(variant_value("HTTP request timeout", "constant"), "HTTP_REQUEST_TIMEOUT");
        assert_eq!(variant_value("HTTPRequest", "pascal"), "HttpRequest");
        // 数字→大写算边界（数字黏在前一个词上）：`line2` | `Item`
        assert_eq!(variant_value("line2Item", "snake"), "line2_item");
        assert_eq!(variant_value("line2Item", "camel"), "line2Item");
        // 已有分隔符 / 标点 / 多余空白
        assert_eq!(variant_value("user_id", "camel"), "userId");
        assert_eq!(variant_value("  Hello,   world!  ", "snake"), "hello_world");
        // iPhone 这类内部大小写保留（只压首字母）
        assert_eq!(variant_value("iPhone app", "camel"), "iPhoneApp");
    }

    #[test]
    fn naming_variants_tolerate_cjk_and_empty() {
        assert_eq!(variant_value("用户 名字", "snake"), "用户_名字");
        assert_eq!(variant_value("用户 名字", "camel"), "用户名字");
        for variant in naming_variants("！！！") {
            assert_eq!(variant.value, "", "没有字母数字 ⇒ 全是空串，不是 panic");
        }
    }

    #[test]
    fn provider_options_match_provider_title() {
        assert_eq!(provider_title("youdao"), "有道");
        assert_eq!(provider_title("baidu"), "百度");
        assert_eq!(provider_title("baidu-llm"), "百度大模型");
        for (value, _) in PROVIDER_OPTIONS {
            assert!(!value.is_empty());
            assert_eq!(normalize_provider(Some(value)), value, "选项值必须能被 normalize 认下");
        }
    }
}
