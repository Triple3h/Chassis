//! 共享契约类型（v1 `packages/plugin-manifest/src/contract.ts` 的 serde 版本）。
//!
//! 说明：`action` / `actions` 保持为原始 `Value` —— 内核**不解释**动作声明（只透传给 UI 与历史快照），
//! 保持与 v1 一致的宽容度（形状不认识也不会让整条结果丢掉）。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 结果项（插件 → 宿主；见 plugin-spec §9.3）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultItem {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    pub action: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// 展示快照（历史 / 固定项共用）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSnapshot {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<Value>,
}

/// §7.5：能力无关的历史项。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    #[serde(flatten)]
    pub snapshot: ItemSnapshot,
    pub key: String,
    pub plugin_id: String,
    pub command: String,
    pub last_used: i64,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedItem {
    #[serde(flatten)]
    pub snapshot: ItemSnapshot,
    pub key: String,
    pub plugin_id: String,
    pub command: String,
    pub order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorShape {
    pub code: String,
    pub message: String,
}

/// 审计记录（requirements §7.7 / P6）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditRecord {
    pub ts: i64,
    pub plugin_id: String,
    /// `ui` | `script` | `kernel`
    pub channel: String,
    pub method: String,
    pub ok: bool,
    pub ms: i64,
    pub capability: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorShape>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated_args: Option<String>,
}

/// 命令执行结果（requirements §7.3）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    /// `view` | `script` | `open` | `copy` | `host`
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorShape>,
    /// 执行后是否隐藏启动台；默认：view=隐藏，script=保持可见并展示进度
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hide_launcher: Option<bool>,
}

impl ActionResult {
    pub fn ok(kind: &str) -> Self {
        Self { ok: true, kind: kind.to_string(), data: None, error: None, hide_launcher: None }
    }

    pub fn with_data(kind: &str, data: Value) -> Self {
        Self { ok: true, kind: kind.to_string(), data: Some(data), error: None, hide_launcher: None }
    }

    pub fn failure(kind: &str, code: &str, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            kind: kind.to_string(),
            data: None,
            error: Some(ErrorShape { code: code.to_string(), message: message.into() }),
            hide_launcher: None,
        }
    }
}

/// 命中高亮用的下标（由内核算好，UI 直接渲染）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatchSpan {
    pub start: usize,
    pub length: usize,
}

/// 带出处的结果项（内核合并后交给 UI）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedResult {
    pub plugin_id: String,
    pub plugin_title: String,
    pub command: String,
    pub item: ResultItem,
    pub item_key: String,
    pub score: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_match: Option<MatchSpan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_history: Option<bool>,
    /// 插件已卸载 / 命令不存在 → 置灰
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale: Option<bool>,
}

/// 宽容校验（读盘时过滤脏条目，与 v1 `isHistoryItem` / `isPinnedItem` 一致）。
pub fn is_history_item(value: &Value) -> bool {
    let str_at = |key: &str| value.get(key).and_then(Value::as_str);
    str_at("key").is_some() && str_at("pluginId").is_some() && str_at("command").is_some() && str_at("title").is_some()
}

pub fn is_pinned_item(value: &Value) -> bool {
    is_history_item(value) && value.get("order").and_then(Value::as_i64).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn history_item_round_trips_with_flattened_snapshot() {
        let item = HistoryItem {
            snapshot: ItemSnapshot {
                title: "打开 Safari".to_string(),
                subtitle: Some("/Applications/Safari.app".to_string()),
                icon: None,
                args: Some(json!({ "path": "/Applications/Safari.app" })),
                action: Some(json!({ "type": "open", "target": "/Applications/Safari.app" })),
            },
            key: "app-launcher:open:abcd1234".to_string(),
            plugin_id: "app-launcher".to_string(),
            command: "open".to_string(),
            last_used: 1_700_000_000_000,
            count: 3,
        };
        let text = serde_json::to_string(&item).unwrap();
        assert!(text.contains("\"lastUsed\":1700000000000"));
        assert!(text.contains("\"title\":\"打开 Safari\""));
        let back: HistoryItem = serde_json::from_str(&text).unwrap();
        assert_eq!(back.key, item.key);
        assert_eq!(back.snapshot.title, "打开 Safari");
    }

    #[test]
    fn validators_reject_dirty_items() {
        assert!(is_history_item(&json!({ "key": "k", "pluginId": "p", "command": "c", "title": "t" })));
        assert!(!is_history_item(&json!({ "key": "k", "pluginId": "p", "command": "c" })));
        assert!(is_pinned_item(&json!({ "key": "k", "pluginId": "p", "command": "c", "title": "t", "order": 0 })));
        assert!(!is_pinned_item(&json!({ "key": "k", "pluginId": "p", "command": "c", "title": "t" })));
    }
}
