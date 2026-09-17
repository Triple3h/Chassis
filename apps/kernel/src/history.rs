//! 最近使用 + 已固定（对齐 v1 `apps/kernel/src/history.ts`；requirements §7.5）。
//!
//! 落盘策略：`schedule()` 只标脏，`flush_loop()`（内核启动的后台任务）每 500ms 检查一次并落盘；
//! 退出 / 换包前调用 `flush()` 强制写一次。schema 能力无关（不出现任何「应用 / 文件」概念）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::contract::{is_history_item, is_pinned_item, HistoryItem, ItemSnapshot, PinnedItem};
use crate::util::fsx::{read_json, write_json_atomic};
use crate::util::now_ms;

const FILE_VERSION: i64 = 1;

#[derive(Debug, Serialize, Deserialize)]
struct HistoryFile {
    version: i64,
    items: Vec<HistoryItem>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PinnedFile {
    version: i64,
    items: Vec<PinnedItem>,
}

/// `record()` 的入参（除 lastUsed / count 外的字段）。
#[derive(Debug, Clone)]
pub struct HistoryEntry {
    pub key: String,
    pub plugin_id: String,
    pub command: String,
    pub snapshot: ItemSnapshot,
}

#[derive(Debug, Clone)]
pub struct PinnedEntry {
    pub key: String,
    pub plugin_id: String,
    pub command: String,
    pub snapshot: ItemSnapshot,
}

struct State {
    history: Vec<HistoryItem>,
    pinned: Vec<PinnedItem>,
    limit: i64,
}

struct Inner {
    data_root: PathBuf,
    state: Mutex<State>,
    dirty: AtomicBool,
}

#[derive(Clone)]
pub struct HistoryStore {
    inner: Arc<Inner>,
}

impl HistoryStore {
    pub fn new(data_root: &Path) -> Self {
        Self {
            inner: Arc::new(Inner {
                data_root: data_root.to_path_buf(),
                state: Mutex::new(State { history: Vec::new(), pinned: Vec::new(), limit: 500 }),
                dirty: AtomicBool::new(false),
            }),
        }
    }

    pub fn history_file(&self) -> PathBuf {
        self.inner.data_root.join("history.json")
    }

    pub fn pinned_file(&self) -> PathBuf {
        self.inner.data_root.join("pinned.json")
    }

    pub fn load(&self, limit: i64) {
        let history_raw = read_json::<Value>(&self.history_file(), Value::Object(Default::default()));
        let pinned_raw = read_json::<Value>(&self.pinned_file(), Value::Object(Default::default()));
        let history = history_raw
            .get("items")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|item| is_history_item(item))
                    .filter_map(|item| serde_json::from_value::<HistoryItem>(item.clone()).ok())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut pinned = pinned_raw
            .get("items")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|item| is_pinned_item(item))
                    .filter_map(|item| serde_json::from_value::<PinnedItem>(item.clone()).ok())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        pinned.sort_by_key(|item| item.order);

