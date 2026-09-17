//! 状态条数据（v1 `services/systemStats.ts`；requirements §3.1「状态显示」/ architecture D21）。
//!
//! 主角是**启动台自身**的占用（用户要看的是"这个东西轻不轻"）：
//!  - 内存 = 壳进程 + 内核进程的常驻内存之和；
//!  - CPU = 两个进程的累计 CPU 时间差分 ÷ 墙钟 ÷ 核心数（**占整机的百分比**）。
//!
//! 内核只能报自己那一半，壳那一半走原语 `app.usage`。整机数字只作 tooltip 里的对照。
//! 采样是**惰性**的：只在有人来读（UI 每 3s 拉一次）时才算，没有常驻定时器。
//! 壳读不到（standalone / `pnpm dev`）时退化成"只报内核"，CPU 记 `null` 让 UI 显示占位符 ——
//! 绝不拿一半的差值冒充整体（那会让数字每次都在两个量级之间跳）。

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{ProcessesToUpdate, System};

use crate::exec::BoxFuture;
use crate::util::now_ms;

#[derive(Debug, Clone, Copy)]
pub struct ShellAppUsage {
    pub rss: i64,
    pub cpu_ms: i64,
}

pub type ShellUsageFn = Arc<dyn Fn() -> BoxFuture<Option<ShellAppUsage>> + Send + Sync>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUsageStat {
    /// 壳 + 内核的常驻内存之和（bytes）
    pub rss: u64,
    pub rss_shell: u64,
    pub rss_kernel: u64,
    /// 占整机 CPU 的百分比（0–100，一位小数）；还没有差分基线时为 null
    pub cpu: Option<f64>,
    /// 本机逻辑核心数（CPU 百分比按它归一）
    pub cores: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub app: AppUsageStat,
    /// 整机 CPU 使用率（0–100，对照用）
    pub cpu: f64,
    /// 整机已用 / 总内存（bytes，对照用）
    pub mem_used: u64,
    pub mem_total: u64,
    /// 1 / 5 / 15 分钟平均负载
    pub load_avg: Vec<f64>,
    /// 采样时刻（epoch ms）
    pub sampled_at: i64,
}

/// 就地补采样的等待时长：够短（不拖慢这次请求）、够长（差分不失真）
const SAMPLE_GAP_MS: u64 = 150;
/// 整机 CPU 的上次采样超过这个时长就算"陈旧"，必须重新起一个短窗口
const STALE_MS: u64 = 10_000;

#[derive(Debug, Clone, Copy)]
struct AppCpuSample {
    at: Instant,
    /// 壳 + 内核的累计 CPU 时间（ms）
    cpu_ms: u64,
    /// 这次采样是否**包含壳**那一半。含壳与不含壳的累计值不能相减 ——
    /// 壳进程的累计 CPU 是"开机以来"的量级，拿它去减只有内核的基线会飙出 300%+。
    has_shell: bool,
}

struct State {
    sys: System,
    last_app: Option<AppCpuSample>,
    last_cpu_at: Option<Instant>,
    warmed: bool,
}

pub struct SystemStatsSampler {
    shell_usage: ShellUsageFn,
    /// 同一时刻只跑一次采样（UI 轮询与其它调用可能撞上）
    state: tokio::sync::Mutex<State>,
}

impl SystemStatsSampler {
    pub fn new(shell_usage: ShellUsageFn) -> Self {
        Self {
            shell_usage,
            state: tokio::sync::Mutex::new(State {
                sys: System::new(),
                last_app: None,
                last_cpu_at: None,
                warmed: false,
            }),
        }
    }

    /// 内核启动时预热一次：整机 CPU 立刻有基线；自身的基线只有内核这一半
    /// （壳的读数要等 IPC，预热不去等）—— 所以首次 `read()` 只建立含壳的基线、不给 CPU 数字。
    pub async fn warmup(&self) {
        let mut state = self.state.lock().await;
        refresh(&mut state);
        let (_, cpu_ms) = kernel_usage(&mut state.sys);
        state.last_app = Some(AppCpuSample { at: Instant::now(), cpu_ms, has_shell: false });
    }

    pub async fn read(&self) -> SystemStats {
        let mut state = self.state.lock().await;
        if !state.warmed {
            refresh(&mut state);
        }
        let (cpu, mem_used, mem_total, load_avg) = read_whole_machine(&mut state).await;
        let app = read_app(&mut state, &self.shell_usage).await;
        SystemStats { app, cpu, mem_used, mem_total, load_avg, sampled_at: now_ms() }
    }
}

fn refresh(state: &mut State) {
    state.sys.refresh_cpu_all();
    state.sys.refresh_memory();
    state.last_cpu_at = Some(Instant::now());
    state.warmed = true;
}

