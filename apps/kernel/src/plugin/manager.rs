//! 插件生命周期（v1 `apps/kernel/src/plugin.ts`；requirements §7.4）：
//! `discovered → validating → loading → active → (disabled | error | crashed | degraded)`。
//!
//! **v2 差异**：逻辑层插件是子进程、视图层插件在 iframe 里，都不再有 in-process
//! `PluginContext` —— 装配期裁剪（P5）改由 `bridge.rs` 与 exec 的 RPC 入口按能力校验，
//! 这里只负责记录「实际授予的能力」并维护状态机 / 命令注册 / listener / 数据目录。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::audit::{AuditInput, AuditLog};
use crate::config::ConfigStore;
use crate::error::{KernelError, Result};
use crate::events::{names, EventBus};
use crate::exec::ScriptRuntime;
use crate::http::plugin_servers::PluginServerPool;
use crate::http::server::LogFn;
use crate::legacy::legacy_data_dir_ids;
use crate::manifest::{
    global_command_id, is_command_name, validate_manifest, CommandDecl, CommandMode, ManifestIssue, PluginManifest, SettingValue,
};
use crate::overrides::{command_keywords_of, merge_keywords, plugin_keywords_of, OverrideStore, PluginOverride};
use crate::plugin_settings::{effective_settings, sanitize_setting_values, PluginSettingStore};
use crate::registry::{CommandRegistry, RegisteredCommand};
use crate::session::SessionManager;
use crate::types::{Disposer, SessionCloseReason};
use crate::util::fsx::{ensure_dir, path_exists, plugin_data_path};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginState {
    Discovered,
    Validating,
    Loading,
    Active,
    Disabled,
    Error,
    Crashed,
    Degraded,
}

impl PluginState {
    pub fn as_str(self) -> &'static str {
        match self {
            PluginState::Discovered => "discovered",
            PluginState::Validating => "validating",
            PluginState::Loading => "loading",
            PluginState::Active => "active",
            PluginState::Disabled => "disabled",
            PluginState::Error => "error",
            PluginState::Crashed => "crashed",
            PluginState::Degraded => "degraded",
        }
    }
}

#[derive(Debug, Clone)]
pub struct PluginRecord {
    pub id: String,
    pub dir: PathBuf,
    pub builtin: bool,
    pub manifest: Option<PluginManifest>,
    pub state: PluginState,
    pub error: Option<String>,
    /// 实际授予的能力 = 声明 − 用户拒绝
    pub capabilities: HashSet<String>,
    pub denied: HashSet<String>,
    pub dev_url: Option<String>,
    pub command_errors: HashMap<String, String>,
    pub failure_count: u32,
    pub listener_port: Option<u16>,
}

pub type EntryResolver = Arc<dyn Fn(&str, &str) -> Option<PathBuf> + Send + Sync>;

pub struct PluginManagerDeps {
    pub data_root: PathBuf,
    /// 出厂插件根目录（可多个；开发态默认就是仓库根的 `plugins/`；靠后的同名插件覆盖靠前的）
    pub builtin_roots: Vec<PathBuf>,
    pub config: Arc<ConfigStore>,
    pub overrides: Arc<OverrideStore>,
    pub plugin_settings: Arc<PluginSettingStore>,
    pub audit: Arc<AuditLog>,
    pub bus: EventBus,
    pub registry: Arc<CommandRegistry>,
    pub sessions: Arc<SessionManager>,
    pub servers: Arc<PluginServerPool>,
    pub exec: Arc<ScriptRuntime>,
    /// 逻辑层产物查找（= `ScriptRuntime::resolve_entry`）：`validateEntries` 与运行时必须一致
    pub resolve_entry: EntryResolver,
    pub log: LogFn,
    pub on_changed: Arc<dyn Fn() + Send + Sync>,
}

struct LoadedPlugin {
    disposers: Vec<(Disposer, String)>,
}

pub struct PluginManager {
    deps: PluginManagerDeps,
    records: Mutex<HashMap<String, PluginRecord>>,
    loaded: Mutex<HashMap<String, LoadedPlugin>>,
    stop_flag: AtomicBool,
    /// 出厂身份表：`id → 是否 essential`，只从出厂 bundle 的清单读（见 `builtin_identity`）。
    builtin_identity: Mutex<HashMap<String, bool>>,
}

impl PluginManager {
    pub fn new(deps: PluginManagerDeps) -> Self {
        Self {
            deps,
            records: Mutex::new(HashMap::new()),
            loaded: Mutex::new(HashMap::new()),
            stop_flag: AtomicBool::new(false),
            builtin_identity: Mutex::new(HashMap::new()),
        }
    }

