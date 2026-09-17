//! 插件私有 KV：`<dataRoot>/plugins/<pluginId>/storage.json`（P7：数据与代码分离）。
//!
//! 写入 debounce（200ms 合并）+ 原子写；**view 桥与逻辑层 RPC 共用 `call` 这一处转发**。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Map, Value};

use crate::audit::AuditLog;
use crate::error::{KernelError, Result};
use crate::services::audited;
use crate::util::fsx::{plugin_data_path, read_json, write_json_atomic};

pub struct PluginStorage {
    data_root: PathBuf,
    audit: Arc<AuditLog>,
    cache: Mutex<HashMap<String, Map<String, Value>>>,
    dirty: Mutex<HashSet<String>>,
}

impl PluginStorage {
    pub fn new(data_root: &Path, audit: Arc<AuditLog>) -> Self {
        Self {
            data_root: data_root.to_path_buf(),
            audit,
            cache: Mutex::new(HashMap::new()),
            dirty: Mutex::new(HashSet::new()),
        }
    }

    pub fn plugin_dir(&self, plugin_id: &str) -> PathBuf {
        plugin_data_path(&self.data_root, plugin_id)
    }

    pub fn file_for(&self, plugin_id: &str) -> PathBuf {
        self.plugin_dir(plugin_id).join("storage.json")
    }

    /// 方法名 → 服务调用（`get` / `set` / `remove` / `all` / `clear`）。
    ///
    /// 参数语义与 v1 一致：`set` / `remove` / `clear` 返回 `null`。
    pub async fn call(&self, plugin_id: &str, channel: &'static str, method: &str, params: &Value) -> Result<Value> {
        match method {
            "get" => {
                let key = string_param(params, "key");
                audited(&self.audit, plugin_id, channel, "ctx.storage.get", "storage", Some(json_args(params)), async {
                    let data = self.load(plugin_id).await;
                    Ok(data.get(&key).cloned().unwrap_or(Value::Null))
                })
                .await
            }
            "set" => {
                let key = string_param(params, "key");
                let value = params.get("value").cloned().unwrap_or(Value::Null);
                let args = json_args(params);
                audited(&self.audit, plugin_id, channel, "ctx.storage.set", "storage", Some(args), async {
                    if key.is_empty() {
                        return Err(KernelError::bad_args("key 必须是非空字符串"));
                    }
                    let mut data = self.load(plugin_id).await;
                    data.insert(key, value);
                    self.store_cache(plugin_id, &data);
                    self.schedule(plugin_id);
                    Ok(Value::Null)
                })
                .await
            }
            "remove" => {
                let key = string_param(params, "key");
                audited(&self.audit, plugin_id, channel, "ctx.storage.remove", "storage", Some(json_args(params)), async {
                    let mut data = self.load(plugin_id).await;
                    data.remove(&key);
                    self.store_cache(plugin_id, &data);
                    self.schedule(plugin_id);
                    Ok(Value::Null)
                })
                .await
            }
            "all" => {
                audited(&self.audit, plugin_id, channel, "ctx.storage.all", "storage", None, async {
                    Ok(Value::Object(self.load(plugin_id).await))
                })
                .await
            }
            "clear" => {
                audited(&self.audit, plugin_id, channel, "ctx.storage.clear", "storage", None, async {
                    self.cache.lock().unwrap_or_else(|err| err.into_inner()).insert(plugin_id.to_string(), Map::new());
                    self.schedule(plugin_id);
                    Ok(Value::Null)
                })
                .await
            }
            other => Err(KernelError::not_found(format!("未知 storage 方法：{other}"))),
        }
    }

    /// 立即落盘全部脏插件（退出前 / 测试用）。
    pub fn flush_all(&self) {
        let dirty: Vec<String> = self.dirty.lock().unwrap_or_else(|err| err.into_inner()).drain().collect();
        for plugin_id in dirty {
            self.flush(&plugin_id);
        }
    }