        let mut state = self.state();
        state.history = history;
        state.pinned = pinned;
        state.limit = limit;
        trim(&mut state);
    }

    pub fn set_history_limit(&self, limit: i64) {
        let mut state = self.state();
        state.limit = limit;
        trim(&mut state);
        drop(state);
        self.schedule();
    }

    pub fn recent(&self, limit: usize) -> Vec<HistoryItem> {
        let mut items = self.state().history.clone();
        items.sort_by(|a, b| b.last_used.cmp(&a.last_used));
        items.truncate(limit);
        items
    }

    pub fn all_recent(&self) -> Vec<HistoryItem> {
        let mut items = self.state().history.clone();
        items.sort_by(|a, b| b.last_used.cmp(&a.last_used));
        items
    }

    pub fn pinned_list(&self) -> Vec<PinnedItem> {
        let mut items = self.state().pinned.clone();
        items.sort_by_key(|item| item.order);
        items
    }

    pub fn find(&self, key: &str) -> Option<HistoryItem> {
        self.state().history.iter().find(|item| item.key == key).cloned()
    }

    pub fn is_pinned(&self, key: &str) -> bool {
        self.state().pinned.iter().any(|item| item.key == key)
    }

    /// 只在 execute 成功且 kind !== 'host' 时调用（requirements §7.5）。
    pub fn record(&self, entry: HistoryEntry) -> HistoryItem {
        let now = now_ms();
        let mut state = self.state();
        if let Some(existing) = state.history.iter_mut().find(|item| item.key == entry.key) {
            existing.last_used = now;
            existing.count += 1;
            existing.snapshot = entry.snapshot;
            let updated = existing.clone();
            drop(state);
            self.schedule();
            return updated;
        }
        let item = HistoryItem {
            snapshot: entry.snapshot,
            key: entry.key,
            plugin_id: entry.plugin_id,
            command: entry.command,
            last_used: now,
            count: 1,
        };
        state.history.insert(0, item.clone());
        trim(&mut state);
        drop(state);
        self.schedule();
        item
    }

    pub fn remove(&self, key: &str) {
        let mut state = self.state();
        let before = state.history.len();
        state.history.retain(|item| item.key != key);
        let changed = state.history.len() != before;
        drop(state);
        if changed {
            self.schedule();
        }
    }

    pub fn clear_history(&self) {
        self.state().history.clear();
        self.schedule();
    }

    /// 固定项恒在最前（按 order），不受搜索影响。
    pub fn pin(&self, entry: PinnedEntry) -> PinnedItem {
        let mut state = self.state();
        if let Some(existing) = state.pinned.iter().find(|item| item.key == entry.key) {
            return existing.clone();
        }
        let order = state.pinned.iter().map(|item| item.order).max().map(|max| max + 1).unwrap_or(0);
        let item = PinnedItem {
            snapshot: entry.snapshot,
            key: entry.key,
            plugin_id: entry.plugin_id,
            command: entry.command,
            order,
        };
        state.pinned.push(item.clone());
        drop(state);
        self.schedule();
        item
    }

    pub fn unpin(&self, key: &str) {
        let mut state = self.state();
        let before = state.pinned.len();
        state.pinned.retain(|item| item.key != key);
        let changed = state.pinned.len() != before;
        if changed {
            reindex_pinned(&mut state);
        }
        drop(state);
        if changed {
            self.schedule();
        }
    }

    /// 拖拽重排。
    pub fn reorder(&self, keys: &[String]) -> Vec<PinnedItem> {
        let mut state = self.state();
        let mut map: HashMap<String, PinnedItem> =
            std::mem::take(&mut state.pinned).into_iter().map(|item| (item.key.clone(), item)).collect();
        let mut next: Vec<PinnedItem> = Vec::new();
        for key in keys {
            if let Some(mut item) = map.remove(key) {
                item.order = next.len() as i64;
                next.push(item);
            }
        }
        let mut rest: Vec<PinnedItem> = map.into_values().collect();
        rest.sort_by_key(|item| item.order);
        for mut item in rest {
            item.order = next.len() as i64;
            next.push(item);
        }
        state.pinned = next;
        let list = {
            let mut items = state.pinned.clone();
            items.sort_by_key(|item| item.order);
            items
        };
        drop(state);
        self.schedule();
        list
    }

    /// 插件改名：把历史 / 固定项里的旧 `pluginId` 与 key 前缀一次性迁到新 id。
    /// `map` 方向是 **旧 id → 新 id**（`crate::legacy::legacy_id_to_current`）。
    pub fn migrate_plugin_ids(&self, map: &HashMap<String, String>) -> (usize, usize) {
        let mut state = self.state();
        let mut history = 0usize;
        let mut pinned = 0usize;
        for item in &mut state.history {
            if rename_plugin(&mut item.plugin_id, &mut item.key, map) {
                history += 1;
            }
        }
        for item in &mut state.pinned {
            if rename_plugin(&mut item.plugin_id, &mut item.key, map) {
                pinned += 1;
            }
        }
        if history > 0 {
            state.history = dedupe_history(std::mem::take(&mut state.history));
        }
        if pinned > 0 {
            state.pinned = dedupe_pinned(std::mem::take(&mut state.pinned));
            reindex_pinned(&mut state);
        }
        drop(state);
        if history > 0 || pinned > 0 {
            self.schedule();
        }
        (history, pinned)
    }

    /// 按插件清掉历史条目（清单 `history: false`）。只动历史、**不动固定项**。
    pub fn drop_history_by(&self, exclude: impl Fn(&str) -> bool) -> usize {
        let mut state = self.state();
        let before = state.history.len();
        state.history.retain(|item| !exclude(&item.plugin_id));
        let removed = before - state.history.len();
        drop(state);
        if removed > 0 {
            self.schedule();
        }
        removed
    }

    /// 标脏（由落盘循环合并写）。
    pub fn schedule(&self) {
        self.inner.dirty.store(true, Ordering::SeqCst);
    }

    /// 立即落盘（退出前 / 测试用）。
    pub fn flush(&self) {
        if !self.inner.dirty.swap(false, Ordering::SeqCst) {
            return;
        }
        let (history_snapshot, pinned_snapshot) = {
            let state = self.state();
            (
                HistoryFile { version: FILE_VERSION, items: state.history.clone() },
                PinnedFile { version: FILE_VERSION, items: state.pinned.clone() },
            )
        };
        let history_ok = write_json_atomic(&self.history_file(), &history_snapshot).is_ok();
        let pinned_ok = write_json_atomic(&self.pinned_file(), &pinned_snapshot).is_ok();
        if !history_ok || !pinned_ok {
            // 写失败重新置脏，等下一轮再试（不能静默丢用户数据）
            self.inner.dirty.store(true, Ordering::SeqCst);
        }
    }

    /// 后台落盘循环（500ms 合并窗口）。
    pub async fn flush_loop(&self) {
        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            self.flush();
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(|err| err.into_inner())
    }
}

