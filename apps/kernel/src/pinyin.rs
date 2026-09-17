//! 拼音索引与匹配打分（v1 `apps/kernel/src/pinyin.ts` 的 Rust 版）。
//!
//! 词典从 `pinyin-pro`（JS）换成 rust-pinyin（m5 计划 §A1.2 / 风险 R1）。命中面与权重逐条照搬：
//! 标题前缀 1.0 / 包含 0.7 / 全拼 0.6 / 首字母 0.5 / 副标题与 keywords 0.4。
//!
//! **R1 的校准方式：多读音变体展开**（2026-09-17）。rust-pinyin 是逐字词典、没有词组消歧
//! （pinyin-pro 会把「双重」读成 `shuang chong`），只建首选读音时「重」只有 `zhong` ——
//! 用户输 `shuangchong` 就搜不到「双重验证码」。与其背一份词组词典，不如**把每个多音字的
//! 所有读音都展开成变体**（`ToPinyinMulti`）：搜索只需要「能搜到」，不需要判断哪个读音才对。
//! 变体是笛卡尔积，因此有封顶（`MAX_VARIANTS`），超出后只用首选读音。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use pinyin::ToPinyinMulti;

use crate::contract::MatchSpan;
use crate::util::text::normalize_query;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PinyinForms {
    pub full: String,
    pub first: String,
}

const CACHE_LIMIT: usize = 4000;
/// 单个字符最多展开的读音数（`还` 这类有 3+ 个读音，取前几个即可）
const MAX_READINGS_PER_CHAR: usize = 3;
/// 一条文本最多产出多少个变体（多音字笛卡尔积的封顶；超出后只用首选读音）
const MAX_VARIANTS: usize = 8;

fn cache() -> &'static Mutex<HashMap<String, Vec<PinyinForms>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<PinyinForms>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 一条文本的**全部读音变体**（全拼 + 首字母两级索引；带 4000 条缓存）。
///
/// 首个变体是「首选读音」那一支 —— 即逐字词典的默认读法（`build_pinyin` 取它）。
pub fn build_pinyin_variants(text: &str) -> Vec<PinyinForms> {
    if let Some(hit) = cache().lock().unwrap_or_else(|err| err.into_inner()).get(text) {
        return hit.clone();
    }
    let forms = compute_variants(text);
    let mut guard = cache().lock().unwrap_or_else(|err| err.into_inner());
    if guard.len() > CACHE_LIMIT {
        guard.clear();
    }
    guard.insert(text.to_string(), forms.clone());
    forms
}

/// 首选读音那一支（逐字词典默认读法）—— 只需要「一个」拼音时用它。
pub fn build_pinyin(text: &str) -> PinyinForms {
    build_pinyin_variants(text).into_iter().next().unwrap_or_default()
}

/// 单个字符的候选读音（非汉字只有一条：它自己）；去重 + 截断到 `MAX_READINGS_PER_CHAR`。
fn readings_of(ch: char) -> Vec<String> {
    let Some(multi) = ch.to_pinyin_multi() else { return vec![ch.to_string()] };
    let mut readings: Vec<String> = Vec::new();
    for pinyin in multi.into_iter() {
        let plain = pinyin.plain();
        if plain.is_empty() || readings.iter().any(|item| item == plain) {
            continue;
        }
        readings.push(plain.to_string());
        if readings.len() >= MAX_READINGS_PER_CHAR {
            break;
        }
    }
    if readings.is_empty() {
        vec![ch.to_string()]
    } else {
        readings
    }
}

fn extend(base: &PinyinForms, reading: &str) -> PinyinForms {
    let mut full = base.full.clone();
    full.push_str(reading);
    let mut first = base.first.clone();
    if let Some(head) = reading.chars().next() {
        first.push(head);
    }
    PinyinForms { full, first }
}

fn compute_variants(text: &str) -> Vec<PinyinForms> {
    let mut variants = vec![PinyinForms::default()];
    for ch in text.chars() {
        let readings = readings_of(ch);
        let primary = readings.first().cloned().unwrap_or_default();
        if variants.len() * readings.len() <= MAX_VARIANTS {
            let mut next = Vec::with_capacity(variants.len() * readings.len());
            for base in &variants {
                for reading in &readings {
                    next.push(extend(base, reading));
                }
            }
            variants = next;
        } else {
            // 封顶了：后面的多音字只按首选读音走，避免 2^n 爆炸
            for base in variants.iter_mut() {
                let next = extend(base, &primary);
                *base = next;
            }
        }
    }
    let mut seen: Vec<PinyinForms> = Vec::new();
    for mut forms in variants {
        forms.full = forms.full.to_lowercase();
        forms.first = forms.first.to_lowercase();
        if !seen.contains(&forms) {
            seen.push(forms);
        }
    }
    seen
}

