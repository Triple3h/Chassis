//! 命令注册表 + 搜索槽（v1 `apps/kernel/src/registry.ts`；requirements §7.2 / §7.6）。
//!
//! 规则：插件内 `name` 唯一，全局 id = `${pluginId}:${name}`；停用插件其命令与结果全部撤回；
//! 搜索槽按 token 校验新鲜度（旧 token 的结果一律丢弃，不回滚已显示的）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::contract::{ActionResult, ResultItem};
use crate::exec::BoxFuture;
use crate::manifest::CommandDecl;
use crate::types::Disposer;

#[derive(Debug)]
pub struct RegisteredCommand {
    pub id: String,
    pub plugin_id: String,
    pub plugin_title: String,
    pub decl: CommandDecl,
    /// 命令级能力已并入插件级
    pub capabilities: Vec<String>,
    /// 注册序号：`update` 后保持不变，disposer 据此判断「还是自己那条」
    pub marker: u64,
}

#[derive(Debug, Clone, Default)]
pub struct CommandPatch {
    pub keywords: Option<Vec<String>>,
}

type Listener = Arc<dyn Fn() + Send + Sync>;
type Invoker = Arc<dyn Fn(String, Option<Value>, String) -> BoxFuture<ActionResult> + Send + Sync>;

#[derive(Default)]
pub struct CommandRegistry {
    commands: Mutex<HashMap<String, Arc<RegisteredCommand>>>,
    listeners: Mutex<Vec<Listener>>,
    invoker: Mutex<Option<Invoker>>,
    markers: AtomicU64,
}