    /// 后台落盘循环（200ms 合并窗口，与 v1 的 debounce 等价）。
    pub async fn flush_loop(self: Arc<Self>) {
        let mut ticker = tokio::time::interval(Duration::from_millis(200));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            self.flush_all();
        }
    }

    fn schedule(&self, plugin_id: &str) {
        self.dirty.lock().unwrap_or_else(|err| err.into_inner()).insert(plugin_id.to_string());
    }

    /// `load` 返回的是克隆 —— 改动后必须显式写回缓存（v1 是就地改缓存对象）。
    fn store_cache(&self, plugin_id: &str, data: &Map<String, Value>) {
        self.cache
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(plugin_id.to_string(), data.clone());
    }

    fn flush(&self, plugin_id: &str) {
        let data = self.cache.lock().unwrap_or_else(|err| err.into_inner()).get(plugin_id).cloned();
        let Some(data) = data else { return };
        if write_json_atomic(&self.file_for(plugin_id), &Value::Object(data)).is_err() {
            // 写失败重新置脏，下一轮再试（不能静默丢用户数据）
            self.schedule(plugin_id);
        }
    }

    async fn load(&self, plugin_id: &str) -> Map<String, Value> {
        if let Some(cached) = self.cache.lock().unwrap_or_else(|err| err.into_inner()).get(plugin_id) {
            return cached.clone();
        }
        let raw = read_json::<Value>(&self.file_for(plugin_id), Value::Object(Map::new()));
        let data = match raw {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        self.cache
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(plugin_id.to_string(), data.clone());
        data
    }
}

fn string_param(params: &Value, key: &str) -> String {
    params.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn json_args(params: &Value) -> Value {
    params.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn storage(dir: &Path) -> PluginStorage {
        PluginStorage::new(dir, Arc::new(AuditLog::new(dir)))
    }

    #[tokio::test]
    async fn kv_round_trip_and_persist() {
        let dir = std::env::temp_dir().join(format!("storage-svc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = storage(&dir);

        assert_eq!(store.call("demo", "ui", "get", &json!({ "key": "missing" })).await.unwrap(), Value::Null);
        store.call("demo", "ui", "set", &json!({ "key": "k", "value": { "n": 1 } })).await.unwrap();
        assert_eq!(store.call("demo", "ui", "get", &json!({ "key": "k" })).await.unwrap()["n"], 1);

        let all = store.call("demo", "ui", "all", &json!({})).await.unwrap();
        assert_eq!(all["k"]["n"], 1);

        store.flush_all();
        let reloaded = storage(&dir);
        assert_eq!(reloaded.call("demo", "ui", "get", &json!({ "key": "k" })).await.unwrap()["n"], 1);

        store.call("demo", "ui", "remove", &json!({ "key": "k" })).await.unwrap();
        store.call("demo", "ui", "clear", &json!({})).await.unwrap();
        assert_eq!(store.call("demo", "script", "all", &json!({})).await.unwrap(), json!({}));

        let err = store.call("demo", "ui", "set", &json!({ "key": "", "value": 1 })).await.unwrap_err();
        assert_eq!(err.code, "BAD_ARGS");
        let err = store.call("demo", "ui", "nope", &json!({})).await.unwrap_err();
        assert_eq!(err.code, "NOT_FOUND");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn calls_are_audited() {
        let dir = std::env::temp_dir().join(format!("storage-audit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let audit = Arc::new(AuditLog::new(&dir));
        audit.init();
        let store = PluginStorage::new(&dir, audit.clone());
        store.call("demo", "script", "set", &json!({ "key": "token", "value": "secret" })).await.unwrap();
        let records = audit.query(Some("demo"), Some("ctx.storage.set"), None, 10);
        assert_eq!(records.len(), 1);
        assert!(records[0].ok);
        assert_eq!(records[0].channel, "script");
        assert_eq!(records[0].capability, "storage");
        assert!(records[0].truncated_args.as_deref().unwrap_or_default().contains("***"), "参数里的敏感键要打码");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
