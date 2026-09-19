//! 跨协议数据结构：返回给界面 / 模块间流转。
//!
//! 字段一律 camelCase（plugin-spec §4.4），视图层 `src/core/types.ts` 与之逐字段对齐。

use serde::Serialize;

/// 端口占用条目（端口视角）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortEntry {
    pub port: u16,
    /// `tcp` / `udp`
    pub protocol: String,
    /// 绑定地址（`*` / `0.0.0.0` / `127.0.0.1` / `::` / `::1`）
    pub address: String,
    /// `listen` / `established` / `time_wait` …（UDP 为空）
    pub state: String,
    pub pid: i32,
    /// 进程名（拿不到时为空串）
    pub process: String,
    pub user: Option<String>,
    /// 常驻内存（bytes）
    pub memory: Option<u64>,
    /// 风险级别：safe / caution / blocked（见 guard.rs）
    pub risk: String,
    /// 属于启动台自身这条链（壳 / 内核 / 本插件进程）
    pub self_related: bool,
}

/// 进程条目（进程视角）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcEntry {
    pub pid: i32,
    pub name: String,
    pub user: Option<String>,
    /// CPU 占用百分比（与活动监视器 / 任务管理器同口径：单核满载 = 100）
    pub cpu: f32,
    /// 常驻内存（bytes）
    pub memory: u64,
    pub parent: Option<i32>,
    pub risk: String,
    pub self_related: bool,
}

/// 进程详情（详情面板 + 终止确认前的信息展示）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcDetail {
    #[serde(flatten)]
    pub base: ProcEntry,
    pub exe: Option<String>,
    /// 完整命令行
    pub cmd: Option<String>,
    /// 启动时刻（epoch 秒）
    pub started_at: Option<u64>,
    /// 该进程正在占用的端口
    pub ports: Vec<PortEntry>,
}

/// 终止结果。语义：
/// - `ok` = 动作成功送达（进程已不存在也算达成目的）；
/// - `alive` = 动作之后进程**仍在**（信号发了但没退场，或需要强杀）；
/// - `permission_denied` = 被系统拒绝，UI 应引导「复制命令 / 提权终止」。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillOutcome {
    pub ok: bool,
    pub pid: i32,
    /// 目标进程名（拿不到时为空串）
    pub name: String,
    /// 本次用的是强制终止（SIGKILL / `taskkill /F`）
    pub force: bool,
    /// 走了系统提权对话框（osascript / UAC）
    pub elevated: bool,
    pub alive: bool,
    /// 进程本来就不存在
    pub not_found: bool,
    pub permission_denied: bool,
    /// 需要用户手动执行时的等价命令
    pub manual_command: String,
    /// 给用户看的一句话
    pub message: String,
    pub error: Option<String>,
}
