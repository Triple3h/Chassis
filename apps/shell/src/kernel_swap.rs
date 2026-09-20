//! 内核换核的「壳执行」那一半（Windows 路线）：docs/kernel-hot-update.md §6 / docs/architecture.md §11。
//!
//! Windows 上运行中的 exe 写不了 ⇒ 内核只写台账（`<dataRoot>/hot/bin/pending.json`），
//! 由壳在「内核已退出、尚未拉起」的窗口里照台账执行；连续两次启动未就绪时内核登记 `revert`，回滚同样由壳执行。
//!
//! 这条路径**数据驱动、不按平台分支**：macOS 上内核自己换（台账的 `swapOwner` 是 `kernel`），
//! 壳读到也不动手 —— 于是它能在 macOS 上被单测完整驱动（替换 / 回滚 / 失败 / 幂等）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 与 `apps/kernel/src/hot/binary.rs::PendingUpdate` 同步的跨进程契约（改字段两边一起改）。
/// 全部字段都带 `#[serde(default)]`：老壳遇到新内核加字段要读得进来，而不是整条台账作废。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingUpdate {
    from_version: String,
    to_version: String,
    target: String,
    backup: String,
    /// `kernel`（内核自己换）| `shell`（壳在重启间隙换）
    swap_owner: String,
    /// 候选二进制：**它还在 = 还没换过** —— 壳判定幂等的唯一依据（与内核侧同款约定）
    staged: Option<String>,
    /// 与内核同包的 UI（内核托管 UI：不一起换会出现「新内核 + 旧 UI」）
    ui_target: Option<String>,
    ui_backup: Option<String>,
    ui_staged: Option<String>,
    /// 内核登记的「把备份换回来」（连续两次启动未就绪）
    revert: bool,
}

/// 回执：内核启动时读后即删、写进热更新日志（`hot/log`）——「成没成」不能只留在 shell.log 里。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwapResult {
    result: String,
    detail: String,
    at: i64,
}

const PENDING_FILE: &str = "pending.json";
const SWAP_RESULT_FILE: &str = "swap-result.json";

/// 内核启动前的「磁盘计划」：有「壳执行」的台账就照它换核 / 回滚。
///
/// 只在**内核已退出、尚未拉起**时调用（`Sidecar::start` 的最前面）。返回 `Some(说明)` = 这次真的动过文件。
pub fn apply_pending(data_root: &Path, entry: &Path) -> Option<String> {
    let bin = data_root.join("hot").join("bin");
    let pending_path = bin.join(PENDING_FILE);
    let raw = std::fs::read_to_string(&pending_path).ok()?;
    let pending: PendingUpdate = match serde_json::from_str(&raw) {
        Ok(value) => value,
        // 坏台账不在这里删：内核的启动守卫会按「损坏」丢弃并留日志（谁写谁负责）
        Err(_) => return Some(format!("内核替换台账无法解析，交给内核处理：{}", pending_path.display())),
    };
    if pending.swap_owner != "shell" {
        return None; // macOS / 开发态：内核自己换过了
    }
    if !same_path(Path::new(&pending.target), entry) {
        // 台账指向的不是本次要启动的内核（例如 App 升级已重投外置内核）⇒ 这次更新作废
        let _ = std::fs::remove_file(&pending_path);
        return Some(format!(
            "内核替换台账指向 {}（与本次启动的 {} 不符），已丢弃该更新",
            pending.target,
            entry.display()
        ));
    }

    let staged = pending.staged.as_deref().map(PathBuf::from);
    let swapped = staged.as_ref().map(|path| !path.exists()).unwrap_or(true);
    if pending.revert {
        return Some(revert(&bin, &pending, swapped));
    }
    if swapped {
        return None; // 已换过：内核的启动守卫正在计启动次数，壳不用插手
    }
    Some(swap_in(&bin, &pending))
}