    fn records(&self) -> std::sync::MutexGuard<'_, HashMap<String, PluginRecord>> {
        self.records.lock().unwrap_or_else(|err| err.into_inner())
    }

    fn log(&self, level: &'static str, message: &str) {
        (self.deps.log)(level, message);
    }

    // ── 查询 ────────────────────────────────────────────────────

    pub fn list(&self) -> Vec<PluginRecord> {
        let mut items: Vec<PluginRecord> = self.records().values().cloned().collect();
        items.sort_by(|a, b| a.id.cmp(&b.id));
        items
    }

    pub fn get(&self, id: &str) -> Option<PluginRecord> {
        self.records().get(id).cloned()
    }

    pub fn dir_of(&self, id: &str) -> Option<PathBuf> {
        self.records().get(id).map(|record| record.dir.clone())
    }

    pub fn title_of(&self, id: &str) -> String {
        self.records()
            .get(id)
            .and_then(|record| record.manifest.as_ref().map(|manifest| manifest.title.clone()))
            .unwrap_or_else(|| id.to_string())
    }

    pub fn data_path_for(&self, id: &str) -> PathBuf {
        plugin_data_path(&self.deps.data_root, id)
    }

    pub fn capabilities_of(&self, id: &str) -> HashSet<String> {
        self.records().get(id).map(|record| record.capabilities.clone()).unwrap_or_default()
    }

    /// 声明了某能力、当前处于 active、且没被用户拒绝的插件。
    ///
    /// `clipboard.watch` 这类「事件 → 拉起插件」的能力用它找订阅者：
    /// 已禁用 / 能力被用户拒绝的插件**不能**被拉起（拒绝就是拒绝，§8 规则 3）。
    pub fn plugins_with_capability(&self, capability: &str) -> Vec<String> {
        let records = self.records();
        let mut ids: Vec<String> = records
            .iter()
            .filter(|(_, record)| {
                matches!(record.state, PluginState::Active | PluginState::Degraded) && record.capabilities.contains(capability)
            })
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }

    pub fn is_active(&self, id: &str) -> bool {
        matches!(
            self.records().get(id).map(|record| record.state),
            Some(PluginState::Active) | Some(PluginState::Degraded)
        )
    }

    /// 底座基础能力：出厂 bundle 里声明了 `essential` 的插件 —— **不可禁用**。
    ///
    /// 只认**出厂身份表**（`builtin_identity`），不看当前生效目录的清单：否则把一个
    /// 声明 `essential: true` 的版本放进 `extensions/` 覆盖掉非 essential 的出厂插件，
    /// 就能白拿「不可禁用 + 免审计」（`audit.set_exempt` 走的就是这里）——权限提升。
    ///
    /// 出厂身份表里查不到（bundle 清单读不出）时按 `true` 处理：宁可不让覆盖，也不放过。
    pub fn is_essential(&self, id: &str) -> bool {
        let builtin = self.records().get(id).map(|record| record.builtin).unwrap_or(false);
        if !builtin {
            return false;
        }
        self.identity_guard().get(id).copied().unwrap_or(true)
    }

    /// 出厂身份表里声明了 `essential`（与「当前生效目录 / 是否已装载」无关）。
    ///
    /// 安装路径用它做二次拒绝：`is_essential` 依赖 `record.builtin`，而插件可能因平台过滤
    /// 根本没进 records（`screen-recorder` 在 Windows 上就是）——那种情况下也必须拒绝覆盖。
    pub fn is_declared_essential(&self, id: &str) -> bool {
        self.identity_guard().get(id).copied().unwrap_or(false)
    }

    /// 该插件当前是否被 `extensions/` 下的目录覆盖（= 装的不是 App 自带的那份）。
    pub fn has_extension_override(&self, id: &str) -> bool {
        let Some(record) = self.records().get(id).cloned() else {
            return false;
        };
        record.dir.starts_with(self.deps.data_root.join("extensions"))
    }

    fn identity_guard(&self) -> std::sync::MutexGuard<'_, HashMap<String, bool>> {
        self.builtin_identity.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// 该插件的条目是否不进「最近使用」（清单 `history: false`）。
    /// 与 `is_essential` 不同，这里**不限制**只有出厂插件能声明（影响面只有它自己）。
    pub fn excludes_history(&self, id: &str) -> bool {
        self.records()
            .get(id)
            .and_then(|record| record.manifest.as_ref())
            .map(|manifest| manifest.history == Some(false))
            .unwrap_or(false)
    }

    pub fn is_command_alive(&self, plugin_id: &str, command: &str) -> bool {
        if !self.is_active(plugin_id) {
            return false;
        }
        self.records()
            .get(plugin_id)
            .and_then(|record| record.manifest.as_ref())
            .map(|manifest| manifest.commands.iter().any(|decl| decl.name == command))
            .unwrap_or(false)
    }

    /// 历史 / 固定项里的「这条结果还能用吗」（requirements §7.5 的置灰判定）。
    /// `command` 可能不是命令名而是结果项 id（`app:/…`、`web:…`），那种情况无从校验，
    /// 只要插件仍可用就不置灰。
    pub fn is_result_alive(&self, plugin_id: &str, command: &str) -> bool {
        if !self.is_active(plugin_id) {
            return false;
        }
        if !is_command_name(command) {
            return true;
        }
        self.is_command_alive(plugin_id, command)
    }

    /// 插件静态资源基址（相对路径图标 → 绝对 URL）。
    pub fn base_url_for(&self, plugin_id: &str) -> Option<String> {
        let record = self.records().get(plugin_id).cloned()?;
        if let Some(dev_url) = record.dev_url {
            return Some(dev_url.trim_end_matches('/').to_string());
        }
        record.listener_port.map(|port| format!("http://127.0.0.1:{port}"))
    }

    /// 会话的期望 origin（UI 侧用它校验 postMessage 来源）。
    pub fn session_origin_for(&self, plugin_id: &str) -> Option<String> {
        let record = self.records().get(plugin_id).cloned()?;
        if let Some(dev_url) = record.dev_url {
            return origin_of(&dev_url);
        }
        record.listener_port.map(|port| format!("http://127.0.0.1:{port}"))
    }

    /// script / no-view 的生效设置（子进程启动时注入 `--launcher-context` 的 `settings`）。
    /// 声明里删掉的键与类型对不上的残留值会被过滤掉。
    pub fn settings_of(&self, plugin_id: &str) -> HashMap<String, SettingValue> {
        let decls = self
            .records()
            .get(plugin_id)
            .and_then(|record| record.manifest.as_ref())
            .and_then(|manifest| manifest.settings.clone())
            .unwrap_or_default();
        if decls.is_empty() {
            return HashMap::new();
        }
        let user_values = self.deps.plugin_settings.get_for(plugin_id);
        let raw = user_values.as_ref().map(|map| serde_json::to_value(map).unwrap_or(Value::Null));
        let values = sanitize_setting_values(raw.as_ref(), &decls);
        effective_settings(&decls, Some(&values))
    }

    /// 管理面 / HTTP API 用的完整视图（字段与 v1 `PluginRuntimeInfo` 逐项对齐）。
    pub fn info(&self) -> Vec<Value> {
        let overrides = self.deps.overrides.get();
        self.list()
            .into_iter()
            .map(|record| {
                let override_entry = overrides.get(&record.id);
                let manifest = record.manifest.clone();
                let plugin_keywords =
                    plugin_keywords_of(manifest.as_ref().and_then(|manifest| manifest.keywords.as_ref()), override_entry);
                let mut entry = json!({
                    "id": record.id,
                    "title": manifest.as_ref().map(|manifest| manifest.title.clone()).unwrap_or_else(|| record.id.clone()),
                    "version": manifest.as_ref().map(|manifest| manifest.version.clone()).unwrap_or_else(|| "0.0.0".to_string()),
                    "apiVersion": manifest.as_ref().map(|manifest| manifest.api_version.clone()).unwrap_or_else(|| "1".to_string()),
                    "capabilities": record.capabilities.iter().cloned().collect::<Vec<_>>(),
                    "deniedCapabilities": record.denied.iter().cloned().collect::<Vec<_>>(),
                    "keywords": plugin_keywords,
                    "keywordsCustomized": override_entry.and_then(|value| value.keywords.as_ref()).is_some(),
                    "settings": self.settings_info(&record),
                    "commands": commands_info(&record, override_entry, manifest.as_ref()),
                    "state": record.state.as_str(),
                    "builtin": record.builtin,
                    "essential": self.is_essential(&record.id),
                    "dir": record.dir,
                });
                if let Some(manifest) = manifest.as_ref() {
                    if let Some(description) = &manifest.description {
                        entry["description"] = json!(description);
                    }
                    if let Some(author) = &manifest.author {
                        entry["author"] = json!(author);
                    }
                    if let Some(icon) = &manifest.icon {
                        entry["icon"] = json!(icon);
                    }
                }
                if let Some(error) = &record.error {
                    entry["error"] = json!(error);
                }
                if let Some(dev_url) = &record.dev_url {
                    entry["devUrl"] = json!(dev_url);
                }
                entry
            })
            .collect()
    }

    /// 设置页用的视图：清单声明 + 生效值（用户值优先，回落 default）。
    fn settings_info(&self, record: &PluginRecord) -> Vec<Value> {
        let decls = record.manifest.as_ref().and_then(|manifest| manifest.settings.clone()).unwrap_or_default();
        if decls.is_empty() {
            return Vec::new();
        }
        let values = self.deps.plugin_settings.get_for(&record.id);
        decls
            .into_iter()
            .map(|decl| {
                let user_value = values.as_ref().and_then(|map| map.get(&decl.key));
                let effective = user_value.cloned().or_else(|| decl.default.clone());
                let mut entry = json!({
                    "key": decl.key,
                    "type": decl.kind,
                    "title": decl.title,
                    "customized": user_value.is_some(),
                });
                if let Some(description) = &decl.description {
                    entry["description"] = json!(description);
                }
                if let Some(default) = &decl.default {
                    entry["default"] = serde_json::to_value(default).unwrap_or(Value::Null);
                }
                if let Some(options) = &decl.options {
                    entry["options"] = serde_json::to_value(options).unwrap_or(Value::Null);
                }
                if let Some(effective) = &effective {
                    entry["value"] = serde_json::to_value(effective).unwrap_or(Value::Null);
                }
                entry
            })
            .collect()
    }

    /// 覆盖层改动后重新落进命令注册表（不用重载插件、更不用重启）：
    /// 只是登记表里的 `keywords` 变了 —— 下一次搜索立刻用新值。
    pub fn apply_overrides(&self, plugin_id: &str) {
        let Some(record) = self.get(plugin_id) else { return };
        let Some(manifest) = record.manifest else { return };
        let override_store = self.deps.overrides.get_for(plugin_id);
        let plugin_keywords = plugin_keywords_of(manifest.keywords.as_ref(), override_store.as_ref());
        for decl in &manifest.commands {
            let command_keywords = command_keywords_of(decl.keywords.as_ref(), override_store.as_ref(), &decl.name);
            self.deps.registry.update(
                &global_command_id(plugin_id, &decl.name),
                crate::registry::CommandPatch { keywords: Some(merge_keywords(&plugin_keywords, &command_keywords)) },
            );
        }
    }

    // ── 装配 ────────────────────────────────────────────────────

    pub async fn init(self: &Arc<Self>) {
        self.scan().await;
        self.prune_essential_disabled();
        for record in self.list() {
            if self.deps.config.get().disabled.contains(&record.id) {
                self.set_state(&record.id, |entry| {
                    entry.state = PluginState::Disabled;
                });
                continue;
            }
            // 加载失败的原因由 `load()` 自己记（reload / 安装路径也同样受益）
            let _ = self.load(&record.id).await;
        }
        let active = self.list().iter().filter(|record| matches!(record.state, PluginState::Active | PluginState::Degraded)).count();
        let total = self.records().len();
        self.log("info", &format!("插件装配完成：{active}/{total} 激活"));
    }

    /// 基础能力不可禁用：配置里若残留它们的禁用项（手改配置 / 旧版本留下的），一律忽略并清掉 ——
    /// 否则「设置与插件管理」被禁用后就再没有界面能把它改回来（自救入口没了）。
    fn prune_essential_disabled(&self) {
        let disabled = self.deps.config.get().disabled;
        if disabled.is_empty() {
            return;
        }
        // 只看出厂身份表（不看当前生效目录的清单）：与 `is_essential` 同一口径
        let mut kept: Vec<String> = Vec::new();
        let mut dropped: Vec<String> = Vec::new();
        for id in disabled {
            if self.is_essential(&id) {
                dropped.push(id);
            } else {
                kept.push(id);
            }
        }
        if dropped.is_empty() {
            return;
        }
        let _ = self.deps.config.patch(&json!({ "disabled": kept }));
        self.log("info", &format!("基础能力不可禁用：已忽略配置中的禁用项（{}）", dropped.join(", ")));
    }

    /// 监听 extensions/：新增 / 更新 / 删除自动热重载。
    ///
    /// v2 用**快照轮询**（2s + 连续两次一致才触发）替代 v1 的 chokidar：无额外依赖、跨平台行为一致，
    /// 且天然满足 v1 `awaitWriteFinish` 的「别在写一半时触发」。
    pub fn start_watcher(self: &Arc<Self>) {
        let manager = self.clone();
        tokio::spawn(async move {
            let dir = manager.deps.data_root.join("extensions");
            let _ = ensure_dir(&dir);
            let mut previous: Option<HashMap<String, u64>> = None;
            let mut pending: Option<HashMap<String, u64>> = None;
            while !manager.stop_flag.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let snapshot = snapshot_extensions(&dir);
                if previous.as_ref() == Some(&snapshot) {
                    continue;
                }
                // 第一次看到变化先按住，等下一次快照一致（写盘中的文件会让快照抖动）
                if pending.as_ref() != Some(&snapshot) {
                    pending = Some(snapshot);
                    continue;
                }
                let changed: Vec<String> = match &previous {
                    Some(before) => {
                        let mut ids: Vec<String> = snapshot
                            .keys()
                            .filter(|id| before.get(*id) != snapshot.get(*id))
                            .cloned()
                            .collect();
                        ids.extend(before.keys().filter(|id| !snapshot.contains_key(*id)).cloned());
                        ids.sort();
                        ids.dedup();
                        ids
                    }
                    // 首次建立基线不算变化
                    None => Vec::new(),
                };
                previous = Some(snapshot);
                pending = None;
                if !changed.is_empty() {
                    manager.reconcile(changed).await;
                }
            }
        });
    }

    pub async fn reconcile(self: &Arc<Self>, ids: Vec<String>) {
        self.scan().await;
        for id in ids {
            let exists = self.records().contains_key(&id);
            if !exists {
                if self.loaded.lock().unwrap_or_else(|err| err.into_inner()).contains_key(&id) {
                    self.disable(&id, SessionCloseReason::Disable).await;
                }
                continue;
            }
            if self.deps.config.get().disabled.contains(&id) {
                continue;
            }
            if let Err(err) = self.reload(&id).await {
                self.log("error", &format!("目录变化重载失败：{id}（{}）", err.message));
            }
        }
    }

    /// 扫描出厂 bundle 与用户 extensions 目录。
    ///
    /// 目录识别规则（统一 install 与 scan）：若 `<dir>/dist/package.json` 存在，
    /// 则 `<dir>/dist` 才是插件根；否则 `<dir>` 本身是插件根。插件 id 以清单里的 `name` 为准。
    pub async fn scan(self: &Arc<Self>) {
        // 出厂身份表先建好：`extensions` 是最后一个 root，扫描到它时要能查「这个 id 是不是 essential」
        let identity = self.collect_builtin_identity();
        *self.identity_guard() = identity.clone();

        let mut found: HashMap<String, (PathBuf, bool)> = HashMap::new();
        let mut roots: Vec<(PathBuf, bool)> = self.deps.builtin_roots.iter().map(|root| (root.clone(), true)).collect();
        roots.push((self.deps.data_root.join("extensions"), false));

        for (root, builtin) in roots {
            for entry in std::fs::read_dir(&root).into_iter().flatten().flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let dir = entry.path();
                let candidate = if path_exists(&dir.join("dist").join("package.json")) { dir.join("dist") } else { dir };
                let pkg_path = candidate.join("package.json");
                if !path_exists(&pkg_path) {
                    continue;
                }
                let mut id = name.clone();
                if let Ok(raw) = std::fs::read_to_string(&pkg_path) {
                    if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                        if let Some(candidate_id) = value.get("name").and_then(Value::as_str) {
                            if crate::manifest::is_plugin_id(candidate_id) {
                                id = candidate_id.to_string();
                            }
                        }
                        if let Some((level, message)) = platform_skip_reason(&id, &value, builtin) {
                            self.log(level, &message);
                            continue;
                        }
                    }
                }
                // 更新机制（M7）的装配前提：`extensions` 可以覆盖**非 essential** 的出厂插件，
                // 覆盖后 `builtin` 仍是 true（不可卸载、可禁用，与出厂插件同等待遇）。
                // essential 的三个是底座基础能力，永不被外部目录顶替。
                let overriding = !builtin && found.contains_key(&id);
                if overriding {
                    if identity.get(&id).copied().unwrap_or(true) {
                        self.log("warn", &format!("忽略 extensions 下的 {id}：出厂基础插件不可被覆盖"));
                        continue;
                    }
                    // 覆盖目录的清单必须读得出且合法，否则回落到出厂版本 ——
                    // 一次坏下载 / 不兼容的新版本不能把插件变成「没有」
                    if let Err(issue) = read_manifest(&candidate).await {
                        self.log("warn", &format!("忽略 extensions 下的 {id}：清单不可用（{}）", issue.message));
                        continue;
                    }
                }
                let builtin_flag = if overriding { true } else { builtin };
                found.insert(id, (candidate, builtin_flag));
            }
        }

        {
            let mut records = self.records();
            for (id, (dir, builtin)) in &found {
                match records.get_mut(id) {
                    Some(existing) => {
                        existing.dir = dir.clone();
                        existing.builtin = *builtin;
                    }
                    None => {
                        records.insert(
                            id.clone(),
                            PluginRecord {
                                id: id.clone(),
                                dir: dir.clone(),
                                builtin: *builtin,
                                manifest: None,
                                state: PluginState::Discovered,
                                error: None,
                                capabilities: HashSet::new(),
                                denied: HashSet::new(),
                                dev_url: None,
                                command_errors: HashMap::new(),
                                failure_count: 0,
                                listener_port: None,
                            },
                        );
                    }
                }
            }
        }

        let vanished: Vec<String> = self.records().keys().filter(|id| !found.contains_key(*id)).cloned().collect();
        for id in vanished {
            let _ = self.disable(&id, SessionCloseReason::Disable).await;
            self.records().remove(&id);
        }
        let builtin_count = found.values().filter(|(_, builtin)| *builtin).count();
        self.log(
            "info",
            &format!("插件扫描：发现 {} 个（出厂 {builtin_count} / 扩展 {}）", found.len(), found.len() - builtin_count),
        );
    }

    /// 出厂身份表：`id → essential`，只从出厂 bundle 的清单读（`builtin_roots`，靠后覆盖靠前）。
    ///
    /// 它是「谁是底座基础能力」的唯一真源 —— 与当前生效目录解耦，覆盖版本改清单也拿不到特权。
    /// 读不出清单的 id 不进表（随后按「查不到 ⇒ essential」的保守口径处理）。
    fn collect_builtin_identity(&self) -> HashMap<String, bool> {
        let mut identity: HashMap<String, bool> = HashMap::new();
        for root in &self.deps.builtin_roots {
            for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let dir = entry.path();
                let candidate = if path_exists(&dir.join("dist").join("package.json")) { dir.join("dist") } else { dir };
                let Ok(raw) = std::fs::read_to_string(candidate.join("package.json")) else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                let id = value
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|id| crate::manifest::is_plugin_id(id))
                    .unwrap_or(name.as_str())
                    .to_string();
                identity.insert(id, value.get("essential").and_then(Value::as_bool).unwrap_or(false));
            }
        }
        identity
    }

    // ── 加载 / 停用 ─────────────────────────────────────────────

    pub async fn load(self: &Arc<Self>, id: &str) -> Result<PluginRecord> {
        let Some(record) = self.get(id) else {
            return Err(KernelError::not_found(format!("插件不存在：{id}")));
        };
        if self.is_active(id) {
            return Ok(record);
        }

        self.set_state(id, |entry| {
            entry.state = PluginState::Validating;
            entry.error = None;
            entry.command_errors.clear();
            // 失败计数只在「本次加载之后」有效：不清零的话，重载后一次失败就可能直接判降级
            entry.failure_count = 0;
        });

        let manifest = match read_manifest(&record.dir).await {
            Ok(manifest) => manifest,
            Err(issue) => {
                self.set_state(id, |entry| {
                    entry.state = PluginState::Error;
                    entry.error = Some(issue.message.clone());
                });
                self.log("error", &format!("插件加载失败：{id}（{}：{}）", issue.code, issue.message));
                self.emit_changed();
                return Err(KernelError::new(issue.code, issue.message));
            }
        };
        self.set_state(id, |entry| {
            entry.manifest = Some(manifest.clone());
        });

        let declared = resolve_capabilities(&manifest);
        let denied_config = self.deps.config.get().denied.get(id).cloned().unwrap_or_default();
        let denied: HashSet<String> = denied_config.into_iter().filter(|capability| declared.contains(capability)).collect();
        let granted: HashSet<String> = declared.iter().filter(|capability| !denied.contains(*capability)).cloned().collect();
        self.set_state(id, |entry| {
            entry.capabilities = granted.clone();
            entry.denied = denied.clone();
        });
        for capability in &denied {
            self.deps.audit.record(AuditInput {
                plugin_id: id.to_string(),
                channel: "kernel",
                method: "capability.denied".to_string(),
                ok: false,
                ms: 0,
                capability: Some(capability.clone()),
                error: Some(crate::contract::ErrorShape {
                    code: "CAPABILITY_DENIED".to_string(),
                    message: format!("用户拒绝了能力：{capability}"),
                }),
                args: None,
            });
        }
        if !denied.is_empty() {
            let mut list: Vec<&str> = denied.iter().map(String::as_str).collect();
            list.sort();
            self.log("warn", &format!("插件 {id} 有 {} 项能力被用户拒绝：{}", denied.len(), list.join(", ")));
        }

        self.validate_entries(id, &manifest).await;
        self.adopt_legacy_data_dir(id).await;

        self.set_state(id, |entry| entry.state = PluginState::Loading);
        let dev_url = self.deps.config.get().dev_plugins.get(id).cloned();
        if let Some(dev_url) = dev_url {
            self.set_state(id, |entry| {
                entry.dev_url = Some(dev_url);
                entry.listener_port = None;
            });
        } else {
            self.set_state(id, |entry| {
                entry.dev_url = None;
            });
            match self.deps.servers.start(id, record.dir.clone()).await {
                Ok(listener) => {
                    self.set_state(id, |entry| entry.listener_port = Some(listener.port));
                }
                Err(err) => {
                    self.set_state(id, |entry| {
                        entry.state = PluginState::Error;
                        entry.error = Some(format!("插件页服务启动失败：{}", err.message));
                    });
                    self.log("error", &format!("插件加载失败：{id}（插件页服务启动失败：{}）", err.message));
                    self.emit_changed();
                    return self.get(id).ok_or_else(|| KernelError::not_found(format!("插件不存在：{id}")));
                }
            }
        }

        // 注册的是「清单 + 用户覆盖层」的合并结果：keywords = 插件级 ∪ 命令级
        let command_errors = self.get(id).map(|record| record.command_errors).unwrap_or_default();
        let mut disposers: Vec<(Disposer, String)> = Vec::new();
        for decl in merge_command_decls(&manifest, self.deps.overrides.get_for(id).as_ref()) {
            if command_errors.contains_key(&decl.name) {
                continue;
            }
            let entry = RegisteredCommand {
                id: global_command_id(id, &decl.name),
                plugin_id: id.to_string(),
                plugin_title: manifest.title.clone(),
                capabilities: unified_capabilities(&manifest, &decl),
                decl: decl.clone(),
                marker: 0,
            };
            match self.deps.registry.register(entry) {
                Ok(dispose) => disposers.push((dispose, format!("command({})", decl.name))),
                Err(message) => self.log("warn", &format!("命令注册失败：{id}:{}（{message}）", decl.name)),
            }
        }
        self.loaded.lock().unwrap_or_else(|err| err.into_inner()).insert(id.to_string(), LoadedPlugin { disposers });

        self.set_state(id, |entry| entry.state = PluginState::Active);
        self.log(
            "info",
            &format!(
                "插件已激活：{id} v{}（{}，{} 条命令）",
                manifest.version,
                if record.builtin { "出厂" } else { "扩展" },
                manifest.commands.len()
            ),
        );
        self.emit_changed();
        self.prewarm_search_sources(id, &manifest);
        self.get(id).ok_or_else(|| KernelError::not_found(format!("插件不存在：{id}")))
    }

    /// 贡献型搜索源：激活后延迟预热，避免第一次输入吃冷启动超时。
    ///
    /// 定时器到点时插件可能已经被禁用 / 重载过 —— 那时 `disable()` 刚把子进程收掉，
    /// 这条迟到的预热会把它**重新拉起来**（且不在 disable 的管辖范围，只能等闲置回收）。
    /// 所以到点先确认插件仍可用。
    fn prewarm_search_sources(self: &Arc<Self>, id: &str, manifest: &PluginManifest) {
        for decl in &manifest.commands {
            if decl.contributes != Some(true) || decl.mode == CommandMode::View {
                continue;
            }
            let manager = self.clone();
            let plugin_id = id.to_string();
            let command = decl.name.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(800)).await;
                if !manager.is_active(&plugin_id) {
                    return;
                }
                manager.deps.exec.prewarm(&plugin_id, &command).await;
            });
        }
    }

    pub async fn disable(self: &Arc<Self>, id: &str, reason: SessionCloseReason) {
        let loaded = self.loaded.lock().unwrap_or_else(|err| err.into_inner()).remove(id);
        if let Some(loaded) = loaded {
            for (dispose, label) in loaded.disposers.into_iter().rev() {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(dispose));
                if outcome.is_err() {
                    self.log("warn", &format!("disposer 失败（{id}/{label}）"));
                }
            }
        }
        self.deps.exec.release_plugin(id).await;
        self.deps.sessions.close_plugin(id, reason);
        self.deps.servers.stop(id).await;
        self.set_state(id, |entry| {
            entry.state = PluginState::Disabled;
            entry.listener_port = None;
            entry.dev_url = None;
        });
        self.log("info", &format!("插件已停用：{id}（{}）", reason.as_str()));
        self.emit_changed();
    }

    pub async fn set_disabled(self: &Arc<Self>, id: &str, disabled: bool) -> Result<()> {
        if disabled && self.is_essential(id) {
            return Err(KernelError::new("FORBIDDEN", format!("「{}」是底座基础能力，不可禁用", self.title_of(id))));
        }
        let config = self.deps.config.get();
        let next: Vec<String> = if disabled {
            let mut list = config.disabled.clone();
            if !list.contains(&id.to_string()) {
                list.push(id.to_string());
            }
            list
        } else {
            config.disabled.iter().filter(|entry| entry.as_str() != id).cloned().collect()
        };
        self.deps
            .config
            .patch(&json!({ "disabled": next }))
            .map_err(|err| KernelError::new("INTERNAL", err.to_string()))?;
        if disabled {
            self.disable(id, SessionCloseReason::Disable).await;
        } else {
            self.load(id).await?;
        }
        Ok(())
    }

    /// 热重载（requirements §7.4）：停用 → 重新读盘 → 加载。
    ///
    /// 原来开着的插件页会话会随停用一起关闭（listener 端口已消失，页面必然失效）；
    /// 重载结束广播 `plugin/reloaded`，由启动台 UI 用同一命令重开页面（新会话 / 新端口）。
    pub async fn reload(self: &Arc<Self>, id: &str) -> Result<PluginRecord> {
        let Some(record) = self.get(id) else {
            return Err(KernelError::not_found(format!("插件不存在：{id}")));
        };
        let was_disabled = record.state == PluginState::Disabled || self.deps.config.get().disabled.contains(&id.to_string());
        // 停用前记下开着的 view 命令，重载成功后交给 UI 重开
        let views: Vec<String> = self.deps.sessions.by_plugin(id).into_iter().map(|session| session.command).collect();
        self.disable(id, SessionCloseReason::Reload).await;
        if was_disabled {
            if let Some(record) = self.get(id) {
                self.set_state(id, |entry| entry.state = PluginState::Disabled);
                return Ok(record);
            }
        }
        match self.load(id).await {
            Ok(loaded) => {
                self.deps.bus.emit(
                    names::PLUGIN_RELOADED,
                    &json!({ "pluginId": id, "commands": views, "ok": self.is_active(id) }),
                );
                Ok(loaded)
            }
            Err(err) => {
                // 加载失败也要通知：UI 不能把死掉的旧页面留在窗口里
                self.deps
                    .bus
                    .emit(names::PLUGIN_RELOADED, &json!({ "pluginId": id, "commands": views, "ok": false }));
                Err(err)
            }
        }
    }

    /// 热重载；失败则退回「直接加载一次」——给「改了权限 / dev 配置后要把插件拉起来」的调用点用。
    pub async fn reload_or_load(self: &Arc<Self>, id: &str) -> Result<PluginRecord> {
        match self.reload(id).await {
            Ok(record) => Ok(record),
            Err(_) => self.load(id).await,
        }
    }

    pub async fn reload_all(self: &Arc<Self>) {
        for record in self.list() {
            if record.state == PluginState::Disabled {
                continue;
            }
            if let Err(err) = self.reload(&record.id).await {
                self.log("error", &format!("重载失败：{}（{}）", record.id, err.message));
            }
        }
    }

    /// view 页崩溃：标记 crashed，不影响其它插件。
    pub fn mark_crashed(&self, id: &str, reason: &str) {
        if self.get(id).is_none() {
            return;
        }
        let reason = reason.to_string();
        self.set_state(id, |entry| {
            entry.state = PluginState::Crashed;
            entry.error = Some(reason.clone());
        });
        self.log("error", &format!("插件页崩溃：{id} {reason}"));
        self.emit_changed();
    }

    /// 脚本失败计数：连续 3 次 → degraded。
    pub fn note_failure(&self, id: &str, command: &str) {
        let Some(mut record) = self.get(id) else { return };
        record.failure_count += 1;
        let failure_count = record.failure_count;
        if failure_count >= 3 && record.state == PluginState::Active {
            let message = format!("命令 {command} 连续失败 {failure_count} 次");
            self.set_state(id, |entry| {
                entry.failure_count = failure_count;
                entry.state = PluginState::Degraded;
                entry.error = Some(message.clone());
            });
            self.log("warn", &format!("插件降级：{id}（{message}）"));
            self.emit_changed();
        } else {
            self.set_state(id, |entry| entry.failure_count = failure_count);
        }
    }

    // ── 安装 / 卸载 ─────────────────────────────────────────────

    pub async fn install_from_directory(self: &Arc<Self>, source_input: &Path, overwrite: bool) -> Result<PluginRecord> {
        // 便利：源码工程（含 dist/）直接拖进来时，装的是 dist/ 的内容（plugin-spec §2.2）
        let source_dir =
            if path_exists(&source_input.join("dist").join("package.json")) { source_input.join("dist") } else { source_input.to_path_buf() };
        let manifest = read_manifest(&source_dir).await.map_err(|issue| KernelError::new(issue.code, issue.message))?;
        // 安装是显式动作：平台不匹配要**明确报错**（不是静默跳过），否则用户不知道装没装上
        if let Some(reason) = manifest.unsupported_reason() {
            return Err(KernelError::new(
                "PLATFORM_MISMATCH",
                format!("插件 {} 不支持当前运行环境：{reason}", manifest.name),
            ));
        }
        // 源目录可能在另一个文件系统（用户挑的目录）⇒ 先落到 data_root 下的 staging，
        // 之后的 rename 才在同一文件系统内（才能原子）。
        let staging = self.staging_dir(&manifest.name);
        let _ = ensure_dir(&staging);
        let outcome = async {
            copy_dir_recursive(&source_dir, &staging)?;
            self.install_prepared(&staging, &manifest, overwrite).await
        }
        .await;
        let _ = std::fs::remove_dir_all(&staging);
        outcome
    }

    /// 把 staging 里的插件换成为生效版本（插件远程更新的内核侧，plugin-spec §6）。
    ///
    /// 与「先删再拷」的旧行为相比，这里保证：**任何失败路径都不会让插件消失** ——
    /// 旧版本先整目录备份，落地只是一次同文件系统内的 rename，起不来就整体回滚。
    /// 用户数据（设置 / 别名 / 历史 / 固定项）按 id 寻址，全都不在插件目录里，天然保留。
    async fn install_prepared(
        self: &Arc<Self>,
        staging: &Path,
        manifest: &PluginManifest,
        overwrite: bool,
    ) -> Result<PluginRecord> {
        let id = manifest.name.clone();
        let extensions = self.deps.data_root.join("extensions");
        let _ = ensure_dir(&extensions);
        let target = extensions.join(&id);

        // essential 出厂插件不接受覆盖（更新器侧已过滤，这里是内核的二次拒绝）
        if self.is_declared_essential(&id) {
            return Err(KernelError::new(
                "ESSENTIAL_PROTECTED",
                format!("「{}」是底座基础能力，不可被覆盖安装", manifest.title),
            ));
        }
        let was_disabled = self.deps.config.get().disabled.contains(&id);
        let existed = self.get(&id).is_some();
        if existed && !overwrite {
            return Err(KernelError::new("PLUGIN_ID_CONFLICT", format!("插件已存在：{id}")));
        }

        // 停用前记下开着的 view 命令：装载成功后交给 UI 用同一命令重开（与 reload() 同语义）
        let views: Vec<String> = self.deps.sessions.by_plugin(&id).into_iter().map(|session| session.command).collect();
        if existed {
            self.disable(&id, SessionCloseReason::Reload).await;
        }

        let backup = match self.move_to_backup(&id, &target).await {
            Ok(path) => path,
            Err(err) => {
                // 备份没做成 ⇒ 旧版本还在原地，直接认输（永不做半替换）
                return Err(KernelError::new("UPDATE_FAILED", format!("备份旧版本失败：{err}（旧版本未改动）")));
            }
        };

        if let Err(err) = rename_with_retry(staging, &target).await {
            let rolled_back = match &backup {
                Some(path) => self.restore_backup(path, &target).await,
                None => false,
            };
            return Err(KernelError::new(
                "UPDATE_FAILED",
                format!("替换插件目录失败：{err}（{}）", rollback_hint(rolled_back, backup.is_none())),
            ));
        }

        self.scan().await;
        let mut outcome = if was_disabled {
            // 已禁用的插件只换文件、不装载（与 reload() 的 was_disabled 分支一致）
            self.get(&id).ok_or_else(|| KernelError::new("MANIFEST_INVALID", "安装后未找到插件目录"))
        } else {
            self.load(&id).await
        };

        if let Err(err) = &outcome {
            let mut rolled_back = false;
            if self.move_to_failed(&id, &target).await {
                if let Some(path) = &backup {
                    rolled_back = self.restore_backup(path, &target).await;
                }
                if rolled_back {
                    self.scan().await;
                    if !was_disabled {
                        let _ = self.load(&id).await;
                    }
                }
            }
            outcome = Err(KernelError::new(
                "UPDATE_FAILED",
                format!("新版本加载失败：{}（{}）", err.message, rollback_hint(rolled_back, backup.is_none())),
            ));
        }

        if outcome.is_ok() {
            self.log(
                "info",
                &format!("插件安装完成：{id} v{}（{}）", manifest.version, if existed { "覆盖更新" } else { "新增" }),
            );
            if !was_disabled {
                self.deps
                    .bus
                    .emit(names::PLUGIN_RELOADED, &json!({ "pluginId": id, "commands": views, "ok": self.is_active(&id) }));
            }
        }
        outcome
    }

    /// staging 目录：与 `extensions/` 同在 data_root 下（rename 才原子）。
    fn staging_dir(&self, id: &str) -> PathBuf {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        self.deps.data_root.join(".staging").join(format!("{id}-{}-{}", crate::util::now_ms(), sequence))
    }

    /// 旧版本整目录挪去 `extensions/.backup/<id>/<版本>`（只保留最近 1 份）。
    ///
    /// 目录以 `.` 开头 ⇒ `scan()` 不会把它当成插件扫进来。
    async fn move_to_backup(&self, id: &str, target: &Path) -> Result<Option<PathBuf>> {
        if !path_exists(target) {
            return Ok(None);
        }
        let version = self
            .get(id)
            .and_then(|record| record.manifest.as_ref().map(|manifest| manifest.version.clone()))
            .unwrap_or_else(|| "0.0.0".to_string());
        let backup_root = self.deps.data_root.join("extensions").join(".backup").join(id);
        let _ = std::fs::remove_dir_all(&backup_root);
        let _ = ensure_dir(&backup_root);
        let destination = backup_root.join(sanitize_dir_name(&version));
        rename_with_retry(target, &destination)
            .await
            .map_err(|err| KernelError::new("UPDATE_FAILED", err.to_string()))?;
        Ok(Some(destination))
    }

    async fn restore_backup(&self, backup: &Path, target: &Path) -> bool {
        let _ = std::fs::remove_dir_all(target);
        rename_with_retry(backup, target).await.is_ok()
    }

    /// 起不来的新版本挪去 `extensions/.failed/<id>-<时间戳>`（供诊断，只保留最近 1 份）。
    async fn move_to_failed(&self, id: &str, target: &Path) -> bool {
        if !path_exists(target) {
            return false;
        }
        let failed_root = self.deps.data_root.join("extensions").join(".failed");
        let _ = ensure_dir(&failed_root);
        let prefix = format!("{id}-");
        for entry in std::fs::read_dir(&failed_root).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
        let destination = failed_root.join(format!("{id}-{}", crate::util::now_ms()));
        rename_with_retry(target, &destination).await.is_ok()
    }

    /// 从 zip 安装（requirements §3.5 / §9「供应链」）：
    /// 只解压到目标目录，拒绝绝对路径、`..`，单文件 ≤ 50MB，解压后 ≤ 200MB。
    pub async fn install_from_zip(self: &Arc<Self>, zip_path: &Path, overwrite: bool) -> Result<PluginRecord> {
        const MAX_FILE: u64 = 50 * 1024 * 1024;
        const MAX_TOTAL: u64 = 200 * 1024 * 1024;

        let file = std::fs::File::open(zip_path).map_err(|err| KernelError::bad_args(format!("zip 无法打开：{err}")))?;
        let mut archive =
            zip::ZipArchive::new(file).map_err(|err| KernelError::bad_args(format!("zip 无法解析：{err}")))?;
        if archive.is_empty() {
            return Err(KernelError::bad_args("zip 是空的"));
        }

        // 第一轮：校验所有条目（路径穿越 / 大小）
        let mut entries: Vec<(String, u64)> = Vec::with_capacity(archive.len());
        let mut total: u64 = 0;
        for index in 0..archive.len() {
            let entry = archive.by_index(index).map_err(|err| KernelError::bad_args(format!("zip 条目无法读取：{err}")))?;
            let name = entry.name().to_string();
            if name.contains('\0') || name.contains("..") || name.starts_with('/') || is_windows_absolute(&name) {
                return Err(KernelError::bad_args(format!("zip 内含非法路径：{name}")));
            }
            let size = entry.size();
            if size > MAX_FILE {
                return Err(KernelError::bad_args(format!("zip 内单文件超过 50MB：{name}")));
            }
            total += size;
            if total > MAX_TOTAL {
                return Err(KernelError::bad_args("zip 解压后超过 200MB"));
            }
            entries.push((name, size));
        }

        // 允许一层包裹目录
        let has_root_pkg = entries.iter().any(|(name, _)| name == "package.json");
        let prefixes: HashSet<&str> = entries.iter().filter_map(|(name, _)| name.split('/').next()).collect();
        let wrapped = (!has_root_pkg && prefixes.len() == 1).then(|| prefixes.iter().next().copied().unwrap_or_default().to_string());

        let staging = self.staging_dir("zip");
        let _ = ensure_dir(&staging);
        let outcome = async {
            for (name, _) in &entries {
                let relative = match &wrapped {
                    Some(prefix) => {
                        let prefix = format!("{prefix}/");
                        if !name.starts_with(&prefix) {
                            continue;
                        }
                        name[prefix.len()..].to_string()
                    }
                    None => name.clone(),
                };
                if relative.is_empty() {
                    continue;
                }
                let destination = staging.join(&relative);
                if let Some(parent) = destination.parent() {
                    let _ = ensure_dir(parent);
                }
                // 目录条目：只建目录
                if relative.ends_with('/') {
                    let _ = ensure_dir(&destination);
                    continue;
                }
                let mut entry = archive
                    .by_name(name)
                    .map_err(|err| KernelError::bad_args(format!("zip 条目无法读取：{name}（{err}）")))?;
                let mut out = std::fs::File::create(&destination)
                    .map_err(|err| KernelError::new("INTERNAL", format!("写入失败：{err}")))?;
                std::io::copy(&mut entry, &mut out).map_err(|err| KernelError::new("INTERNAL", format!("解压失败：{err}")))?;
            }
            // 解压结果已经是插件根（包裹层已在上面剥掉）⇒ 直接走原子替换，不再拷一次
            let manifest = read_manifest(&staging).await.map_err(|issue| KernelError::new(issue.code, issue.message))?;
            if let Some(reason) = manifest.unsupported_reason() {
                return Err(KernelError::new(
                    "PLATFORM_MISMATCH",
                    format!("插件 {} 不支持当前运行环境：{reason}", manifest.name),
                ));
            }
            self.install_prepared(&staging, &manifest, overwrite).await
        }
        .await;
        let _ = std::fs::remove_dir_all(&staging);
        outcome
    }

    pub async fn uninstall(self: &Arc<Self>, id: &str) -> Result<()> {
        let Some(record) = self.get(id) else {
            return Err(KernelError::not_found(format!("插件不存在：{id}")));
        };
        if record.builtin {
            return Err(KernelError::new("FORBIDDEN", "出厂插件不可卸载（可禁用）"));
        }
        self.disable(id, SessionCloseReason::Uninstall).await;
        let _ = std::fs::remove_dir_all(&record.dir);
        // 覆盖层 / 设置值跟着插件走：重装后不该还带着上一份别名与配置
        let _ = self.deps.overrides.clear(id);
        let _ = self.deps.plugin_settings.clear(id);
        self.records().remove(id);
        self.log("info", &format!("插件已卸载：{id}"));
        self.emit_changed();
        Ok(())
    }

    /// 恢复出厂版本：删掉 `extensions/` 下的覆盖，让 App 自带的那份重新生效。
    ///
    /// 这是更新机制的**逃生口** —— 出厂插件不可卸载（`uninstall` 对 builtin 是 FORBIDDEN），
    /// 更新到坏版本后必须有等价动作可回退。返回 `false` = 本来就没有覆盖（不是错误）。
    pub async fn revert_to_builtin(self: &Arc<Self>, id: &str) -> Result<bool> {
        let Some(record) = self.get(id) else {
            return Err(KernelError::not_found(format!("插件不存在：{id}")));
        };
        if !record.builtin {
            return Err(KernelError::new("FORBIDDEN", "只有出厂插件能恢复出厂版本"));
        }
        if !self.has_extension_override(id) {
            return Ok(false);
        }
        let _ = std::fs::remove_dir_all(&record.dir);
        // 备份一起清：否则下一次安装的备份里还躺着那个坏版本
        let _ = std::fs::remove_dir_all(self.deps.data_root.join("extensions").join(".backup").join(id));
        self.log("info", &format!("已恢复出厂版本：{id}（删除 extensions 下的覆盖）"));
        self.scan().await;
        // reload 的语义正是我们需要的：停用旧进程 → 读盘 → 加载 → 广播 plugin/reloaded（UI 重开页面）
        self.reload(id).await?;
        Ok(true)
    }

    pub async fn dispose(self: &Arc<Self>) {
        self.stop_flag.store(true, Ordering::SeqCst);
        for record in self.list() {
            self.disable(&record.id, SessionCloseReason::Shutdown).await;
        }
    }

    // ── 内部 ────────────────────────────────────────────────────

    /// 插件改过 id 时，把旧数据目录整体搬到新 id 下（只复制不删除；新目录已存在则不动）。
    /// 候选见 `legacy_data_dir_ids`：改名过一次只有一个候选，改过两次就逐个试。
    /// 失败只记日志，不阻塞加载。
    async fn adopt_legacy_data_dir(&self, id: &str) {
        let candidates = legacy_data_dir_ids(id);
        if candidates.is_empty() {
            return;
        }
        let next = self.data_path_for(id);
        if path_exists(&next) {
            return;
        }
        for legacy_id in candidates {
            let previous = self.data_path_for(legacy_id);
            if !path_exists(&previous) {
                continue;
            }
            match copy_dir_recursive(&previous, &next) {
                Ok(()) => self.log("info", &format!("已迁移旧插件数据目录：{legacy_id} → {id}")),
                Err(err) => self.log("warn", &format!("旧插件数据目录迁移失败：{legacy_id} → {id}（{err}）")),
            }
            return;
        }
    }

    /// 产物校验（plugin-spec §2.2 / §4.4）：view 要 index.html，逻辑层要可执行产物。
    async fn validate_entries(&self, id: &str, manifest: &PluginManifest) {
        let Some(record) = self.get(id) else { return };
        let mut errors: HashMap<String, String> = HashMap::new();

        let has_view = manifest.commands.iter().any(|decl| decl.mode == CommandMode::View);
        if has_view && !path_exists(&record.dir.join("index.html")) {
            for decl in &manifest.commands {
                if decl.mode == CommandMode::View {
                    errors.insert(decl.name.clone(), "缺少 index.html".to_string());
                }
            }
        }
        for decl in &manifest.commands {
            if decl.mode == CommandMode::View {
                continue;
            }
            if (self.deps.resolve_entry)(id, &decl.name).is_none() {
                errors.insert(decl.name.clone(), format!("缺少可执行产物 {}", decl.name));
            }
        }

        for (name, message) in &errors {
            self.log("warn", &format!("插件 {id} 命令 {name} 不可用：{message}"));
            self.deps.audit.record(AuditInput {
                plugin_id: id.to_string(),
                channel: "kernel",
                method: "plugin.validateEntry".to_string(),
                ok: false,
                ms: 0,
                capability: None,
                error: Some(crate::contract::ErrorShape { code: "ENTRY_MISSING".to_string(), message: message.clone() }),
                args: None,
            });
        }
        if !errors.is_empty() {
            self.set_state(id, |entry| entry.command_errors = errors);
        }
    }

    fn set_state<F: FnOnce(&mut PluginRecord)>(&self, id: &str, mutate: F) {
        if let Some(record) = self.records().get_mut(id) {
            mutate(record);
        }
    }

    fn emit_changed(&self) {
        self.deps.bus.emit(names::PLUGIN_STATE, &json!({ "plugins": self.info() }));
        (self.deps.on_changed)();
    }
}

