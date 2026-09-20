//! 内核热更新（v0.1.0）：不重启进程地热替换**路由 / 中间件 / 事件订阅**，并支持内核二进制热替换。
//!
//! ## 机制（对齐插件热更新的更新语义：plugin-spec §6.4 / ADR-0006）
//!
//! ```text
//!   投递（本地文件 / HTTP 请求体）          内核（本模块）                     生效范围
//!   ────────────────────────────          ──────────────────────────        ─────────────
//!   spec.json ──① validate ──────────────▶ 校验（schema / 版本 / 路由冲突）
//!              ──② build ───────────────▶ 构建候选代（路由树 + 中间件 + 订阅）
//!              ──③ probe ───────────────▶ 对候选代发自检请求（失败 ⇒ 不切换）
//!              ──④ swap（原子）─────────▶ 新请求走新代；在途请求持旧代跑完（零中断）
//!              ──⑤ verify ──────────────▶ 复核失败 ⇒ 自动 swap 回上一稳定代（回滚）
//! ```
//!
//! - **generation（代）**：每次成功应用产出一个不可变的「代」快照（路由树 + 中间件配置 +
//!   事件订阅）。请求进入时取一份当前代的 Arc，处理完释放 —— 切换只换指针，
//!   在途请求继续用旧代跑完，**不中断**。
//! - **两阶段**：`stage`（只校验落盘到 `candidate.json`）→ `apply`（构建 + 自检 + 原子切换）。
//! - **回滚**：保留上一稳定代（`previous.json`，只留 1 份）；apply 失败**不动当前代**；
//!   手动 `rollback` 与上一代互换（再执行一次 = 恢复刚才回滚掉的那一版）。
//! - **日志**：`<dataRoot>/hot/hot-update.log`（JSONL），每行含时间 / 机制版本 / 变更模块 / 结果。
//! - **持久化**：`current.json` / `previous.json` 落在 `<dataRoot>/hot/`，内核重启后自动恢复。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use axum::Router;
use serde::Serialize;
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::error::{KernelError, Result};
use crate::events::{EventBus, EventHandler};
use crate::util::now_ms;

pub use log::HotLog;
use self::spec::HotSpec;

pub mod binary;
pub mod log;
pub mod middleware;
pub mod spec;

pub use spec::HOT_UPDATE_VERSION;

pub const CURRENT_FILE: &str = "current.json";
pub const PREVIOUS_FILE: &str = "previous.json";
pub const CANDIDATE_FILE: &str = "candidate.json";

/// 事件订阅的取消句柄（切换代时先装新的、再撤旧的）。
pub type BusDisposer = Box<dyn Fn() + Send + Sync>;
/// 路由树构建器（由 kernel 注入：`api::router_with` + 中间件 + 状态装配）。
pub type TreeBuilder = Arc<dyn Fn(&HotSpec) -> Result<Router> + Send + Sync>;

/// 一次成功应用的结果（HTTP 返回 / 日志用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub generation: u64,
    pub revision: String,
    pub previous_revision: String,
    pub modules: Vec<String>,
    pub probed: usize,
    pub source: String,
}

/// 内核对热更新的全部状态。
pub struct HotUpdate {
    dir: PathBuf,
    log: HotLog,
    bus: EventBus,
    builder: TreeBuilder,
    inflight: Arc<AtomicU64>,
    inner: RwLock<Inner>,
}

struct Inner {
    generation: u64,
    spec: HotSpec,
    revision: String,
    applied_at_ms: i64,
    tree: Arc<Router>,
    disposers: Vec<BusDisposer>,
    previous: Option<StableGen>,
}

#[derive(Clone)]
struct StableGen {
    spec: HotSpec,
    revision: String,
    generation: u64,
    applied_at_ms: i64,
}

