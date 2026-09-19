//! 进程信息（sysinfo 封装）：进程列表 / 单进程详情 / 端口条目补进程信息。
//!
//! 与内核状态条同款依赖（`sysinfo`，关默认特性），口径也保持一致：
//! - CPU 百分比 = 活动监视器 / 任务管理器口径（单核满载 = 100%）；
//! - 内存 = 常驻内存（RSS，bytes）。
//!
//! CPU 需要**两次采样**才有意义（sysinfo 的硬要求），因此这里会等一个
//! `MINIMUM_CPU_UPDATE_INTERVAL`（macOS / Windows 都是 200ms）—— 一次调用几百毫秒是正常的。

use std::collections::{HashMap, HashSet};
use std::thread;

use sysinfo::{Pid, ProcessesToUpdate, System, Users, MINIMUM_CPU_UPDATE_INTERVAL};

use crate::guard::{self, Risk};
use crate::model::{ProcDetail, ProcEntry};

/// 端口条目补进程信息用的结果（端口视角只关心这几项）。
#[derive(Debug, Clone)]
pub struct PidInfo {
    pub name: String,
    pub user: Option<String>,
    pub memory: u64,
    pub risk: Risk,
    pub self_related: bool,
}

/// 进程快照（一次采样同时给出总量，供界面算占比）。
#[derive(Debug, Clone)]
pub struct ProcessSnapshot {
    pub entries: Vec<ProcEntry>,
    pub total_memory: u64,
    pub cores: usize,
}

pub fn current_pid() -> i32 {
    std::process::id() as i32
}

/// 是否属于启动台自身这条链：壳（`Chassis`）/ 内核（`launcher-kernel`）按名字算，
/// 本插件进程按 PID 算 —— 这些一律不许终止（杀自己等于界面凭空消失）。
pub fn self_related(pid: i32, name: &str) -> bool {
    pid == current_pid() || guard::is_launcher_process(name)
}

fn to_pid(pid: i32) -> Pid {
    Pid::from_u32(pid.max(0) as u32)
}

fn user_name(process: &sysinfo::Process, users: &Users) -> Option<String> {
    let uid = process.user_id()?;
    Some(users.get_user_by_id(uid)?.name().to_string())
}

fn entry_from(process: &sysinfo::Process, users: &Users) -> ProcEntry {
    let pid = process.pid().as_u32() as i32;
    let name = process.name().to_string_lossy().to_string();
    let related = self_related(pid, &name);
    let risk = guard::evaluate(pid, &name, related);
    ProcEntry {
        pid,
        name,
        user: user_name(process, users),
        cpu: process.cpu_usage(),
        memory: process.memory(),
        parent: process.parent().map(|parent| parent.as_u32() as i32),
        risk: risk.as_str().to_string(),
        self_related: related,
    }
}

/// `pid → 进程信息`：只刷新请求到的那些进程（拿不到的 pid 直接缺席，调用方当「已不存在」处理）。
pub fn lookup(pids: &[i32]) -> HashMap<i32, PidInfo> {
    let mut out = HashMap::new();
    let unique: Vec<Pid> = {
        let mut seen = HashSet::new();
        pids.iter()
            .filter(|pid| **pid > 0)
            .filter(|pid| seen.insert(**pid))
            .map(|pid| to_pid(*pid))
            .collect()
    };
    if unique.is_empty() {
        return out;
    }

    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&unique[..]), true);
    let users = Users::new_with_refreshed_list();

    for pid in unique {
        let Some(process) = sys.process(pid) else { continue };
        let numeric = pid.as_u32() as i32;
        let name = process.name().to_string_lossy().to_string();
        let related = self_related(numeric, &name);
        let risk = guard::evaluate(numeric, &name, related);
        out.insert(
            numeric,
            PidInfo { name, user: user_name(process, &users), memory: process.memory(), risk, self_related: related },
        );
    }
    out
}

/// 全量进程快照（按 CPU 降序）。
pub fn snapshot() -> ProcessSnapshot {
    let mut sys = System::new();
    // 核心数给 UI 显示（CPU 百分比的口径是「单核满载 = 100」）。
    // 必须自己刷一次：`System::new()` 之后 `cpus()` 是空的，靠 `refresh_processes`
    // 顺带填充属于 sysinfo 的实现细节（实测有的运行环境下拿不到，会退化成 1 核）。
    sys.refresh_cpu_all();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
    sys.refresh_processes(ProcessesToUpdate::All, true);
    sys.refresh_memory();

    let users = Users::new_with_refreshed_list();
    let mut entries: Vec<ProcEntry> = sys.processes().values().map(|process| entry_from(process, &users)).collect();
    entries.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal));

    ProcessSnapshot { entries, total_memory: sys.total_memory(), cores: sys.cpus().len().max(1) }
}

/// 单进程详情（含命令行、可执行文件、启动时刻、占用的端口）。
pub fn process_detail(pid: i32) -> Option<ProcDetail> {
    let target = to_pid(pid);
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[target]), true);
    thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
    sys.refresh_processes(ProcessesToUpdate::Some(&[target]), true);

    let users = Users::new_with_refreshed_list();
    let process = sys.process(target)?;
    let base = entry_from(process, &users);

    let cmd = {
        let parts = process.cmd();
        if parts.is_empty() {
            None
        } else {
            Some(parts.iter().map(|part| part.to_string_lossy().to_string()).collect::<Vec<_>>().join(" "))
        }
    };
    let exe = process.exe().map(|path| path.to_string_lossy().to_string());
    let started_at = Some(process.start_time()).filter(|value| *value > 0);

    // 它此刻占着哪些端口（全量扫一次；失败就当没有，不阻塞详情展示）
    let ports = crate::scan::scan_ports(crate::scan::SCOPE_ALL)
        .map(|entries| entries.into_iter().filter(|entry| entry.pid == pid).collect())
        .unwrap_or_default();

    Some(ProcDetail { base, exe, cmd, started_at, ports })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_process_is_self_related() {
        let pid = current_pid();
        assert!(self_related(pid, "whatever-binary-name"));
    }

    #[test]
    fn launcher_chain_counts_as_self_related() {
        assert!(self_related(4242, "Chassis"));
        assert!(self_related(4242, "launcher-kernel"));
        assert!(!self_related(4242, "node"));
    }

    #[test]
    fn lookup_finds_own_process_with_metadata() {
        let pid = current_pid();
        let info = lookup(&[pid]);
        let me = info.get(&pid).expect("必须能查到自己");
        assert!(me.self_related, "自己永远算自身链");
        assert_eq!(me.risk, Risk::Blocked, "自己不许被终止");
        assert!(me.memory > 0, "自己总要有常驻内存");
    }

    #[test]
    fn lookup_tolerates_missing_and_noise_pids() {
        let info = lookup(&[0, -1, 999_999]);
        assert!(info.is_empty(), "非法 PID 与不存在的进程都静默缺席");
    }

    #[test]
    fn snapshot_contains_own_process() {
        let snapshot = snapshot();
        assert!(snapshot.total_memory > 0);
        let expected = {
            let mut probe = System::new();
            probe.refresh_cpu_all();
            probe.cpus().len().max(1)
        };
        assert_eq!(snapshot.cores, expected, "核心数必须来自显式 refresh，不能退回 1");
        let me = snapshot.entries.iter().find(|entry| entry.pid == current_pid());
        assert!(me.is_some(), "全量列表里必须有自己");
        assert!(snapshot.entries.iter().all(|entry| entry.risk != ""));
    }
}