impl CommandRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// `invoke` 的实际执行（由内核装配期绑定到执行管线）。
    pub fn bind_invoker(&self, invoker: Invoker) {
        *self.invoker.lock().unwrap_or_else(|err| err.into_inner()) = Some(invoker);
    }

    pub fn register(self: &Arc<Self>, mut entry: RegisteredCommand) -> std::result::Result<Disposer, String> {
        let marker = self.markers.fetch_add(1, Ordering::SeqCst) + 1;
        entry.marker = marker;
        let id = entry.id.clone();
        {
            let mut commands = self.lock();
            if commands.contains_key(&id) {
                return Err(format!("命令 id 冲突：{id}"));
            }
            commands.insert(id.clone(), Arc::new(entry));
        }
        self.emit();

        let registry = self.clone();
        Ok(Box::new(move || {
            let removed = {
                let mut commands = registry.lock();
                let is_self = commands.get(&id).map(|existing| existing.marker == marker).unwrap_or(false);
                if is_self {
                    commands.remove(&id);
                }
                is_self
            };
            if removed {
                registry.emit();
            }
        }))
    }

    /// 就地更新（别名改写等）；`name` 不可改，marker 保持不变（disposer 仍生效）。
    pub fn update(&self, id: &str, patch: CommandPatch) -> bool {
        let mut commands = self.lock();
        let Some(existing) = commands.get(id).cloned() else { return false };
        let mut next = RegisteredCommand {
            id: existing.id.clone(),
            plugin_id: existing.plugin_id.clone(),
            plugin_title: existing.plugin_title.clone(),
            decl: existing.decl.clone(),
            capabilities: existing.capabilities.clone(),
            marker: existing.marker,
        };
        if let Some(keywords) = patch.keywords {
            next.decl.keywords = Some(keywords);
        }
        commands.insert(id.to_string(), Arc::new(next));
        drop(commands);
        self.emit();
        true
    }

    pub fn get(&self, id: &str) -> Option<Arc<RegisteredCommand>> {
        self.lock().get(id).cloned()
    }

    pub fn list(&self) -> Vec<Arc<RegisteredCommand>> {
        self.lock().values().cloned().collect()
    }

    pub fn by_plugin(&self, plugin_id: &str) -> Vec<Arc<RegisteredCommand>> {
        self.list().into_iter().filter(|entry| entry.plugin_id == plugin_id).collect()
    }

    /// 参与搜索的命令（`searchable` 且未 `hidden`）。
    pub fn searchable(&self) -> Vec<Arc<RegisteredCommand>> {
        self.list()
            .into_iter()
            .filter(|entry| entry.decl.searchable == Some(true) && entry.decl.hidden != Some(true))
            .collect()
    }

    /// 贡献型搜索源：需要拉起逻辑层进程的命令。
    pub fn contributors(&self) -> Vec<Arc<RegisteredCommand>> {
        self.list()
            .into_iter()
            .filter(|entry| entry.decl.contributes == Some(true) && entry.decl.hidden != Some(true))
            .collect()
    }

    pub fn on_change(self: &Arc<Self>, listener: Listener) -> Disposer {
        let stored = listener;
        self.listeners.lock().unwrap_or_else(|err| err.into_inner()).push(stored.clone());
        let registry = self.clone();
        Box::new(move || {
            registry
                .listeners
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .retain(|item| !Arc::ptr_eq(item, &stored));
        })
    }

    pub async fn invoke(&self, id: &str, args: Option<Value>, source: &str) -> ActionResult {
        let invoker = self.invoker.lock().unwrap_or_else(|err| err.into_inner()).clone();
        match invoker {
            Some(invoker) => invoker(id.to_string(), args, source.to_string()).await,
            None => ActionResult::failure("host", "NOT_FOUND", "invoke 尚未装配"),
        }
    }

    fn emit(&self) {
        let listeners: Vec<Listener> = self.listeners.lock().unwrap_or_else(|err| err.into_inner()).clone();
        for listener in listeners {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener()));
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<RegisteredCommand>>> {
        self.commands.lock().unwrap_or_else(|err| err.into_inner())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetMode {
    Set,
    Append,
    Clear,
}

#[derive(Debug, Clone)]
pub struct SearchSlot {
    pub token: u64,
    pub query: String,
    /// pluginId → 结果项
    pub results: HashMap<String, Vec<ResultItem>>,
    pub closed: bool,
}

/// 搜索槽（requirements §7.6）：内核每次搜索开一个槽，按 token 校验新鲜度。
#[derive(Default)]
pub struct SearchResultHub {
    slots: Mutex<HashMap<u64, SearchSlot>>,
    current_token: AtomicU64,
}

impl SearchResultHub {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(&self, token: u64, query: &str) {
        let mut slots = self.slots.lock().unwrap_or_else(|err| err.into_inner());
        slots.insert(token, SearchSlot { token, query: query.to_string(), results: HashMap::new(), closed: false });
        if slots.len() > 8 {
            let mut keys: Vec<u64> = slots.keys().copied().collect();
            keys.sort_unstable();
            let remove_count = keys.len() - 8;
            for key in keys.into_iter().take(remove_count) {
                slots.remove(&key);
            }
        }
    }

    pub fn close(&self, token: u64) {
        if let Some(slot) = self.slots.lock().unwrap_or_else(|err| err.into_inner()).get_mut(&token) {
            slot.closed = true;
        }
    }

    pub fn accept(&self, token: Option<u64>, plugin_id: &str, items: Vec<ResultItem>, mode: SetMode) -> bool {
        let effective = token.unwrap_or_else(|| self.current());
        let mut slots = self.slots.lock().unwrap_or_else(|err| err.into_inner());
        let Some(slot) = slots.get_mut(&effective) else { return false };
        if slot.closed {
            return false;
        }
        match mode {
            SetMode::Clear => {
                slot.results.remove(plugin_id);
            }
            SetMode::Set => {
                slot.results.insert(plugin_id.to_string(), items);
            }
            SetMode::Append => {
                slot.results.entry(plugin_id.to_string()).or_default().extend(items);
            }
        }
        true
    }

    pub fn results(&self, token: u64) -> HashMap<String, Vec<ResultItem>> {
        self.slots
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(&token)
            .map(|slot| slot.results.clone())
            .unwrap_or_default()
    }

    /// 该 token 的查询串（延迟补位推送要用它重新组装响应）。
    pub fn query_of(&self, token: u64) -> Option<String> {
        self.slots
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(&token)
            .map(|slot| slot.query.clone())
    }

    pub fn set_current(&self, token: u64) {
        self.current_token.store(token, Ordering::SeqCst);
    }

    pub fn current(&self) -> u64 {
        self.current_token.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::CommandMode;
    use serde_json::json;

    fn decl(name: &str, searchable: bool, contributes: bool) -> CommandDecl {
        CommandDecl {
            name: name.to_string(),
            title: name.to_string(),
            mode: CommandMode::NoView,
            subtitle: None,
            icon: None,
            searchable: Some(searchable),
            placeholder: None,
            keywords: None,
            contributes: Some(contributes),
            capabilities: None,
            hidden: None,
        }
    }

    fn entry(id: &str, plugin_id: &str, decl: CommandDecl) -> RegisteredCommand {
        RegisteredCommand {
            id: id.to_string(),
            plugin_id: plugin_id.to_string(),
            plugin_title: plugin_id.to_string(),
            decl,
            capabilities: Vec::new(),
            marker: 0,
        }
    }

    #[test]
    fn register_update_and_disposer_semantics() {
        let registry = Arc::new(CommandRegistry::new());
        let dispose = registry.register(entry("demo:run", "demo", decl("run", true, false))).expect("首次注册应当成功");
        assert_eq!(registry.list().len(), 1);

        // id 冲突
        assert!(registry.register(entry("demo:run", "demo", decl("run", true, false))).is_err());

        // update 改别名、marker 不变 → disposer 仍能删掉自己
        assert!(registry.update("demo:run", CommandPatch { keywords: Some(vec!["alias".to_string()]) }));
        assert_eq!(registry.get("demo:run").unwrap().decl.keywords, Some(vec!["alias".to_string()]));
        dispose();
        assert!(registry.list().is_empty(), "update 之后 disposer 仍应生效");

        // 过滤
        let registry = Arc::new(CommandRegistry::new());
        let _x = registry.register(entry("a:x", "a", decl("x", true, false))).unwrap();
        let _y = registry.register(entry("a:y", "a", decl("y", false, false))).unwrap();
        let mut contributor = decl("feed", false, true);
        contributor.hidden = Some(true);
        let _feed = registry.register(entry("a:feed", "a", contributor)).unwrap();
        assert_eq!(registry.searchable().len(), 1, "只有 searchable 且未 hidden 的参与搜索");
        assert!(registry.contributors().is_empty(), "hidden 的贡献型源不参与");
    }

    #[test]
    fn hub_accepts_by_token_and_rejects_stale() {
        let hub = SearchResultHub::new();
        hub.set_current(1);
        hub.open(1, "q");
        let item = |id: &str| ResultItem {
            id: id.to_string(),
            title: id.to_string(),
            subtitle: None,
            icon: None,
            score: None,
            action: json!({ "type": "command", "command": "run" }),
            actions: None,
            detail: None,
        };

        assert!(hub.accept(Some(1), "p", vec![item("a")], SetMode::Set));
        assert!(hub.accept(Some(1), "p", vec![item("b")], SetMode::Append));
        assert_eq!(hub.results(1).get("p").unwrap().len(), 2);

        hub.close(1);
        assert!(!hub.accept(Some(1), "p", vec![item("c")], SetMode::Set), "关闭后的槽拒绝写入");
        assert!(!hub.accept(Some(99), "p", vec![item("d")], SetMode::Set), "过期 token 一律丢弃");

        // token 缺省时落到 current
        hub.set_current(2);
        hub.open(2, "q2");
        assert!(hub.accept(None, "p", vec![item("e")], SetMode::Clear));
        assert!(hub.results(2).get("p").is_none(), "clear 删除该插件的结果");
    }
}
