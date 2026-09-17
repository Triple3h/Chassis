//! 窗口显隐的「动画协作」（v1 `windowVisibility.ts`；ADR-0004）。
//!
//! 壳仍然是「什么时候该显、什么时候该隐」的唯一裁决者，这里只负责**让这次显隐好看一点**：
//! 把广播和真正落地拆成两步，中间留给 UI 播动画的时间。所有跨进程路径都必须走这两个方法，
//! 否则就会出现「有的入口有动画、有的入口啪一下」这种最难查的不一致。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio::sync::{Mutex, Notify};

use crate::error::Result;
use crate::events::{names, EventBus};
use crate::exec::BoxFuture;
use crate::services::primitives::Primitives;

/// 隐藏的**兜底**时长（ms）：等不到 UI 的回执也只能落地。
///
/// 正常路径根本不看这个数：UI 演完离场动画会回执 `/api/window/hidden`，内核拿到就立刻隐藏。
/// 回执才是「演完了」的准确信号 —— 广播穿过 内核 → SSE → webview 的耗时不可控，
/// 任何固定时长都可能砍在淡出中途，把半透明的一帧留成「下一场唤出先亮的旧画面」。
/// 这个值只防「UI 没了 / SSE 断了 / 回执丢了」：500ms 比正常回执（约 140+100ms）宽裕一倍多。
pub const HIDE_FALLBACK_MS: u64 = 500;

/// 「显示」这条广播的延迟（ms）。
///
/// 壳的 `show()` 只是把窗口排进显示队列：窗口真正上屏、webview 从「隐藏」恢复绘制
/// 还要几十毫秒，而 **CSS 的时间线在这段时间里照走**。广播发早了，UI 的入场动画会在
/// 窗口还没有画面的时候播完 —— 用户看到的是「啪」一下整块出现。
pub const SHOW_ANIMATION_MS: u64 = 80;

/// 显隐只用到壳原语的三个方法（v1 用 `Pick<Primitives, …>` 达到同样效果；
/// 独立成窄接口是为了让状态机能拿假实现直接测）。
pub trait VisibilityPrimitives: Send + Sync {
    fn show_window_now(&self, focus: bool) -> BoxFuture<Result<Option<String>>>;
    fn hide_window_now(&self) -> BoxFuture<Result<()>>;
    fn is_visible_now(&self) -> BoxFuture<Option<bool>>;
}

impl VisibilityPrimitives for Arc<Primitives> {
    fn show_window_now(&self, focus: bool) -> BoxFuture<Result<Option<String>>> {
        let primitives = self.clone();
        Box::pin(async move { primitives.show_window(focus).await })
    }

    fn hide_window_now(&self) -> BoxFuture<Result<()>> {
        let primitives = self.clone();
        Box::pin(async move { primitives.hide_window().await })
    }

    fn is_visible_now(&self) -> BoxFuture<Option<bool>> {
        let primitives = self.clone();
        Box::pin(async move { primitives.is_visible().await })
    }
}

struct PendingHide {
    /// 撤销令牌：唤出时 +1，让已经排队的隐藏落地前自己失效
    token: u64,
    /// 让 `hide()` 的调用方等到真正落地（回执或兜底）再返回
    notify: Arc<Notify>,
}

pub struct WindowVisibility {
    primitives: Arc<dyn VisibilityPrimitives>,
    bus: EventBus,
    show_token: AtomicU64,
    hide_token: AtomicU64,
    /// 正在「演离场」的那次隐藏（同一时刻只允许一次）
    pending: Mutex<Option<PendingHide>>,
}

impl WindowVisibility {
    pub fn new(primitives: Arc<dyn VisibilityPrimitives>, bus: EventBus) -> Arc<Self> {
        Arc::new(Self { primitives, bus, show_token: AtomicU64::new(0), hide_token: AtomicU64::new(0), pending: Mutex::new(None) })
    }

    /// 显示窗口：先落地，再等窗口真的能画了才广播。
    /// 广播一定会发（即使敲壳失败）—— UI 更不能停在「隐藏态」（那正好是一块透明窗口）。
    ///
    /// 返回值透传壳读到的**前台选中文本**：那是「显示之前」那一瞬的事实，只有壳抓得住。
    pub async fn show(&self, focus: bool) -> Result<Option<String>> {
        self.cancel_pending_hide().await;
        let outcome = self.primitives.show_window_now(focus).await;
        self.emit_visible().await;
        outcome
    }