impl HotUpdate {
    pub fn new(dir: PathBuf, log: HotLog, bus: EventBus, builder: TreeBuilder) -> Self {
        Self {
            dir,
            log,
            bus,
            builder,
            inflight: Arc::new(AtomicU64::new(0)),
            inner: RwLock::new(Inner {
                generation: 0,
                spec: HotSpec::default(),
                revision: String::new(),
                applied_at_ms: 0,
                tree: Arc::new(Router::new()),
                disposers: Vec::new(),
                previous: None,
            }),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn log(&self) -> &HotLog {
        &self.log
    }

    /// 在途请求计数（热中间件维护；优雅重启的排空依据）。
    pub fn inflight(&self) -> u64 {
        self.inflight.load(Ordering::SeqCst)
    }

    pub fn inflight_counter(&self) -> Arc<AtomicU64> {
        self.inflight.clone()
    }

    /// 当前生效的路由树（每次请求取一次快照）。
    pub fn current_tree(&self) -> Arc<Router> {
        self.inner.read().unwrap_or_else(|err| err.into_inner()).tree.clone()
    }

    /// 启动加载：`current.json` → 校验 → 构建 → 成为第 1 代；坏文件回落内置默认（不阻塞启动）。
    pub fn boot(&self) -> Result<()> {
        let path = self.dir.join(CURRENT_FILE);
        let stored: Option<HotSpec> = crate::util::fsx::read_json(&path, None);
        let (spec, persisted, detail) = match stored {
            Some(spec) => match spec::validate(&spec, &spec::builtin_paths()) {
                Ok(()) => {
                    let revision = spec.revision.clone();
                    (spec, true, format!("已从 {CURRENT_FILE} 恢复（revision={revision}）"))
                }
                Err(err) => (
                    default_spec(),
                    false,
                    format!("{CURRENT_FILE} 不合法（{}），回落内置默认", err.message),
                ),
            },
            None => (default_spec(), false, format!("无 {CURRENT_FILE}，使用内置默认（仅内置路由）")),
        };

        let tree = self.build_or_default(&spec)?;
        let revision = if spec.revision.is_empty() { "builtin".to_string() } else { spec.revision.clone() };
        {
            let mut inner = self.inner.write().unwrap_or_else(|err| err.into_inner());
            inner.generation = 1;
            inner.spec = spec.clone();
            inner.revision = revision.clone();
            inner.applied_at_ms = now_ms();
            inner.tree = Arc::new(tree);
            inner.disposers = self.subscribe_bus(&spec);
        }
        let modules = if persisted { spec.modules.clone() } else { Vec::new() };
        self.log.append(json!({
            "type": "boot",
            "result": if persisted { "restored" } else { "default" },
            "generation": 1,
            "revision": revision,
            "modules": modules,
            "detail": detail,
        }));
        Ok(())
    }

    /// 两阶段之一：只校验并落盘到 `candidate.json`（不生效）。
    pub fn stage(&self, spec: &HotSpec, source: &str) -> Result<()> {
        if let Err(err) = spec::validate(spec, &spec::builtin_paths()) {
            self.log.append(json!({
                "type": "stage",
                "result": "rejected",
                "source": source,
                "revision": spec.revision,
                "detail": err.message,
            }));
            return Err(err);
        }
        let path = self.dir.join(CANDIDATE_FILE);
        crate::util::fsx::write_json_atomic(&path, spec)
            .map_err(|err| KernelError::internal(format!("候选 spec 落盘失败：{err}")))?;
        self.log.append(json!({
            "type": "stage",
            "result": "staged",
            "source": source,
            "revision": spec.revision,
            "modules": spec.modules,
            "path": path.display().to_string(),
        }));
        Ok(())
    }

    /// 应用一份 spec：校验 → 构建 → 自检 → 原子切换 → 复核（失败自动回滚）。
    ///
    /// 任何失败都**不会**破坏当前代 —— 这就是「新版本加载失败自动恢复上一稳定版本」。
    pub async fn apply(&self, spec: HotSpec, source: &str) -> Result<ApplyOutcome> {
        if let Err(err) = spec::validate(&spec, &spec::builtin_paths()) {
            self.log.append(json!({
                "type": "apply",
                "result": "rejected",
                "source": source,
                "revision": spec.revision,
                "detail": err.message,
            }));
            return Err(err);
        }

        // ① 构建候选代（不动现状）
        let tree = match (self.builder)(&spec) {
            Ok(tree) => tree,
            Err(err) => {
                self.log.append(json!({
                    "type": "apply",
                    "result": "rejected",
                    "stage": "build",
                    "source": source,
                    "revision": spec.revision,
                    "detail": err.message,
                }));
                return Err(err);
            }
        };

        // ② 自检（不过关就不切换）
        let probed = match spec::probe(&tree, &spec).await {
            Ok(probed) => probed,
            Err(err) => {
                self.log.append(json!({
                    "type": "apply",
                    "result": "rejected",
                    "stage": "probe",
                    "source": source,
                    "revision": spec.revision,
                    "detail": err.message,
                }));
                return Err(err);
            }
        };

        // ③ 原子切换：新请求立刻走新代；在途请求持旧代跑完
        let (generation, revision, previous_revision, modules) = {
            let mut inner = self.inner.write().unwrap_or_else(|err| err.into_inner());
            let previous = StableGen {
                spec: inner.spec.clone(),
                revision: inner.revision.clone(),
                generation: inner.generation,
                applied_at_ms: inner.applied_at_ms,
            };
            let modules = spec::changed_modules(&inner.spec, &spec);
            let revision = if spec.revision.is_empty() { format!("gen-{}", inner.generation + 1) } else { spec.revision.clone() };
            inner.generation += 1;
            inner.spec = spec.clone();
            inner.revision = revision.clone();
            inner.applied_at_ms = now_ms();
            inner.tree = Arc::new(tree);
            inner.previous = Some(previous.clone());
            // 事件订阅：先装新的、再撤旧的（注销不参与原子性，放锁外做）
            let disposers = self.subscribe_bus(&spec);
            let old = std::mem::replace(&mut inner.disposers, disposers);
            let generation = inner.generation;
            drop(inner);
            for dispose in old {
                dispose();
            }
            (generation, revision, previous.revision, modules)
        };

        // ④ 落盘（失败只记日志：内存里已生效，不能因为磁盘问题让「已切到新代」的事实丢失）
        if let Err(err) = self.persist(&spec) {
            self.log.append(json!({ "type": "apply", "result": "persist-failed", "detail": err.message }));
        }

        // ⑤ 复核：走**当前分发通道**再自检一次；失败自动回滚
        if let Err(err) = spec::probe(&self.current_tree(), &spec).await {
            let detail = self.rollback_internal("apply-verify").await.unwrap_or_else(|rollback_err| {
                format!("自动回滚失败：{}", rollback_err.message)
            });
            self.log.append(json!({
                "type": "apply",
                "result": "rolled-back",
                "stage": "verify",
                "source": source,
                "revision": revision,
                "detail": format!("{}；{detail}", err.message),
            }));
            return Err(KernelError::new("ROLLED_BACK", format!("新版本复核失败已回滚：{}", err.message)));
        }

        let message = format!(
            "热更新已应用：{previous_revision} → {revision}（代数 {generation}，模块 {}）",
            if modules.is_empty() { "无实质变化".to_string() } else { modules.join("/") }
        );
        self.log.append(json!({
            "type": "apply",
            "result": "applied",
            "source": source,
            "from": previous_revision.clone(),
            "to": revision,
            "generation": generation,
            "modules": modules,
            "probed": probed,
            "inflight": self.inflight(),
        }));
        self.bus.emit(
            crate::events::names::HOT_UPDATED,
            &json!({
                "hotVersion": HOT_UPDATE_VERSION,
                "generation": generation,
                "revision": revision,
                "previousRevision": previous_revision,
                "modules": modules,
                "message": message,
            }),
        );
        Ok(ApplyOutcome { generation, revision, previous_revision, modules, probed, source: source.to_string() })
    }

    /// 回滚到上一稳定代（再执行一次 = 恢复刚才回滚掉的那一版）。
    pub async fn rollback(&self, source: &str) -> Result<ApplyOutcome> {
        let previous_revision = self
            .inner
            .read()
            .unwrap_or_else(|err| err.into_inner())
            .previous
            .as_ref()
            .map(|previous| previous.revision.clone())
            .ok_or_else(|| KernelError::new("NO_PREVIOUS", "没有可回滚的上一稳定版本"))?;

        let detail = self.rollback_internal(source).await?;
        let inner = self.inner.read().unwrap_or_else(|err| err.into_inner());
        let outcome = ApplyOutcome {
            generation: inner.generation,
            revision: inner.revision.clone(),
            previous_revision: previous_revision.clone(),
            modules: vec!["rollback".to_string()],
            probed: 0,
            source: source.to_string(),
        };
        self.log.append(json!({
            "type": "rollback",
            "result": "rolled-back",
            "source": source,
            "to": outcome.revision,
            "generation": outcome.generation,
            "detail": detail,
            "inflight": self.inflight(),
        }));
        self.bus.emit(
            crate::events::names::HOT_UPDATED,
            &json!({
                "hotVersion": HOT_UPDATE_VERSION,
                "generation": outcome.generation,
                "revision": outcome.revision,
                "rolledBack": true,
                "message": format!("已回滚到 {previous_revision}"),
            }),
        );
        Ok(outcome)
    }

    /// 排空在途请求（优雅重启 / 二进制热替换前调用）；超时返回 false。
    pub async fn drain(&self, timeout: Duration) -> bool {
        let started = Instant::now();
        while self.inflight() > 0 && started.elapsed() < timeout {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        self.inflight() == 0
    }

    /// 状态快照（`GET /api/hot/status`）。
    pub fn status(&self, kernel_version: &str) -> Value {
        let inner = self.inner.read().unwrap_or_else(|err| err.into_inner());
        let previous = inner.previous.as_ref().map(|previous| {
            json!({
                "revision": previous.revision,
                "generation": previous.generation,
                "appliedAt": previous.applied_at_ms,
                "spec": previous.spec,
            })
        });
        json!({
            "hotVersion": HOT_UPDATE_VERSION,
            "generation": inner.generation,
            "revision": inner.revision,
            "appliedAt": inner.applied_at_ms,
            "inflight": self.inflight(),
            "modules": inner.spec.modules,
            "spec": inner.spec,
            "previous": previous,
            "paths": {
                "dir": self.dir.display().to_string(),
                "current": self.dir.join(CURRENT_FILE).display().to_string(),
                "candidate": self.dir.join(CANDIDATE_FILE).display().to_string(),
                "previous": self.dir.join(PREVIOUS_FILE).display().to_string(),
                "log": self.log.path().display().to_string(),
            },
            "binary": binary::status_payload(&self.dir, kernel_version),
        })
    }

    pub fn log_tail(&self, limit: usize) -> Vec<Value> {
        self.log.read_tail(limit)
    }

    /// 内核就绪时确认二进制更新（清 pending 台账）。
    pub fn mark_boot_success(&self) -> Option<String> {
        binary::mark_boot_success(&self.dir)
    }

    /// 取走壳的替换回执（读后即删）：由 `Kernel::mark_ready` 写进热更新日志。
    pub fn take_swap_result(&self) -> Option<binary::SwapResult> {
        binary::take_swap_result(&self.dir)
    }

    fn build_or_default(&self, spec: &HotSpec) -> Result<Router> {
        match (self.builder)(spec) {
            Ok(tree) => Ok(tree),
            Err(err) if spec != &default_spec() => {
                self.log.append(json!({
                    "type": "boot",
                    "result": "fallback",
                    "detail": format!("构建失败（{}），回落内置默认", err.message),
                }));
                (self.builder)(&default_spec())
            }
            Err(err) => Err(err),
        }
    }

    /// 事件订阅随代切换：**先装新的、再撤旧的**（宁可多投一次，不可漏投）。
    fn subscribe_bus(&self, spec: &HotSpec) -> Vec<BusDisposer> {
        let mut disposers: Vec<BusDisposer> = Vec::new();
        for event in &spec.bus.log {
            let log = self.log.clone();
            let name = event.clone();
            let handler: EventHandler = Arc::new(move |payload| {
                log.append(json!({
                    "type": "event",
                    "event": name,
                    "payload": summarize(payload),
                }));
            });
            disposers.push(self.bus.on(event, handler));
        }
        disposers
    }

    async fn rollback_internal(&self, source: &str) -> Result<String> {
        let previous = self
            .inner
            .read()
            .unwrap_or_else(|err| err.into_inner())
            .previous
            .clone()
            .ok_or_else(|| KernelError::new("NO_PREVIOUS", "没有可回滚的上一稳定版本"))?;
        let tree = (self.builder)(&previous.spec)?;

        let (from_revision, to_revision) = {
            let mut inner = self.inner.write().unwrap_or_else(|err| err.into_inner());
            let current = StableGen {
                spec: inner.spec.clone(),
                revision: inner.revision.clone(),
                generation: inner.generation,
                applied_at_ms: inner.applied_at_ms,
            };
            let from_revision = current.revision.clone();
            let to_revision = previous.revision.clone();
            inner.generation += 1;
            inner.spec = previous.spec.clone();
            inner.revision = previous.revision.clone();
            inner.applied_at_ms = now_ms();
            inner.tree = Arc::new(tree);
            inner.previous = Some(current);
            let disposers = self.subscribe_bus(&previous.spec);
            let old = std::mem::replace(&mut inner.disposers, disposers);
            drop(inner);
            for dispose in old {
                dispose();
            }
            (from_revision, to_revision)
        };

        if let Err(err) = self.persist(&previous.spec) {
            self.log.append(json!({ "type": "rollback", "result": "persist-failed", "detail": err.message }));
        }
        Ok(format!("{from_revision} → {to_revision}（source={source}）"))
    }

    fn persist(&self, spec: &HotSpec) -> Result<()> {
        let current = self.dir.join(CURRENT_FILE);
        crate::util::fsx::write_json_atomic(&current, spec)
            .map_err(|err| KernelError::internal(format!("current.json 落盘失败：{err}")))?;

        // previous.json：上一稳定代（没有就删掉旧文件）
        let previous_spec = self.inner.read().unwrap_or_else(|err| err.into_inner()).previous.as_ref().map(|p| p.spec.clone());
        let previous_path = self.dir.join(PREVIOUS_FILE);
        match previous_spec {
            Some(spec) => crate::util::fsx::write_json_atomic(&previous_path, &spec)
                .map_err(|err| KernelError::internal(format!("previous.json 落盘失败：{err}")))?,
            None => {
                let _ = std::fs::remove_file(&previous_path);
            }
        }
        Ok(())
    }
}

/// **分发层**：listener 上唯一常驻的 router —— 每个请求现取「当前代」的树来跑。
///
/// 热替换能真正生效的关键：axum 的 `serve` 拿到的是一个**具体的 Router 值**，
/// 换 generation 只改 `HotUpdate` 内部的指针，改不动 listener 手里那棵；
/// 所以 listener 挂这个转发器，树按代取；在途请求拿到的 Arc 指向旧树，跑完即释。
pub fn dispatch_router(hot: Arc<HotUpdate>) -> Router {
    Router::new().fallback(move |request: Request<Body>| {
        let hot = hot.clone();
        async move {
            let tree = (*hot.current_tree()).clone();
            match tree.oneshot(request).await {
                Ok(response) => response,
                Err(err) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(json!({
                        "ok": false,
                        "error": { "code": "INTERNAL", "message": format!("热更新分发失败：{err}") }
                    })),
                )
                    .into_response(),
            }
        }
    })
}

fn default_spec() -> HotSpec {
    HotSpec {
        schema: spec::HOT_SCHEMA,
        hot_version: HOT_UPDATE_VERSION.to_string(),
        ..Default::default()
    }
}

/// 事件载荷摘要（日志用，截断防大 payload 写爆日志）。
fn summarize(payload: &Value) -> String {
    let text = serde_json::to_string(payload).unwrap_or_else(|_| "null".to_string());
    if text.chars().count() <= 200 {
        return text;
    }
    let mut truncated: String = text.chars().take(200).collect();
    truncated.push('…');
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::get;
    use tower::ServiceExt;

    fn temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("hot-manager-{label}-{}", now_ms()))
    }