/// 声明能力 = 插件级 ∪ 各命令级。
pub fn resolve_capabilities(manifest: &PluginManifest) -> HashSet<String> {
    let mut set: HashSet<String> = manifest.capabilities.iter().cloned().collect();
    for decl in &manifest.commands {
        for capability in decl.capabilities.iter().flatten() {
            set.insert(capability.clone());
        }
    }
    set
}

fn unified_capabilities(manifest: &PluginManifest, decl: &CommandDecl) -> Vec<String> {
    let mut list: Vec<String> = manifest.capabilities.clone();
    for capability in decl.capabilities.iter().flatten() {
        if !list.contains(capability) {
            list.push(capability.clone());
        }
    }
    list
}

pub async fn read_manifest(dir: &Path) -> std::result::Result<PluginManifest, ManifestIssue> {
    let raw = match tokio::fs::read_to_string(dir.join("package.json")).await {
        Ok(raw) => raw,
        Err(err) => {
            return Err(ManifestIssue { code: "MANIFEST_INVALID", message: format!("package.json 无法读取：{err}") })
        }
    };
    let value: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(err) => {
            return Err(ManifestIssue { code: "MANIFEST_INVALID", message: format!("package.json 无法解析：{err}") })
        }
    };
    validate_manifest(&value)
}

