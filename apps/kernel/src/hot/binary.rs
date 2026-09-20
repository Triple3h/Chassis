//! 内核二进制热替换（进程级）：校验 → staging → 备份 → 原子替换 → 待重启 → 自动回滚。
//!
//! 与插件热更新的安装语义（plugin-spec §6.4：原子替换 + 备份 + 回滚）同构：
//!  - **staging**：新产物先落到 `<dataRoot>/hot/bin/staging/`，做完整校验（存在 / 可执行 / 自检 probe）；
//!  - **备份**：旧二进制整份 rename 到 `<dataRoot>/hot/bin/backup/`（只保留最近 1 份）；
//!  - **原子替换**：copy staged → target（当前 `current_exe()`），失败立刻用备份换回；
//!  - **回滚**：`pending.json` 记账 —— 新版本启动后**没走到就绪**（连续 2 次启动失败）
//!    则下一次启动时自动恢复备份（`boot_guard`）。
//!
//! 边界（有意为之）：
//!  - 替换 `.app` bundle 内的二进制会让代码签名失效（macOS 上换完可能直接起不来）⇒
//!    **默认拒绝**，除非显式设置 `LAUNCHER_HOT_ALLOW_BUNDLE_SWAP=1`（自用版可重新签名）；
//!  - Windows 上运行中的 exe 无法被 rename/覆盖 ⇒ 报告明确错误（由壳在重启间隙替换）；
//!  - 真正的「重启生效」由壳完成：内核优雅退出 → 壳 `supervise` 拉起新二进制（PID 变、主程序不重启）。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::{KernelError, Result};
use crate::util::fsx::{retry, write_json_atomic, RENAME_POLICY};
use crate::util::now_ms;

pub const BIN_DIR: &str = "bin";
pub const STAGING_DIR: &str = "staging";
pub const BACKUP_DIR: &str = "backup";
pub const PENDING_FILE: &str = "pending.json";
/// 壳执行替换后的回执（壳写、内核读后即删；见 `take_swap_result`）
pub const SWAP_RESULT_FILE: &str = "swap-result.json";
/// 与内核同包的 UI 目录名（壳侧同名常量；内核托管 UI，两边必须一致）
pub const EXTERNAL_UI_DIR: &str = "ui";
/// 允许替换 `.app` bundle 内二进制（默认拒绝：破坏代码签名）
pub const ALLOW_BUNDLE_SWAP_ENV: &str = "LAUNCHER_HOT_ALLOW_BUNDLE_SWAP";
/// probe 自检超时（新二进制启动即退出，正常在 50ms 内）
const PROBE_TIMEOUT_MS: u64 = 2_000;

/// 新二进制的自检报告（`--hot-probe` 的输出）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    pub version: String,
    pub hot_version: String,
    pub path: String,
}

/// 谁来执行替换 **这个文件** —— 是能力判断，不是平台判断（docs/win-hot-update-research.md §5.3-4）：
///  - `Kernel`：内核自己换（unix：运行中的映像允许被替换；也是老壳的回落路径）；
///  - `Shell`：内核**只写台账**，由壳在「内核已退出、尚未拉起」的窗口里换（Windows：映像被锁）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SwapOwner {
    #[default]
    Kernel,
    Shell,
}

/// 平台倾向的执行者（Windows = 壳、其余 = 内核）；**用不用 Shell 还要看壳报没报能力**。
pub fn preferred_swap_owner() -> SwapOwner {
    if cfg!(windows) {
        SwapOwner::Shell
    } else {
        SwapOwner::Kernel
    }
}

/// 结合壳能力后的最终执行者：平台倾向 Shell **且** 壳声明了 `kernelSwap` 才交给壳 ——
/// 老壳（不认识台账）配新内核时必须退回内核自换：让它给出明确错误，而不是写一份没人执行的台账。
pub fn swap_owner_for(shell_can_swap: bool) -> SwapOwner {
    match preferred_swap_owner() {
        SwapOwner::Shell if shell_can_swap => SwapOwner::Shell,
        _ => SwapOwner::Kernel,
    }
}

/// 待验证的二进制更新（`pending.json`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingUpdate {
    pub from_version: String,
    pub to_version: String,
    /// 被替换的目标（`current_exe()`）
    pub target: String,
    /// 旧二进制备份（回滚用）
    pub backup: String,
    /// 已尝试启动次数（≥2 ⇒ 判定失败，自动回滚）
    pub attempts: u32,
    pub requested_at: i64,
    /// 与内核同包的 UI 目录（内核托管 UI：不一起换会出现「新内核 + 旧 UI」）
    #[serde(default)]
    pub ui_target: Option<String>,
    /// 旧 UI 的备份（回滚用）
    #[serde(default)]
    pub ui_backup: Option<String>,
    /// 谁来执行替换（缺省 = 内核自己：老台账读得进来、老壳也不会看到 Shell）
    #[serde(default)]
    pub swap_owner: SwapOwner,
    /// 候选二进制（`swap_owner = Shell` 时由壳搬进 `target`）；
    /// **它还在 = 还没换过** —— 壳据此幂等，回滚请求也据此判断「换过没有」
    #[serde(default)]
    pub staged: Option<String>,
    /// 候选 UI 目录（与内核同包；同上，还在 = 还没换过）
    #[serde(default)]
    pub ui_staged: Option<String>,
    /// 需要壳把备份换回来（连续两次启动未就绪时由启动守卫登记；壳换完会清台账）
    #[serde(default)]
    pub revert: bool,
}