    fn builder() -> TreeBuilder {
        Arc::new(|spec: &HotSpec| {
            let mut tree: Router = Router::new().route("/api/health", get(|| async { "ok" }));
            tree = tree.merge(spec::extension_router::<()>(spec));
            Ok(tree)
        })
    }

    fn manager(dir: &Path) -> HotUpdate {
        HotUpdate::new(dir.to_path_buf(), HotLog::new(dir), EventBus::new(), builder())
    }

    fn spec_with_ext(path: &str) -> HotSpec {
        HotSpec {
            schema: spec::HOT_SCHEMA,
            hot_version: HOT_UPDATE_VERSION.to_string(),
            revision: format!("rev-{path}"),
            routes: spec::RoutesSpec {
                extensions: vec![spec::ExtensionRoute {
                    kind: "json".to_string(),
                    method: "GET".to_string(),
                    path: path.to_string(),
                    body: Some(json!({ "hot": true })),
                    ..Default::default()
                }],
                disabled: Vec::new(),
            },
            ..Default::default()
        }
    }

    async fn probe_path(manager: &HotUpdate, path: &str) -> u16 {
        let request = Request::builder().uri(path).body(Body::empty()).unwrap();
        manager
            .current_tree()
            .as_ref()
            .clone()
            .oneshot(request)
            .await
            .map(|response| response.status())
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
            .as_u16()
    }