/// 执行替换：备份用 **copy**（目标不会被搬走 ⇒ 任何失败路径都不会出现「内核不见了」），
/// 落地用 **rename**（同卷原子 ⇒ 不会留下半个二进制）。候选被搬走 = 幂等标记。
fn swap_in(bin: &Path, pending: &PendingUpdate) -> String {
    let (target, backup) = (PathBuf::from(&pending.target), PathBuf::from(&pending.backup));
    let Some(staged) = pending.staged.as_deref().map(PathBuf::from) else {
        return fail(bin, pending, "台账缺少候选二进制路径");
    };
    if let Some(parent) = backup.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            return fail(bin, pending, &format!("创建备份目录失败：{err}"));
        }
    }
    if let Err(err) = std::fs::copy(&target, &backup) {
        return fail(bin, pending, &format!("备份旧内核失败（旧版本未改动）：{err}"));
    }
    if let Err(err) = std::fs::rename(&staged, &target) {
        let _ = std::fs::remove_file(&backup); // 没换成，别留一份会被误当回滚目标的旧副本
        return fail(bin, pending, &format!("落地新内核失败（旧版本未改动）：{err}"));
    }
    if let Some(detail) = swap_ui(pending) {
        // 二进制与 UI 同进同退：UI 没换成就整体退回（新二进制还给 staging、备份换回目标）
        let _ = std::fs::rename(&target, &staged);
        let _ = std::fs::rename(&backup, &target);
        return fail(bin, pending, &detail);
    }
    write_result(bin, "applied", &format!("已替换内核 v{} → v{}", pending.from_version, pending.to_version));
    format!("内核已替换 v{} → v{}（壳在重启间隙执行）", pending.from_version, pending.to_version)
}

/// UI 目录替换（可选）。返回 `Some(失败说明)` 由调用方负责整体回退。
fn swap_ui(pending: &PendingUpdate) -> Option<String> {
    let (Some(ui_target), Some(ui_staged)) = (pending.ui_target.as_deref(), pending.ui_staged.as_deref()) else {
        return None;
    };
    let (ui_target, ui_staged) = (PathBuf::from(ui_target), PathBuf::from(ui_staged));
    if !ui_staged.exists() {
        return None; // 已换过
    }
    let backup = pending.ui_backup.as_deref().map(PathBuf::from);
    if let Some(backup) = backup.as_ref() {
        let _ = std::fs::remove_dir_all(backup);
    }
    if ui_target.exists() {
        let Some(backup) = backup.as_ref() else {
            return Some("台账缺少 UI 备份路径".to_string());
        };
        if let Err(err) = std::fs::rename(&ui_target, backup) {
            return Some(format!("备份旧 UI 失败：{err}"));
        }
    }
    if let Err(err) = std::fs::rename(&ui_staged, &ui_target) {
        if let Some(backup) = backup.as_ref() {
            let _ = std::fs::rename(backup, &ui_target);
        }
        return Some(format!("落地新 UI 失败：{err}"));
    }
    None
}

/// 回滚：把备份换回目标（含 UI），然后清台账 —— 壳换完，内核启动时就没有 pending 可记了。
fn revert(bin: &Path, pending: &PendingUpdate, swapped: bool) -> String {
    let (target, backup) = (PathBuf::from(&pending.target), PathBuf::from(&pending.backup));
    if !swapped || !backup.exists() {
        // 没换过 / 备份不在 ⇒ 没有可回滚的东西：直接丢弃这次更新（别让守卫永远在要求回滚）
        let _ = std::fs::remove_file(bin.join(PENDING_FILE));
        write_result(bin, "failed", "回滚请求到达时已无可回滚的备份，已丢弃该更新");
        return "回滚请求无可回滚的备份：已丢弃该内核更新".to_string();
    }
    if let Err(err) = std::fs::rename(&backup, &target) {
        return fail(bin, pending, &format!("回滚失败：{err}（备份仍在 {}）", backup.display()));
    }
    restore_ui(pending);
    let _ = std::fs::remove_file(bin.join(PENDING_FILE));
    write_result(bin, "reverted", &format!("已回滚内核 v{} → v{}", pending.to_version, pending.from_version));
    format!("内核已回滚 v{} → v{}（壳在重启间隙执行）", pending.to_version, pending.from_version)
}

/// UI 回滚：删掉当前 UI、把备份换回来（与内核同进同退）。
fn restore_ui(pending: &PendingUpdate) {
    let (Some(ui_target), Some(ui_backup)) = (pending.ui_target.as_deref(), pending.ui_backup.as_deref()) else {
        return;
    };
    let backup = PathBuf::from(ui_backup);
    if !backup.exists() {
        return;
    }
    let target = PathBuf::from(ui_target);
    let _ = std::fs::remove_dir_all(&target);
    let _ = std::fs::rename(&backup, &target);
}