/// 壳执行替换后的回执（壳写、内核读后即删；`<hot>/bin/swap-result.json`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapResult {
    /// `applied` | `reverted` | `failed`
    pub result: String,
    pub detail: String,
    pub at: i64,
}

/// 取走壳的替换回执（读后即删）：内核启动时把它写进热更新日志 ——
/// 替换发生在壳里，不回执的话「这次更新到底成没成」在 `hot/log` 里是一段空白。
pub fn take_swap_result(hot_dir: &Path) -> Option<SwapResult> {
    let path = bin_dir(hot_dir).join(SWAP_RESULT_FILE);
    let result: Option<SwapResult> = crate::util::fsx::read_json(&path, None);
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    result
}

pub fn bin_dir(hot_dir: &Path) -> PathBuf {
    hot_dir.join(BIN_DIR)
}

/// 更新包里的 UI 目录：显式给的优先（存在才认）；否则按约定取「候选二进制同目录下的 ui/」
/// （分发侧保证 zip 解压后 = `launcher-kernel` + `ui/`，见 docs/kernel-hot-update.md）。
pub fn peer_ui(explicit: Option<&Path>, staged: &Path) -> Option<PathBuf> {
    if let Some(path) = explicit {
        if path.exists() {
            return Some(path.to_path_buf());
        }
    }
    staged
        .parent()
        .map(|parent| parent.join(EXTERNAL_UI_DIR))
        .filter(|path| path.join("index.html").exists())
}

/// `.app` bundle 内的路径（macOS 的代码签名覆盖整个 bundle）。
pub fn is_inside_app_bundle(path: &Path) -> bool {
    let text = path.to_string_lossy();
    text.contains(".app/Contents/")
}

pub fn allow_bundle_swap() -> bool {
    std::env::var(ALLOW_BUNDLE_SWAP_ENV).map(|value| value == "1" || value == "true").unwrap_or(false)
}

/// 新二进制自检：跑一次 `--hot-probe`，读它自报的版本。
///
/// 这是「新版本能不能跑」的最低限度验证 —— 连 probe 都跑不起来就不该换上去。
pub fn probe(binary: &Path) -> Result<ProbeReport> {
    if !binary.exists() {
        return Err(KernelError::bad_args(format!("二进制不存在：{}", binary.display())));
    }
    let mut child = Command::new(binary)
        .arg("--hot-probe")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| KernelError::new("PROBE_FAILED", format!("自检无法启动（{}）：{err}", binary.display())))?;

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|err| KernelError::new("PROBE_FAILED", format!("自检输出读取失败：{err}")))?;
                if !status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    return Err(KernelError::new(
                        "PROBE_FAILED",
                        format!("自检退出码 {:?}：{}", status.code(), stderr.trim().chars().take(200).collect::<String>()),
                    ));
                }
                let stdout = String::from_utf8_lossy(&output.stdout);
                return parse_probe_output(&stdout, binary);
            }
            Ok(None) => {}
            Err(err) => return Err(KernelError::new("PROBE_FAILED", format!("自检进程异常：{err}"))),
        }
        if started.elapsed() > Duration::from_millis(PROBE_TIMEOUT_MS) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(KernelError::new("PROBE_FAILED", format!("自检超时（{}ms）", PROBE_TIMEOUT_MS)));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// 解析 `--hot-probe` 输出：优先 JSON（`{"version":…,"hotVersion":…}`），否则当作纯版本号。
pub fn parse_probe_output(stdout: &str, binary: &Path) -> Result<ProbeReport> {
    let text = stdout.trim();
    if text.is_empty() {
        return Err(KernelError::new("PROBE_FAILED", "自检没有输出（--hot-probe）"));
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
        let version = value.get("version").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        if version.is_empty() {
            return Err(KernelError::new("PROBE_FAILED", "自检输出缺少 version"));
        }
        return Ok(ProbeReport {
            version,
            hot_version: value.get("hotVersion").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            path: binary.display().to_string(),
        });
    }
    Ok(ProbeReport { version: text.to_string(), hot_version: String::new(), path: binary.display().to_string() })
}

/// 把候选二进制放进 staging（先校验，再落盘 —— 坏产物不进入候选区）。
pub fn stage(hot_dir: &Path, source: &Path, to_version: &str) -> Result<(PathBuf, ProbeReport)> {
    if !source.exists() {
        return Err(KernelError::bad_args(format!("候选二进制不存在：{}", source.display())));
    }
    let report = probe(source)?;
    let target_version = if to_version.is_empty() { report.version.clone() } else { to_version.to_string() };
    let dir = bin_dir(hot_dir).join(STAGING_DIR);
    fs::create_dir_all(&dir).map_err(|err| KernelError::internal(format!("创建 staging 目录失败：{err}")))?;
    let staged = dir.join(format!("launcher-kernel-{target_version}"));
    fs::copy(source, &staged).map_err(|err| KernelError::internal(format!("暂存失败：{err}")))?;
    set_executable(&staged)?;
    Ok((staged, report))
}