fn trim(state: &mut State) {
    if state.history.len() as i64 <= state.limit {
        return;
    }
    state.history.sort_by(|a, b| b.last_used.cmp(&a.last_used));
    state.history.truncate(state.limit.max(0) as usize);
}

fn reindex_pinned(state: &mut State) {
    state.pinned.sort_by_key(|item| item.order);
    for (index, item) in state.pinned.iter_mut().enumerate() {
        item.order = index as i64;
    }
}

fn rename_plugin(plugin_id: &mut String, key: &mut String, map: &HashMap<String, String>) -> bool {
    let Some(next) = map.get(plugin_id.as_str()).cloned() else { return false };
    let prefix = format!("{plugin_id}:");
    if let Some(rest) = key.strip_prefix(&prefix) {
        *key = format!("{next}:{rest}");
    }
    *plugin_id = next;
    true
}

/// 合并同 key 的历史项：保留最近使用的一条，次数相加。
fn dedupe_history(items: Vec<HistoryItem>) -> Vec<HistoryItem> {
    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, HistoryItem> = HashMap::new();
    for item in items {
        match map.remove(&item.key) {
            None => {
                order.push(item.key.clone());
                map.insert(item.key.clone(), item);
            }
            Some(existing) => {
                let (newer, older) = if item.last_used > existing.last_used { (item, existing) } else { (existing, item) };
                let mut merged = newer;
                merged.count += older.count;
                map.insert(merged.key.clone(), merged);
            }
        }
    }
    order.into_iter().filter_map(|key| map.remove(&key)).collect()
}