    /// 「显示」这条广播要晚一点发：延迟期间又来了隐藏 / 新的显示，这一次就作废。
    pub async fn emit_visible(&self) {
        let token = self.show_token.fetch_add(1, Ordering::SeqCst) + 1;
        tokio::time::sleep(Duration::from_millis(SHOW_ANIMATION_MS)).await;
        if token != self.show_token.load(Ordering::SeqCst) {
            return;
        }
        self.bus.emit(names::SHELL_VISIBILITY, &json!({ "visible": true }));
    }

    /// 隐藏窗口：先广播（UI 演离场动画），**等 UI 回执「最后一帧画出来了」才真正落地**。
    ///
    /// 为什么不能定时落地：广播要穿过 内核 → SSE → webview 才变成 CSS 的起点，这段延迟不可控；
    /// 任何固定时长都可能砍在淡出中途 —— 被砍掉的那一帧（半透明面板）会被 webview 留成
    /// 「最后一帧」，下次唤出时合成器先亮它（用户：「闪一下，像打开了两次」）。
    /// 回执把「演完了」交给唯一知道答案的一方；`HIDE_FALLBACK_MS` 只防回执永远不来。
    ///
    /// 重复调用会搭同一班车（一次 `ctx.hostUi.hide` 会同时从内核和 UI 两条路走回来）。
    pub async fn hide(self: &Arc<Self>) -> Result<()> {
        let riding = {
            let pending = self.pending.lock().await;
            pending.as_ref().map(|entry| entry.notify.clone())
        };
        if let Some(notify) = riding {
            notify.notified().await;
            return Ok(());
        }

        // 排队中的「显示广播」一并作废：先显后隐的连按不能被它补一帧可见
        self.show_token.fetch_add(1, Ordering::SeqCst);
        self.bus.emit(names::SHELL_VISIBILITY, &json!({ "visible": false }));

        let token = self.hide_token.fetch_add(1, Ordering::SeqCst) + 1;
        let notify = Arc::new(Notify::new());
        *self.pending.lock().await = Some(PendingHide { token, notify: notify.clone() });

        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(HIDE_FALLBACK_MS)).await;
            if let Some(this) = weak.upgrade() {
                this.land(token).await;
            }
        });

        notify.notified().await;
        Ok(())
    }

    /// UI 回执：离场动画的最后一帧已经画出来了 —— 现在可以落地了。
    pub async fn finish_hide(self: &Arc<Self>) {
        let token = self.pending.lock().await.as_ref().map(|entry| entry.token);
        if let Some(token) = token {
            self.land(token).await;
        }
    }

    /// 撤销尚在排队的隐藏（热键连按不能被上一次隐藏偷走窗口）。
    pub async fn cancel_pending_hide(&self) {
        self.hide_token.fetch_add(1, Ordering::SeqCst);
        let notify = self.pending.lock().await.take().map(|entry| entry.notify);
        if let Some(notify) = notify {
            notify.notify_waiters();
        }
    }

    /// 收尾一次排队中的隐藏：令牌被换过 / 已经落地过 → 什么都不动。
    async fn land(self: &Arc<Self>, token: u64) {
        let notify = {
            let mut pending = self.pending.lock().await;
            match pending.as_ref() {
                Some(entry) if entry.token == token => pending.take().map(|entry| entry.notify),
                _ => None,
            }
        };
        let Some(notify) = notify else { return };
        self.hide_now().await;
        notify.notify_waiters();
    }

    /// 真正敲壳隐藏（回执与兜底共用的一条路）。
    async fn hide_now(&self) {
        // 只有**明确知道**已经被藏掉了才跳过；问不到（壳没连上）就照常走，隐藏本身会失败并静默
        if self.primitives.is_visible_now().await == Some(false) {
            return;
        }
        let _ = self.primitives.hide_window_now().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    struct FakePrimitives {
        calls: StdMutex<Vec<String>>,
        visible: StdMutex<Option<bool>>,
        selection: StdMutex<Option<String>>,
    }

    impl FakePrimitives {
        fn new(visible: Option<bool>) -> Arc<Self> {
            let fake = Arc::new(Self::default());
            *fake.visible.lock().unwrap() = visible;
            fake
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl VisibilityPrimitives for FakePrimitives {
        fn show_window_now(&self, focus: bool) -> BoxFuture<Result<Option<String>>> {
            self.calls.lock().unwrap().push(format!("show:{focus}"));
            let selection = self.selection.lock().unwrap().clone();
            Box::pin(async move { Ok(selection) })
        }

        fn hide_window_now(&self) -> BoxFuture<Result<()>> {
            self.calls.lock().unwrap().push("hide".to_string());
            *self.visible.lock().unwrap() = Some(false);
            Box::pin(async { Ok(()) })
        }

        fn is_visible_now(&self) -> BoxFuture<Option<bool>> {
            let visible = *self.visible.lock().unwrap();
            Box::pin(async move { visible })
        }
    }

    struct Harness {
        visibility: Arc<WindowVisibility>,
        primitives: Arc<FakePrimitives>,
        events: Arc<StdMutex<Vec<String>>>,
    }

    fn build(visible: Option<bool>) -> Harness {
        let primitives = FakePrimitives::new(visible);
        let bus = EventBus::new();
        let events = Arc::new(StdMutex::new(Vec::new()));
        let sink = events.clone();
        bus.set_sink(Arc::new(move |event, payload| {
            sink.lock().unwrap().push(format!("{event}:{payload}"));
        }));
        Harness { visibility: WindowVisibility::new(primitives.clone(), bus), primitives, events }
    }

    #[tokio::test]
    async fn hide_broadcasts_then_waits_for_ack() {
        let harness = build(Some(true));
        let task = {
            let visibility = harness.visibility.clone();
            tokio::spawn(async move { visibility.hide().await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;

        let events = harness.events.lock().unwrap().clone();
        assert!(events.iter().any(|line| line.contains("shell/visibility") && line.contains("false")), "events = {events:?}");
        assert!(harness.primitives.calls().is_empty(), "回执没到之前不得敲壳");

        harness.visibility.finish_hide().await;
        task.await.unwrap().unwrap();
        assert_eq!(harness.primitives.calls(), vec!["hide".to_string()], "回执之后敲一次 window.hide");
    }

    #[tokio::test]
    async fn duplicate_hide_rides_the_same_flight() {
        let harness = build(Some(true));
        let first = {
            let visibility = harness.visibility.clone();
            tokio::spawn(async move { visibility.hide().await })
        };
        let second = {
            let visibility = harness.visibility.clone();
            tokio::spawn(async move { visibility.hide().await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;

        let broadcasts = harness
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|line| line.contains("shell/visibility") && line.contains("false"))
            .count();
        assert_eq!(broadcasts, 1, "同一时刻只允许一次离场");

        harness.visibility.finish_hide().await;
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
        assert_eq!(harness.primitives.calls(), vec!["hide".to_string()]);
    }

    #[tokio::test]
    async fn cancel_makes_pending_hide_noop() {
        let harness = build(Some(true));
        let task = {
            let visibility = harness.visibility.clone();
            tokio::spawn(async move { visibility.hide().await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        harness.visibility.cancel_pending_hide().await;
        task.await.unwrap().unwrap();

        // 兜底定时器到点也不能落地（令牌已失效）
        tokio::time::sleep(Duration::from_millis(HIDE_FALLBACK_MS + 80)).await;
        assert!(harness.primitives.calls().is_empty(), "被撤销的隐藏不得敲壳");
    }

    #[tokio::test]
    async fn fallback_lands_when_ack_never_comes() {
        let harness = build(Some(true));
        harness.visibility.hide().await.unwrap();
        assert_eq!(harness.primitives.calls(), vec!["hide".to_string()], "兜底时长到点必须落地");
    }

    #[tokio::test]
    async fn already_hidden_window_is_not_hidden_again() {
        let harness = build(Some(false));
        harness.visibility.hide().await.unwrap();
        // is_visible 明确为 false → 不重复敲壳
        assert!(harness.primitives.calls().is_empty(), "calls = {:?}", harness.primitives.calls());
    }

    #[tokio::test]
    async fn show_delivers_selection_and_broadcasts_visible() {
        let harness = build(Some(false));
        *harness.primitives.selection.lock().unwrap() = Some("选中文本".to_string());
        let selection = harness.visibility.show(true).await.unwrap();
        assert_eq!(selection.as_deref(), Some("选中文本"), "选中文本原样交给调用方");

        tokio::time::sleep(Duration::from_millis(SHOW_ANIMATION_MS + 40)).await;
        let events = harness.events.lock().unwrap().clone();
        assert!(events.iter().any(|line| line.contains("shell/visibility") && line.contains("true")), "events = {events:?}");
    }
}
