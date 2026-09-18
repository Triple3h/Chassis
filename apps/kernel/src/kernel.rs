//! 内核装配（v1 `apps/kernel/src/kernel.ts`；requirements §4.2 / §5）。
//!
//! 各组件之间用 `Weak<Kernel>` 做**延迟求值**（v1 用 `this.plugins?.xxx` 达到同样效果）：
//! exec 比 plugins 先构造、hostUi 要回调 kernel 的隐藏方法 …… 全都靠 `Arc::new_cyclic`。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex, Weak};

use serde_json::{json, Value};

use crate::audit::AuditLog;
use crate::bridge::{BridgeDeps, BridgeDispatcher};
use crate::config::ConfigStore;
use crate::contract::{ActionResult, ResultItem};
use crate::error::{KernelError, Result};
use crate::events::{names, EventBus};
use crate::exec::{BoxFuture, RuntimeOptions, ScriptRuntime};
use crate::history::{HistoryEntry, HistoryStore};
use crate::hot::middleware::HotMiddlewareCtx;
use crate::hot::{spec::HotSpec, HotUpdate};
use crate::http::plugin_servers::PluginServerPool;
use crate::http::server::{serve, InfraState, LogFn, ServerOptions, SseHub, UiServer};
use crate::legacy::legacy_id_to_current;
use crate::overrides::OverrideStore;
use crate::pipeline::Pipeline;
use crate::plugin::admin::{PluginAdmin, PluginAdminDeps};
use crate::plugin::manager::{PluginManager, PluginManagerDeps};
use crate::plugin_settings::PluginSettingStore;
use crate::registry::{CommandRegistry, SearchResultHub, SetMode};
use crate::search::{plugin_key_of, SearchDeps, SearchEngine};
use crate::services::host_ui::HostUiBridge;
use crate::services::primitives::{HotkeyResult, Primitives};
use crate::services::quicklink::QuicklinkStore;
use crate::services::settings::{SettingsHost, SettingsService};
use crate::services::storage::PluginStorage;
use crate::services::system_stats::{ShellAppUsage, SystemStatsSampler};
use crate::session::SessionManager;
use crate::types::ExecContext;
use crate::util::fsx::plugin_data_path;
use crate::util::text::item_key;
use crate::window_visibility::{VisibilityPrimitives, WindowVisibility};

/// 唤出时带入的选中文本长度上限。
///
/// 用户在前台选了一整篇文档再按热键时，把它塞进搜索框只会变成一次必然搜不到的查询，
/// 还得手动删掉 —— 所以宁可当作「没有选中文本」。
pub const SELECTION_MAX_CHARS: usize = 400;

/// plugin-spec §8.1：剪贴板变化驱动的固定命令名（宿主 `exec.run(pluginId, 'record')`）。
pub const RECORD_COMMAND: &str = "record";
/// `record` 的超时：读一次剪贴板 + 落盘，5s 足够（默认 10s 会让异常插件多占一个进程槽）
const RECORD_TIMEOUT_MS: u64 = 5_000;

pub struct KernelOptions {
    pub data_root: PathBuf,
    /// 出厂插件根目录（可多个；开发态默认就是仓库根的 `plugins/`）
    pub builtin_roots: Vec<PathBuf>,
    pub ui_dist_dir: Option<PathBuf>,
    pub ui_dev_url: Option<String>,
    pub version: String,
    /// 壳 ↔ 内核 stdio JSON-RPC 的写入端（main 提供 `println!`；测试可注入假写入）
    pub link_writer: crate::link::OutputFn,
}

pub struct Kernel {
    opts: KernelOptions,
    pub bus: EventBus,
    pub config: Arc<ConfigStore>,
    pub audit: Arc<AuditLog>,
    pub history: Arc<HistoryStore>,
    pub overrides: Arc<OverrideStore>,
    pub plugin_settings: Arc<PluginSettingStore>,
    pub registry: Arc<CommandRegistry>,
    pub hub: Arc<SearchResultHub>,
    pub sessions: Arc<SessionManager>,
    pub pipeline: Arc<Pipeline>,
    pub servers: Arc<PluginServerPool>,
    pub link: crate::link::ShellLink,
    pub storage: Arc<PluginStorage>,
    pub quicklinks: Arc<QuicklinkStore>,
    pub primitives: Arc<Primitives>,
    pub host_ui: Arc<HostUiBridge>,
    pub exec: Arc<ScriptRuntime>,
    pub plugins: Arc<PluginManager>,
    pub search: Arc<SearchEngine>,
    pub bridge: Arc<BridgeDispatcher>,
    pub visibility: Arc<WindowVisibility>,
    pub stats: Arc<SystemStatsSampler>,
    pub admin: Arc<PluginAdmin>,
    /// 内核热更新（v0.1.0）：路由 / 中间件 / 事件订阅的 generation 切换 + 二进制热替换。
    pub hot: Arc<HotUpdate>,
    pub sse: SseHub,
    log: LogFn,
    ui: Mutex<Option<UiServer>>,
    ui_port: AtomicU16,
    ready: AtomicBool,
    quitting: AtomicBool,
    started: AtomicBool,
    /// 剪贴板监听的**当前实际状态**（plugin-spec §8.1）：幂等地开/关，避免每次插件变动都打扰壳
    clipboard_watch: AtomicBool,
}

/// 管理面特权服务的宿主实现（v1 `services/settingsHost.ts`）。
pub struct KernelSettingsHost {
    kernel: Arc<Kernel>,
}

impl SettingsHost for KernelSettingsHost {
    fn get_config(&self) -> Value {
        serde_json::to_value(self.kernel.config.get()).unwrap_or(Value::Null)
    }

    fn patch_config(&self, patch: Value) -> BoxFuture<Result<Value>> {
        let kernel = self.kernel.clone();
        Box::pin(async move { kernel.patch_config(patch).await })
    }

    fn set_autostart(&self, enabled: bool) -> BoxFuture<Result<()>> {
        let kernel = self.kernel.clone();
        Box::pin(async move {
            kernel.patch_config(json!({ "autostart": enabled })).await?;
            Ok(())
        })
    }

    fn set_history_limit(&self, limit: i64) -> BoxFuture<Result<()>> {
        let kernel = self.kernel.clone();
        Box::pin(async move {
            kernel.patch_config(json!({ "historyLimit": limit })).await?;
            Ok(())
        })
    }

    fn list_plugins(&self) -> BoxFuture<Result<Vec<Value>>> {
        let plugins = self.kernel.plugins.clone();
        Box::pin(async move { Ok(plugins.info()) })
    }

    fn plugin_action(&self, action: String, payload: Value) -> BoxFuture<Result<Value>> {
        let kernel = self.kernel.clone();
        Box::pin(async move { kernel.plugin_action(&action, &payload).await })
    }

    fn export_logs(&self, scope: String) -> BoxFuture<Result<Value>> {
        let kernel = self.kernel.clone();
        Box::pin(async move { kernel.export_logs(&scope).await })
    }

    fn query_audit(&self, limit: usize) -> Vec<Value> {
        self.kernel
            .audit
            .query(None, None, None, limit)
            .into_iter()
            .map(|record| serde_json::to_value(record).unwrap_or(Value::Null))
            .collect()
    }

    fn clear_audit(&self) {
        self.kernel.audit.clear();
    }

    fn clear_history(&self) {
        self.kernel.history.clear_history();
        self.kernel.bus.emit(names::HISTORY_CHANGED, &json!({}));
    }