/// 原子替换：备份当前二进制 → 写入新二进制 →（可选的 UI 同包）→ 记 pending。
/// 任何一步失败都不留下半替换状态。
///
/// `owner = Kernel` 走上面这条；`owner = Shell` 只写台账（Windows 上写不了运行中的自身映像）。
pub fn apply(
    hot_dir: &Path,
    staged: &Path,
    from_version: &str,
    to_version: &str,
    ui: Option<&Path>,
    owner: SwapOwner,
) -> Result<PendingUpdate> {
    let target = std::env::current_exe()
        .map_err(|err| KernelError::internal(format!("无法定位当前内核二进制：{err}")))?;
    apply_to(hot_dir, staged, &target, from_version, to_version, ui, owner)
}

/// `apply` 的可测版本（target 可注入）。
pub fn apply_to(
    hot_dir: &Path,
    staged: &Path,
    target: &Path,
    from_version: &str,
    to_version: &str,
    ui: Option<&Path>,
    owner: SwapOwner,
) -> Result<PendingUpdate> {
    if !staged.exists() {
        return Err(KernelError::bad_args(format!("staged 二进制不存在：{}", staged.display())));
    }
    if !target.exists() {
        return Err(KernelError::internal(format!("目标二进制不存在：{}", target.display())));
    }
    if is_inside_app_bundle(target) && !allow_bundle_swap() {
        return Err(KernelError::new(
            "SIGNED_BUNDLE",
            format!(
                "拒绝替换 .app 内的内核（会让代码签名失效）：{}；打包版本请随 App 一起更新，\
                 开发/自编译产物或愿意重新签名的场景可设 {ALLOW_BUNDLE_SWAP_ENV}=1 强制",
                target.display()
            ),
        ));
    }
    if owner == SwapOwner::Shell {
        return plan_shell_swap(hot_dir, staged, target, from_version, to_version, ui);
    }

    let backup_dir = bin_dir(hot_dir).join(BACKUP_DIR);
    fs::create_dir_all(&backup_dir).map_err(|err| KernelError::internal(format!("创建备份目录失败：{err}")))?;
    keep_latest_backup(&backup_dir);
    let backup = backup_dir.join(format!("launcher-kernel-{from_version}-{}", now_ms()));

    // ① 备份（rename：旧文件不丢；跨设备 / 被占用时退回 copy+删除，失败即中止）
    if let Err(err) = rename_with_retry(target, &backup) {
        fs::copy(target, &backup).map_err(|copy_err| {
            KernelError::new("UPDATE_FAILED", format!("备份当前内核失败：{err}；copy 兜底也失败：{copy_err}"))
        })?;
        if let Err(remove_err) = fs::remove_file(target) {
            return Err(KernelError::new("UPDATE_FAILED", format!("备份后无法移除旧内核（Windows 上通常是句柄延迟）：{remove_err}")));
        }
    }

    // ② 落地新二进制（copy 而非 rename：staged 留在原地可供再次应用 / 诊断）
    if let Err(err) = fs::copy(staged, target) {
        let _ = rename_with_retry(&backup, target); // 立刻回滚，别把内核弄丢
        return Err(KernelError::new("UPDATE_FAILED", format!("写入新内核失败（已回滚）：{err}")));
    }
    if let Err(err) = set_executable(target) {
        let _ = fs::remove_file(target);
        let _ = rename_with_retry(&backup, target);
        return Err(KernelError::new("UPDATE_FAILED", format!("设置可执行权限失败（已回滚）：{err}")));
    }

    // ③ UI（与内核同一次热更新）：失败就把二进制也回滚，不留「新内核 + 旧 UI」
    let (ui_target, ui_backup) = match ui {
        Some(staged_ui) => match apply_ui(hot_dir, staged_ui, target) {
            Ok((target_path, backup_path)) => (Some(target_path), backup_path),
            Err(err) => {
                let _ = fs::remove_file(target);
                let _ = rename_with_retry(&backup, target);
                return Err(err);
            }
        },
        None => (None, None),
    };

    let pending = PendingUpdate {
        from_version: from_version.to_string(),
        to_version: to_version.to_string(),
        target: target.display().to_string(),
        backup: backup.display().to_string(),
        attempts: 0,
        requested_at: now_ms(),
        ui_target: ui_target.clone(),
        ui_backup: ui_backup.clone(),
        swap_owner: SwapOwner::Kernel,
        staged: None,
        ui_staged: None,
        revert: false,
    };
    if let Err(err) = write_json_atomic(&bin_dir(hot_dir).join(PENDING_FILE), &pending) {
        let _ = fs::remove_file(target);
        let _ = rename_with_retry(&backup, target);
        if let Some(ui_target) = ui_target.as_deref() {
            restore_ui(Path::new(ui_target), &ui_backup);
        }
        return Err(KernelError::new("UPDATE_FAILED", format!("写入 pending 台账失败（已回滚）：{err}")));
    }
    Ok(pending)
}