async fn read_whole_machine(state: &mut State) -> (f64, u64, u64, Vec<f64>) {
    // 基线陈旧 → 起一个 150ms 的短窗口再取差值（与 v1 的 SAMPLE_GAP_MS 一致）
    let stale = state.last_cpu_at.map_or(true, |at| at.elapsed().as_millis() as u64 > STALE_MS);
    if stale {
        state.sys.refresh_cpu_all();
        tokio::time::sleep(Duration::from_millis(SAMPLE_GAP_MS)).await;
    }
    state.sys.refresh_cpu_all();
    state.sys.refresh_memory();
    state.last_cpu_at = Some(Instant::now());

    let cpu = (state.sys.global_cpu_usage() as f64).clamp(0.0, 100.0);
    let mem_total = state.sys.total_memory();
    let mem_used = state.sys.used_memory().min(mem_total);
    // macOS 的"已用"口径比活动监视器的"内存压力"偏保守（不含可回收文件缓存）—— tooltip 里写清即可
    let load = System::load_average();
    (cpu, mem_used, mem_total, vec![load.one, load.five, load.fifteen])
}

async fn read_app(state: &mut State, shell_usage: &ShellUsageFn) -> AppUsageStat {
    let cores = state.sys.cpus().len().max(1);
    let (rss_kernel, kernel_cpu_ms) = kernel_usage(&mut state.sys);
    let shell = shell_usage().await;
    let rss_shell = shell.map(|usage| usage.rss.max(0) as u64).unwrap_or(0);
    let cpu_ms = kernel_cpu_ms + shell.map(|usage| usage.cpu_ms.max(0) as u64).unwrap_or(0);
    let now = Instant::now();

    // 差分要"两次都含壳"才作数（见 `AppCpuSample::has_shell`）：壳从无到有会让累计值跳一大截
    let prev = state.last_app;
    let mut cpu = None;
    if let Some(prev) = prev {
        if prev.has_shell && shell.is_some() {
            let elapsed_ms = now.duration_since(prev.at).as_millis() as u64;
            if elapsed_ms > 0 && cpu_ms >= prev.cpu_ms {
                let delta = cpu_ms - prev.cpu_ms;
                cpu = Some(round1(delta as f64 / elapsed_ms as f64 / cores as f64 * 100.0));
            }
        }
    }
    state.last_app = Some(AppCpuSample { at: now, cpu_ms, has_shell: shell.is_some() });

    AppUsageStat { rss: rss_shell + rss_kernel, rss_shell, rss_kernel, cpu, cores }
}

/// 内核进程自己的常驻内存（bytes）与累计 CPU 时间（ms）。
fn kernel_usage(sys: &mut System) -> (u64, u64) {
    let Ok(pid) = sysinfo::get_current_pid() else {
        return (0, 0);
    };
    sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    match sys.process(pid) {
        Some(process) => (process.memory(), process.accumulated_cpu_time()),
        None => (0, 0),
    }
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn shell_usage(calls: Arc<AtomicUsize>, alive: bool) -> ShellUsageFn {
        Arc::new(move || {
            let calls = calls.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                alive.then_some(ShellAppUsage { rss: 50 * 1024 * 1024, cpu_ms: 1000 })
            }) as BoxFuture<Option<ShellAppUsage>>
        })
    }

    #[tokio::test]
    async fn samples_app_and_machine() {
        let calls = Arc::new(AtomicUsize::new(0));
        let sampler = SystemStatsSampler::new(shell_usage(calls.clone(), true));

        sampler.warmup().await;
        let first = sampler.read().await;
        assert!(first.app.rss > 0, "rss 至少有内核自己");
        assert!(first.app.rss_shell > 0, "壳读数已接入");
        assert!(first.app.cpu.is_none(), "首次只有不含壳的基线 → 不给 CPU 数字");
        assert!(first.app.cores >= 1);
        assert!(first.mem_total > 0);
        assert_eq!(first.load_avg.len(), 3);
        assert!(first.sampled_at > 0);

        // 差分窗口要 ≥1ms（真实场景两次采样间隔 3s；这里只验证窗口成立）
        tokio::time::sleep(Duration::from_millis(5)).await;
        let second = sampler.read().await;
        assert!(second.app.cpu.is_some(), "第二次起有含壳的差分基线");
        assert_eq!(second.app.cores, first.app.cores);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn degrades_to_kernel_only_without_shell() {
        let calls = Arc::new(AtomicUsize::new(0));
        let sampler = SystemStatsSampler::new(shell_usage(calls, false));
        sampler.warmup().await;
        let stats = sampler.read().await;
        assert_eq!(stats.app.rss_shell, 0);
        assert!(stats.app.rss > 0, "壳读不到时退化成只报内核");
        assert!(stats.app.cpu.is_none(), "不含壳的两次采样不得算差分");
    }
}
