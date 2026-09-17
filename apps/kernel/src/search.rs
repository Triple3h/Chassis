//! 搜索调度（v1 `apps/kernel/src/search.ts`；requirements §7.6）。
//!
//! debounce 在 UI 侧（80ms）；这里负责广播 / 合并 / 去重 / 排序 / 防抖稳定。
//! 与 v1 的差异：不做同 query 的 in-flight 复用（UI 侧 80ms debounce 之后重复请求概率极低，
//! 复用需要共享 future，收益不抵复杂度）。

use std::collections::HashSet;
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
            return SearchResponse {
                token,
                query: query.clone(),
                groups: SearchGroups { pinned: self.pinned_results(""), best: Vec::new(), recent: self.recent_results("") },
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

        SearchResponse { token, query: query.to_string(), groups: SearchGroups { pinned, best, recent }, pending }
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