/// 只登记、不动文件的那条路（`swap_owner = Shell`）。
///
/// 备份路径**先算好写进台账**（壳照它建备份），此刻并不创建；候选二进制与候选 UI 留在 staging，
/// 壳搬走它们 —— **「候选还在不在」就是壳判定「换过没有」的幂等标记**（壳侧同款约定）。
fn plan_shell_swap(
    hot_dir: &Path,
    staged: &Path,
    target: &Path,
    from_version: &str,
    to_version: &str,
    ui: Option<&Path>,
) -> Result<PendingUpdate> {
    if let Some(staged_ui) = ui {
        if !staged_ui.join("index.html").exists() {
            return Err(KernelError::bad_args(format!("UI 目录缺少 index.html：{}", staged_ui.display())));
        }
    }
    let bin_root = bin_dir(hot_dir);
    let backup = bin_root.join(BACKUP_DIR).join(format!("launcher-kernel-{from_version}-{}", now_ms()));
    let ui_target = ui.and_then(|_| target.parent().map(|parent| parent.join(EXTERNAL_UI_DIR)));
    let ui_backup = ui.map(|_| bin_root.join(BACKUP_DIR).join(format!("ui-{}", now_ms())));
    let pending = PendingUpdate {
        from_version: from_version.to_string(),
        to_version: to_version.to_string(),
        target: target.display().to_string(),
        backup: backup.display().to_string(),
        attempts: 0,
        requested_at: now_ms(),
        ui_target: ui_target.map(|path| path.display().to_string()),
        ui_backup: ui_backup.map(|path| path.display().to_string()),
        swap_owner: SwapOwner::Shell,
        staged: Some(staged.display().to_string()),
        ui_staged: ui.map(|path| path.display().to_string()),
        revert: false,
    };
    write_json_atomic(&bin_dir(hot_dir).join(PENDING_FILE), &pending)
        .map_err(|err| KernelError::new("UPDATE_FAILED", format!("写入 pending 台账失败：{err}")))?;
    Ok(pending)
}

/// UI 目录替换：`staged_ui` → `<内核父目录>/ui`（与二进制同一次热更新、同一份 pending 台账）。
fn apply_ui(hot_dir: &Path, staged_ui: &Path, target_exe: &Path) -> Result<(String, Option<String>)> {
    if !staged_ui.join("index.html").exists() {
        return Err(KernelError::bad_args(format!("UI 目录缺少 index.html：{}", staged_ui.display())));
    }
    let root = target_exe.parent().ok_or_else(|| KernelError::internal("目标二进制没有父目录"))?;
    let target = root.join(EXTERNAL_UI_DIR);
    let backup = bin_dir(hot_dir).join(BACKUP_DIR).join(format!("ui-{}", now_ms()));
    fs::create_dir_all(bin_dir(hot_dir).join(BACKUP_DIR))
        .map_err(|err| KernelError::internal(format!("创建备份目录失败：{err}")))?;

    let backup_used = if target.exists() {
        rename_with_retry(&target, &backup)
            .map_err(|err| KernelError::new("UPDATE_FAILED", format!("备份旧 UI 失败：{}", err.message)))?;
        Some(backup.display().to_string())
    } else {
        None
    };
    if let Err(err) = copy_tree(staged_ui, &target) {
        let _ = fs::remove_dir_all(&target);
        if backup_used.is_some() {
            let _ = rename_with_retry(&backup, &target);
        }
        return Err(KernelError::new("UPDATE_FAILED", format!("写入新 UI 失败（已回滚）：{err}")));
    }
    Ok((target.display().to_string(), backup_used))
}

/// 回滚 UI：删当前 UI，把备份换回来（无备份 ⇒ 本来就没有旧 UI，删掉即可）。
fn restore_ui(target: &Path, backup: &Option<String>) {
    let _ = fs::remove_dir_all(target);
    if let Some(backup) = backup.as_deref().map(Path::new) {
        if backup.exists() {
            let _ = rename_with_retry(backup, target);
        }
    }
}

/// 递归复制目录（UI 只有 ~1MB，够用；不引入额外依赖）。
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = to.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// 启动守卫：在**进程最早**阶段调用（早于内核装配）。
///
/// 返回 `Some(说明)` 表示本次启动处理过一项待验证更新（供日志）。
/// 语义：pending 里的 attempts 每启动一次 +1；达到 2 次还没走到就绪 ⇒ 判定新版本启动失败，
/// 自动把备份换回去（本次运行仍是新版本，下次启动即回到旧版本）。
pub fn boot_guard(hot_dir: &Path) -> Option<String> {
    let pending_path = bin_dir(hot_dir).join(PENDING_FILE);
    if !pending_path.exists() {
        return None;
    }
    let mut pending: PendingUpdate = match crate::util::fsx::read_json(&pending_path, None::<PendingUpdate>) {
        Some(value) => value,
        None => {
            let _ = fs::remove_file(&pending_path);
            return Some("pending 台账损坏，已丢弃".to_string());
        }
    };
    pending.attempts += 1;
    let _ = write_json_atomic(&pending_path, &pending);

    if pending.attempts >= 2 {
        // 壳执行替换（Windows）：删自身 + rename 备份在自己进程里做不到 ⇒ **只登记回滚请求**，
        // 由壳在下次启动前执行（docs/win-hot-update-research.md §4.2）；台账留给壳，换完它清。
        if pending.swap_owner == SwapOwner::Shell {
            pending.revert = true;
            let _ = write_json_atomic(&pending_path, &pending);
            return Some(format!(
                "新内核 v{} 连续 {} 次启动未就绪：已登记回滚到 v{}，交给壳在下次启动前换回",
                pending.to_version, pending.attempts, pending.from_version
            ));
        }
        let backup = PathBuf::from(&pending.backup);
        let target = PathBuf::from(&pending.target);
        let mut detail = format!(
            "新内核 v{} 连续 {} 次启动未就绪，自动回滚到 v{}",
            pending.to_version, pending.attempts, pending.from_version
        );
        if backup.exists() {
            match restore(&backup, &target) {
                Ok(()) => {
                    // UI 与内核同包 ⇒ 一起回滚（半个新 UI 会让新内核读不到自己的前端）
                    if let Some(ui_target) = pending.ui_target.as_deref() {
                        restore_ui(Path::new(ui_target), &pending.ui_backup);
                        detail.push_str("（内核与 UI 已恢复备份）");
                    } else {
                        detail.push_str("（已恢复备份）");
                    }
                }
                Err(err) => detail.push_str(&format!("（恢复备份失败：{err}，请手动处理）")),
            }
        } else {
            detail.push_str("（备份不存在，保持现状）");
        }
        let _ = fs::remove_file(&pending_path);
        return Some(detail);
    }
    Some(format!(
        "检测到待验证的内核更新 v{} → v{}（第 {} 次启动；走到就绪即确认成功）",
        pending.from_version, pending.to_version, pending.attempts
    ))
}