/// 扫描期的平台过滤判定（plugin-spec §3.5）：返回 `Some((级别, 说明))` = **跳过**。
///
/// 只在「声明合法且明确不含当前运行环境」时跳过；声明写得非法 ⇒ `None`
/// （留给 `load()` 里的 `validate_manifest()` 报 `MANIFEST_INVALID`，用户在设置页看得见，
/// 好过插件无声无息地消失）。出厂基础插件被过滤是异常 ⇒ 提到 `warn`。
fn platform_skip_reason(id: &str, raw: &Value, builtin: bool) -> Option<(&'static str, String)> {
    let reason = crate::manifest::raw_platform_mismatch(raw)?;
    let essential = builtin && raw.get("essential").and_then(Value::as_bool) == Some(true);
    let level = if essential { "warn" } else { "info" };
    let suffix = if essential { "（出厂基础插件被平台过滤，请核对出厂 bundle）" } else { "" };
    Some((level, format!("跳过插件 {id}：{reason}{suffix}")))
}

/// 清单 + 用户覆盖层合并（keywords = 插件级 ∪ 命令级）。
pub fn merge_command_decls(manifest: &PluginManifest, override_store: Option<&PluginOverride>) -> Vec<CommandDecl> {
    let plugin_keywords = plugin_keywords_of(manifest.keywords.as_ref(), override_store);
    manifest
        .commands
        .iter()
        .map(|decl| {
            let command_keywords = command_keywords_of(decl.keywords.as_ref(), override_store, &decl.name);
            let mut merged = decl.clone();
            merged.keywords = Some(merge_keywords(&plugin_keywords, &command_keywords));
            merged
        })
        .collect()
}