#[derive(Debug, Clone, Default)]
pub struct SearchTarget {
    pub title: String,
    pub subtitle: Option<String>,
    pub keywords: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct MatchResult {
    /// 0–1；-1 表示不匹配（与 v1 一致的哨兵值）
    pub score: f64,
    pub span: Option<MatchSpan>,
}

pub const NO_MATCH: MatchResult = MatchResult { score: -1.0, span: None };

/// 匹配打分（requirements §7.5）。
pub fn match_target(query: &str, target: &SearchTarget) -> MatchResult {
    let q = normalize_query(query);
    if q.is_empty() {
        return MatchResult { score: 0.0, span: None };
    }

    let title = target.title.as_str();
    let lower_title = title.to_lowercase();
    if lower_title.starts_with(&q) {
        return MatchResult { score: 1.0, span: Some(MatchSpan { start: 0, length: q.len() }) };
    }
    if lower_title.contains(&q) {
        return MatchResult { score: 0.7, span: find_span(title, &q) };
    }

    let query_is_ascii = ascii_ratio(&q) > 0.6;
    if query_is_ascii {
        // 任一读音变体命中即算命中（多音字：`shuangchong` 与 `shuangzhong` 都能搜到「双重验证码」）
        let variants = build_pinyin_variants(title);
        if variants
            .iter()
            .any(|forms| forms.full.starts_with(&q) || forms.full.contains(&q))
        {
            return MatchResult { score: 0.6, span: None };
        }
        if variants
            .iter()
            .any(|forms| forms.first.starts_with(&q) || (q.len() >= 2 && forms.first.contains(&q)))
        {
            return MatchResult { score: 0.5, span: None };
        }
    }

    if let Some(subtitle) = target.subtitle.as_deref() {
        if !subtitle.is_empty() && subtitle.to_lowercase().contains(&q) {
            return MatchResult { score: 0.4, span: None };
        }
    }
    for keyword in &target.keywords {
        if keyword.is_empty() {
            continue;
        }
        if keyword.to_lowercase().contains(&q) {
            return MatchResult { score: 0.4, span: None };
        }
        if query_is_ascii {
            let hit = build_pinyin_variants(keyword)
                .iter()
                .any(|forms| forms.full.contains(&q) || forms.first.contains(&q));
            if hit {
                return MatchResult { score: 0.4, span: None };
            }
        }
    }

    NO_MATCH
}

/// 时间衰减：半衰 3 天。
pub fn recency_score(last_used_ms: i64, now_ms: i64) -> f64 {
    let delta_hours = ((now_ms - last_used_ms) as f64 / 3_600_000.0).max(0.0);
    (-delta_hours / 72.0).exp()
}

/// 频率：`min(1, log2(count + 1) / 5)`。
pub fn frequency_score(count: i64) -> f64 {
    ((count.max(0) as f64 + 1.0).log2() / 5.0).min(1.0)
}

/// 历史/固定项综合分（requirements §7.5）。
pub fn combined_score(match_score: f64, last_used_ms: i64, count: i64, now_ms: i64) -> f64 {
    0.55 * match_score + 0.3 * recency_score(last_used_ms, now_ms) + 0.15 * frequency_score(count)
}

/// 插件自评与内核评分的混合。
pub fn blend_plugin_score(plugin_score: Option<f64>, kernel_score: f64) -> f64 {
    let Some(plugin_score) = plugin_score else { return kernel_score };
    if plugin_score.is_nan() {
        return kernel_score;
    }
    let p = plugin_score.clamp(0.0, 1.0);
    let k = kernel_score.clamp(0.0, 1.0);
    0.6 * p + 0.4 * k
}

fn ascii_ratio(input: &str) -> f64 {
    if input.is_empty() {
        return 0.0;
    }
    let total = input.chars().count() as f64;
    let ascii = input.chars().filter(|ch| (*ch as u32) < 128).count() as f64;
    ascii / total
}

fn find_span(haystack: &str, needle: &str) -> Option<MatchSpan> {
    let lower_haystack = haystack.to_lowercase();
    let index = lower_haystack.find(needle)?;
    Some(MatchSpan { start: index, length: needle.len() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_full_and_first_forms() {
        let forms = build_pinyin("微信");
        assert_eq!(forms.full, "weixin");
        assert_eq!(forms.first, "wx");

        // 非中文原样保留（大小写归一到小写）
        let mixed = build_pinyin("微信WeChat");
        assert!(mixed.full.starts_with("weixin"), "full = {}", mixed.full);
        assert!(mixed.full.ends_with("wechat"), "full = {}", mixed.full);
        assert!(mixed.first.starts_with("wx"), "first = {}", mixed.first);
    }

    #[test]
    fn polyphone_readings_are_all_indexed() {
        // R1 校准（2026-09-17）：不做词组消歧，但每个多音字的所有读音都进索引。
        // 「重」在 rust-pinyin 里首选 `zhong`，词组里的 `chong` 靠变体补齐。
        let variants = build_pinyin_variants("双重验证码");
        let fulls = variants.iter().map(|forms| forms.full.as_str()).collect::<Vec<_>>();
        assert!(fulls.contains(&"shuangzhongyanzhengma"), "fulls = {fulls:?}");
        assert!(fulls.contains(&"shuangchongyanzhengma"), "fulls = {fulls:?}");

        let target = SearchTarget { title: "双重验证码".to_string(), ..Default::default() };
        assert_eq!(match_target("shuangchong", &target).score, 0.6, "词组读音之一（chong）");
        assert_eq!(match_target("shuangzhong", &target).score, 0.6, "首选读音（zhong）");
        assert_eq!(match_target("scyzm", &target).score, 0.5, "首字母变体（c）");
        assert_eq!(match_target("szyzm", &target).score, 0.5, "首字母首选读音（z）");
    }

    #[test]
    fn variant_expansion_is_capped() {
        // 每个字 2 个读音、4 个字 = 16 组合 ⇒ 必须封顶，不能 2^n 爆炸
        let variants = build_pinyin_variants("重行长乐");
        assert!(variants.len() <= MAX_VARIANTS, "变体数应当封顶：{}", variants.len());
        assert!(!variants.is_empty(), "封顶之后仍要有首选变体");
        // 首选那一支仍是「逐字词典默认读法」
        assert_eq!(build_pinyin("微信").full, "weixin");
        assert_eq!(build_pinyin("微信").first, "wx");
    }

    #[test]
    fn match_scores_follow_v1_weights() {
        let target = SearchTarget {
            title: "打开 Safari".to_string(),
            subtitle: Some("/Applications/Safari.app".to_string()),
            keywords: vec!["浏览器".to_string()],
        };
        assert_eq!(match_target("打开", &target).score, 1.0, "标题前缀");
        assert_eq!(match_target("safari", &target).score, 0.7, "标题包含");
        assert_eq!(match_target("app", &target).score, 0.4, "副标题");
        assert_eq!(match_target("浏览器", &target).score, 0.4, "keywords");
        assert_eq!(match_target("zzz", &target).score, -1.0, "不匹配");

        // 拼音（依赖词典）：全拼 / 首字母
        let zh = SearchTarget { title: "微信".to_string(), ..Default::default() };
        assert_eq!(match_target("weixin", &zh).score, 0.6, "全拼");
        assert_eq!(match_target("wx", &zh).score, 0.5, "首字母");
    }

    #[test]
    fn scores_and_blend_match_v1_formulas() {
        let now = 1_700_000_000_000i64;
        assert!((recency_score(now, now) - 1.0).abs() < 1e-9);
        assert!((recency_score(now - 72 * 3_600_000, now) - (-1.0f64).exp()).abs() < 1e-9, "半衰 3 天");
        assert!((frequency_score(0) - 0.0).abs() < 1e-9);
        assert!((frequency_score(31) - 1.0).abs() < 1e-9, "log2(32)/5 = 1");

        let score = combined_score(1.0, now, 0, now);
        assert!((score - (0.55 + 0.3)).abs() < 1e-9);

        assert!((blend_plugin_score(Some(1.0), 0.0) - 0.6).abs() < 1e-9);
        assert!((blend_plugin_score(None, 0.42) - 0.42).abs() < 1e-9);
        assert!((blend_plugin_score(Some(f64::NAN), 0.42) - 0.42).abs() < 1e-9);
    }
}