/// 内核就绪后调用：确认本次启动成功，清掉 pending。
pub fn mark_boot_success(hot_dir: &Path) -> Option<String> {
    let pending_path = bin_dir(hot_dir).join(PENDING_FILE);
    if !pending_path.exists() {
        return None;
    }
    let pending: Option<PendingUpdate> = crate::util::fsx::read_json(&pending_path, None);
    let _ = fs::remove_file(&pending_path);
    pending.map(|value| {
        // 确认成功 ⇒ 旧 UI 备份不再需要（否则每次更新都在备份目录里攒一份）
        if let Some(ui_backup) = value.ui_backup.as_deref() {
            let _ = fs::remove_dir_all(ui_backup);
        }
        let ui_note = if value.ui_target.is_some() { "（含 UI）" } else { "" };
        format!("内核二进制更新{ui_note} v{} → v{} 已确认生效", value.from_version, value.to_version)
    })
}

/// 手动回滚（无 pending 时返回 `Ok(None)`）。
pub fn rollback(hot_dir: &Path) -> Result<Option<String>> {
    let pending_path = bin_dir(hot_dir).join(PENDING_FILE);
    if !pending_path.exists() {
        return Ok(None);
    }
    let pending: PendingUpdate = crate::util::fsx::read_json(&pending_path, None)
        .ok_or_else(|| KernelError::internal("pending 台账损坏（先修好它再回滚）"))?;
    if pending.swap_owner == SwapOwner::Shell {
        // 壳换过没有，看候选还在不在（与壳侧同一条判据）
        let swapped = pending.staged.as_deref().map(|path| !Path::new(path).exists()).unwrap_or(false);
        if !swapped {
            // 还没换过 ⇒ 直接取消这次更新（删台账 + 清候选），没有备份要回滚
            let _ = fs::remove_file(&pending_path);
            if let Some(staged) = pending.staged.as_deref() {
                let _ = fs::remove_file(staged);
            }
            return Ok(Some(format!(
                "已取消未生效的内核更新 v{} → v{}（壳尚未替换）",
                pending.from_version, pending.to_version
            )));
        }
        let mut updated = pending.clone();
        updated.revert = true;
        write_json_atomic(&pending_path, &updated)
            .map_err(|err| KernelError::internal(format!("写入回滚请求失败：{err}")))?;
        return Ok(Some(format!(
            "已登记回滚 v{} → v{}（壳在下次启动前换回；本次仍跑当前版本）",
            pending.to_version, pending.from_version
        )));
    }
    let backup = PathBuf::from(&pending.backup);
    if !backup.exists() {
        return Err(KernelError::new("NOT_FOUND", format!("备份不存在：{}", pending.backup)));
    }
    restore(&backup, &PathBuf::from(&pending.target))?;
    if let Some(ui_target) = pending.ui_target.as_deref() {
        restore_ui(Path::new(ui_target), &pending.ui_backup);
    }
    let _ = fs::remove_file(&pending_path);
    let ui_note = if pending.ui_target.is_some() { "（含 UI）" } else { "" };
    Ok(Some(format!("已回滚内核{ui_note} v{} → v{}（重启后生效）", pending.to_version, pending.from_version)))
}

/// 当前 pending 台账（供 `hot/status` 展示）。
pub fn pending_of(hot_dir: &Path) -> Option<PendingUpdate> {
    crate::util::fsx::read_json(&bin_dir(hot_dir).join(PENDING_FILE), None)
}

fn restore(backup: &Path, target: &Path) -> Result<()> {
    if target.exists() {
        let _ = fs::remove_file(target);
    }
    rename_with_retry(backup, target)
        .or_else(|_| fs::copy(backup, target).map(|_| ()).map_err(|err| KernelError::internal(format!("恢复失败：{err}"))))
        .map_err(|err| KernelError::internal(format!("恢复失败：{}", err.message)))?;
    set_executable(target).ok();
    Ok(())
}

/// 备份保留策略（对齐插件 `.backup` 的「只留最近 1 份」）：
/// **按族分别清理** —— `launcher-kernel-*` 留 1 份、`ui-*` 留 1 份；
/// 混在一起排序会把「一次更新的二进制 + UI」拆散，回滚就缺一半。
fn keep_latest_backup(backup_dir: &Path) {
    for prefix in ["launcher-kernel-", "ui-"] {
        let mut items: Vec<PathBuf> = crate::util::fsx::list_dir_safe(backup_dir)
            .into_iter()
            .filter(|path| path.file_name().and_then(|name| name.to_str()).map(|name| name.starts_with(prefix)).unwrap_or(false))
            .collect();
        items.sort();
        if items.len() <= 1 {
            continue;
        }
        for path in &items[..items.len() - 1] {
            if path.is_dir() {
                let _ = fs::remove_dir_all(path);
            } else {
                let _ = fs::remove_file(path);
            }
        }
    }
}