fn commands_info(record: &PluginRecord, override_store: Option<&PluginOverride>, manifest: Option<&PluginManifest>) -> Vec<Value> {
    let Some(manifest) = manifest else { return Vec::new() };
    manifest
        .commands
        .iter()
        .map(|decl| {
            let mut entry = json!({
                "name": decl.name,
                "title": decl.title,
                "mode": decl.mode.as_str(),
                "searchable": decl.searchable == Some(true),
                "contributes": decl.contributes == Some(true),
                "hidden": decl.hidden == Some(true),
                "keywords": command_keywords_of(decl.keywords.as_ref(), override_store, &decl.name),
                "keywordsCustomized": override_store
                    .and_then(|value| value.commands.as_ref())
                    .and_then(|commands| commands.get(&decl.name))
                    .and_then(|command| command.keywords.as_ref())
                    .is_some(),
            });
            if let Some(placeholder) = &decl.placeholder {
                entry["placeholder"] = json!(placeholder);
            }
            if let Some(error) = record.command_errors.get(&decl.name) {
                entry["error"] = json!(error);
            }
            entry
        })
        .collect()
}

fn origin_of(url: &str) -> Option<String> {
    let without_scheme = url.split_once("://")?;
    let authority = without_scheme.1.split('/').next()?;
    Some(format!("{}://{authority}", without_scheme.0))
}

