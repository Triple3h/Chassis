//! 输入解析（v1 `src/core/parse.ts` 的 Rust 版，逐条对齐）。
//!
//! 视图层仍用 TS 那份（它是 Web）；这里是为逻辑层写的第二份实现 ——
//! **两版一致性由测试向量守护**（`test/parse.test.ts` 的用例逐条搬到这里）。

pub struct Engine {
    pub id: &'static str,
    pub name: &'static str,
    pub template: &'static str,
}

/// 可选引擎；清单 `settings` 的 options 与这里一一对应（改一处要改两处）。
/// 结果项图标由 `main.rs` 按「直达 / 搜索」给（`globe` / `search`），不在这里声明。
pub const ENGINES: [Engine; 4] = [
    Engine { id: "google", name: "Google", template: "https://www.google.com/search?q={q}" },
    Engine { id: "bing", name: "Bing", template: "https://www.bing.com/search?q={q}" },
    Engine { id: "baidu", name: "百度", template: "https://www.baidu.com/s?wd={q}" },
    Engine { id: "github", name: "GitHub", template: "https://github.com/search?q={q}" },
];

/// 设置里的引擎 id → 引擎；认不出来就回落第一个（用户配置异常也不至于没有搜索入口）
pub fn resolve_engine(id: Option<&str>) -> &'static Engine {
    match id {
        Some(text) => ENGINES.iter().find(|engine| engine.id == text).unwrap_or(&ENGINES[0]),
        None => &ENGINES[0],
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct UrlHit {
    pub url: String,
    pub label: String,
    pub kind: &'static str,
    pub engine: Option<&'static str>,
    pub score: f64,
}

pub fn normalize_user_url(input: &str) -> Option<String> {
    let raw = input.trim();
    if raw.is_empty() {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Some(raw.to_string());
    }
    if lower.starts_with("mailto:") {
        return Some(raw.to_string());
    }
    if looks_like_host(raw) {
        return Some(format!("https://{raw}"));
    }
    None
}

/// 解析输入：能当网址就直接打开，否则给**一条**默认引擎的搜索项。
///
/// 只出一条是刻意的：四个引擎全出时，「最佳匹配」整个分区都是同一个查询串，
/// 真正命中的命令反而被挤到后面。引擎在设置里换（`ctx.settings.engine`）。
pub fn parse_query(input: &str, engine: &Engine) -> Vec<UrlHit> {
    let raw = input.trim();
    if raw.is_empty() {
        return Vec::new();
    }
    if let Some(direct) = normalize_user_url(raw) {
        let label = format!("打开 {}", strip_http_scheme(&direct));
        return vec![UrlHit { url: direct, label, kind: "url", engine: None, score: 1.0 }];
    }
    vec![UrlHit {
        url: engine.template.replace("{q}", &encode_uri_component(raw)),
        label: format!("用 {} 搜索「{raw}」", engine.name),
        kind: "search",
        engine: Some(engine.id),
        score: 0.8,
    }]
}

// ── 主机名判定（v1 的三条正则的等价实现）────────────────────────
// 手写而不是引 `regex`：产物更小，且这三条规则的形态很固定。

fn looks_like_host(raw: &str) -> bool {
    let host_port = split_rest(raw).0;
    is_domain(host_port) || is_localhost(host_port) || is_ipv4(host_port)
}

/// 切掉 `[/?#]` 之后的部分（与 v1 正则里的 `(?:[/?#].*)?$` 对应）。
fn split_rest(raw: &str) -> (&str, &str) {
    match raw.find(['/', '?', '#']) {
        Some(index) => (&raw[..index], &raw[index..]),
        None => (raw, ""),
    }
}

/// 拆端口：`host:1234` → (`host`, true)。冒号后不是纯数字 → 不匹配（与 `(?::\d+)?` 一致）。
fn strip_port(host_port: &str) -> (&str, bool) {
    match host_port.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()) => (host, true),
        Some(_) => (host_port, false),
        None => (host_port, true),
    }
}

/// `^(?:[a-z0-9-]+\.)+[a-z]{2,}`：段 ≥2、每段只含 [a-z0-9-]、末段 ≥2 个字母。
fn is_domain(host_port: &str) -> bool {
    let (host, ok) = strip_port(host_port);
    if !ok || host.is_empty() {
        return false;
    }
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() < 2 {
        return false;
    }
    if !parts.iter().all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-')) {
        return false;
    }
    let last = parts[parts.len() - 1];
    last.len() >= 2 && last.chars().all(|ch| ch.is_ascii_alphabetic())
}