/// rename 的重试收口在 `util::fsx`（策略与「什么算瞬时」都按平台取，docs/win-hot-update-research.md §5.1-#1）；
/// 这里只把失败翻译成内核错误码。
fn rename_with_retry(from: &Path, to: &Path) -> Result<()> {
    retry(RENAME_POLICY, || fs::rename(from, to)).map_err(|err| {
        KernelError::new("UPDATE_FAILED", format!("rename 失败（{} → {}）：{err}", from.display(), to.display()))
    })
}

fn set_executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)
            .map_err(|err| KernelError::internal(format!("读取权限失败：{err}")))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).map_err(|err| KernelError::internal(format!("设置权限失败：{err}")))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

/// 二进制热更新的展示载荷（`hot/status` 里的 `binary` 字段）。
pub fn status_payload(hot_dir: &Path, version: &str) -> serde_json::Value {
    let pending = pending_of(hot_dir);
    // 有台账就报台账里的执行者，否则报平台倾向（Windows = 壳；用不用得上还看壳报没报 `kernelSwap`）
    let swap_owner = pending.as_ref().map(|value| value.swap_owner).unwrap_or_else(preferred_swap_owner);
    json!({
        // Windows 也算支持了：本进程不换，由壳在重启间隙换（老壳配新内核时会退回内核自换并明确报错）
        "supported": cfg!(target_os = "macos") || cfg!(target_os = "linux") || cfg!(target_os = "windows"),
        "swapOwner": swap_owner,
        "currentVersion": version,
        "currentExe": std::env::current_exe().ok().map(|path| path.display().to_string()),
        "bundleSwapAllowed": allow_bundle_swap(),
        "pending": pending,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("hot-bin-{label}-{}", now_ms()))
    }

    #[test]
    fn parses_probe_json_and_plain_version() {
        let json_report = parse_probe_output(r#"{"version":"0.2.0","hotVersion":"0.1.0"}"#, Path::new("/x/k")).unwrap();
        assert_eq!(json_report.version, "0.2.0");
        assert_eq!(json_report.hot_version, "0.1.0");

        let plain = parse_probe_output("0.3.1\n", Path::new("/x/k")).unwrap();
        assert_eq!(plain.version, "0.3.1");
        assert_eq!(plain.hot_version, "");

        assert!(parse_probe_output("   ", Path::new("/x/k")).is_err(), "空输出要报错");
        assert!(parse_probe_output("{}", Path::new("/x/k")).is_err(), "缺 version 要报错");
    }

    #[test]
    fn apply_backs_up_replaces_and_records_pending() {
        let dir = temp_dir("apply");
        let target = dir.join("launcher-kernel");
        let staged = dir.join("staged-kernel");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&target, b"old-binary").unwrap();
        fs::write(&staged, b"new-binary").unwrap();

        let pending = apply_to(&dir, &staged, &target, "0.1.0", "0.2.0", None, SwapOwner::Kernel).expect("替换应成功");
        assert_eq!(fs::read(&target).unwrap(), b"new-binary", "目标已换新");
        assert_eq!(fs::read(&pending.backup).unwrap(), b"old-binary", "备份保留旧版本");
        assert!(bin_dir(&dir).join(PENDING_FILE).exists(), "pending 台账已写");
        assert_eq!(pending.attempts, 0);

        // 手动回滚：换回旧版 + 清台账
        let message = rollback(&dir).expect("回滚应成功").expect("应有 pending");
        assert!(message.contains("0.2.0"), "回滚说明要含版本：{message}");
        assert_eq!(fs::read(&target).unwrap(), b"old-binary");
        assert!(!bin_dir(&dir).join(PENDING_FILE).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn boot_guard_rolls_back_after_second_failed_boot() {
        let dir = temp_dir("guard");
        let target = dir.join("launcher-kernel");
        let backup = dir.join("backup-kernel");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&target, b"new-binary").unwrap();
        fs::write(&backup, b"old-binary").unwrap();
        let pending = PendingUpdate {
            from_version: "0.1.0".to_string(),
            to_version: "0.2.0".to_string(),
            target: target.display().to_string(),
            backup: backup.display().to_string(),
            attempts: 0,
            requested_at: now_ms(),
            ui_target: None,
            ui_backup: None,
            swap_owner: SwapOwner::Kernel,
            staged: None,
            ui_staged: None,
            revert: false,
        };
        write_json_atomic(&bin_dir(&dir).join(PENDING_FILE), &pending).unwrap();

        let first = boot_guard(&dir).expect("第一次启动要记账");
        assert!(first.contains("第 1 次启动"), "{first}");
        assert_eq!(fs::read(&target).unwrap(), b"new-binary", "第一次启动不改动目标");

        let second = boot_guard(&dir).expect("第二次启动要触发回滚");
        assert!(second.contains("自动回滚"), "{second}");
        assert_eq!(fs::read(&target).unwrap(), b"old-binary", "连续两次启动未就绪 ⇒ 恢复备份");
        assert!(!bin_dir(&dir).join(PENDING_FILE).exists(), "回滚后台账清理");

        // 成功路径：mark_boot_success 清台账
        write_json_atomic(&bin_dir(&dir).join(PENDING_FILE), &pending).unwrap();
        let ok = mark_boot_success(&dir).expect("成功确认应有说明");
        assert!(ok.contains("已确认生效"), "{ok}");
        assert!(boot_guard(&dir).is_none(), "台账已清 ⇒ 不再干预");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_app_bundle_targets_unless_forced() {
        let dir = temp_dir("bundle");
        let target = dir.join("Chassis.app/Contents/Resources/kernel/launcher-kernel");
        let staged = dir.join("staged");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"old").unwrap();
        fs::write(&staged, b"new").unwrap();

        let err = apply_to(&dir, &staged, &target, "0.1.0", "0.2.0", None, SwapOwner::Kernel).expect_err("打包内二进制必须被拒绝");
        assert_eq!(err.code, "SIGNED_BUNDLE");
        assert_eq!(fs::read(&target).unwrap(), b"old", "拒绝时目标不动");
        let _ = fs::remove_dir_all(&dir);
    }

    /// UI 与内核同包：一起换、一起回滚（「新内核 + 旧 UI」比不更新更糟）。
    #[test]
    fn ui_travels_with_kernel_and_rolls_back_together() {
        let dir = temp_dir("ui");
        let target = dir.join("launcher-kernel");
        let target_ui = dir.join(EXTERNAL_UI_DIR);
        let staged_dir = dir.join("download");
        let staged = staged_dir.join("launcher-kernel");
        let staged_ui = staged_dir.join(EXTERNAL_UI_DIR);
        fs::create_dir_all(&target_ui).unwrap();
        fs::create_dir_all(&staged_ui).unwrap();
        fs::write(&target, b"old-binary").unwrap();
        fs::write(target_ui.join("index.html"), b"old-ui").unwrap();
        fs::write(&staged, b"new-binary").unwrap();
        fs::write(staged_ui.join("index.html"), b"new-ui").unwrap();

        let pending = apply_to(&dir, &staged, &target, "0.1.0", "0.2.0", Some(&staged_ui), SwapOwner::Kernel).expect("换核 + 换 UI 应成功");
        assert_eq!(fs::read(&target).unwrap(), b"new-binary");
        assert_eq!(fs::read(target_ui.join("index.html")).unwrap(), b"new-ui");
        assert!(pending.ui_target.is_some() && pending.ui_backup.is_some(), "台账要带 UI 目标与备份");

        let message = rollback(&dir).expect("回滚成功").expect("应有 pending");
        assert!(message.contains("含 UI"), "回滚说明要提到 UI：{message}");
        assert_eq!(fs::read(&target).unwrap(), b"old-binary");
        assert_eq!(fs::read(target_ui.join("index.html")).unwrap(), b"old-ui", "UI 与内核一起回滚");
        let _ = fs::remove_dir_all(&dir);
    }

    /// UI 目录非法（缺 index.html）⇒ 整次更新拒绝，内核回到旧版本（不留半替换）。
    #[test]
    fn invalid_ui_rejects_update_and_restores_kernel() {
        let dir = temp_dir("ui-bad");
        let target = dir.join("launcher-kernel");
        let staged = dir.join("staged-kernel");
        let bad_ui = dir.join("bad-ui");
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(&bad_ui).unwrap();
        fs::write(&target, b"old-binary").unwrap();
        fs::write(&staged, b"new-binary").unwrap();

        let err = apply_to(&dir, &staged, &target, "0.1.0", "0.2.0", Some(&bad_ui), SwapOwner::Kernel).expect_err("缺 index.html 必须拒绝");
        assert_eq!(err.code, "BAD_ARGS");
        assert_eq!(fs::read(&target).unwrap(), b"old-binary", "拒绝时内核回到旧版本");
        assert!(!bin_dir(&dir).join(PENDING_FILE).exists(), "拒绝不写台账");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_only_latest_backup() {
        let dir = temp_dir("keep");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("launcher-kernel-0.1.0-100"), b"a").unwrap();
        fs::write(dir.join("launcher-kernel-0.1.1-200"), b"b").unwrap();
        keep_latest_backup(&dir);
        let files = crate::util::fsx::list_dir_safe(&dir);
        assert_eq!(files.len(), 1, "只保留最近一份备份：{files:?}");
        assert!(files[0].to_string_lossy().contains("200"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// 壳侧台账的最小构造（测试用）
    fn shell_pending(target: &Path, staged: &Path, backup: &Path) -> PendingUpdate {
        PendingUpdate {
            from_version: "0.1.0".to_string(),
            to_version: "0.2.0".to_string(),
            target: target.display().to_string(),
            backup: backup.display().to_string(),
            attempts: 0,
            requested_at: now_ms(),
            ui_target: None,
            ui_backup: None,
            swap_owner: SwapOwner::Shell,
            staged: Some(staged.display().to_string()),
            ui_staged: None,
            revert: false,
        }
    }

    /// Windows 路线：内核**只登记、不动文件**（运行中的映像写不了）——
    /// 目标一个字节都不能变，候选留在原地等壳来搬，备份只是先把路径算好。
    #[test]
    fn shell_owner_registers_swap_without_touching_files() {
        let dir = temp_dir("shell-plan");
        let target = dir.join("launcher-kernel");
        let staged_dir = dir.join("download");
        let staged = staged_dir.join("launcher-kernel");
        let staged_ui = staged_dir.join(EXTERNAL_UI_DIR);
        fs::create_dir_all(&staged_ui).unwrap();
        fs::write(&target, b"old-binary").unwrap();
        fs::write(&staged, b"new-binary").unwrap();
        fs::write(staged_ui.join("index.html"), b"new-ui").unwrap();

        let pending = apply_to(&dir, &staged, &target, "0.1.0", "0.2.0", Some(&staged_ui), SwapOwner::Shell)
            .expect("登记应成功");
        assert_eq!(pending.swap_owner, SwapOwner::Shell);
        let staged_text = staged.display().to_string();
        assert_eq!(pending.staged.as_deref(), Some(staged_text.as_str()));
        assert!(pending.ui_staged.is_some() && pending.ui_target.is_some(), "UI 要一起登记（同进同退）");
        assert!(!pending.revert);
        assert_eq!(fs::read(&target).unwrap(), b"old-binary", "目标一个字节都不能动");
        assert_eq!(fs::read(&staged).unwrap(), b"new-binary", "候选留在原地等壳来搬");
        assert!(!Path::new(&pending.backup).exists(), "备份路径只是先算好，此刻不创建");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 壳换过之后（候选不在了）连续两次启动仍未就绪 ⇒ **登记回滚请求**，
    /// 而不是在自身进程里恢复（Windows 上删不掉运行中的自己）。
    #[test]
    fn shell_owner_boot_guard_requests_revert_instead_of_restoring() {
        let dir = temp_dir("shell-guard");
        let target = dir.join("launcher-kernel");
        let backup = dir.join("backup-kernel");
        let staged = dir.join("already-consumed"); // 不存在 = 壳已换过
        fs::create_dir_all(&dir).unwrap();
        fs::write(&target, b"new-binary").unwrap();
        fs::write(&backup, b"old-binary").unwrap();
        write_json_atomic(&bin_dir(&dir).join(PENDING_FILE), &shell_pending(&target, &staged, &backup)).unwrap();

        let first = boot_guard(&dir).expect("第一次启动要记账");
        assert!(first.contains("第 1 次启动"), "{first}");
        let second = boot_guard(&dir).expect("第二次要登记回滚");
        assert!(second.contains("交给壳"), "{second}");
        let after = pending_of(&dir).expect("台账留给壳执行");
        assert!(after.revert, "回滚请求要落进台账");
        assert_eq!(fs::read(&target).unwrap(), b"new-binary", "内核自己不动文件");
        assert_eq!(fs::read(&backup).unwrap(), b"old-binary", "备份原封不动");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 手动回滚：壳还没换过 ⇒ 取消这次更新（没有备份可回滚）；已换过 ⇒ 登记回滚交给壳。
    #[test]
    fn shell_owner_rollback_cancels_before_swap_and_defers_after() {
        // ① 还没换过：候选还在
        let dir = temp_dir("shell-cancel");
        let target = dir.join("launcher-kernel");
        let staged = dir.join("staged-kernel");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&target, b"old-binary").unwrap();
        fs::write(&staged, b"new-binary").unwrap();
        write_json_atomic(&bin_dir(&dir).join(PENDING_FILE), &shell_pending(&target, &staged, &dir.join("no-backup"))).unwrap();
        let message = rollback(&dir).expect("取消应成功").expect("应有说明");
        assert!(message.contains("已取消"), "{message}");
        assert!(!staged.exists(), "取消要顺手清掉候选");
        assert!(!bin_dir(&dir).join(PENDING_FILE).exists(), "取消要清台账");
        assert_eq!(fs::read(&target).unwrap(), b"old-binary");
        let _ = fs::remove_dir_all(&dir);

        // ② 已经换过：候选被搬走了 ⇒ 登记回滚，等壳来换
        let dir = temp_dir("shell-revert");
        let target = dir.join("launcher-kernel");
        let backup = dir.join("backup-kernel");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&target, b"new-binary").unwrap();
        fs::write(&backup, b"old-binary").unwrap();
        write_json_atomic(&bin_dir(&dir).join(PENDING_FILE), &shell_pending(&target, &dir.join("consumed"), &backup)).unwrap();
        let message = rollback(&dir).expect("登记应成功").expect("应有说明");
        assert!(message.contains("已登记回滚"), "{message}");
        let after = pending_of(&dir).expect("台账要留给壳");
        assert!(after.revert);
        assert_eq!(fs::read(&target).unwrap(), b"new-binary", "内核自己不动文件");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 执行者判定：平台倾向 + 壳能力 —— 壳没这个能力就一律内核自换（老壳配新内核的回落）。
    #[test]
    fn swap_owner_follows_declared_capability() {
        assert_eq!(swap_owner_for(false), SwapOwner::Kernel, "壳没声明 ⇒ 内核自换并给出明确错误");
        assert_eq!(swap_owner_for(true) == SwapOwner::Shell, cfg!(windows), "只有 Windows 才需要壳代劳");
    }

    /// 壳的回执读后即删（内核启动时把它写进热更新日志，避免「成没成」一片空白）。
    #[test]
    fn swap_result_is_consumed_once() {
        let dir = temp_dir("swap-result");
        fs::create_dir_all(bin_dir(&dir)).unwrap();
        let path = bin_dir(&dir).join(SWAP_RESULT_FILE);
        write_json_atomic(&path, &serde_json::json!({ "result": "applied", "detail": "壳已替换", "at": 1 })).unwrap();
        let first = take_swap_result(&dir).expect("第一次应读到");
        assert_eq!(first.result, "applied");
        assert!(!path.exists(), "读完即删");
        assert!(take_swap_result(&dir).is_none(), "第二次没有");
        let _ = fs::remove_dir_all(&dir);
    }
}