fn is_windows_absolute(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// rename 的重试次数 / 间隔：Windows 上插件进程刚被杀，句柄释放会滞后一点
/// （`disable()` 已经回收过，但杀进程是异步的）；失败就整体回滚，不做半替换。
const RENAME_ATTEMPTS: usize = 5;
const RENAME_RETRY_MS: u64 = 200;

async fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last: Option<std::io::Error> = None;
    for _ in 0..RENAME_ATTEMPTS {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(err) => {
                last = Some(err);
                tokio::time::sleep(Duration::from_millis(RENAME_RETRY_MS)).await;
            }
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "rename 失败")))
}

fn rollback_hint(rolled_back: bool, no_backup: bool) -> &'static str {
    if rolled_back {
        "已回滚到旧版本"
    } else if no_backup {
        "本次是首次安装，没有旧版本可回滚"
    } else {
        "未能回滚，请用「恢复出厂版本」或重装"
    }
}

/// 版本号进目录名：非 `[A-Za-z0-9._-]` 一律换成 `-`（版本号来自清单，不可信）。
fn sanitize_dir_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') { ch } else { '-' })
        .collect();
    if cleaned.is_empty() {
        "unknown".to_string()
    } else {
        cleaned
    }
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<()> {
    ensure_dir(target).map_err(|err| KernelError::new("INTERNAL", format!("创建目录失败：{err}")))?;
    let entries = std::fs::read_dir(source).map_err(|err| KernelError::new("INTERNAL", format!("读取目录失败：{err}")))?;
    for entry in entries.flatten() {
        let from = entry.path();
        let to = target.join(entry.file_name());
        let metadata = entry.metadata().map_err(|err| KernelError::new("INTERNAL", err.to_string()))?;
        if metadata.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|err| KernelError::new("INTERNAL", format!("复制失败：{err}")))?;
        }
    }
    Ok(())
}

