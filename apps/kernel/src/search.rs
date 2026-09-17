//! 搜索调度（v1 `apps/kernel/src/search.ts`；requirements §7.6）。
//!
//! debounce 在 UI 侧（80ms）；这里负责广播 / 合并 / 去重 / 排序 / 防抖稳定。
//! 与 v1 的差异：不做同 query 的 in-flight 复用（UI 侧 80ms debounce 之后重复请求概率极低，
//! 复用需要共享 future，收益不抵复杂度）。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::config::ConfigStore;
use crate::contract::{RankedResult, ResultItem};
use crate::events::{names, EventBus};
use crate::history::HistoryStore;
use crate::manifest::CommandMode;
use crate::pinyin::{blend_plugin_score, combined_score, match_target, SearchTarget};
use crate::registry::{CommandRegistry, RegisteredCommand, SearchResultHub, SetMode};
use crate::util::now_ms;
use crate::util::text::{item_key, normalize_query};

/// 活跃 view 会话（由 a1-6 的会话管理器实现；搜索只关心「有哪些、标记 token」）。
pub trait ViewSessions: Send + Sync {
    /// `(sid, pluginId)` 列表
    fn list(&self) -> Vec<(String, String)>;
    fn mark_search(&self, sid: &str, token: u64);
}

pub struct SearchDeps {
    pub registry: Arc<CommandRegistry>,
    pub hub: Arc<SearchResultHub>,
    pub history: Arc<HistoryStore>,
    pub exec: Arc<crate::exec::ScriptRuntime>,
    pub bus: EventBus,
    pub config: Arc<ConfigStore>,
    pub sessions: Arc<dyn ViewSessions>,
    pub plugin_title_of: Arc<dyn Fn(&str) -> String + Send + Sync>,
    /// 插件静态资源基址（相对路径图标 → 绝对 URL）
    pub plugin_base_url: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    /// 历史/固定项可用性（`command` 可能是命令名，也可能是结果项 id）
    pub is_result_alive: Arc<dyn Fn(&str, &str) -> bool + Send + Sync>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchGroups {
    pub pinned: Vec<RankedResult>,
    pub best: Vec<RankedResult>,
    pub recent: Vec<RankedResult>,
    /// 空输入时的「已安装插件」：每个插件一条入口项，按插件最近一次使用倒序
    pub plugins: Vec<RankedResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResponse {
    pub token: u64,
    pub query: String,
    pub groups: SearchGroups,
    /// 命中的插件（用于 UI 提示哪些插件还在补位）
    pub pending: Vec<String>,
}

const MAX_BEST: usize = 20;
const SEARCH_BUDGET_MS: u64 = 200;

pub struct SearchEngine {
    deps: SearchDeps,
    counter: AtomicU64,
    last_order: Mutex<Vec<String>>,
    order_index: Mutex<std::collections::HashMap<String, usize>>,
}

impl SearchEngine {
    pub fn new(deps: SearchDeps) -> Self {
        Self { deps, counter: AtomicU64::new(0), last_order: Mutex::new(Vec::new()), order_index: Mutex::new(Default::default()) }
    }

    pub async fn search(self: &Arc<Self>, raw_query: &str) -> SearchResponse {
        let query = normalize_query(raw_query);
        let token = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
        self.deps.hub.set_current(token);

        if query.is_empty() {
            // 首页：固定项 + 已安装插件（后者按「这个插件最近一次被打开」倒序）。
            // 不发广播、不开搜索槽 —— 插件入口全部来自注册表与历史，内核自己就有。
            return SearchResponse {
                token,
                query: query.clone(),
                groups: SearchGroups {
                    pinned: self.pinned_results(""),
                    best: Vec::new(),
                    recent: self.recent_results(""),
                    plugins: self.plugin_entries(),
                },
                pending: Vec::new(),
            };
        }

        self.run_search(&query, token).await
    }

    async fn run_search(self: &Arc<Self>, query: &str, token: u64) -> SearchResponse {
        self.deps.hub.open(token, query);

        // 1) 贡献型：逻辑层子进程（常驻）
        let mut script_tasks = Vec::new();
        for entry in self.deps.registry.contributors() {
            if entry.decl.mode == CommandMode::View {
                continue;
            }
            let exec = self.deps.exec.clone();
            let hub = self.deps.hub.clone();
            let engine = self.clone();
            let plugin_id = entry.plugin_id.clone();
            let command = entry.decl.name.clone();
            let query_owned = query.to_string();
            script_tasks.push(tokio::spawn(async move {
                let raw = exec
                    .query_search_source(&plugin_id, &command, &query_owned, Duration::from_millis(SEARCH_BUDGET_MS), token)
                    .await;
                let Some(raw) = raw else { return };
                // 宽容解析：形状不合法的结果项跳过（v1 是原样透传，这里更严一点但更安全）
                let items: Vec<ResultItem> = raw
                    .into_iter()
                    .filter_map(|value| match serde_json::from_value::<ResultItem>(value) {
                        Ok(item) => Some(item),
                        Err(err) => {
                            crate::log_warn!("[{plugin_id}] 贡献的结果项不合法（已跳过）：{err}");
                            None
                        }
                    })
                    .collect();
                if items.is_empty() {
                    return;
                }
                if !hub.accept(Some(token), &plugin_id, items, SetMode::Set) {
                    return;
                }
                // ★ 慢源补位（v1 缺的一环）：预算内回不来的贡献（如实测 ~450ms 的 `mdfind`）
                // 写完 slot 就结束了 —— v1 的界面因此永远看不到它们。UI 的 `search/results`
                // 监听（stores/data.ts）本来就是为这件事留的，这里把它接上。
                engine.emit_results(token);
            }));
        }

        // 2) 贡献型：活跃 view 会话（postMessage 广播）
        for (sid, plugin_id) in self.deps.sessions.list() {
            let contributes = self
                .deps
                .registry
                .by_plugin(&plugin_id)
                .iter()
                .any(|entry| entry.decl.contributes == Some(true) && entry.decl.hidden != Some(true));
            if !contributes {
                continue;
            }
            self.deps.sessions.mark_search(&sid, token);
            self.deps.bus.emit(names::SEARCH_QUERY, &json!({ "sid": sid, "query": query, "token": token }));
        }

        // 预算内等待脚本结果（200ms + 30ms 余量）
        let _ = tokio::time::timeout(Duration::from_millis(SEARCH_BUDGET_MS + 30), async {
            for task in script_tasks {
                let _ = task.await;
            }
        })
        .await;
        // 这里**不关** slot：预算之外到达的补位还要写进它（`emit_results` 才有料可推）。
        // slot 数量由 hub 的 LRU（8 条）兜底，不会无限涨。
        self.compose(token, query)
    }

    /// 组装一次完整响应 —— 最终响应与延迟补位推送**共用**。
    ///
    /// 两边必须一致：UI 收到 `search/results` 时是整体替换 `response`（stores/data.ts），
    /// 少一个分区或多一个 pending 都会让界面跳变。
    fn compose(&self, token: u64, query: &str) -> SearchResponse {
        let config = self.deps.config.get();
        let local_commands = self.score_commands(query);
        let pinned = self.pinned_results(query);
        let recent = if config.history_in_search { self.recent_results(query) } else { Vec::new() };

        let mut contributed: Vec<RankedResult> = Vec::new();
        for (plugin_id, items) in self.deps.hub.results(token) {
            for item in items {
                contributed.push(self.rank_plugin_item(&plugin_id, item, query));
            }
        }

        let merged = self.dedupe(local_commands.into_iter().chain(contributed).collect());
        let best: Vec<RankedResult> = self.stable_sort(merged).into_iter().take(MAX_BEST).collect();
        self.remember_order(&best);

        // pending 与 `run_search` 同款：贡献型脚本命令 + 活跃 view 会话（顺序也一致）
        let mut seen = HashSet::new();
        let mut pending: Vec<String> = Vec::new();
        for entry in self.deps.registry.contributors() {
            if entry.decl.mode == CommandMode::View {
                continue;
            }
            if seen.insert(entry.plugin_id.clone()) {
                pending.push(entry.plugin_id.clone());
            }
        }
        for (_, plugin_id) in self.deps.sessions.list() {
            let contributes = self
                .deps
                .registry
                .by_plugin(&plugin_id)
                .iter()
                .any(|entry| entry.decl.contributes == Some(true) && entry.decl.hidden != Some(true));
            if contributes && seen.insert(plugin_id.clone()) {
                pending.push(plugin_id);
            }
        }

        SearchResponse { token, query: query.to_string(), groups: SearchGroups { pinned, best, recent, plugins: Vec::new() }, pending }
    }

    /// 把补位后的完整响应推给 UI（`search/results`）。
    ///
    /// 查询串从 hub 的 slot 取（= 那次搜索的原始查询），调用方不必自己带。
    pub fn emit_results(&self, token: u64) {
        let Some(query) = self.deps.hub.query_of(token) else { return };
        let response = self.compose(token, &query);
        match serde_json::to_value(&response) {
            Ok(payload) => self.deps.bus.emit(names::SEARCH_RESULTS, &payload),
            Err(err) => crate::log_warn!("搜索补位推送序列化失败：{err}"),
        }
    }

    /// `searchable` 命令参与搜索（入口型）。
    fn score_commands(&self, query: &str) -> Vec<RankedResult> {
        let mut out = Vec::new();
        for entry in self.deps.registry.searchable() {
            let target = command_target(&entry);
            let matched = match_target(query, &target);
            if matched.score < 0.0 {
                continue;
            }
            let key = item_key(&entry.plugin_id, &entry.decl.name, None);
            let score = match self.deps.history.find(&key) {
                Some(history) => combined_score(matched.score, history.last_used, history.count, now_ms()),
                None => matched.score * 0.9,
            };
            out.push(RankedResult {
                plugin_id: entry.plugin_id.clone(),
                plugin_title: entry.plugin_title.clone(),
                command: entry.decl.name.clone(),
                item: ResultItem {
                    id: format!("command:{}", entry.decl.name),
                    title: entry.decl.title.clone(),
                    subtitle: entry.decl.subtitle.clone(),
                    icon: entry.decl.icon.clone(),
                    score: None,
                    action: json!({ "type": "command", "command": entry.decl.name }),
                    actions: None,
                    detail: None,
                },
                item_key: key,
                score,
                title_match: matched.span,
                pinned: None,
                from_history: None,
                stale: None,
            });
        }
        out
    }

    fn rank_plugin_item(&self, plugin_id: &str, item: ResultItem, query: &str) -> RankedResult {
        let key = item_key(plugin_id, &plugin_key_of(&item), item.action.get("args"));
        let target = SearchTarget {
            title: item.title.clone(),
            subtitle: item.subtitle.clone(),
            keywords: Vec::new(),
        };
        let matched = match_target(query, &target);
        let kernel_score = if matched.score < 0.0 { 0.3 } else { matched.score };
        let usage = match self.deps.history.find(&key) {
            Some(history) => combined_score(kernel_score, history.last_used, history.count, now_ms()),
            None => kernel_score,
        };
        let icon = item.icon.clone();
        let mut ranked_item = item.clone();
        ranked_item.icon = self.resolve_icon(plugin_id, icon.as_deref());
        RankedResult {
            plugin_id: plugin_id.to_string(),
            plugin_title: (self.deps.plugin_title_of)(plugin_id),
            command: plugin_key_of(&item),
            item: ranked_item,
            item_key: key.clone(),
            score: blend_plugin_score(item.score, usage),
            title_match: matched.span,
            pinned: Some(self.deps.history.is_pinned(&key)),
            from_history: None,
            stale: None,
        }
    }

    fn pinned_results(&self, query: &str) -> Vec<RankedResult> {
        let mut results = Vec::new();
        for pin in self.deps.history.pinned_list() {
            let alive = (self.deps.is_result_alive)(&pin.plugin_id, &pin.command);
            let target = SearchTarget { title: pin.snapshot.title.clone(), subtitle: pin.snapshot.subtitle.clone(), keywords: Vec::new() };
            let matched = if query.is_empty() {
                crate::pinyin::MatchResult { score: 1.0, span: None }
            } else {
                match_target(query, &target)
            };
            if !query.is_empty() && matched.score < 0.0 {
                continue;
            }
            results.push(RankedResult {
                plugin_id: pin.plugin_id.clone(),
                plugin_title: (self.deps.plugin_title_of)(&pin.plugin_id),
                command: pin.command.clone(),
                item: ResultItem {
                    id: format!("pinned:{}", pin.key),
                    title: pin.snapshot.title.clone(),
                    subtitle: pin.snapshot.subtitle.clone(),
                    icon: self.resolve_icon(&pin.plugin_id, pin.snapshot.icon.as_deref()),
                    score: None,
                    action: snapshot_action(&pin.command, pin.snapshot.args.as_ref(), pin.snapshot.action.as_ref()),
                    actions: None,
                    detail: None,
                },
                item_key: pin.key.clone(),
                score: 1.0,
                title_match: matched.span,
                pinned: Some(true),
                from_history: None,
                stale: (!alive).then_some(true),
            });
        }
        results
    }

    fn recent_results(&self, query: &str) -> Vec<RankedResult> {
        let mut results = Vec::new();
        for item in self.deps.history.all_recent() {
            let alive = (self.deps.is_result_alive)(&item.plugin_id, &item.command);
            let target = SearchTarget { title: item.snapshot.title.clone(), subtitle: item.snapshot.subtitle.clone(), keywords: Vec::new() };
            let matched = if query.is_empty() {
                crate::pinyin::MatchResult { score: 1.0, span: None }
            } else {
                match_target(query, &target)
            };
            if !query.is_empty() && matched.score < 0.0 {
                continue;
            }
            let score = if query.is_empty() {
                1.0
            } else {
                combined_score(matched.score, item.last_used, item.count, now_ms())
            };
            results.push(RankedResult {
                plugin_id: item.plugin_id.clone(),
                plugin_title: (self.deps.plugin_title_of)(&item.plugin_id),
                command: item.command.clone(),
                item: ResultItem {
                    id: format!("history:{}", item.key),
                    title: item.snapshot.title.clone(),
                    subtitle: item.snapshot.subtitle.clone(),
                    icon: self.resolve_icon(&item.plugin_id, item.snapshot.icon.as_deref()),
                    score: None,
                    action: snapshot_action(&item.command, item.snapshot.args.as_ref(), item.snapshot.action.as_ref()),
                    actions: None,
                    detail: None,
                },
                item_key: item.key.clone(),
                score,
                title_match: matched.span,
                pinned: Some(self.deps.history.is_pinned(&item.key)),
                from_history: Some(true),
                stale: (!alive).then_some(true),
            });
        }
        results
    }

    /// 空输入时的「已安装插件」：每个插件一条入口项（`entry_commands`），
    /// 按该插件**最近一次使用**倒序；没用过的排在后面按标题排序。
    ///
    /// 已固定在「已固定」分区里的入口（key 相同）不再重复出现 —— 首页两行各自不重样；
    /// 固定项里那些非插件条目（应用 / 文件 / 网址）与本分区互不相干。
    fn plugin_entries(&self) -> Vec<RankedResult> {
        let recency = self.plugin_recency();
        let mut entries: Vec<(Option<i64>, RankedResult)> = Vec::new();
        for entry in entry_commands(self.deps.registry.list()) {
            let key = item_key(&entry.plugin_id, &entry.decl.name, None);
            if self.deps.history.is_pinned(&key) {
                continue;
            }
            entries.push((
                recency.get(&entry.plugin_id).copied(),
                RankedResult {
                    plugin_id: entry.plugin_id.clone(),
                    plugin_title: entry.plugin_title.clone(),
                    command: entry.decl.name.clone(),
                    item: ResultItem {
                        id: format!("command:{}", entry.decl.name),
                        title: entry.decl.title.clone(),
                        subtitle: entry.decl.subtitle.clone(),
                        icon: self.resolve_icon(&entry.plugin_id, entry.decl.icon.as_deref()),
                        score: None,
                        action: json!({ "type": "command", "command": entry.decl.name }),
                        actions: None,
                        detail: None,
                    },
                    item_key: key,
                    score: 1.0,
                    title_match: None,
                    pinned: Some(false),
                    from_history: None,
                    stale: None,
                },
            ));
        }
        sort_plugin_entries(&mut entries);
        entries.into_iter().map(|(_, item)| item).collect()
    }

    /// 插件 id → 最近一次使用时间（`all_recent` 已按 lastUsed 倒序，首次出现即最新）。
    fn plugin_recency(&self) -> HashMap<String, i64> {
        let mut map = HashMap::new();
        for item in self.deps.history.all_recent() {
            map.entry(item.plugin_id).or_insert(item.last_used);
        }
        map
    }

    /// 按 id 去重，保留 score 高者（requirements §7.6.4）。
    fn dedupe(&self, items: Vec<RankedResult>) -> Vec<RankedResult> {
        let mut map: std::collections::HashMap<String, RankedResult> = std::collections::HashMap::new();
        for item in items {
            let key = format!("{}:{}", item.plugin_id, item.item.id);
            match map.get(&key) {
                Some(existing) if existing.score >= item.score => {}
                _ => {
                    map.insert(key, item);
                }
            }
        }
        map.into_values().collect()
    }

    /// 防抖稳定（requirements §7.6.5）：结果集合没变时保持上次顺序，避免列表跳动。
    fn stable_sort(&self, items: Vec<RankedResult>) -> Vec<RankedResult> {
        let order = self.order_index.lock().unwrap_or_else(|err| err.into_inner()).clone();
        let same_set = items.len() == order.len() && items.iter().all(|item| order.contains_key(&item.item_key));
        let mut sorted = items;
        if same_set {
            sorted.sort_by_key(|item| order.get(&item.item_key).copied().unwrap_or(usize::MAX));
        } else {
            sorted.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        }
        sorted
    }

    fn remember_order(&self, items: &[RankedResult]) {
        let mut index = self.order_index.lock().unwrap_or_else(|err| err.into_inner());
        index.clear();
        for (position, item) in items.iter().enumerate() {
            index.insert(item.item_key.clone(), position);
        }
        *self.last_order.lock().unwrap_or_else(|err| err.into_inner()) =
            items.iter().map(|item| item.item_key.clone()).collect();
    }

    fn resolve_icon(&self, plugin_id: &str, icon: Option<&str>) -> Option<String> {
        let icon = icon?;
        if is_passthrough_icon(icon) {
            return Some(icon.to_string());
        }
        let base = (self.deps.plugin_base_url)(plugin_id)?;
        let clean = icon.trim_start_matches("./").trim_start_matches('/');
        Some(format!("{base}/{clean}"))
    }
}

/// 每个插件的**入口命令** —— 首页「已安装插件」分区里那一格。
///
/// 条件：`mode == view`（点下去能打开插件页）、未 `hidden`。同一插件有多条时取
/// 清单顺序里第一条 `searchable` 的（都没有可搜索的才兜底取第一条）—— 保证每插件恰好一格。
/// 只有贡献型 / 脚本命令的插件（应用启动器、文件搜索、网址直达这类"搜索结果来源"）
/// 没有入口，不出现在列表里：它们不是"打开一个页面"的插件。
fn entry_commands(commands: Vec<Arc<RegisteredCommand>>) -> Vec<Arc<RegisteredCommand>> {
    let mut ordered = commands;
    // marker = 注册序号 = 清单顺序（`PluginManager` 按 commands 数组逐个注册）
    ordered.sort_by_key(|entry| entry.marker);
    let mut out: Vec<Arc<RegisteredCommand>> = Vec::new();
    let mut picked: HashSet<String> = HashSet::new();
    let mut fallback: HashMap<String, Arc<RegisteredCommand>> = HashMap::new();
    for entry in ordered {
        if entry.decl.mode != CommandMode::View || entry.decl.hidden == Some(true) {
            continue;
        }
        if picked.contains(&entry.plugin_id) {
            continue;
        }
        if entry.decl.searchable == Some(true) {
            picked.insert(entry.plugin_id.clone());
            out.push(entry);
        } else {
            // 不可搜索的 view 命令：万一该插件只有这一条入口，也得能在首页点开
            fallback.entry(entry.plugin_id.clone()).or_insert(entry);
        }
    }
    let mut rest: Vec<Arc<RegisteredCommand>> =
        fallback.into_values().filter(|entry| !picked.contains(&entry.plugin_id)).collect();
    rest.sort_by_key(|entry| entry.marker);
    out.extend(rest);
    out
}

/// 「已安装插件」的排序：最近打开过的按时间倒序在前，没用过的排最后、按标题给出稳定顺序。
fn sort_plugin_entries(entries: &mut [(Option<i64>, RankedResult)]) {
    entries.sort_by(|a, b| match (a.0, b.0) {
        (Some(left), Some(right)) if left != right => right.cmp(&left),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        _ => a.1.item.title.cmp(&b.1.item.title),
    });
}

fn command_target(entry: &RegisteredCommand) -> SearchTarget {
    SearchTarget {
        title: entry.decl.title.clone(),
        subtitle: entry.decl.subtitle.clone(),
        keywords: entry.decl.keywords.clone().unwrap_or_default(),
    }
}

/// 结果项在插件内的业务 key：`command` 类动作取命令名，否则取结果项 id。
pub fn plugin_key_of(item: &ResultItem) -> String {
    if item.action.get("type").and_then(Value::as_str) == Some("command") {
        if let Some(command) = item.action.get("command").and_then(Value::as_str) {
            return command.to_string();
        }
    }
    item.id.clone()
}

/// 固定/历史项的动作：优先用持久化的快照，老数据没有快照时退回「按命令名执行」。
fn snapshot_action(command: &str, args: Option<&Value>, action: Option<&Value>) -> Value {
    if let Some(action) = action {
        return action.clone();
    }
    let mut value = json!({ "type": "command", "command": command });
    if let Some(args) = args {
        value["args"] = args.clone();
    }
    value
}

fn is_passthrough_icon(icon: &str) -> bool {
    let lower = icon.to_lowercase();
    if lower.starts_with("data:") || lower.starts_with("http:") || lower.starts_with("https:") || lower.starts_with("lucide:") {
        return true;
    }
    !icon.is_empty() && icon.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::CommandDecl;

    fn command(plugin_id: &str, name: &str, mode: CommandMode, searchable: bool, hidden: bool, marker: u64) -> Arc<RegisteredCommand> {
        Arc::new(RegisteredCommand {
            id: format!("{plugin_id}:{name}"),
            plugin_id: plugin_id.to_string(),
            plugin_title: plugin_id.to_string(),
            decl: CommandDecl {
                name: name.to_string(),
                title: name.to_string(),
                mode,
                subtitle: None,
                icon: None,
                searchable: Some(searchable),
                placeholder: None,
                keywords: None,
                contributes: None,
                capabilities: None,
                hidden: hidden.then_some(true),
            },
            capabilities: Vec::new(),
            marker,
        })
    }

    fn ranked(plugin_id: &str, title: &str) -> RankedResult {
        RankedResult {
            plugin_id: plugin_id.to_string(),
            plugin_title: plugin_id.to_string(),
            command: "open".to_string(),
            item: ResultItem {
                id: "command:open".to_string(),
                title: title.to_string(),
                subtitle: None,
                icon: None,
                score: None,
                action: json!({ "type": "command", "command": "open" }),
                actions: None,
                detail: None,
            },
            item_key: format!("{plugin_id}:open:00000000"),
            score: 1.0,
            title_match: None,
            pinned: Some(false),
            from_history: None,
            stale: None,
        }
    }

    #[test]
    fn entry_commands_keeps_one_openable_entry_per_plugin() {
        let entries = vec![
            command("host-manager", "hosts", CommandMode::View, true, false, 1),
            command("host-manager", "hosts-read", CommandMode::Script, false, false, 2),
            command("app-launcher", "search", CommandMode::Script, false, false, 3),
            command("app-launcher", "refresh", CommandMode::NoView, true, false, 4),
            command("internal-settings", "settings", CommandMode::View, true, false, 5),
            command("internal-settings", "manage", CommandMode::View, true, false, 6),
            command("odd", "panel", CommandMode::View, false, false, 7),
        ];
        let picked: Vec<(String, String)> =
            entry_commands(entries).iter().map(|entry| (entry.plugin_id.clone(), entry.decl.name.clone())).collect();
        assert_eq!(
            picked,
            vec![
                ("host-manager".to_string(), "hosts".to_string()),
                ("internal-settings".to_string(), "settings".to_string()),
                ("odd".to_string(), "panel".to_string()),
            ],
            "每插件一条：view 命令优先、清单顺序里第一条可搜索的胜出；只有脚本命令的插件（应用启动器）不出现"
        );
    }

    #[test]
    fn entry_commands_skip_hidden_view_commands() {
        let entries = vec![
            command("a", "secret", CommandMode::View, true, true, 1),
            command("a", "open", CommandMode::View, true, false, 2),
            command("b", "hidden-only", CommandMode::View, true, true, 3),
        ];
        let picked: Vec<(String, String)> =
            entry_commands(entries).iter().map(|entry| (entry.plugin_id.clone(), entry.decl.name.clone())).collect();
        assert_eq!(picked, vec![("a".to_string(), "open".to_string())], "hidden 的 view 命令不算入口");
    }

    #[test]
    fn plugin_entries_sort_recent_first_then_title() {
        let mut entries = vec![
            (None, ranked("c", "C 插件")),
            (Some(100), ranked("a", "A 插件")),
            (None, ranked("b", "B 插件")),
            (Some(300), ranked("d", "D 插件")),
        ];
        sort_plugin_entries(&mut entries);
        let order: Vec<&str> = entries.iter().map(|(_, item)| item.plugin_id.as_str()).collect();
        assert_eq!(order, vec!["d", "a", "b", "c"], "打开过的按最近倒序在前，没用过的按标题排在后面");
    }

    #[test]
    fn plugin_key_prefers_command_action() {
        let command_item = ResultItem {
            id: "app:/Applications/Safari.app".to_string(),
            title: "Safari".to_string(),
            subtitle: None,
            icon: None,
            score: None,
            action: json!({ "type": "command", "command": "open", "args": { "path": "/Applications/Safari.app" } }),
            actions: None,
            detail: None,
        };
        assert_eq!(plugin_key_of(&command_item), "open");

        let open_item = ResultItem { action: json!({ "type": "open", "target": "https://x" }), ..command_item.clone() };
        assert_eq!(plugin_key_of(&open_item), "app:/Applications/Safari.app");
    }

    #[test]
    fn icon_resolution_passes_lucide_and_joins_relative() {
        assert!(is_passthrough_icon("terminal"));
        assert!(is_passthrough_icon("lucide:terminal"));
        assert!(is_passthrough_icon("data:image/png;base64,xxx"));
        assert!(!is_passthrough_icon("./icons/app.png"));
        assert!(!is_passthrough_icon("icons/app.png"));
    }

    #[test]
    fn snapshot_action_falls_back_to_command() {
        let from_snapshot = snapshot_action("open", None, Some(&json!({ "type": "copy", "text": "x" })));
        assert_eq!(from_snapshot["type"], "copy");

        let fallback = snapshot_action("open", Some(&json!({ "path": "/tmp" })), None);
        assert_eq!(fallback["type"], "command");
        assert_eq!(fallback["command"], "open");
        assert_eq!(fallback["args"]["path"], "/tmp");

        let bare = snapshot_action("open", None, None);
        assert!(bare.get("args").is_none(), "没有 args 时不写字段");
    }
}