    #[tokio::test]
    async fn apply_switches_route_and_records_log() {
        let dir = temp_dir("apply");
        let manager = manager(&dir);
        manager.boot().expect("boot 应成功");
        assert_eq!(probe_path(&manager, "/api/ext/a").await, 404, "未应用前扩展路由不存在");

        let outcome = manager.apply(spec_with_ext("/api/ext/a"), "test").await.expect("应用应成功");
        assert_eq!(outcome.generation, 2);
        assert_eq!(outcome.modules, vec!["routes"]);
        assert_eq!(probe_path(&manager, "/api/ext/a").await, 200, "应用后扩展路由生效");
        assert_eq!(probe_path(&manager, "/api/health").await, 200, "内置路由不受影响");

        let log = manager.log_tail(20);
        assert!(log.iter().any(|entry| entry["result"] == "applied"), "要有 applied 日志：{log:?}");
        assert!(dir.join(CURRENT_FILE).exists(), "current.json 已落盘");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn rejected_spec_keeps_current_generation() {
        let dir = temp_dir("reject");
        let manager = manager(&dir);
        manager.boot().unwrap();
        manager.apply(spec_with_ext("/api/ext/a"), "test").await.unwrap();

        let mut bad = spec_with_ext("/api/ext/b");
        bad.schema = 42;
        let err = manager.apply(bad, "test").await.expect_err("非法 spec 必须拒绝");
        assert_eq!(err.code, "BAD_ARGS");
        assert_eq!(probe_path(&manager, "/api/ext/a").await, 200, "拒绝后当前代原样在跑");
        assert_eq!(probe_path(&manager, "/api/ext/b").await, 404);
        assert!(manager.log_tail(20).iter().any(|entry| entry["result"] == "rejected"), "要有 rejected 日志");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn rollback_swaps_with_previous_and_can_be_repeated() {
        let dir = temp_dir("rollback");
        let manager = manager(&dir);
        manager.boot().unwrap();
        manager.apply(spec_with_ext("/api/ext/a"), "test").await.unwrap();

        let outcome = manager.rollback("test").await.expect("回滚应成功");
        assert_eq!(probe_path(&manager, "/api/ext/a").await, 404, "回滚后扩展路由消失");
        assert_eq!(probe_path(&manager, "/api/health").await, 200);
        assert!(outcome.revision.contains("builtin"), "回滚目标是内置默认代：{}", outcome.revision);

        manager.rollback("test").await.expect("再回滚一次 = 恢复刚才回滚掉的那一版");
        assert_eq!(probe_path(&manager, "/api/ext/a").await, 200, "重做成功");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn boot_restores_persisted_spec() {
        let dir = temp_dir("boot");
        {
            let manager = manager(&dir);
            manager.boot().unwrap();
            manager.apply(spec_with_ext("/api/ext/a"), "test").await.unwrap();
        }
        // 模拟内核重启：同一数据目录重新 boot
        let reborn = manager(&dir);
        reborn.boot().expect("重启后应能从 current.json 恢复");
        assert_eq!(probe_path(&reborn, "/api/ext/a").await, 200, "持久化的热更新在重启后仍然生效");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn bus_subscription_switches_with_generation() {
        let dir = temp_dir("bus");
        let bus = EventBus::new();
        let manager = HotUpdate::new(dir.clone(), HotLog::new(&dir), bus.clone(), builder());
        manager.boot().unwrap();

        let mut spec = spec_with_ext("/api/ext/a");
        spec.bus.log = vec![crate::events::names::HISTORY_CHANGED.to_string()];
        manager.apply(spec, "test").await.unwrap();
        bus.emit(crate::events::names::HISTORY_CHANGED, &json!({ "count": 3 }));
        assert!(
            manager.log_tail(50).iter().any(|entry| entry["type"] == "event" && entry["event"] == "history/changed"),
            "订阅的事件要写进热更新日志"
        );

        // 回滚后订阅撤销：再 emit 不应新增 event 行
        let before = manager.log_tail(200).iter().filter(|entry| entry["type"] == "event").count();
        manager.rollback("test").await.unwrap();
        bus.emit(crate::events::names::HISTORY_CHANGED, &json!({ "count": 4 }));
        let after = manager.log_tail(200).iter().filter(|entry| entry["type"] == "event").count();
        assert_eq!(before, after, "回滚后旧订阅必须撤销");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 回归：listener 上挂的是**分发层**，换代必须立刻反映到请求路由上。
    /// （第一版把「启动时的树」直接挂给 listener，apply 之后请求仍走旧树 —— 热替换形同虚设。）
    #[tokio::test]
    async fn dispatch_router_follows_generation_switches() {
        let dir = temp_dir("dispatch");
        let manager = Arc::new(manager(&dir));
        manager.boot().unwrap();
        let dispatch = dispatch_router(manager.clone());

        let probe = |path: String| {
            let dispatch = dispatch.clone();
            async move {
                let request = Request::builder().uri(path).body(Body::empty()).unwrap();
                dispatch.oneshot(request).await.map(|response| response.status().as_u16()).unwrap_or(500)
            }
        };

        assert_eq!(probe("/api/ext/a".to_string()).await, 404, "应用前：当前代没有这条扩展路由");
        manager.apply(spec_with_ext("/api/ext/a"), "test").await.unwrap();
        assert_eq!(probe("/api/ext/a".to_string()).await, 200, "应用后：分发层立刻走新代（listener 不用重启）");
        assert_eq!(probe("/api/health".to_string()).await, 200, "内置路由照常");
        manager.rollback("test").await.unwrap();
        assert_eq!(probe("/api/ext/a".to_string()).await, 404, "回滚后：分发层回到上一稳定代");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn drain_waits_for_inflight_requests() {
        let dir = temp_dir("drain");
        let manager = manager(&dir);
        manager.boot().unwrap();
        assert!(manager.drain(Duration::from_millis(30)).await, "没有在途请求时立刻返回 true");

        manager.inflight.fetch_add(1, Ordering::SeqCst);
        assert!(!manager.drain(Duration::from_millis(80)).await, "有在途请求且超时 ⇒ false");
        manager.inflight.fetch_sub(1, Ordering::SeqCst);
        assert!(manager.drain(Duration::from_millis(80)).await, "在途清零后 ⇒ true");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