/// extensions/ 下每个插件目录的「快照指纹」：id → 目录 + package.json 的 mtime（毫秒）。
fn snapshot_extensions(dir: &Path) -> HashMap<String, u64> {
    let mut snapshot = HashMap::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let plugin_dir = entry.path();
        let package_json = plugin_dir.join("package.json");
        let mut stamp = modified_ms(&package_json);
        // index.html 变了也要重载（视图更新），逻辑层产物同理
        stamp = stamp.max(modified_ms(&plugin_dir.join("index.html")));
        snapshot.insert(name.clone(), stamp);
        // 后台构建产物目录（dist）里的 package.json 才是插件根时也要跟着变
        let nested = plugin_dir.join("dist").join("package.json");
        if nested.exists() {
            snapshot.insert(format!("{name}/dist"), modified_ms(&nested));
        }
    }
    snapshot
}

fn modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest_value(name: &str, commands: Value) -> Value {
        json!({
            "name": name,
            "title": "Demo",
            "version": "1.0.0",
            "apiVersion": "2",
            "type": "module",
            "capabilities": ["storage"],
            "commands": commands,
        })
    }

    #[test]
    fn resolve_capabilities_unions_plugin_and_command_levels() {
        let manifest = validate_manifest(&manifest_value(
            "demo",
            json!([{ "name": "show", "title": "Show", "mode": "view", "capabilities": ["shell.open"] }]),
        ))
        .unwrap();
        let declared = resolve_capabilities(&manifest);
        assert!(declared.contains("storage"));
        assert!(declared.contains("shell.open"));
    }

    #[test]
    fn merge_command_decls_unions_plugin_and_command_keywords() {
        let manifest = validate_manifest(&manifest_value(
            "demo",
            json!([{ "name": "show", "title": "Show", "mode": "view", "keywords": ["命令别名"] }]),
        ))
        .unwrap();
        let merged = merge_command_decls(&manifest, None);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].keywords.as_deref().unwrap(), vec!["命令别名".to_string()]);
    }

    #[test]
    fn scan_skips_plugins_that_declare_other_platforms() {
        use crate::manifest::{current_platform, PLATFORMS};
        let other = PLATFORMS.iter().find(|name| **name != current_platform()).copied().unwrap();

        // 声明其它平台 ⇒ 跳过（info）
        let mut raw = manifest_value("demo", json!([{ "name": "show", "title": "Show", "mode": "view" }]));
        raw["platforms"] = json!([other]);
        let (level, message) = platform_skip_reason("demo", &raw, false).expect("应当跳过");
        assert_eq!(level, "info");
        assert!(message.contains(other), "说明里要有声明值：{message}");

        // 出厂基础插件被过滤是异常 ⇒ warn
        raw["essential"] = json!(true);
        let (level, _) = platform_skip_reason("demo", &raw, true).unwrap();
        assert_eq!(level, "warn");
        // 第三方插件写了 essential 也不算数（与装载规则一致）
        let (level, _) = platform_skip_reason("demo", &raw, false).unwrap();
        assert_eq!(level, "info");

        // 声明含当前平台 / 未声明 / 声明非法 ⇒ 不跳过
        raw = manifest_value("demo", json!([{ "name": "show", "title": "Show", "mode": "view" }]));
        raw["platforms"] = json!([other, current_platform()]);
        assert!(platform_skip_reason("demo", &raw, false).is_none());
        raw["platforms"] = json!([]);
        assert!(platform_skip_reason("demo", &raw, false).is_none(), "空数组交给 validate_manifest 报错");
        raw["platforms"] = json!("windows");
        assert!(platform_skip_reason("demo", &raw, false).is_none());
    }

    #[test]
    fn windows_absolute_paths_are_rejected() {
        assert!(is_windows_absolute("C:/windows/system32"));
        assert!(!is_windows_absolute("dist/app.js"));
        // 与 v1 的 `/^[a-zA-Z]:/` 一致：字母 + 冒号一律当盘符路径拒绝（宁可误拒）
        assert!(is_windows_absolute("a:b"));
    }

    #[test]
    fn origin_of_handles_dev_urls() {
        assert_eq!(origin_of("http://localhost:5173/").unwrap(), "http://localhost:5173");
        assert_eq!(origin_of("http://localhost:5173/app").unwrap(), "http://localhost:5173");
        assert!(origin_of("not-a-url").is_none());
    }

    // ── 插件更新（M7）：覆盖规则 / 原子安装 / 恢复出厂 ──────────────

    fn temp_root(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("manager-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_plugin_dir(dir: &Path, name: &str, version: &str, essential: bool) {
        let mut manifest = manifest_value(name, json!([{ "name": "show", "title": "Show", "mode": "view" }]));
        manifest["version"] = json!(version);
        if essential {
            manifest["essential"] = json!(true);
        }
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("package.json"), serde_json::to_string(&manifest).unwrap()).unwrap();
        std::fs::write(dir.join("index.html"), "<html></html>").unwrap();
    }

    fn version_of(dir: &Path) -> String {
        let raw = std::fs::read_to_string(dir.join("package.json")).unwrap();
        serde_json::from_str::<Value>(&raw).unwrap()["version"].as_str().unwrap().to_string()
    }

    fn test_manager(root: &Path, builtin_roots: Vec<PathBuf>) -> Arc<PluginManager> {
        let log: LogFn = Arc::new(|_, _| {});
        let exec = Arc::new(ScriptRuntime::new(crate::exec::RuntimeOptions {
            data_root: root.to_path_buf(),
            resolve_plugin_dir: Arc::new(|_| None),
            data_path_for: Arc::new(|_| std::env::temp_dir()),
            settings_for: Arc::new(|_| HashMap::new()),
            handle_rpc: Arc::new(|_, _, _| Box::pin(async { Err(KernelError::not_found("测试装置不提供 RPC")) })),
            on_failure: Arc::new(|_, _| {}),
            on_late_result: Arc::new(|_, _, _| {}),
        }));
        let exec_for_entry = exec.clone();
        let config = Arc::new(ConfigStore::new(root));
        let _ = config.init();
        let overrides = Arc::new(OverrideStore::new(root));
        overrides.load();
        let plugin_settings = Arc::new(PluginSettingStore::new(root));
        plugin_settings.load();
        Arc::new(PluginManager::new(PluginManagerDeps {
            data_root: root.to_path_buf(),
            builtin_roots,
            config,
            overrides,
            plugin_settings,
            audit: Arc::new(AuditLog::new(root)),
            bus: EventBus::new(),
            registry: Arc::new(CommandRegistry::new()),
            sessions: Arc::new(SessionManager::new()),
            servers: Arc::new(PluginServerPool::new(log.clone())),
            exec,
            resolve_entry: Arc::new(move |plugin_id, command| exec_for_entry.resolve_entry(plugin_id, command)),
            log,
            on_changed: Arc::new(|| {}),
        }))
    }

    #[tokio::test]
    async fn extensions_can_override_non_essential_builtin() {
        let root = temp_root("override");
        let builtin = root.join("builtin");
        write_plugin_dir(&builtin.join("demo"), "demo", "1.0.0", false);
        let manager = test_manager(&root, vec![builtin.clone()]);
        manager.scan().await;
        assert_eq!(manager.get("demo").unwrap().dir, builtin.join("demo"));

        let extensions = root.join("extensions");
        write_plugin_dir(&extensions.join("demo"), "demo", "2.0.0", false);
        manager.scan().await;

        let record = manager.get("demo").unwrap();
        assert_eq!(record.dir, extensions.join("demo"), "非 essential 出厂插件可被覆盖");
        assert!(record.builtin, "覆盖后仍是出厂插件：不可卸载、可禁用");
        assert!(!manager.is_essential("demo"));
        assert!(manager.has_extension_override("demo"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn extensions_never_override_essential_builtin() {
        let root = temp_root("essential");
        let builtin = root.join("builtin");
        write_plugin_dir(&builtin.join("demo"), "demo", "1.0.0", true);
        write_plugin_dir(&root.join("extensions").join("demo"), "demo", "2.0.0", false);
        let manager = test_manager(&root, vec![builtin.clone()]);
        manager.scan().await;

        assert_eq!(manager.get("demo").unwrap().dir, builtin.join("demo"), "底座基础能力不可被外部目录顶替");
        assert!(manager.is_essential("demo"));
        assert!(!manager.has_extension_override("demo"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn broken_override_falls_back_to_builtin() {
        let root = temp_root("broken");
        let builtin = root.join("builtin");
        write_plugin_dir(&builtin.join("demo"), "demo", "1.0.0", false);
        let override_dir = root.join("extensions").join("demo");
        std::fs::create_dir_all(&override_dir).unwrap();
        std::fs::write(override_dir.join("package.json"), "{ 这不是 json").unwrap();

        let manager = test_manager(&root, vec![builtin.clone()]);
        manager.scan().await;
        assert_eq!(manager.get("demo").unwrap().dir, builtin.join("demo"), "坏覆盖必须回落到出厂版本");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn essential_declared_in_override_grants_nothing() {
        let root = temp_root("escalation");
        let builtin = root.join("builtin");
        write_plugin_dir(&builtin.join("demo"), "demo", "1.0.0", false);
        write_plugin_dir(&root.join("extensions").join("demo"), "demo", "2.0.0", true);
        let manager = test_manager(&root, vec![builtin.clone()]);
        manager.scan().await;

        assert!(!manager.is_essential("demo"), "essential 只认出厂身份表：覆盖版本改清单不能拿到不可禁用");
        assert!(!manager.is_declared_essential("demo"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn overwrite_install_keeps_user_data_and_backs_up_old_version() {
        let root = temp_root("install");
        let builtin = root.join("builtin");
        write_plugin_dir(&builtin.join("demo"), "demo", "1.0.0", false);
        let manager = test_manager(&root, vec![builtin.clone()]);
        manager.scan().await;
        manager.load("demo").await.unwrap();
        // 用户数据：插件设置 + 别名覆盖（升级必须原样保留）
        let _ = manager.deps.plugin_settings.set("demo", "k", SettingValue::Str("v".to_string()));
        let _ = manager.deps.overrides.set_plugin_keywords("demo", Some(vec!["别名".to_string()]));

        let source = root.join("source");
        write_plugin_dir(&source, "demo", "2.0.0", false);
        manager.install_from_directory(&source, true).await.unwrap();

        let record = manager.get("demo").unwrap();
        assert_eq!(record.manifest.clone().unwrap().version, "2.0.0", "新版本生效");
        assert_eq!(record.dir, root.join("extensions").join("demo"));
        assert!(record.builtin, "被覆盖的出厂插件身份不变");
        assert_eq!(
            manager.deps.plugin_settings.get_for("demo").unwrap().get("k").cloned(),
            Some(SettingValue::Str("v".to_string())),
            "插件设置不随升级丢失"
        );
        assert!(manager.deps.overrides.get_for("demo").is_some(), "别名覆盖不随升级丢失");

        // 首次覆盖不备份：出厂版本在 App 包里，本来就还在（「恢复出厂版本」就是回到它）
        let backup_root = root.join("extensions").join(".backup").join("demo");
        assert!(!backup_root.exists());

        // 再升两级：备份始终只有最近 1 份
        for next in ["3.0.0", "4.0.0"] {
            let previous = manager.get("demo").unwrap().manifest.unwrap().version;
            write_plugin_dir(&source, "demo", next, false);
            manager.install_from_directory(&source, true).await.unwrap();
            assert_eq!(manager.get("demo").unwrap().manifest.unwrap().version, next);
            let backups: Vec<PathBuf> = std::fs::read_dir(&backup_root).unwrap().flatten().map(|entry| entry.path()).collect();
            assert_eq!(backups.len(), 1, "只保留最近 1 份备份");
            assert_eq!(version_of(&backups[0]), previous);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn install_refuses_to_overwrite_essential_plugin() {
        let root = temp_root("refuse");
        let builtin = root.join("builtin");
        write_plugin_dir(&builtin.join("demo"), "demo", "1.0.0", true);
        let manager = test_manager(&root, vec![builtin.clone()]);
        manager.scan().await;

        let source = root.join("source");
        write_plugin_dir(&source, "demo", "2.0.0", false);
        let err = manager.install_from_directory(&source, true).await.unwrap_err();
        assert_eq!(err.code, "ESSENTIAL_PROTECTED");
        assert_eq!(manager.get("demo").unwrap().dir, builtin.join("demo"), "拒绝后旧版本原地不动");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn revert_to_builtin_restores_bundle_version() {
        let root = temp_root("revert");
        let builtin = root.join("builtin");
        write_plugin_dir(&builtin.join("demo"), "demo", "1.0.0", false);
        let manager = test_manager(&root, vec![builtin.clone()]);
        manager.scan().await;

        let source = root.join("source");
        write_plugin_dir(&source, "demo", "2.0.0", false);
        manager.install_from_directory(&source, true).await.unwrap();
        assert_eq!(manager.get("demo").unwrap().manifest.clone().unwrap().version, "2.0.0");

        assert!(manager.revert_to_builtin("demo").await.unwrap(), "有覆盖时应真的恢复");
        let record = manager.get("demo").unwrap();
        assert_eq!(record.manifest.unwrap().version, "1.0.0");
        assert_eq!(record.dir, builtin.join("demo"));
        assert!(!manager.has_extension_override("demo"));
        assert!(!root.join("extensions").join(".backup").join("demo").exists(), "备份一起清，避免又被装回去");

        // 没有覆盖时不是错误
        assert!(!manager.revert_to_builtin("demo").await.unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn revert_to_builtin_rejects_third_party_plugins() {
        let root = temp_root("revert-third");
        let manager = test_manager(&root, vec![root.join("builtin")]);
        let source = root.join("source");
        write_plugin_dir(&source, "demo", "1.0.0", false);
        manager.install_from_directory(&source, false).await.unwrap();

        let err = manager.revert_to_builtin("demo").await.unwrap_err();
        assert_eq!(err.code, "FORBIDDEN", "第三方插件没有「出厂版本」可恢复");
        let _ = std::fs::remove_dir_all(&root);
    }
}