    fn open_data_dir(&self) -> BoxFuture<Result<()>> {
        let primitives = self.kernel.primitives.clone();
        let data_root = self.kernel.opts.data_root.clone();
        Box::pin(async move { primitives.shell_open_path("kernel", &data_root.to_string_lossy()).await })
    }

    fn reveal_path(&self, target: String) -> BoxFuture<Result<()>> {
        let primitives = self.kernel.primitives.clone();
        Box::pin(async move { primitives.shell_reveal("kernel", &target).await })
    }

    fn host_info(&self) -> Value {
        json!({
            "version": self.kernel.version(),
            // 内核热更新机制版本（v0.1.0）：插件侧用它判断「这个更新包我装不装得了」
            "hotVersion": crate::hot::HOT_UPDATE_VERSION,
            "platform": platform_string(),
            "dataRoot": self.kernel.data_root(),
            // v2 没有 Node 运行时：字段保留（UI「关于」面板在显示它），值给「—」
            "node": "—",
        })
    }
}

impl Kernel {
    pub fn new(opts: KernelOptions) -> Arc<Self> {
        let log: LogFn = Arc::new(|level, message| crate::logging::emit(level, message));
        Arc::new_cyclic(|weak: &Weak<Kernel>| {
            let data_root = opts.data_root.clone();
            let version = opts.version.clone();

            let bus = EventBus::new();
            let config = Arc::new(ConfigStore::new(&data_root));
            let audit = Arc::new(AuditLog::new(&data_root));
            let history = Arc::new(HistoryStore::new(&data_root));
            let overrides = Arc::new(OverrideStore::new(&data_root));
            let plugin_settings = Arc::new(PluginSettingStore::new(&data_root));
            let registry = Arc::new(CommandRegistry::new());
            let hub = Arc::new(SearchResultHub::new());
            let sessions = Arc::new(SessionManager::new());
            let pipeline = Arc::new(Pipeline::new());
            let storage = Arc::new(PluginStorage::new(&data_root, audit.clone()));
            let quicklinks = Arc::new(QuicklinkStore::new(&data_root, audit.clone()));
            let servers = Arc::new(PluginServerPool::new(log.clone()));
            let link = crate::link::ShellLink::new(opts.link_writer.clone());
            let primitives = Arc::new(Primitives::new(link.clone(), audit.clone()));
            let sse = SseHub::new(256);

            // 壳的显隐回调：hostUi 的 hide 要落到「广播 + 等回执 + 兜底」
            let host_ui = {
                let weak = weak.clone();
                let hide: Arc<dyn Fn() -> BoxFuture<Result<()>> + Send + Sync> = Arc::new(move || {
                    let weak = weak.clone();
                    Box::pin(async move {
                        match weak.upgrade() {
                            Some(kernel) => kernel.hide_window_animated().await,
                            None => Ok(()),
                        }
                    })
                });
                Arc::new(HostUiBridge::new(bus.clone(), audit.clone(), hide))
            };

            // 状态条要「启动台一共占多少」：壳那一半得点名要（app.usage）
            let stats = {
                let primitives = primitives.clone();
                Arc::new(SystemStatsSampler::new(Arc::new(move || {
                    let primitives = primitives.clone();
                    Box::pin(async move {
                        primitives.app_usage().await.map(|usage| ShellAppUsage { rss: usage.rss, cpu_ms: usage.cpu_ms })
                    }) as BoxFuture<Option<ShellAppUsage>>
                })))
            };

            let exec = {
                let weak_for_dir = weak.clone();
                let weak_for_settings = weak.clone();
                let weak_for_failure = weak.clone();
                let weak_for_rpc = weak.clone();
                let storage_for_rpc = storage.clone();
                let root_for_data = data_root.clone();
                Arc::new(ScriptRuntime::new(RuntimeOptions {
                    data_root: data_root.clone(),
                    resolve_plugin_dir: Arc::new(move |plugin_id| {
                        weak_for_dir.upgrade().and_then(|kernel| kernel.plugins.dir_of(plugin_id))
                    }),
                    data_path_for: Arc::new(move |plugin_id| plugin_data_path(&root_for_data, plugin_id)),
                    settings_for: Arc::new(move |plugin_id| {
                        weak_for_settings.upgrade().map(|kernel| kernel.plugins.settings_of(plugin_id)).unwrap_or_default()
                    }),
                    handle_rpc: Arc::new(move |plugin_id: String, method: String, params: Value| {
                        let weak = weak_for_rpc.clone();
                        let storage = storage_for_rpc.clone();
                        Box::pin(async move {
                            let Some(rest) = method.strip_prefix("storage.") else {
                                return Err(KernelError::not_found(format!("未知脚本 RPC：{method}")));
                            };
                            let Some(kernel) = weak.upgrade() else {
                                return Err(KernelError::new("INTERNAL", "内核已释放"));
                            };
                            // 转发与 view 桥共用同一实现（PluginStorage.call），这里只做能力校验
                            if !kernel.plugins.capabilities_of(&plugin_id).contains("storage") {
                                return Err(KernelError::new("CAPABILITY_DENIED", "未声明能力：storage"));
                            }
                            storage.call(&plugin_id, "script", rest, &params).await
                        }) as BoxFuture<Result<Value>>
                    }),
                    on_failure: Arc::new(move |plugin_id: &str, command: &str| {
                        if let Some(kernel) = weak_for_failure.upgrade() {
                            kernel.plugins.note_failure(plugin_id, command);
                        }
                    }),
                    // 预算超时后才回来的搜索结果：写进 hub 并补位推送（v1 在这里丢弃）
                    on_late_result: {
                        let weak = weak.clone();
                        Arc::new(move |plugin_id: &str, token: u64, raw: Vec<Value>| {
                            let Some(kernel) = weak.upgrade() else { return };
                            let items: Vec<ResultItem> = raw
                                .into_iter()
                                .filter_map(|value| serde_json::from_value(value).ok())
                                .collect();
                            if items.is_empty() {
                                return;
                            }
                            if !kernel.hub.accept(Some(token), plugin_id, items, SetMode::Set) {
                                return;
                            }
                            kernel.search.emit_results(token);
                        })
                    },
                }))
            };

            let plugins = {
                let weak_for_changed = weak.clone();
                let exec_for_entry = exec.clone();
                Arc::new(PluginManager::new(PluginManagerDeps {
                    data_root: data_root.clone(),
                    builtin_roots: opts.builtin_roots.clone(),
                    config: config.clone(),
                    overrides: overrides.clone(),
                    plugin_settings: plugin_settings.clone(),
                    audit: audit.clone(),
                    bus: bus.clone(),
                    registry: registry.clone(),
                    sessions: sessions.clone(),
                    servers: servers.clone(),
                    exec: exec.clone(),
                    resolve_entry: Arc::new(move |plugin_id, command| exec_for_entry.resolve_entry(plugin_id, command)),
                    log: log.clone(),
                    on_changed: Arc::new(move || {
                        if let Some(kernel) = weak_for_changed.upgrade() {
                            // 托盘菜单随插件状态刷新（v1 的 `onChanged: () => void this.registerTray()`）
                            tokio::spawn(async move { kernel.register_tray().await });
                        }
                    }),
                }))
            };

            {
                // 底座基础能力（essential）的调用不进审计：等价于底座自身行为，且调用量大
                let plugins = plugins.clone();
                audit.set_exempt(move |plugin_id| plugins.is_essential(plugin_id));
            }

            let search = {
                let plugins_for_title = plugins.clone();
                let plugins_for_base = plugins.clone();
                let plugins_for_alive = plugins.clone();
                Arc::new(SearchEngine::new(SearchDeps {
                    registry: registry.clone(),
                    hub: hub.clone(),
                    history: history.clone(),
                    exec: exec.clone(),
                    bus: bus.clone(),
                    config: config.clone(),
                    sessions: sessions.clone(),
                    plugin_title_of: Arc::new(move |plugin_id| plugins_for_title.title_of(plugin_id)),
                    plugin_base_url: Arc::new(move |plugin_id| plugins_for_base.base_url_for(plugin_id)),
                    is_result_alive: Arc::new(move |plugin_id, command| plugins_for_alive.is_result_alive(plugin_id, command)),
                }))
            };

            let bridge = {
                let weak_for_invoke = weak.clone();
                let weak_for_settings = weak.clone();
                let plugins_for_caps = plugins.clone();
                Arc::new(BridgeDispatcher::new(BridgeDeps {
                    sessions: sessions.clone(),
                    registry: registry.clone(),
                    hub: hub.clone(),
                    audit: audit.clone(),
                    storage: storage.clone(),
                    primitives: primitives.clone(),
                    host_ui: host_ui.clone(),
                    quicklinks: quicklinks.clone(),
                    exec: exec.clone(),
                    version: version.clone(),
                    platform: platform_string(),
                    data_root: data_root.clone(),
                    invoke_command: Arc::new(move |id: String, args: Option<Value>, source: &'static str| {
                        let weak = weak_for_invoke.clone();
                        Box::pin(async move {
                            let Some(kernel) = weak.upgrade() else {
                                return Err(KernelError::new("INTERNAL", "内核已释放"));
                            };
                            Ok(serde_json::to_value(kernel.invoke(&id, args, source).await).unwrap_or(Value::Null))
                        }) as BoxFuture<Result<Value>>
                    }),
                    capabilities_of: Arc::new(move |plugin_id| plugins_for_caps.capabilities_of(plugin_id)),
                    settings_for: Some(Arc::new(move |plugin_id: &str| {
                        let kernel = weak_for_settings.upgrade()?;
                        Some(Arc::new(SettingsService::new(
                            Arc::new(KernelSettingsHost { kernel }) as Arc<dyn SettingsHost>,
                            plugin_id,
                        )))
                    })),
                }))
            };

            {
                let weak_for_invoker = weak.clone();
                registry.bind_invoker(Arc::new(move |id: String, args: Option<Value>, source: String| {
                    let weak = weak_for_invoker.clone();
                    Box::pin(async move {
                        match weak.upgrade() {
                            Some(kernel) => kernel.invoke(&id, args, &source).await,
                            None => ActionResult::failure("host", "INTERNAL", "内核已释放"),
                        }
                    }) as BoxFuture<ActionResult>
                }));
            }

            let visibility = WindowVisibility::new(
                Arc::new(primitives.clone()) as Arc<dyn VisibilityPrimitives>,
                bus.clone(),
            );

            let admin = Arc::new(PluginAdmin::new(PluginAdminDeps {
                plugins: plugins.clone(),
                overrides: overrides.clone(),
                plugin_settings: plugin_settings.clone(),
                config: config.clone(),
                primitives: primitives.clone(),
            }));

            // 热更新管理器：builder 走 Weak<Kernel>（装配期不能拿强引用 —— 会形成 Arc 环）
            let hot = {
                let weak = weak.clone();
                let dir = data_root.join("hot");
                let log = crate::hot::HotLog::new(&dir);
                let builder: crate::hot::TreeBuilder = Arc::new(move |spec: &HotSpec| {
                    let kernel = weak.upgrade().ok_or_else(|| KernelError::internal("内核已释放"))?;
                    kernel.build_hot_tree(spec)
                });
                Arc::new(HotUpdate::new(dir, log, bus.clone(), builder))
            };

            Kernel {
                opts,
                bus,
                config,
                audit,
                history,
                overrides,
                plugin_settings,
                registry,
                hub,
                sessions,
                pipeline,
                servers,
                link,
                storage,
                quicklinks,
                primitives,
                host_ui,
                exec,
                plugins,
                search,
                bridge,
                visibility,
                stats,
                admin,
                hot,
                sse,
                log,
                ui: Mutex::new(None),
                ui_port: AtomicU16::new(0),
                ready: AtomicBool::new(false),
                quitting: AtomicBool::new(false),
                started: AtomicBool::new(false),
                clipboard_watch: AtomicBool::new(false),
            }
        })
    }

    pub fn data_root(&self) -> String {
        self.opts.data_root.to_string_lossy().to_string()
    }

    pub fn data_root_path(&self) -> &Path {
        &self.opts.data_root
    }

    pub fn version(&self) -> String {
        self.opts.version.clone()
    }

    pub fn ui_port(&self) -> u16 {
        self.ui_port.load(Ordering::SeqCst)
    }

    pub fn log(&self, level: &'static str, message: &str) {
        (self.log)(level, message);
    }

    pub fn mark_ready(&self) {
        self.ready.store(true, Ordering::SeqCst);
        // 走到「就绪」= 本次启动成功：确认二进制热更新（清 pending 台账）
        if let Some(detail) = self.hot.mark_boot_success() {
            self.log("info", &detail);
        }
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    /// 管理面（internal 插件）特权服务。
    pub fn settings_service(self: &Arc<Self>, plugin_id: &str) -> Arc<SettingsService> {
        Arc::new(SettingsService::new(
            Arc::new(KernelSettingsHost { kernel: self.clone() }) as Arc<dyn SettingsHost>,
            plugin_id,
        ))
    }

    // ── 诊断日志导出（设置页「导出日志」）────────────────────────────

    /// 把内核日志 + 插件状态 + 审计摘要汇总成一个文本文件（用户可发给开发者 / AI 助手排查）。
    ///
    /// - `scope = "session"`：本次内核运行期（内存环形缓冲，最近 `RING_SIZE` 条）；
    /// - `scope = "all"`：`<dataRoot>/logs/kernel.log`（跨运行，含轮转的上一代）+ `audit-*.jsonl`。
    ///
    /// 文件落 `<dataRoot>/logs/exports/`（只保留最近 10 份），并尽量在访达 / 资源管理器中显示；
    /// `revealed = false` 只表示「没能帮你打开文件管理器」（壳未连接等），文件本身已经写好。
    pub async fn export_logs(self: &Arc<Self>, scope: &str) -> Result<Value> {
        let scope = if scope == "all" { "all" } else { "session" };
        let now = crate::util::now_ms();

        let (log_body, log_count, log_truncated) = self.collect_kernel_log(scope);
        let (audit_lines, audit_truncated) = self.collect_audit(scope);

        let plugins = self.plugins.info();
        let mut active = 0usize;
        let mut disabled = 0usize;
        let mut broken = 0usize;
        let mut plugin_lines: Vec<String> = Vec::with_capacity(plugins.len());
        for plugin in &plugins {
            let id = plugin.get("id").and_then(Value::as_str).unwrap_or("?");
            let version = plugin.get("version").and_then(Value::as_str).unwrap_or("?");
            let state = plugin.get("state").and_then(Value::as_str).unwrap_or("?");
            match state {
                "active" | "degraded" => active += 1,
                "disabled" => disabled += 1,
                _ => broken += 1,
            }
            let mut line = format!("{id} v{version} [{state}]");
            if let Some(error) = plugin.get("error").and_then(Value::as_str) {
                line.push_str(&format!(" —— {error}"));
            }
            plugin_lines.push(line);
        }

        let mut text = String::new();
        text.push_str("Chassis 内核诊断日志\n");
        text.push_str("====================\n");
        text.push_str(&format!("导出时间：{}\n", crate::logging::format_local(now)));
        text.push_str(&format!(
            "导出范围：{}\n",
            if scope == "all" {
                "全部日志（跨运行；单次导出最多取日志 2MB / 审计 3000 条）"
            } else {
                "最近一次会话（本次内核运行）"
            }
        ));
        text.push_str(&format!("内核版本：{}（热更新机制 {}）\n", self.version(), crate::hot::HOT_UPDATE_VERSION));
        text.push_str(&format!("平台：{} / {} · 内核 pid {}\n", platform_string(), std::env::consts::ARCH, std::process::id()));
        text.push_str(&format!("数据目录：{}\n", self.data_root()));
        text.push_str(&format!("本次会话开始：{}\n", crate::logging::format_local(crate::logging::session_start_ms())));
        if let Some(path) = crate::logging::log_path() {
            text.push_str(&format!("内核日志文件：{}\n", path.display()));
        }
        text.push_str(&format!("插件：{} 个（{active} 激活 / {disabled} 禁用 / {broken} 异常）\n", plugins.len()));
        text.push_str("说明：本文件由「设置 → 关于 → 导出日志」生成，含内核日志、插件状态与审计摘要；壳日志在同目录的 shell.log。\n");
        text.push_str("注意：内容可能包含本机路径与插件日志，请只发送给可信对象。\n");

        text.push_str("\n── 插件状态 ─────────────────────────────\n");
        text.push_str(&plugin_lines.join("\n"));
        text.push('\n');

        text.push_str(&format!(
            "\n── 内核日志（{log_count} 条{}）──────────────────\n",
            if log_truncated { "，已截断至最近一段" } else { "" }
        ));
        text.push_str(&log_body);
        if !text.ends_with('\n') {
            text.push('\n');
        }

        text.push_str(&format!(
            "\n── 审计日志（{} 条{}）──────────────────\n",
            audit_lines.len(),
            if scope == "all" { "，来自 audit-*.jsonl" } else { "，来自本次运行的内存缓冲" }
        ));
        if audit_truncated {
            text.push_str("（仅保留最近 3000 条）\n");
        }
        text.push_str(&audit_lines.join("\n"));
        text.push('\n');

        let filename = format!("chassis-logs-{scope}-{}.txt", crate::logging::format_stamp(now));
        let path = crate::logging::write_export_file(&filename, &text)
            .map_err(|err| KernelError::new("INTERNAL", format!("写入导出文件失败：{err}")))?;
        let revealed = self.primitives.shell_reveal("kernel", &path.to_string_lossy()).await.is_ok();

        Ok(json!({
            "ok": true,
            "scope": scope,
            "filename": filename,
            "path": path.to_string_lossy(),
            "bytes": text.len(),
            "entries": log_count,
            "auditEntries": audit_lines.len(),
            "truncated": log_truncated || audit_truncated,
            "revealed": revealed,
        }))
    }

    /// 内核日志正文：session = 内存环形缓冲；all = kernel.log（含轮转的 kernel.log.1）。
    fn collect_kernel_log(&self, scope: &str) -> (String, usize, bool) {
        if scope == "all" {
            let (content, truncated) = crate::logging::read_log_file(crate::logging::EXPORT_READ_MAX_BYTES);
            if !content.trim().is_empty() {
                let count = content.lines().count();
                return (content, count, truncated);
            }
            // 文件不可用（未 init / 权限问题）时回落到本次会话，别导出空内容
        }
        let (lines, truncated) = crate::logging::session_lines();
        let count = lines.len();
        (lines.join("\n"), count, truncated)
    }

    /// 审计摘要：session = 内存环形缓冲；all = `audit-*.jsonl`（滚动 7 天，按日期升序拼接）。
    fn collect_audit(&self, scope: &str) -> (Vec<String>, bool) {
        if scope != "all" {
            let records = self.audit.query(None, None, None, crate::audit::RING_SIZE);
            return (records.iter().map(Self::audit_line).collect(), false);
        }
        const MAX_LINES: usize = 3000;
        let Ok(entries) = std::fs::read_dir(self.data_root_path().join("logs")) else {
            return (Vec::new(), false);
        };
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                let name = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
                name.starts_with("audit-") && name.ends_with(".jsonl")
            })
            .collect();
        files.sort();
        let mut lines: Vec<String> = Vec::new();
        for path in files {
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            for raw in text.lines() {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<crate::contract::AuditRecord>(trimmed) {
                    Ok(record) => lines.push(Self::audit_line(&record)),
                    Err(_) => lines.push(format!("（无法解析的审计行）{}", trimmed.chars().take(200).collect::<String>())),
                }
            }
        }
        let truncated = lines.len() > MAX_LINES;
        if truncated {
            lines.drain(0..lines.len() - MAX_LINES);
        }
        (lines, truncated)
    }

    fn audit_line(record: &crate::contract::AuditRecord) -> String {
        let mut line = format!(
            "{} [{}] {} · {}ms · {}",
            crate::logging::format_local(record.ts),
            record.plugin_id,
            record.method,
            record.ms,
            if record.ok { "ok" } else { "err" }
        );
        if !record.capability.is_empty() {
            line.push_str(&format!(" · 需要能力 {}", record.capability));
        }
        if let Some(error) = &record.error {
            line.push_str(&format!(" —— {}：{}", error.code, error.message));
        }
        line
    }

    // ── 生命周期 ────────────────────────────────────────────────

    pub async fn start(self: &Arc<Self>) -> Result<()> {
        if self.started.swap(true, Ordering::SeqCst) {
            return Ok(());
        }

        self.config.init().map_err(|err| KernelError::new("INTERNAL", err.to_string()))?;
        let config = self.config.load();
        // 覆盖层要在插件装配（plugins.init）之前就位，否则首轮注册拿不到用户别名
        self.overrides.load();
        // 设置值同理：搜索子进程的预热在装配期就发生，晚加载会让首个子进程读到空设置
        self.plugin_settings.load();
        self.audit.init();
        self.history.load(config.history_limit);
        // 插件改过 id：历史 / 固定项里的旧 pluginId 与 key 前缀一次性迁移
        let (history_migrated, pinned_migrated) = self.history.migrate_plugin_ids(&legacy_id_to_current());
        if history_migrated > 0 || pinned_migrated > 0 {
            self.log(
                "info",
                &format!("历史 / 固定项插件 id 迁移：历史 {history_migrated} 条、固定 {pinned_migrated} 条"),
            );
        }

        self.host_ui.set_theme(if config.theme == "light" { "light" } else { "dark" });

        // 落盘循环：历史 / 固定（500ms 合并）与插件存储（200ms 合并）——
        // 两处写入都只标脏，没有这两个循环就永远不会落盘
        {
            let history = self.history.clone();
            tokio::spawn(async move { history.flush_loop().await });
        }
        tokio::spawn(self.storage.clone().flush_loop());

        // 热更新：先加载持久化的 spec（current.json）建成第 1 代，UI 服务才有路由树可挂
        self.hot.boot().map_err(|err| KernelError::new("INTERNAL", format!("热更新初始化失败：{}", err.message)))?;
        self.start_ui_server().await?;
        self.plugins.init().await;
        self.plugins.start_watcher();
        // 插件已装配完：现在才知道有没有人订阅剪贴板（plugin-spec §8.1）
        self.sync_clipboard_watch().await;

        // 清单声明 `history: false` 的插件（底座自身入口）：光「以后不写」不够 ——
        // 界面上那条旧记录会一直留着，看起来就是「改了没生效」
        let dropped = self.history.drop_history_by(|plugin_id| self.plugins.excludes_history(plugin_id));
        if dropped > 0 {
            self.log("info", &format!("最近使用清理：摘掉 {dropped} 条「不计入历史」插件的条目"));
        }

        // 会话回收：关闭时把理由一起广播给 UI（`reload` ⇒ 重载完成后重开页面，其余 ⇒ 卸载 iframe）。
        // disper 不保存：订阅活到进程结束（drop 句柄不会取消订阅）
        {
            let bus = self.bus.clone();
            let _disposer = self.sessions.on(Arc::new(move |session, kind, reason| {
                if kind != crate::session::SessionEvent::Close {
                    return;
                }
                bus.emit(
                    names::SESSION_CLOSED,
                    &json!({
                        "sid": session.sid,
                        "pluginId": session.plugin_id,
                        "command": session.command,
                        "reason": reason.map(|value| value.as_str()).unwrap_or("close"),
                    }),
                );
            }));
        }

        self.register_tray().await;
        self.apply_hotkey(&config).await;
        if config.autostart {
            let _ = self.primitives.set_autostart(true).await;
        }

        // 状态条第一次被读到时就能给出有意义的差分（否则首个 CPU 读数只能是 0）
        self.stats.warmup().await;

        self.log("info", &format!("内核就绪：UI http://127.0.0.1:{}，数据目录 {}", self.ui_port(), self.data_root()));
        Ok(())
    }

    fn server_options(&self) -> ServerOptions {
        ServerOptions {
            ui_dist_dir: self.opts.ui_dist_dir.clone(),
            ui_dev_url: self.opts.ui_dev_url.clone(),
            allowed_origins: self.opts.ui_dev_url.as_deref().and_then(origin_of).into_iter().collect(),
            port: 0,
        }
    }

    /// 构建一整棵热更新路由树（业务路由 + 扩展路由 + infra 静态 + CORS + 热中间件）。
    ///
    /// 由 `HotUpdate` 的 builder 回调调用：**每次 apply 都重新构建**（含新的中间件配置），
    /// 构建 / 自检失败都不会动当前代。
    pub fn build_hot_tree(self: &Arc<Self>, spec: &HotSpec) -> Result<axum::Router> {
        let options = self.server_options();
        let infra = InfraState::new(self.sse.clone(), &options);
        let policy = crate::api::RoutePolicy::from_spec(spec);
        // CORS 必须挂在整个 merge 完的树上（业务路由在 api::router_with 里，挂 infra_router 上覆盖不到）
        let router = crate::api::router_with(&policy, spec)
            .merge(crate::http::server::infra_router::<Arc<Kernel>>(infra.clone()));
        let router = crate::http::server::with_cors(router, infra);
        let ctx = HotMiddlewareCtx {
            inflight: self.hot.inflight_counter(),
            log: self.hot.log().clone(),
            config: spec.middleware.clone(),
        };
        let router = router.layer(axum::middleware::from_fn_with_state(ctx, crate::hot::middleware::hot_middleware));
        Ok(router.with_state(self.clone()))
    }

    async fn start_ui_server(self: &Arc<Self>) -> Result<u16> {
        let options = self.server_options();

        // bus → SSE（UI 与插件页的事件都从这里扇出）
        {
            let sse = self.sse.clone();
            self.bus.set_sink(Arc::new(move |event, payload| sse.broadcast(event, payload)));
        }

        // listener 上挂**分发层**（不是某一棵具体的树）：热更新换代时 listener 不用动，
        // 每个请求由分发层现取当前代 —— 这才让路由 / 中间件的热替换真正生效。
        let router = crate::hot::dispatch_router(self.hot.clone());
        let server = serve(router, self.sse.clone(), options, self.log.clone()).await?;
        self.ui_port.store(server.port, Ordering::SeqCst);
        *self.ui.lock().unwrap_or_else(|err| err.into_inner()) = Some(server);
        Ok(self.ui_port())
    }

    pub async fn stop(self: &Arc<Self>) {
        // 收尾时把还没落地的隐藏丢掉：否则定时器会在 UI 服务停掉之后再去敲壳
        self.cancel_pending_hide().await;
        self.plugins.dispose().await;
        self.exec.shutdown().await;
        self.servers.stop_all().await;
        self.history.flush();
        self.storage.flush_all();
        let server = self.ui.lock().unwrap_or_else(|err| err.into_inner()).take();
        if let Some(mut server) = server {
            server.stop().await;
        }
        self.started.store(false, Ordering::SeqCst);
    }

    /// 退出内核的**唯一收口**：托盘「退出」、`/api/app/quit`、壳的 `app/shutdown` 全走这里。
    ///
    /// 统一为：广播退出（UI 先知道）→ 收尾 → 回请壳退出（壳发起的退出不必回请）→
    /// 延迟 120ms 让在途响应写出去再 exit。
    pub async fn quit(self: &Arc<Self>, quit_shell: bool) {
        if self.quitting.swap(true, Ordering::SeqCst) {
            return;
        }
        self.bus.emit(names::SHELL_VISIBILITY, &json!({ "visible": false }));
        self.bus.emit(names::APP_QUIT, &json!({}));
        self.stop().await;
        if quit_shell {
            let _ = self.primitives.quit().await;
        }
        tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(120)).await;
            std::process::exit(0);
        });
    }

    /// 热更新收尾：排空在途请求 → 通知壳 → 优雅退出（壳 `supervise` 会拉起新二进制）。
    ///
    /// 「不中断正在处理的请求」在这里落地：先 `drain`（等在途请求跑完，最长 3s），
    /// 再停服务退出 —— SSE 长连接不计入在途（否则永远等不到 0）。
    pub async fn hot_restart(self: &Arc<Self>, reason: &str) {
        if self.quitting.swap(true, Ordering::SeqCst) {
            return;
        }
        let payload = json!({
            "reason": reason,
            "version": self.version(),
            "pid": std::process::id(),
            "hotVersion": crate::hot::HOT_UPDATE_VERSION,
        });
        self.bus.emit(names::HOT_RESTARTING, &payload);
        self.link.notify("kernel/restarting", Some(payload.clone()));
        self.log("info", &format!("内核热更新重启：{reason}（等待在途请求排空…）"));

        let drained = self.hot.drain(std::time::Duration::from_secs(3)).await;
        if !drained {
            self.log("warn", &format!("在途请求未能排空（剩余 {}），继续重启", self.hot.inflight()));
        }
        // 兜底：stop() 可能被未断开的 SSE 长连接拖住；数据已在 stop() 里 flush 过
        tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
            std::process::exit(0);
        });
        self.stop().await;
    }

    // ── 窗口显隐（状态机在 `WindowVisibility`，这里是薄转发）────────

    pub async fn show_window_animated(self: &Arc<Self>, focus: bool) -> Result<()> {
        let selection = self.visibility.show(focus).await?;
        self.apply_selection(selection.as_deref());
        Ok(())
    }

    /// 唤出时把前台选中的文本带进搜索框（requirements §3.1）。
    ///
    /// 只填**搜索框为空**时的：用户已经开始打字（或开了「保留上次输入」）时覆盖输入是最伤人的
    /// 行为 —— 选中文本大多只是「顺带的上下文」，而正在输的内容是明确意图。
    pub fn apply_selection(&self, text: Option<&str>) -> bool {
        let Some(text) = text else { return false };
        let value = text.trim();
        if value.is_empty() || value.chars().count() > SELECTION_MAX_CHARS {
            return false;
        }
        if !self.host_ui.search_content().trim().is_empty() {
            return false;
        }
        self.host_ui.set_query(value);
        self.bus.emit(names::UI_SEARCH_CONTENT, &json!({ "value": value }));
        true
    }

    pub async fn emit_visible_animated(&self) {
        self.visibility.emit_visible().await;
    }

    pub async fn hide_window_animated(self: &Arc<Self>) -> Result<()> {
        self.visibility.hide().await
    }

    /// UI 回执：离场动画的最后一帧已经画出来了 —— 现在可以落地了。
    pub async fn finish_window_hide(self: &Arc<Self>) {
        self.visibility.finish_hide().await;
    }

    pub async fn cancel_pending_hide(&self) {
        self.visibility.cancel_pending_hide().await;
    }

    // ── 命令执行 ────────────────────────────────────────────────

    /// 执行命令（入口：UI / 插件 / 宿主）。
    pub async fn invoke(self: &Arc<Self>, id: &str, args: Option<Value>, source: &str) -> ActionResult {
        let Some(entry) = self.registry.get(id) else {
            return ActionResult::failure("host", "NOT_FOUND", format!("命令不存在：{id}"));
        };
        if !self.plugins.is_active(&entry.plugin_id) {
            return ActionResult::failure("host", "NOT_FOUND", format!("插件未启用：{}", entry.plugin_id));
        }
        let ctx = ExecContext {
            id: id.to_string(),
            plugin_id: entry.plugin_id.clone(),
            command: entry.decl.name.clone(),
            mode: entry.decl.mode,
            args: args.clone(),
            session: None,
            source: source.to_string(),
            meta: Default::default(),
        };

        let terminal: crate::pipeline::Next = {
            let ctx = ctx.clone();
            let kernel = self.clone();
            Arc::new(move || {
                let ctx = ctx.clone();
                let kernel = kernel.clone();
                Box::pin(async move { kernel.execute(&ctx).await }) as BoxFuture<ActionResult>
            })
        };

        let result = self.pipeline.run(ctx, terminal).await;
        // `history: false` 的插件（底座自身入口）不进「最近使用」—— 它们一用就占满整个分区
        if result.ok && result.kind != "host" && !self.plugins.excludes_history(&entry.plugin_id) {
            let key = item_key(&entry.plugin_id, &entry.decl.name, args.as_ref());
            self.history.record(HistoryEntry {
                key: key.clone(),
                plugin_id: entry.plugin_id.clone(),
                command: entry.decl.name.clone(),
                snapshot: crate::contract::ItemSnapshot {
                    title: entry.decl.title.clone(),
                    subtitle: entry.decl.subtitle.clone(),
                    icon: entry.decl.icon.clone(),
                    args: args.clone(),
                    action: None,
                },
            });
            self.bus.emit(names::HISTORY_CHANGED, &json!({ "key": key }));
        }
        result
    }

    async fn execute(self: &Arc<Self>, ctx: &ExecContext) -> ActionResult {
        if self.registry.get(&ctx.id).is_none() {
            return ActionResult::failure("host", "NOT_FOUND", "命令已消失");
        }
        if ctx.mode == crate::manifest::CommandMode::View {
            return self.open_session(&ctx.plugin_id, &ctx.command, ctx.args.clone()).await;
        }
        match self.exec.run(&ctx.plugin_id, &ctx.command, ctx.args.clone(), None).await {
            Ok(data) => ActionResult::with_data("script", data),
            Err(err) => ActionResult::failure("script", &err.code, err.message),
        }
    }

    /// 打开 view 会话（每次打开 = 新会话；生产用插件 listener，开发用 dev server）。
    pub async fn open_session(&self, plugin_id: &str, command: &str, args: Option<Value>) -> ActionResult {
        let (Some(base), Some(origin)) = (self.plugins.base_url_for(plugin_id), self.plugins.session_origin_for(plugin_id))
        else {
            return ActionResult::failure("view", "NOT_FOUND", format!("插件页不可用：{plugin_id}"));
        };
        let port = origin.rsplit(':').next().and_then(|value| value.parse::<u16>().ok()).unwrap_or(0);
        let session = self.sessions.create(plugin_id, command, port);

        let mut params = vec![
            ("sid".to_string(), session.sid.clone()),
            ("cmd".to_string(), command.to_string()),
            ("theme".to_string(), self.host_ui.theme()),
            ("token".to_string(), session.token.clone()),
        ];
        if let Some(args) = args.as_ref() {
            if let Ok(serialized) = serde_json::to_string(args) {
                params.push(("args".to_string(), serialized));
            }
        }
        let query: String = params
            .into_iter()
            .map(|(key, value)| format!("{key}={}", url_encode(&value)))
            .collect::<Vec<_>>()
            .join("&");
        let url = format!("{base}/index.html?{query}");

        let mut result = ActionResult::with_data(
            "view",
            json!({ "sid": session.sid, "url": url, "pluginId": plugin_id, "command": command, "title": self.plugins.title_of(plugin_id) }),
        );
        // view 命令保持窗口可见：启动台切换到插件视图（requirements §3.2 二级面板）
        result.hide_launcher = Some(false);
        result
    }

    /// 执行结果项的 ActionDecl（UI 点击 / Enter）。
    pub async fn run_action(self: &Arc<Self>, action: &Value, source: (&str, &str)) -> ActionResult {
        let plugin_id = source.0;
        let capabilities = self.plugins.capabilities_of(plugin_id);
        let action_type = action.get("type").and_then(Value::as_str).unwrap_or_default();
        match action_type {
            "command" => {
                let command = action.get("command").and_then(Value::as_str).unwrap_or_default();
                let args = action.get("args").cloned();
                self.invoke(&format!("{plugin_id}:{command}"), args, "ui").await
            }
            "invoke" => {
                let target = action.get("pluginId").and_then(Value::as_str).unwrap_or_default();
                let command = action.get("command").and_then(Value::as_str).unwrap_or_default();
                self.invoke(&format!("{target}:{command}"), action.get("args").cloned(), "ui").await
            }
            "open" => {
                if !capabilities.contains("shell.open") {
                    return ActionResult::failure("open", "CAPABILITY_DENIED", "插件未声明 shell.open");
                }
                let target = action.get("target").and_then(Value::as_str).unwrap_or_default();
                let target_kind = action.get("targetKind").and_then(Value::as_str).unwrap_or("url");
                let outcome = if target_kind == "path" || target_kind == "app" {
                    self.primitives.shell_open_path(plugin_id, target).await
                } else {
                    self.primitives.shell_open_url(plugin_id, target).await
                };
                match outcome {
                    Ok(()) => {
                        let mut result = ActionResult::ok("open");
                        result.hide_launcher = Some(true);
                        result
                    }
                    Err(err) => ActionResult::failure("open", &err.code, err.message),
                }
            }
            "copy" => {
                if !capabilities.contains("clipboard.write") {
                    return ActionResult::failure("copy", "CAPABILITY_DENIED", "插件未声明 clipboard.write");
                }
                let text = action.get("text").and_then(Value::as_str).unwrap_or_default();
                match self.primitives.clipboard_write_text(plugin_id, "ui", text).await {
                    Ok(()) => {
                        let mut result = ActionResult::ok("copy");
                        result.hide_launcher = Some(true);
                        result
                    }
                    Err(err) => ActionResult::failure("copy", &err.code, err.message),
                }
            }
            "host" => {
                let method = action.get("method").and_then(Value::as_str).unwrap_or_default();
                if method == "hostUi.setSearchContent" {
                    let value = action.get("value").and_then(Value::as_str).unwrap_or_default();
                    self.host_ui.set_query(value);
                    self.bus.emit(names::UI_SEARCH_CONTENT, &json!({ "value": value }));
                    return ActionResult::ok("host");
                }
                if method == "hostUi.hide" {
                    let _ = self.hide_window_animated().await;
                    let mut result = ActionResult::ok("host");
                    result.hide_launcher = Some(true);
                    return result;
                }
                ActionResult::failure("host", "NOT_FOUND", format!("未知 host 方法：{method}"))
            }
            _ => ActionResult::failure("host", "BAD_ARGS", "未知动作类型"),
        }
    }

    /// 把一个结果项转换为可执行动作（列表项默认动作）。
    pub async fn execute_item(
        self: &Arc<Self>,
        plugin_id: &str,
        item: &ResultItem,
        args: Option<Value>,
        command: Option<&str>,
    ) -> ActionResult {
        let action_type = item.action.get("type").and_then(Value::as_str).unwrap_or_default();
        let action_command = item.action.get("command").and_then(Value::as_str).unwrap_or_default();
        let target_command = command.unwrap_or(if action_type == "command" { action_command } else { "" });

        let mut action = item.action.clone();
        if let Some(args) = args.as_ref() {
            if let Value::Object(object) = &mut action {
                object.insert("args".to_string(), args.clone());
            }
        }
        if !target_command.is_empty() && action_type == "command" && !action_command.is_empty() {
            let args = args.or_else(|| action.get("args").cloned());
            return self.invoke(&format!("{plugin_id}:{action_command}"), args, "ui").await;
        }
        let result = self.run_action(&action, (plugin_id, target_command)).await;
        self.remember_item_result(plugin_id, item, &action, &result);
        result
    }

    /// 非命令结果项（应用 / 文件 / 网址）执行成功也写历史 —— 否则「最近使用」永远只有命令（§7.5）。
    /// key 与搜索侧 `rankPluginItem` 完全一致，最近使用才能和最佳匹配对上号。
    fn remember_item_result(&self, plugin_id: &str, item: &ResultItem, action: &Value, result: &ActionResult) {
        if !result.ok || result.kind == "host" {
            return;
        }
        if self.plugins.excludes_history(plugin_id) {
            return;
        }
        let command = plugin_key_of(item);
        let key = item_key(plugin_id, &command, Some(item.action.get("args").unwrap_or(&item.action)));
        self.history.record(HistoryEntry {
            key: key.clone(),
            plugin_id: plugin_id.to_string(),
            command,
            snapshot: crate::contract::ItemSnapshot {
                title: item.title.clone(),
                subtitle: item.subtitle.clone(),
                icon: item.icon.clone(),
                args: None,
                action: Some(action.clone()),
            },
        });
        self.bus.emit(names::HISTORY_CHANGED, &json!({ "key": key }));
    }

    /// 供 UI 查询：命令 + 固定 / 最近（空输入的本地快照）。
    pub fn snapshot(&self) -> Value {
        let commands: Vec<Value> = self
            .registry
            .list()
            .iter()
            .filter(|entry| entry.decl.hidden != Some(true))
            .map(|entry| {
                let mut value = json!({
                    "id": entry.id,
                    "pluginId": entry.plugin_id,
                    "pluginTitle": entry.plugin_title,
                    "title": entry.decl.title,
                    "mode": entry.decl.mode.as_str(),
                });
                if let Some(subtitle) = &entry.decl.subtitle {
                    value["subtitle"] = json!(subtitle);
                }
                if let Some(icon) = &entry.decl.icon {
                    value["icon"] = json!(icon);
                }
                if let Some(placeholder) = &entry.decl.placeholder {
                    value["placeholder"] = json!(placeholder);
                }
                value
            })
            .collect();
        json!({
            "commands": commands,
            "pinned": self.history.pinned_list(),
            "recent": self.history.recent(50),
        })
    }

    // ── 配置 / 插件管理 / 托盘 ──────────────────────────────────

    /// 配置写入的**唯一收口**：落盘 → 副作用（历史上限 / 自启 / 热键）→ 广播 `config/changed`。
    ///
    /// 主题 / 主题色 / 密度只有启动台 UI 知道怎么落到 CSS 变量上，漏一次广播 = 用户看到
    /// 「改了没反应」，而配置文件其实早写进去了。别再在调用点上补，收在这里。
    pub async fn patch_config(&self, patch: Value) -> Result<Value> {
        let before = self.config.get();
        let config = self
            .config
            .patch(&patch)
            .map_err(|err| KernelError::new("INTERNAL", err.to_string()))?;
        if config.history_limit != before.history_limit {
            self.history.set_history_limit(config.history_limit);
        }
        self.bus.emit(names::CONFIG_CHANGED, &json!({ "config": config }));

        if let Some(enabled) = patch.get("autostart").and_then(Value::as_bool) {
            if config.autostart != before.autostart {
                let _ = self.primitives.set_autostart(enabled).await;
            }
        }
        if patch.get("hotkey").is_some() && config.hotkey.accelerator != before.hotkey.accelerator {
            let hotkey = self.apply_hotkey(&config).await;
            return Ok(json!({ "config": config, "hotkey": hotkey }));
        }
        Ok(json!({ "config": config }))
    }

    /// 插件管理动作（托盘、设置面板、HTTP API 共用同一条路径）。
    pub async fn plugin_action(self: &Arc<Self>, action: &str, payload: &Value) -> Result<Value> {
        // 内核自身的热更新动作：只对 `internal-` 插件开放（`ctx.settings` 的注入闸门见 ADR-0003）
        if action == "applyKernelUpdate" {
            return self.apply_kernel_update(payload).await;
        }
        let result = self.admin.run(action, payload).await;
        // 启用 / 禁用 / 安装 / 卸载都会改变「谁在订阅剪贴板」
        self.sync_clipboard_watch().await;
        result
    }

    /// 应用内核热更新（`internal-store` 的「内核更新」发起）：stage 自检 → 备份 → 原子替换（含 UI）→ 优雅重启。
    ///
    /// 与 `POST /api/hot/binary` 同一条底层路径；**必须由 view 发起**（重启会杀掉正在执行命令的子进程，
    /// 与插件更新的分工完全一致：下载在逻辑层、安装由 view 调 `ctx.settings.pluginAction` 发起）。
    async fn apply_kernel_update(self: &Arc<Self>, payload: &Value) -> Result<Value> {
        let path = payload
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::bad_args("path 必填（候选内核二进制的本地路径）"))?
            .to_string();
        let version = payload.get("version").and_then(Value::as_str).unwrap_or_default().to_string();
        let ui = payload.get("uiPath").and_then(Value::as_str).map(std::path::PathBuf::from);
        let restart = payload.get("restart").and_then(Value::as_bool).unwrap_or(true);
        let dir = self.hot.dir().to_path_buf();

        let (staged, report) = match crate::hot::binary::stage(&dir, std::path::Path::new(&path), &version) {
            Ok(value) => value,
            Err(err) => {
                self.hot.log().append(json!({
                    "type": "binary", "result": "rejected", "stage": "probe",
                    "source": format!("pluginAction:{path}"), "detail": err.message,
                }));
                return Err(err);
            }
        };
        let ui_path = crate::hot::binary::peer_ui(ui.as_deref(), &staged);
        let pending = match crate::hot::binary::apply(&dir, &staged, &self.version(), &report.version, ui_path.as_deref()) {
            Ok(pending) => pending,
            Err(err) => {
                self.hot.log().append(json!({
                    "type": "binary", "result": "rejected", "stage": "apply",
                    "source": format!("pluginAction:{path}"), "detail": err.message,
                }));
                return Err(err);
            }
        };
        self.hot.log().append(json!({
            "type": "binary",
            "result": "applied",
            "source": format!("pluginAction:{path}"),
            "from": pending.from_version,
            "to": pending.to_version,
            "ui": pending.ui_target.is_some(),
        }));
        if restart {
            let kernel = self.clone();
            tokio::spawn(async move { kernel.hot_restart("kernel-update").await });
        }
        Ok(json!({
            "ok": true,
            "pending": pending,
            "restartScheduled": restart,
            "note": "内核会优雅重启（等在途请求排空）；新版本若连续两次启动未就绪，下一次启动自动回滚",
        }))
    }

    // ── 剪贴板监听（plugin-spec §8.1）───────────────────────────

    /// 有插件订阅才向壳开监听，一个都不剩就关掉。
    ///
    /// 幂等：状态没变就不打扰壳（插件启停很频繁，而壳侧开/关要动一个线程）。
    /// 壳不支持（非 Windows）时按「已同步」记账 —— 平台在进程生命周期内不会变，
    /// 反复重试只会把同一条降级日志刷一遍又一遍。
    pub async fn sync_clipboard_watch(&self) {
        let wanted = !self.plugins.plugins_with_capability("clipboard.watch").is_empty();
        if wanted == self.clipboard_watch.load(Ordering::SeqCst) {
            return;
        }
        let ok = self.primitives.clipboard_watch(wanted).await;
        self.clipboard_watch.store(wanted, Ordering::SeqCst);
        if wanted && !ok {
            self.log(
                "warn",
                "剪贴板监听未开启（壳不支持或调用失败）：声明 clipboard.watch 的插件不会收到变化事件",
            );
        }
    }

    /// 壳通报剪贴板变化 → 拉起订阅插件的 `record` 命令（一次性：spawn → done → 回收）。
    ///
    /// 每个插件各跑一次、互不等待：读不读、记不记由插件自己决定，失败只记日志 ——
    /// 「一次复制没记上」不值得打断用户，更不该让一个插件的失败拖住其它订阅者。
    pub async fn on_clipboard_changed(&self, params: &Value) {
        let args = json!({
            "changeCount": params.get("changeCount").and_then(Value::as_u64).unwrap_or(0),
            "kinds": params.get("kinds").cloned().unwrap_or_else(|| json!([])),
        });
        for plugin_id in self.plugins.plugins_with_capability("clipboard.watch") {
            if self.registry.get(&format!("{plugin_id}:{RECORD_COMMAND}")).is_none() {
                self.log("warn", &format!("插件 {plugin_id} 声明了 clipboard.watch 却没有 {RECORD_COMMAND} 命令，跳过"));
                continue;
            }
            let exec = self.exec.clone();
            let id = plugin_id.clone();
            let args = args.clone();
            tokio::spawn(async move {
                if let Err(err) = exec.run(&id, RECORD_COMMAND, Some(args), Some(RECORD_TIMEOUT_MS)).await {
                    crate::log_warn!("剪贴板记录失败（{id}）：{}", err.message);
                }
            });
        }
    }

    /// 注册全局热键。壳在被占用时会自动回退到候选键 —— 这里把**实际生效的键**写回配置，
    /// 这样下次启动就能直接用可用的那个。
    pub async fn apply_hotkey(&self, config: &crate::config::Config) -> HotkeyResult {
        let requested = config.hotkey.accelerator.clone();
        let result = self.primitives.register_hotkey(&requested).await;
        if result.ok {
            if let Some(accelerator) = result.accelerator.clone() {
                if accelerator != requested {
                    let _ = self.config.patch(&json!({ "hotkey": { "accelerator": accelerator } }));
                    self.log("warn", &format!("热键 {requested} 不可用，已改用 {accelerator}（已写回配置）"));
                    self.bus.emit(
                        names::PLUGIN_STATE,
                        &json!({ "hotkey": { "accelerator": accelerator, "fallback": true } }),
                    );
                }
            }
        } else {
            self.log(
                "warn",
                &format!("全局热键注册失败（{requested}）：{}", result.reason.clone().unwrap_or_else(|| "可能被占用".to_string())),
            );
            self.bus.emit(names::PLUGIN_STATE, &json!({ "hotkey": { "accelerator": requested, "ok": false } }));
        }
        result
    }

    /// 托盘菜单由内核提供（便于插件加项），壳只负责渲染。
    pub async fn register_tray(&self) {
        let items = json!([
            { "id": "show", "label": "唤出启动台" },
            { "id": "separator-1", "label": "", "type": "separator" },
            { "id": "settings", "label": "设置…" },
            { "id": "plugins", "label": "插件管理…" },
            { "id": "reload", "label": "重载全部插件" },
            { "id": "separator-2", "label": "", "type": "separator" },
            { "id": "quit", "label": "退出" },
        ]);
        let _ = self.primitives.set_tray_menu(items).await;
    }

    pub async fn handle_tray_menu(self: &Arc<Self>, id: &str) {
        match id {
            "show" => {
                let _ = self.show_window_animated(true).await;
            }
            "settings" | "plugins" => {
                // 托盘点菜单时窗口多半藏着：先唤出，再打开对应页面。
                let _ = self.show_window_animated(true).await;
                let command = if id == "settings" { "settings" } else { "manage" };
                let result = self.invoke(&format!("internal-settings:{command}"), None, "host").await;
                // UI 打开插件页靠的是 invoke 的返回值（HTTP 路径由调用方处理）；
                // 托盘这条路没有调用方，结果不广播 = 点了没反应。带上完整
                // ActionResult 广播，UI 端复用同一条 handleResult（失败也能 toast）。
                if let Ok(value) = serde_json::to_value(&result) {
                    self.bus.emit(names::UI_OPEN_VIEW, &value);
                }
            }
            "reload" => self.plugins.reload_all().await,
            "quit" => self.quit(true).await,
            _ => {}
        }
    }
}

fn platform_string() -> String {
    // 与 v1 的 `process.platform` 保持同一套取值（UI / 契约里可能有判断）
    match std::env::consts::OS {
        "macos" => "darwin".to_string(),
        "windows" => "win32".to_string(),
        other => other.to_string(),
    }
}

fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split('/').next()?;
    Some(format!("{scheme}://{authority}"))
}

fn url_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