/// 合并同 key 的固定项：保留 order 最小的一条。
fn dedupe_pinned(items: Vec<PinnedItem>) -> Vec<PinnedItem> {
    let mut sorted = items;
    sorted.sort_by_key(|item| item.order);
    let mut seen: Vec<String> = Vec::new();
    sorted
        .into_iter()
        .filter(|item| {
            if seen.contains(&item.key) {
                false
            } else {
                seen.push(item.key.clone());
                true
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(key: &str, title: &str) -> HistoryEntry {
        HistoryEntry {
            key: key.to_string(),
            plugin_id: "demo".to_string(),
            command: "run".to_string(),
            snapshot: ItemSnapshot { title: title.to_string(), ..Default::default() },
        }
    }

    #[test]
    fn record_merges_same_key_and_counts() {
        let store = HistoryStore::new(Path::new("/tmp/nowhere-history"));
        let first = store.record(entry("demo:run:aaaa", "第一次"));
        assert_eq!(first.count, 1);
        let second = store.record(entry("demo:run:aaaa", "第二次"));
        assert_eq!(second.count, 2);
        assert_eq!(second.snapshot.title, "第二次");
        assert_eq!(store.recent(10).len(), 1, "同 key 只保留一条");
    }

    #[test]
    fn pin_reorder_and_unpin_keep_order_dense() {
        let store = HistoryStore::new(Path::new("/tmp/nowhere-pin"));
        let pin_entry = |key: &str| PinnedEntry {
            key: key.to_string(),
            plugin_id: "demo".to_string(),
            command: "run".to_string(),
            snapshot: ItemSnapshot::default(),
        };
        store.pin(pin_entry("a"));
        store.pin(pin_entry("b"));
        store.pin(pin_entry("c"));

        let reordered = store.reorder(&["c".to_string(), "a".to_string()]);
        let keys: Vec<&str> = reordered.iter().map(|item| item.key.as_str()).collect();
        assert_eq!(keys, vec!["c", "a", "b"], "未列出的项接在尾部");
        assert!(reordered.iter().all(|item| item.order >= 0));

        store.unpin("c");
        let remaining = store.pinned_list();
        assert_eq!(remaining.len(), 2);
        assert_eq!(remaining[0].order, 0, "unpin 后重新编号");
    }

    #[test]
    fn migrate_renames_plugin_and_key_prefix_then_dedupes() {
        let store = HistoryStore::new(Path::new("/tmp/nowhere-migrate"));
        store.record(entry("hosts", "旧插件"));
        // 直接构造出 key 为旧前缀的条目（entry 的 key 是手写的，这里模拟数据文件内容）
        let mut old_item = store.record(entry("host-manager:read:bbbb", "新插件"));
        old_item.key = "hosts:read:bbbb".to_string();
        old_item.plugin_id = "hosts".to_string();
        // 覆盖 store 内部状态，模拟磁盘里并存新旧两份
        {
            let mut state = store.state();
            state.history = vec![
                HistoryItem { plugin_id: "hosts".to_string(), key: "hosts:run:xxxx".to_string(), ..old_item.clone() },
                HistoryItem { plugin_id: "host-manager".to_string(), key: "host-manager:read:bbbb".to_string(), ..old_item.clone() },
            ];
        }
        let map = crate::legacy::legacy_id_to_current();
        let (history, _pinned) = store.migrate_plugin_ids(&map);
        assert_eq!(history, 1);
        let items = store.all_recent();
        assert!(items.iter().all(|item| item.plugin_id == "host-manager"));
        assert!(items.iter().all(|item| item.key.starts_with("host-manager:")));
    }

    #[test]
    fn flush_persists_and_load_reads_back() {
        let dir = std::env::temp_dir().join(format!("history-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let store = HistoryStore::new(&dir);
        store.record(entry("demo:run:cccc", "落盘"));
        store.pin(PinnedEntry {
            key: "demo:run:cccc".to_string(),
            plugin_id: "demo".to_string(),
            command: "run".to_string(),
            snapshot: ItemSnapshot { title: "落盘".to_string(), ..Default::default() },
        });
        store.flush();

        let reloaded = HistoryStore::new(&dir);
        reloaded.load(500);
        assert_eq!(reloaded.recent(10).len(), 1);
        assert_eq!(reloaded.pinned_list().len(), 1);
        assert!(reloaded.is_pinned("demo:run:cccc"));

        // 历史上限裁剪
        for index in 0..10 {
            reloaded.record(entry(&format!("demo:run:{index}"), "x"));
        }
        reloaded.set_history_limit(3);
        assert_eq!(reloaded.all_recent().len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