/// 失败收尾：清台账（别让内核的守卫拿着一条永远执行不了的计划去计启动次数）+ 写回执。
fn fail(bin: &Path, pending: &PendingUpdate, detail: &str) -> String {
    let _ = std::fs::remove_file(bin.join(PENDING_FILE));
    write_result(bin, "failed", detail);
    format!(
        "内核替换失败，保持旧版本 v{} → v{} 未生效：{detail}",
        pending.from_version, pending.to_version
    )
}

/// 回执是「尽力而为」：写不进去只影响日志可读性，不影响内核正确性。
fn write_result(bin: &Path, result: &str, detail: &str) {
    let payload = SwapResult { result: result.to_string(), detail: detail.to_string(), at: now_ms() };
    if let Ok(json) = serde_json::to_string_pretty(&payload) {
        let _ = std::fs::write(bin.join(SWAP_RESULT_FILE), json);
    }
}

/// 路径相等：先按字面，再按规范化（同一个文件可能一个带 `..`、一个是解析过的）。
fn same_path(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kernel-swap-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("hot").join("bin")).unwrap();
        std::fs::create_dir_all(dir.join("staging")).unwrap();
        dir
    }

    fn target_of(dir: &Path) -> PathBuf {
        dir.join("launcher-kernel")
    }

    fn backup_of(dir: &Path) -> PathBuf {
        dir.join("hot").join("bin").join("backup").join("launcher-kernel-0.1.0")
    }

    fn ledger_path(dir: &Path) -> PathBuf {
        dir.join("hot").join("bin").join(PENDING_FILE)
    }

    /// 造一份「壳执行」的台账（字段 = 内核 `PendingUpdate` 的 camelCase）
    fn write_ledger(dir: &Path, owner: &str, staged: Option<&Path>, ui: Option<(&Path, &Path)>, revert: bool) {
        let mut ledger = serde_json::json!({
            "fromVersion": "0.1.0",
            "toVersion": "0.2.0",
            "target": target_of(dir).display().to_string(),
            "backup": backup_of(dir).display().to_string(),
            "attempts": 1,
            "requestedAt": 1,
            "swapOwner": owner,
            "revert": revert,
        });
        if let Some(staged) = staged {
            ledger["staged"] = serde_json::json!(staged.display().to_string());
        }
        if let Some((ui_target, ui_staged)) = ui {
            ledger["uiTarget"] = serde_json::json!(ui_target.display().to_string());
            ledger["uiStaged"] = serde_json::json!(ui_staged.display().to_string());
            ledger["uiBackup"] = serde_json::json!(
                dir.join("hot").join("bin").join("backup").join("ui-1").display().to_string()
            );
        }
        std::fs::write(ledger_path(dir), ledger.to_string()).unwrap();
    }

    fn read_ledger(dir: &Path) -> Option<serde_json::Value> {
        std::fs::read_to_string(ledger_path(dir)).ok().and_then(|raw| serde_json::from_str(&raw).ok())
    }

    fn read_result(dir: &Path) -> Option<SwapResult> {
        let raw = std::fs::read_to_string(dir.join("hot").join("bin").join(SWAP_RESULT_FILE)).ok()?;
        serde_json::from_str(&raw).ok()
    }

    #[test]
    fn applies_pending_swap_and_keeps_backup() {
        let dir = temp_dir("apply");
        let target = target_of(&dir);
        let staged = dir.join("staging").join("launcher-kernel");
        std::fs::write(&target, b"old-binary").unwrap();
        std::fs::write(&staged, b"new-binary").unwrap();
        write_ledger(&dir, "shell", Some(&staged), None, false);

        let detail = apply_pending(&dir, &target).expect("应执行替换");
        assert!(detail.contains("已替换"), "{detail}");
        assert_eq!(std::fs::read(&target).unwrap(), b"new-binary", "目标换新");
        assert!(!staged.exists(), "候选被搬走 = 幂等标记");
        assert_eq!(std::fs::read(backup_of(&dir)).unwrap(), b"old-binary", "备份是旧版本（回滚要它）");
        assert!(read_ledger(&dir).is_some(), "台账留给内核的启动守卫计启动次数");
        assert_eq!(read_result(&dir).unwrap().result, "applied", "回执要落盘（内核写进热日志）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_idempotent_once_staged_is_consumed() {
        let dir = temp_dir("idempotent");
        let target = target_of(&dir);
        std::fs::write(&target, b"new-binary").unwrap();
        write_ledger(&dir, "shell", Some(&dir.join("staging").join("gone")), None, false); // 候选不在 = 已换过

        assert!(apply_pending(&dir, &target).is_none(), "已换过 ⇒ 壳不插手");
        assert_eq!(std::fs::read(&target).unwrap(), b"new-binary");
        assert!(read_result(&dir).is_none(), "没动手就不写回执");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ignores_kernel_owned_ledger() {
        let dir = temp_dir("kernel-owned");
        let target = target_of(&dir);
        std::fs::write(&target, b"old-binary").unwrap();
        write_ledger(&dir, "kernel", Some(&dir.join("staging").join("x")), None, false);

        assert!(apply_pending(&dir, &target).is_none(), "macOS 路线：内核自己换过了，壳不动");
        assert_eq!(std::fs::read(&target).unwrap(), b"old-binary");
        assert!(read_ledger(&dir).is_some(), "别人的台账，壳不碰");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reverts_when_kernel_asks_for_it() {
        let dir = temp_dir("revert");
        let target = target_of(&dir);
        std::fs::create_dir_all(backup_of(&dir).parent().unwrap()).unwrap();
        std::fs::write(&target, b"new-binary").unwrap();
        std::fs::write(backup_of(&dir), b"old-binary").unwrap();
        write_ledger(&dir, "shell", Some(&dir.join("consumed")), None, true);

        let detail = apply_pending(&dir, &target).expect("应执行回滚");
        assert!(detail.contains("已回滚"), "{detail}");
        assert_eq!(std::fs::read(&target).unwrap(), b"old-binary", "换回旧版本");
        assert!(!ledger_path(&dir).exists(), "回滚完清台账（否则守卫会一直要求回滚）");
        assert_eq!(read_result(&dir).unwrap().result, "reverted");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn swaps_ui_together_with_the_binary() {
        let dir = temp_dir("ui");
        let target = target_of(&dir);
        let staged = dir.join("staging").join("launcher-kernel");
        let ui_target = dir.join("ui");
        let ui_staged = dir.join("staging").join("ui");
        std::fs::create_dir_all(&ui_target).unwrap();
        std::fs::create_dir_all(&ui_staged).unwrap();
        std::fs::write(ui_target.join("index.html"), b"old-ui").unwrap();
        std::fs::write(ui_staged.join("index.html"), b"new-ui").unwrap();
        std::fs::write(&target, b"old-binary").unwrap();
        std::fs::write(&staged, b"new-binary").unwrap();
        write_ledger(&dir, "shell", Some(&staged), Some((&ui_target, &ui_staged)), false);

        apply_pending(&dir, &target).expect("应执行替换");
        assert_eq!(std::fs::read(ui_target.join("index.html")).unwrap(), b"new-ui", "UI 一起换");
        let ui_backup = PathBuf::from(read_ledger(&dir).unwrap()["uiBackup"].as_str().unwrap());
        assert_eq!(std::fs::read(ui_backup.join("index.html")).unwrap(), b"old-ui", "旧 UI 有备份");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn drops_stale_ledger_for_another_target() {
        let dir = temp_dir("stale");
        let other = dir.join("somewhere-else");
        std::fs::write(&other, b"x").unwrap();
        write_ledger(&dir, "shell", Some(&dir.join("staging").join("s")), None, false);

        let detail = apply_pending(&dir, &other).expect("应给出说明");
        assert!(detail.contains("已丢弃"), "{detail}");
        assert!(!ledger_path(&dir).exists(), "台账被丢弃");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_swap_keeps_old_version_and_reports() {
        let dir = temp_dir("fail");
        let target = target_of(&dir); // 故意不创建 target ⇒ 备份这一步就会失败
        let staged = dir.join("staging").join("s");
        std::fs::write(&staged, b"new-binary").unwrap(); // 候选在 ⇒ 不会被当成「已换过」
        write_ledger(&dir, "shell", Some(&staged), None, false);

        let detail = apply_pending(&dir, &target).expect("应给出失败说明");
        assert!(detail.contains("保持旧版本"), "{detail}");
        assert!(!ledger_path(&dir).exists(), "失败要清台账（否则守卫会拿着执行不了的计划计数）");
        assert_eq!(read_result(&dir).unwrap().result, "failed");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
