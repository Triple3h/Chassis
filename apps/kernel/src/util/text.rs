//! 文本工具（对齐 v1 `util/text.ts`）：稳定序列化 / 稳定 key / 审计截断与打码。

use serde_json::Value;
use sha1::{Digest, Sha1};

/// 稳定 JSON 序列化（键排序）—— `args → 稳定 key` 的输入。
pub fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Array(items) => {
            format!("[{}]", items.iter().map(stable_stringify).collect::<Vec<_>>().join(","))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let body = keys
                .iter()
                .map(|key| {
                    let key_json = serde_json::to_string(key.as_str()).unwrap_or_default();
                    format!("{key_json}:{}", stable_stringify(&map[key.as_str()]))
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
        Value::String(text) => serde_json::to_string(text).unwrap_or_default(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "null".to_string()),
    }
}

/// sha1 前 `len` 位十六进制（与 v1 `shortHash` 一致：8 位）。
pub fn short_hash(input: &str, len: usize) -> String {
    let mut hasher = Sha1::new();
    hasher.update(input.as_bytes());
    let hex = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    hex.chars().take(len).collect()
}

/// 历史 / 固定的稳定 key（绝不使用下标）。
pub fn item_key(plugin_id: &str, command: &str, args: Option<&Value>) -> String {
    let payload = args.cloned().unwrap_or(Value::Null);
    format!("{plugin_id}:{command}:{}", short_hash(&stable_stringify(&payload), 8))
}

const SENSITIVE_KEYS: [&str; 10] =
    ["token", "key", "secret", "password", "passwd", "pwd", "authorization", "credential", "otp", "totp"];

/// 审计用：截断到 `limit` 字符（默认 200），敏感字段打码。
pub fn truncate_for_audit(value: &Value, limit: usize) -> String {
    let masked = mask_sensitive(value, 0);
    let text = match &masked {
        Value::String(text) => text.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    };
    if text.chars().count() > limit {
        format!("{}…", text.chars().take(limit).collect::<String>())
    } else {
        text
    }
}

/// 搜索归一化：小写 + 去首尾空白。
pub fn normalize_query(input: &str) -> String {
    input.trim().to_lowercase()
}

fn is_sensitive_key(key: &str) -> bool {
    let lower = key.to_lowercase();
    SENSITIVE_KEYS.iter().any(|needle| lower.contains(needle))
}

fn mask_sensitive(value: &Value, depth: usize) -> Value {
    if depth > 4 {
        return Value::String("…".to_string());
    }
    match value {
        Value::Array(items) => {
            Value::Array(items.iter().take(20).map(|item| mask_sensitive(item, depth + 1)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| {
                    let masked = if is_sensitive_key(key) {
                        Value::String("***".to_string())
                    } else {
                        mask_sensitive(item, depth + 1)
                    };
                    (key.clone(), masked)
                })
                .collect(),
        ),
        Value::String(text) if text.chars().count() > 120 => {
            Value::String(format!("{}…", text.chars().take(120).collect::<String>()))
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stable_stringify_sorts_object_keys() {
        let a = stable_stringify(&json!({ "b": 1, "a": [2, { "z": 1, "y": 2 }] }));
        let b = stable_stringify(&json!({ "a": [2, { "y": 2, "z": 1 }], "b": 1 }));
        assert_eq!(a, b);
        assert_eq!(a, r#"{"a":[2,{"y":2,"z":1}],"b":1}"#);
    }

    #[test]
    fn item_key_prefix_matches_v1_format() {
        let key = item_key("app-launcher", "open", Some(&json!({ "n": 21 })));
        assert!(key.starts_with("app-launcher:open:"));
        assert_eq!(key.split(':').count(), 3);
        assert_eq!(key.rsplit(':').next().unwrap().len(), 8);
    }

    #[test]
    fn short_hash_is_stable_sha1_prefix() {
        // sha1("") = da39a3ee5e6b4b0d3255bfef95601890afd80709
        assert_eq!(short_hash("", 8), "da39a3ee");
    }

    #[test]
    fn truncate_masks_sensitive_keys_and_limits_length() {
        let masked = truncate_for_audit(&json!({ "token": "abc", "path": "/tmp/x" }), 200);
        assert!(masked.contains("\"***\""));
        assert!(!masked.contains("abc"));

        // 字符串在 mask 阶段就截到 120 + 省略号（与 v1 `maskSensitive` 一致）
        let long = truncate_for_audit(&json!("x".repeat(500)), 200);
        assert_eq!(long.chars().count(), 121);

        // 结构化的长对象走 truncate_for_audit 的 200 上限（足够多的小键才能超过 200 字符）
        let many: serde_json::Map<String, Value> =
            (0..100).map(|index| (format!("key{index:03}"), json!(index))).collect();
        let wide = truncate_for_audit(&Value::Object(many), 200);
        assert_eq!(wide.chars().count(), 201, "200 字符 + 省略号");
    }
}
