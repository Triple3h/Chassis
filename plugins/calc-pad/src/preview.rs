//! 结果项构造：一次输入 → 至多一条「算式 = 结果」推荐项（没有就是静默）。

use serde_json::{json, Value};

use crate::eval::{evaluate, format_number, looks_like_expression};

/// 回车 = 打开计算稿纸继续算（算式交给 view 侧从搜索框内容取，见下）；
/// ⇧回车 = 复制结果（`actions[0]`）。
///
/// title 用「算式 = 结果」而不是只给结果：算式排在最前，内核按前缀命中打 1.0 分，
/// 加上这里的自评 1.0，混合分 1.0 —— 稳过「用 XX 搜索」那条（0.76）。
///
/// 动作**刻意不带 `args`**：带 `{seed}` 会让内核按 args 哈希出不同的历史 key，
/// 每算一个算式就在「最近使用」里多一条「计算稿纸」（标题还都一样，分不出是哪条）；
/// 不带则复用同一条历史，而主路径的算式由搜索框内容兜住（打开稿纸时它还在）。
pub fn preview(query: &str) -> Option<Value> {
    let text = query.trim();
    if !looks_like_expression(text) {
        return None;
    }
    let value = evaluate(text).ok()?;
    let result = format_number(value);
    Some(json!({
        "id": format!("calc:{text}"),
        "title": format!("{text} = {result}"),
        "subtitle": "回车打开计算稿纸继续算 · ⇧回车复制结果",
        "icon": "calculator",
        "score": 1.0,
        "action": { "type": "command", "command": "calc-pad" },
        // 复制的是能再解析的纯数字（去掉千分位）
        "actions": [{ "type": "copy", "text": result.replace(',', "") }],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_recommendation() {
        let item = preview("10+22").expect("应给出推荐");
        assert_eq!(item["id"], "calc:10+22");
        assert_eq!(item["title"], "10+22 = 32");
        assert_eq!(item["subtitle"], "回车打开计算稿纸继续算 · ⇧回车复制结果");
        assert_eq!(item["icon"], "calculator");
        assert_eq!(item["score"], 1.0);
        assert_eq!(item["action"]["type"], "command");
        assert_eq!(item["action"]["command"], "calc-pad");
        assert!(
            item["action"].get("args").is_none(),
            "带 args 会让历史里每算一个算式就多一条「计算稿纸」"
        );
        assert_eq!(item["actions"][0]["type"], "copy");
        assert_eq!(item["actions"][0]["text"], "32");
    }

    #[test]
    fn is_silent_for_noise() {
        for input in [
            "微信",
            "safari",
            "1password",
            "3d",
            "2024-01-01",
            "1.2.3",
            "42",
            "10+",
            "1/0",
            "x = 5",
            "e",
            "  ",
        ] {
            assert!(preview(input).is_none(), "{input} 不该给出推荐");
        }
    }

    #[test]
    fn strips_thousands_in_copy_payload() {
        let item = preview("1000000+1").expect("应给出推荐");
        assert_eq!(item["title"], "1000000+1 = 1,000,001");
        assert_eq!(item["actions"][0]["text"], "1000001", "复制回去要能再解析");
    }

    #[test]
    fn keeps_user_spacing_and_odd_symbols() {
        let item = preview("10 + 22").expect("应给出推荐");
        assert_eq!(item["title"], "10 + 22 = 32");
        assert_eq!(item["id"], "calc:10 + 22");
    }
}