fn is_localhost(host_port: &str) -> bool {
    let (host, ok) = strip_port(host_port);
    ok && host.eq_ignore_ascii_case("localhost")
}

/// `^\d{1,3}(?:\.\d{1,3}){3}`：不校验 ≤255（与 v1 一致）。
fn is_ipv4(host_port: &str) -> bool {
    let (host, ok) = strip_port(host_port);
    if !ok {
        return false;
    }
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|part| (1..=3).contains(&part.len()) && part.chars().all(|ch| ch.is_ascii_digit()))
}

/// `direct.replace(/^https?:\/\//, '')` —— 只去小写的 http/https 前缀（v1 正则没有 `i`）。
fn strip_http_scheme(url: &str) -> &str {
    url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")).unwrap_or(url)
}

/// `encodeURIComponent` 的等价实现（未保留字符集必须逐字符一致，否则结果项里的 URL 会不一样）。
pub fn encode_uri_component(value: &str) -> String {
    const UNRESERVED: &[u8] = b"-_.!~*'()";
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || UNRESERVED.contains(byte) {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // 以下用例与 `test/parse.test.ts` 一一对应（v1 ↔ v2 行为守护）
    #[test]
    fn direct_urls_get_https_prefix() {
        assert_eq!(normalize_user_url("example.com").as_deref(), Some("https://example.com"));
        assert_eq!(normalize_user_url("localhost:5173/x").as_deref(), Some("https://localhost:5173/x"));
        assert_eq!(normalize_user_url("127.0.0.1:8080").as_deref(), Some("https://127.0.0.1:8080"));
        assert_eq!(normalize_user_url("https://a.example.com/b?c=1").as_deref(), Some("https://a.example.com/b?c=1"));
        assert_eq!(normalize_user_url("mailto:a@b.com").as_deref(), Some("mailto:a@b.com"));
        assert_eq!(normalize_user_url("hello world"), None);
    }

    #[test]
    fn keywords_yield_single_search_hit() {
        let hits = parse_query("dee", resolve_engine(Some("google")));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "search");
        assert_eq!(hits[0].engine, Some("google"));
        assert_eq!(hits[0].url, "https://www.google.com/search?q=dee");
        assert_eq!(hits[0].label, "用 Google 搜索「dee」");
    }

    #[test]
    fn engine_setting_changes_template_and_label() {
        let hits = parse_query("dee", resolve_engine(Some("baidu")));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://www.baidu.com/s?wd=dee");
        assert_eq!(hits[0].label, "用 百度 搜索「dee」");
    }

    #[test]
    fn unknown_engine_falls_back_to_first() {
        assert_eq!(resolve_engine(Some("nope")).id, ENGINES[0].id);
        assert_eq!(resolve_engine(None).id, ENGINES[0].id);
    }

    #[test]
    fn query_is_encoded_and_blank_yields_nothing() {
        let hits = parse_query("c++ & rust", resolve_engine(Some("bing")));
        assert_eq!(hits[0].url, "https://www.bing.com/search?q=c%2B%2B%20%26%20rust");
        assert_eq!(parse_query("   ", resolve_engine(Some("google"))).len(), 0);
    }

    #[test]
    fn url_and_keyword_are_mutually_exclusive() {
        let hits = parse_query("example.com", resolve_engine(Some("google")));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "url");
        assert_eq!(hits[0].url, "https://example.com");
        assert_eq!(hits[0].label, "打开 example.com");
    }

    #[test]
    fn host_heuristics_match_v1_regexes() {
        // 域名的边界：段不能空、末段必须 ≥2 个字母
        assert!(normalize_user_url("a.b.co").is_some());
        assert_eq!(normalize_user_url("a.c"), None);
        assert_eq!(normalize_user_url("example.com:abc"), None, "冒号后不是数字 → 整体不匹配");
        assert_eq!(normalize_user_url("foo..com"), None, "空段不匹配");
        // IP：四段 1–3 位数字（不校验 ≤255）
        assert!(normalize_user_url("999.1.1.1").is_some());
        assert_eq!(normalize_user_url("1.2.3"), None);
        assert_eq!(normalize_user_url("1.2.3.4.5"), None);
        // localhost 大小写不敏感
        assert!(normalize_user_url("LOCALHOST:3000").is_some());
    }
}
