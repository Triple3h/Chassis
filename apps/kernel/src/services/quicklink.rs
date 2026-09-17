//! 快捷链接（宿主级共享数据，插件经 `ctx.quicklink.*` 增删改查；v1 `services/quicklink.ts`）。
//!
//! 落盘 `quicklinks.json`：懒加载 + 原子写。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use uuid::Uuid;

use crate::audit::AuditLog;
use crate::error::{KernelError, Result};
use crate::services::audited;
use crate::types::Quicklink;
use crate::util::fsx::{read_json, write_json_atomic};

pub struct QuicklinkStore {
    file: PathBuf,
    audit: Arc<AuditLog>,
    items: Mutex<Option<Vec<Quicklink>>>,
}

impl QuicklinkStore {
    pub fn new(data_root: &Path, audit: Arc<AuditLog>) -> Self {
        Self { file: data_root.join("quicklinks.json"), audit, items: Mutex::new(None) }
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    pub fn load(&self) -> Vec<Quicklink> {
        let mut guard = self.items.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(items) = guard.as_ref() {
            return items.clone();
        }
        let raw = read_json::<Value>(&self.file, Value::Object(Default::default()));
        let items: Vec<Quicklink> = raw
            .get("items")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter(|item| item.get("url").and_then(Value::as_str).is_some())
                    .filter_map(|item| serde_json::from_value::<Quicklink>(item.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();
        *guard = Some(items.clone());
        items
    }

    pub async fn all(&self, plugin_id: &str) -> Result<Vec<Quicklink>> {
        audited(&self.audit, plugin_id, "ui", "ctx.quicklink.all", "quicklink", None, async {
            Ok(self.load())
        })
        .await
    }

    pub async fn add(&self, plugin_id: &str, link: &Value) -> Result<Quicklink> {
        audited(&self.audit, plugin_id, "ui", "ctx.quicklink.add", "quicklink", Some(link.clone()), async {
            let url = link.get("url").and_then(Value::as_str).unwrap_or_default();
            if url.is_empty() {
                return Err(KernelError::bad_args("url 必填"));
            }
            let name = link.get("name").and_then(Value::as_str).filter(|value| !value.is_empty()).unwrap_or(url);
            let item = Quicklink {
                id: Uuid::new_v4().to_string(),
                name: name.to_string(),
                url: url.to_string(),
                icon: link.get("icon").and_then(Value::as_str).map(str::to_string),
            };
            let mut items = self.load();
            items.push(item.clone());
            self.persist(items);
            Ok(item)
        })
        .await
    }

    pub async fn edit(&self, plugin_id: &str, id: &str, patch: &Value) -> Result<()> {
        audited(
            &self.audit,
            plugin_id,
            "ui",
            "ctx.quicklink.edit",
            "quicklink",
            Some(serde_json::json!({ "id": id, "patch": patch })),
            async {
                let mut items = self.load();
                let Some(existing) = items.iter_mut().find(|item| item.id == id) else {
                    return Err(KernelError::not_found(format!("快捷链接不存在：{id}")));
                };
                if let Some(name) = patch.get("name").and_then(Value::as_str) {
                    existing.name = name.to_string();
                }
                if let Some(url) = patch.get("url").and_then(Value::as_str) {
                    existing.url = url.to_string();
                }
                if let Some(icon) = patch.get("icon") {
                    existing.icon = icon.as_str().map(str::to_string);
                }
                self.persist(items);
                Ok(())
            },
        )
        .await
    }

    pub async fn remove(&self, plugin_id: &str, id: &str) -> Result<()> {
        audited(
            &self.audit,
            plugin_id,
            "ui",
            "ctx.quicklink.remove",
            "quicklink",
            Some(serde_json::json!({ "id": id })),
            async {
                let mut items = self.load();
                items.retain(|item| item.id != id);
                self.persist(items);
                Ok(())
            },
        )
        .await
    }

    fn persist(&self, items: Vec<Quicklink>) {
        *self.items.lock().unwrap_or_else(|err| err.into_inner()) = Some(items.clone());
        let payload = serde_json::json!({ "version": 1, "items": items });
        let _ = write_json_atomic(&self.file, &payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn crud_round_trip() {
        let dir = std::env::temp_dir().join(format!("quicklink-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = QuicklinkStore::new(&dir, Arc::new(AuditLog::new(&dir)));

        let added = store.add("demo", &json!({ "url": "https://example.com" })).await.unwrap();
        assert_eq!(added.name, "https://example.com", "没给 name 时回落 url");
        store.add("demo", &json!({ "url": "https://b.com", "name": "B" })).await.unwrap();
        assert_eq!(store.all("demo").await.unwrap().len(), 2);

        store.edit("demo", &added.id, &json!({ "name": "改名" })).await.unwrap();
        assert_eq!(store.load()[0].name, "改名");

        let err = store.edit("demo", "missing", &json!({})).await.unwrap_err();
        assert_eq!(err.code, "NOT_FOUND");
        let err = store.add("demo", &json!({ "name": "无 url" })).await.unwrap_err();
        assert_eq!(err.code, "BAD_ARGS");

        store.remove("demo", &added.id).await.unwrap();
        assert_eq!(store.all("demo").await.unwrap().len(), 1);

        // 落盘后重新加载
        let reloaded = QuicklinkStore::new(&dir, Arc::new(AuditLog::new(&dir)));
        assert_eq!(reloaded.load().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
