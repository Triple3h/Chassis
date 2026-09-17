//! 执行管线（v1 `apps/kernel/src/pipeline.ts`；requirements §7.3）。
//!
//! `invoke → resolve → pre-execute → execute → post-execute → ActionResult`；
//! 中间件本身也是插件注册的（提权确认 / 审计 / 重试都是插件）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::contract::ActionResult;
use crate::exec::BoxFuture;
use crate::types::{Disposer, ExecContext};

pub type Next = Arc<dyn Fn() -> BoxFuture<ActionResult> + Send + Sync>;
pub type Middleware = Arc<dyn Fn(ExecContext, Next) -> BoxFuture<ActionResult> + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Stage {
    PreExecute,
    Execute,
    PostExecute,
}

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Stage::PreExecute => "pre-execute",
            Stage::Execute => "execute",
            Stage::PostExecute => "post-execute",
        }
    }
}

#[derive(Clone)]
struct Entry {
    middleware: Middleware,
    #[allow(dead_code)]
    label: String,
    #[allow(dead_code)]
    plugin_id: String,
    marker: u64,
}

#[derive(Default)]
pub struct Pipeline {
    stages: Mutex<HashMap<Stage, Vec<Entry>>>,
    markers: std::sync::atomic::AtomicU64,
}

impl Pipeline {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn use_middleware(
        self: &Arc<Self>,
        stage: Stage,
        middleware: Middleware,
        plugin_id: &str,
        label: &str,
    ) -> Disposer {
        let marker = self.markers.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let entry = Entry {
            middleware,
            label: label.to_string(),
            plugin_id: plugin_id.to_string(),
            marker,
        };
        self.stages.lock().unwrap_or_else(|err| err.into_inner()).entry(stage).or_default().push(entry);

        let pipeline = self.clone();
        Box::new(move || {
            if let Some(list) = pipeline.stages.lock().unwrap_or_else(|err| err.into_inner()).get_mut(&stage) {
                list.retain(|item| item.marker != marker);
            }
        })
    }

    /// 组合运行：`pre-execute → execute → post-execute`（所有 stage 共享同一个 `ctx`）。
    pub async fn run(&self, ctx: ExecContext, terminal: Next) -> ActionResult {
        let chain: Vec<Entry> = {
            let stages = self.stages.lock().unwrap_or_else(|err| err.into_inner());
            [Stage::PreExecute, Stage::Execute, Stage::PostExecute]
                .iter()
                .flat_map(|stage| stages.get(stage).cloned().unwrap_or_default())
                .collect()
        };

        let mut next: Next = terminal;
        for entry in chain.into_iter().rev() {
            let middleware = entry.middleware.clone();
            let downstream = next.clone();
            let shared_ctx = ctx.clone();
            next = Arc::new(move || middleware(shared_ctx.clone(), downstream.clone()));
        }
        next().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::CommandMode;
    use std::sync::Mutex as StdMutex;

    fn context() -> ExecContext {
        ExecContext {
            id: "demo:run".to_string(),
            plugin_id: "demo".to_string(),
            command: "run".to_string(),
            mode: CommandMode::NoView,
            args: None,
            session: None,
            source: "ui".to_string(),
            meta: HashMap::new(),
        }
    }

    #[tokio::test]
    async fn middlewares_wrap_in_stage_order() {
        let pipeline = Arc::new(Pipeline::new());
        let order = Arc::new(StdMutex::new(Vec::<String>::new()));

        let mark = |stage: &'static str| {
            let order = order.clone();
            Arc::new(move |_ctx: ExecContext, next: Next| {
                let order = order.clone();
                Box::pin(async move {
                    order.lock().unwrap().push(format!("{stage}:enter"));
                    let result = next().await;
                    order.lock().unwrap().push(format!("{stage}:exit"));
                    result
                }) as BoxFuture<ActionResult>
            }) as Middleware
        };

        let _a = pipeline.use_middleware(Stage::PreExecute, mark("pre"), "demo", "pre");
        let _b = pipeline.use_middleware(Stage::Execute, mark("exec"), "demo", "exec");
        let _c = pipeline.use_middleware(Stage::PostExecute, mark("post"), "demo", "post");

        let terminal: Next = Arc::new(|| Box::pin(async { ActionResult::ok("script") }));
        let result = pipeline.run(context(), terminal).await;
        assert!(result.ok);

        let log = order.lock().unwrap().clone();
        assert_eq!(
            log,
            vec!["pre:enter", "exec:enter", "post:enter", "post:exit", "exec:exit", "pre:exit"],
            "洋葱模型：pre 最先进入、最后退出"
        );
    }

    #[tokio::test]
    async fn disposer_removes_middleware() {
        let pipeline = Arc::new(Pipeline::new());
        let hits = Arc::new(StdMutex::new(0));
        let counter = hits.clone();
        let middleware: Middleware = Arc::new(move |_ctx, next| {
            let counter = counter.clone();
            Box::pin(async move {
                *counter.lock().unwrap() += 1;
                next().await
            })
        });
        let dispose = pipeline.use_middleware(Stage::Execute, middleware, "demo", "count");
        let terminal: Next = Arc::new(|| Box::pin(async { ActionResult::ok("script") }));

        pipeline.run(context(), terminal.clone()).await;
        assert_eq!(*hits.lock().unwrap(), 1);

        dispose();
        pipeline.run(context(), terminal).await;
        assert_eq!(*hits.lock().unwrap(), 1, "注销后不再参与");
    }
}
