//! 壳自更新（App 层热更新）：候选包自检 → 备份 → **独立 helper 替换安装** → 重启；
//! 失败由 helper（立即回滚）与下次启动的 `boot_guard`（连续两次未就绪回滚）两处自愈。
//!
//! 与内核热更新（`apps/kernel/src/hot/binary.rs`）**同构**，差别只在「谁来重启」：
//! 内核不能重启自己（壳的 `supervise` 拉起它），壳也没有父进程可依靠 —— 所以替换与重启交给
//! 一个**脱离壳进程树**的 helper（macOS `/bin/sh`、Windows PowerShell 5.1，两者都是系统自带），
//! 等壳完全退出后再动手（壳退出会连带停掉内核，整个应用一起重启，这是预期行为）。
//!
//! 两种安装形态（`InstallKind`）只有「候选包长什么样」与「helper 怎么写」不同，账本 / 启动守卫 /
//! 确认成功三段**完全共用**：
//!  - macOS：`X.app`（同卷 rename 整个 bundle），helper = `<dataRoot>/hot/shell/swap.sh`；
//!  - Windows：绿色版安装目录（`Chassis.exe` + `resources/`，同卷 rename 整个目录），helper = `swap.ps1`。
//!
//! 两端都不能在**自己还活着**的时候替换：macOS 是「替换了 bundle 也算数」（旧 inode 继续跑），
//! Windows 则连运行中的 exe 与它所在目录都动不了 —— 所以「等进程退出」这一步在两边都是硬前提。
//!
//! 签名是 macOS 的**硬前提**：新包必须与当前包同一签名身份（固定证书），否则 TCC 授权（辅助功能 /
//! 屏幕录制…）会失配重弹。CI 侧用 `MACOS_SIGN_P12` secrets 导入同一证书解决，见 `.github/workflows/app-release.yml`。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 壳自更新机制版本（索引的 `minShellHotVersion` 与它比对；**机制变了才动**，产物版本另算）。
///
/// 2026-09-20 加 Windows 安装形态时**刻意没动**：包格式对 macOS 没变，而 Windows 侧此前
/// `canSelfUpdate` 恒 false（根本不会尝试安装）⇒ 没有需要被挡下的旧客户端；
/// 反过来动它会把**所有存量客户端（含 macOS）**挡在门外 —— 那是「机制不兼容」才配付的代价。
pub const SHELL_HOT_VERSION: &str = "0.1.0";

/// `Contents/MacOS/` 下的壳二进制名（改这里要同步 `scripts/pack-local-app.mjs`）。
const SHELL_EXE: &str = "launcher-shell";

/// Windows 绿色版里的壳二进制名（改这里要同步 `scripts/pack-win.mjs` 的 `Chassis.exe`）。
const APP_EXE: &str = "Chassis.exe";

/// `CREATE_NO_WINDOW`（winbase.h）：GUI 进程 spawn 控制台程序时不要闪黑框。
/// 定义收在 `sidecar`（子进程管理的归属地），内核 / helper / 自检共用一份。
#[cfg(windows)]
use crate::sidecar::CREATE_NO_WINDOW;

/// 自检超时：`--hot-probe` 只打印一行 JSON 就退出，正常在几十毫秒内。
const PROBE_TIMEOUT_MS: u64 = 3_000;

/// 候选包放行给 helper 之后的等待：先让「正在重启」的响应发出去，再退出进程。
const EXIT_DELAY_MS: u64 = 400;

/// 编译期注入（`build.rs` 读 `tauri.conf.json`）：壳版本只有一个源。
pub fn version() -> &'static str {
    env!("SHELL_VERSION")
}

pub fn hot_version() -> &'static str {
    SHELL_HOT_VERSION
}

// ── 定位 ────────────────────────────────────────────────────────

/// 安装形态：决定「候选包长什么样」「怎么替换」「helper 用哪门脚本」。
/// 抽成参数（而不是到处 `cfg`）是为了让两条路都能在任一平台上被单测驱动。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallKind {
    /// `X.app`（macOS）
    MacBundle,
    /// 绿色版安装目录：`Chassis.exe` + `resources/`（Windows）
    WindowsDir,
}

/// 当前平台的安装形态
pub fn install_kind() -> InstallKind {
    if cfg!(windows) {
        InstallKind::WindowsDir
    } else {
        InstallKind::MacBundle
    }
}

/// 当前安装目标；开发态（`target/debug/…`）为 `None`。
pub fn install_target() -> Option<PathBuf> {
    install_target_of(install_kind(), &std::env::current_exe().ok()?)
}

/// 从可执行文件路径推断安装目标（可注入，便于测试另一种形态）。
pub fn install_target_of(kind: InstallKind, exe: &Path) -> Option<PathBuf> {
    match kind {
        InstallKind::MacBundle => bundle_of(exe),
        InstallKind::WindowsDir => windows_dir_of(exe),
    }
}

/// 从可执行文件往上找 `.app`：`…/X.app/Contents/MacOS/x` → `…/X.app`。
fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let looks_like_bundle = macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app";
    looks_like_bundle.then(|| bundle.to_path_buf())
}

/// Windows 绿色版安装目录：`<dir>/Chassis.exe` 且 `<dir>/resources/` 在才算正经安装位
/// （开发态是 `target/debug/launcher-shell.exe`，名字与结构都对不上 ⇒ 一律拒绝 ——
/// 与 macOS「开发态不是 `.app`」同一条规矩：绝不拿 dev 跑出来的路径去替换生产安装）。
fn windows_dir_of(exe: &Path) -> Option<PathBuf> {
    if exe.file_name()? != APP_EXE {
        return None;
    }
    let dir = exe.parent()?.to_path_buf();
    dir.join("resources").is_dir().then_some(dir)
}

/// 打包态 + **父目录可写** ⇒ 允许自更新（两种形态都是「整个目录被 rename 走再换新的」，
/// 所以写权限取决于父目录；开发态一律拒绝：替换的不是正经安装位）。
pub fn can_self_update() -> bool {
    match install_target() {
        Some(target) => target.parent().map(is_writable).unwrap_or(false),
        None => false,
    }
}

/// 「看起来能写」的判定（真写一个小文件）；真正的失败由 helper 报告并在那里回滚。
fn is_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".chassis-write-probe-{}", std::process::id()));
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

// ── 自检（--hot-probe）──────────────────────────────────────────

/// `--hot-probe` 的输出：候选包「能不能跑」的最低限度验证（对应内核的同名参数）。
pub fn probe_report() -> String {
    json!({
        "version": version(),
        "hotVersion": SHELL_HOT_VERSION,
        "bundle": install_target().map(|path| path.display().to_string()),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
    .to_string()
}

/// 候选包的自检结果。
#[derive(Debug, Clone)]
pub struct StagedApp {
    pub path: PathBuf,
    pub version: String,
}

/// 候选包校验（三道都要过）：
///  1. 结构：macOS = `Contents/MacOS/launcher-shell`、Windows = `Chassis.exe` 存在；
///  2. 版本：macOS 要 `Info.plist` 的 `CFBundleShortVersionString` 与二进制 `--hot-probe` 自报**一致**
///     （不一致 = 包拼装事故，宁可拒绝也不装出一个版本说不清的包）；Windows 没有 plist，
///     改查自检报告的 `platform` 与当前形态同源（防拿错平台的包）；
///  3. 能跑：`--hot-probe` 真的跑起来并退出 0。
///
/// 版本**是否比当前新**不在这里判断 —— 那是调用方（内核侧 internal-store 的 semver 比较）的职责，
/// 壳只保证「这个包是完整、自洽、能跑的」。
pub fn verify_staged(candidate: &Path) -> Result<StagedApp, String> {
    verify_staged_with(install_kind(), candidate)
}

/// `verify_staged` 的可注入版本（便于在任一平台上测另一种形态）。
pub fn verify_staged_with(kind: InstallKind, candidate: &Path) -> Result<StagedApp, String> {
    if !candidate.is_dir() {
        return Err(format!("候选包不是目录：{}", candidate.display()));
    }
    let (binary, expected_platform) = match kind {
        InstallKind::MacBundle => (candidate.join("Contents").join("MacOS").join(SHELL_EXE), "macos"),
        InstallKind::WindowsDir => (candidate.join(APP_EXE), "windows"),
    };
    if !binary.exists() {
        return Err(match kind {
            InstallKind::MacBundle => format!("候选包里没有 Contents/MacOS/{SHELL_EXE}（不是完整的 .app）"),
            InstallKind::WindowsDir => format!("候选包里没有 {APP_EXE}（不是绿色版目录）"),
        });
    }
    let report = run_probe(&binary)?;
    let reported = report.get("version").and_then(Value::as_str).unwrap_or_default().to_string();
    if reported.is_empty() {
        return Err("候选包自检没有报告版本（--hot-probe）".to_string());
    }
    let platform = report.get("platform").and_then(Value::as_str).unwrap_or_default();
    if platform != expected_platform {
        return Err(format!(
            "候选包自检报告的平台是 {platform}，与当前安装形态（{expected_platform}）不符：拒绝安装"
        ));
    }
    if kind == InstallKind::MacBundle {
        let plist_version = plist_version(candidate)?;
        if reported != plist_version {
            return Err(format!(
                "候选包的二进制版本（{reported}）与 Info.plist（{plist_version}）不一致：包拼装有问题，拒绝安装"
            ));
        }
    }
    Ok(StagedApp { path: candidate.to_path_buf(), version: reported })
}

fn run_probe(binary: &Path) -> Result<Value, String> {
    let mut command = Command::new(binary);
    command.arg("--hot-probe").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW); // 自检不要闪黑框
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("候选包自检无法启动（{}）：{err}", binary.display()))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child.wait_with_output().map_err(|err| format!("自检输出读取失败：{err}"))?;
                if !status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    return Err(format!(
                        "候选包自检退出码 {:?}：{}",
                        status.code(),
                        stderr.trim().chars().take(200).collect::<String>()
                    ));
                }
                let stdout = String::from_utf8_lossy(&output.stdout);
                return serde_json::from_str(stdout.trim()).map_err(|err| format!("候选包自检输出无法解析：{err}"));
            }
            Ok(None) => {}
            Err(err) => return Err(format!("候选包自检进程异常：{err}")),
        }
        if started.elapsed() > Duration::from_millis(PROBE_TIMEOUT_MS) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("候选包自检超时（{PROBE_TIMEOUT_MS}ms）"));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// 从 `Info.plist` 抠一个 `<key>X</key><string>Y</string>` —— 只读两个键，不值得引 plist 依赖。
fn plist_string(plist: &str, key: &str) -> Option<String> {
    let needle = format!("<key>{key}</key>");
    let rest = plist.split(&needle).nth(1)?;
    let value = rest.split("<string>").nth(1)?;
    Some(value.split("</string>").next()?.trim().to_string())
}

fn plist_version(bundle: &Path) -> Result<String, String> {
    let plist_path = bundle.join("Contents").join("Info.plist");
    let text = std::fs::read_to_string(&plist_path).map_err(|err| format!("读不到 Info.plist：{err}"))?;
    plist_string(&text, "CFBundleShortVersionString")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Info.plist 里没有 CFBundleShortVersionString".to_string())
}

// ── 台账与路径 ──────────────────────────────────────────────────

/// `<dataRoot>/hot/shell/`：壳自更新的全部状态（脚本 / 台账 / 日志都不在 `.app` 内，
/// 替换 bundle 不会动它们）。
pub fn shell_hot_dir(data_root: &Path) -> PathBuf {
    data_root.join("hot").join("shell")
}

pub fn pending_file(data_root: &Path) -> PathBuf {
    shell_hot_dir(data_root).join("pending.json")
}

/// helper 脚本路径（形态决定扩展名：macOS `swap.sh` / Windows `swap.ps1`）
fn helper_script_of(kind: InstallKind, data_root: &Path) -> PathBuf {
    let name = match kind {
        InstallKind::MacBundle => "swap.sh",
        InstallKind::WindowsDir => "swap.ps1",
    };
    shell_hot_dir(data_root).join(name)
}

pub fn helper_log(data_root: &Path) -> PathBuf {
    shell_hot_dir(data_root).join("swap.log")
}

/// 待验证的壳更新（与内核的 `pending.json` 同构）：新版本启动后走到「内核就绪」即确认，
/// 连续两次启动都没走到 ⇒ 判定坏包，回滚。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingUpdate {
    pub from_version: String,
    pub to_version: String,
    /// 被替换的 `.app`（`/Applications/Chassis.app`）
    pub target: String,
    /// 旧包的备份（同卷 rename，回滚就是换回来）
    pub backup: String,
    /// 已尝试启动次数（≥2 ⇒ 自动回滚）
    pub attempts: u32,
    pub requested_at: i64,
}

pub fn read_pending(data_root: &Path) -> Option<PendingUpdate> {
    let text = std::fs::read_to_string(pending_file(data_root)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_pending(data_root: &Path, pending: &PendingUpdate) -> Result<(), String> {
    let dir = shell_hot_dir(data_root);
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建热更新目录失败：{err}"))?;
    let target = pending_file(data_root);
    let tmp = dir.join("pending.json.tmp");
    let text = serde_json::to_string_pretty(pending).map_err(|err| format!("序列化台账失败：{err}"))?;
    std::fs::write(&tmp, text).map_err(|err| format!("写台账失败：{err}"))?;
    std::fs::rename(&tmp, &target).map_err(|err| format!("落位台账失败：{err}"))
}

/// 回滚后的备份位置（`/Applications/Chassis.app.chassis-backup`）。
fn backup_path(target: &Path) -> PathBuf {
    let name = target.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| "Chassis.app".to_string());
    target.with_file_name(format!("{name}.chassis-backup"))
}

// ── helper 脚本 ────────────────────────────────────────────────

/// 生成（覆盖写）helper 脚本。脚本是**唯一**能在壳退出后动手的角色。
///
/// 参数：`<replace|restore> <pid> <target> <staged> <backup> <log>`
///  - `replace`：备份旧包 → 落新包 → 换失败立刻换回 → open；
///  - `restore`：删当前包 → 备份换回 → open（boot_guard 判定坏包时用）。
///
/// 两条路都会在 `open` 之后等 8 秒查一次进程；没起来就（replace 模式下）回滚再 open ——
/// 这是 boot_guard 之外的第一道自愈（新包连启动都做不到时，用户只会看到「闪一下」）。
fn write_helper(data_root: &Path) -> Result<PathBuf, String> {
    write_helper_with(install_kind(), data_root)
}

fn write_helper_with(kind: InstallKind, data_root: &Path) -> Result<PathBuf, String> {
    let script = helper_script_of(kind, data_root);
    if let Some(parent) = script.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建热更新目录失败：{err}"))?;
    }
    let source = match kind {
        InstallKind::MacBundle => HELPER_SOURCE.to_string(),
        // PowerShell 5.1 读无 BOM 的 UTF-8 会按 ANSI 解 —— 中文日志会乱码，必须带 BOM
        InstallKind::WindowsDir => format!("\u{feff}{HELPER_PS1}"),
    };
    std::fs::write(&script, source).map_err(|err| format!("写入 helper 失败：{err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
    }
    Ok(script)
}

/// helper 脚本源码（POSIX sh：只用 `/bin/sh` 里有的东西）。
///
/// 为什么不写成 Rust：替换必须发生在**壳完全退出之后**，而那时壳已经不在 ——
/// 只能留一个独立进程在外面等（壳退出不会杀它：macOS 上父进程退出不连带子进程）。
const HELPER_SOURCE: &str = r#"#!/bin/sh
# 壳自更新 helper（由启动台生成，不要手改）：等旧进程退出 → 替换 .app → 重新 open。
# 用法: swap.sh <replace|restore> <pid> <target> <staged> <backup> <log>
mode="$1"; pid="$2"; target="$3"; staged="$4"; backup="$5"; log="$6"

log_line() {
  printf '%s [shell-swap] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >> "$log" 2>/dev/null
}

# ① 等旧进程完全退出：bundle 里的二进制还活着时替换，LaunchServices 会拿到半新半旧的状态
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i+1))
  if [ "$i" -gt 300 ]; then
    log_line "等待旧进程退出超时（pid=$pid），放弃（本次不做任何替换）"
    exit 1
  fi
  sleep 0.2
done
sleep 0.3

# ② 替换（失败一律回到「原包还在原位」的状态，绝不留半个安装）
if [ "$mode" = "replace" ]; then
  log_line "开始替换：$target（候选 $staged）"
  rm -rf "$backup" 2>/dev/null
  if ! mv "$target" "$backup"; then
    log_line "备份失败（目标目录不可写？），放弃替换"
    exit 1
  fi
  if ! mv "$staged" "$target"; then
    log_line "候选包落位失败，立即回滚"
    mv "$backup" "$target" 2>/dev/null
    open "$target" 2>>"$log"
    exit 1
  fi
else
  log_line "回滚：备份换回 $target"
  rm -rf "$target" 2>/dev/null
  if ! mv "$backup" "$target"; then
    log_line "回滚失败：备份不存在或不可用（$backup）"
    exit 1
  fi
fi

# ③ 去 quarantine（未公证的包从网络来时会带）并刷新 LaunchServices（图标 / 图标缓存）
xattr -dr com.apple.quarantine "$target" 2>/dev/null
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$target" 2>/dev/null

# ④ 起新实例
open "$target" 2>>"$log"
sleep 8
if pgrep -f "$target/Contents/MacOS/" >/dev/null 2>&1; then
  log_line "新实例已就绪：$target"
  exit 0
fi

# ⑤ 连启动都做不到：replace 模式下自动回滚（boot_guard 之外的兜底）
log_line "新实例未在 8 秒内起来"
if [ "$mode" = "replace" ] && [ -d "$backup" ]; then
  log_line "自动回滚到备份"
  rm -rf "$target" 2>/dev/null
  mv "$backup" "$target"
  open "$target" 2>>"$log"
fi
exit 1
"#;

/// Windows 版 helper（PowerShell 5.1：系统自带，仍是「脱离壳进程树等它退出再动手」同一套）。
///
/// 与 sh 版的差异只有三处，都是平台决定的：
///  - **整目录 rename**：绿色版安装 = 一个目录（`Chassis.exe` + `resources/`），替换 = 目录换位；
///  - 等进程退出用 `Get-Process -Id`（Windows 上运行中的 exe 与它所在目录都被锁，等是硬前提）；
///  - 起新实例用 `Start-Process`（等价 macOS 的 `open`）。
///
/// 坑：参数名**不能叫 `pid`** —— PowerShell 的 `$PID` 是只读自动变量，声明同名参数会直接报错。
const HELPER_PS1: &str = r#"# 壳自更新 helper（由启动台生成，不要手改）：等旧进程退出 → 替换安装目录 → 重新启动。
# 用法: swap.ps1 <replace|restore> <pid> <target> <staged> <backup> <log>
param([string]$mode, [int]$targetPid, [string]$target, [string]$staged, [string]$backup, [string]$log)
$ErrorActionPreference = 'Stop'

function Write-Log([string]$message) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  Add-Content -Path $log -Value "$stamp [shell-swap] $message" -ErrorAction SilentlyContinue
}

# ① 等旧进程完全退出：运行中的 exe 与它所在目录都动不了
$waited = 0
while ($waited -lt 300) {
  if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 200
  $waited++
}
if ($waited -ge 300) {
  Write-Log "等待旧进程退出超时（pid=$targetPid），放弃（本次不做任何替换）"
  exit 1
}
Start-Sleep -Milliseconds 300

$exe = Join-Path $target 'Chassis.exe'

# ② 替换（失败一律回到「原目录还在原位」的状态，绝不留半个安装）
if ($mode -eq 'replace') {
  Write-Log "开始替换：$target（候选 $staged）"
  try {
    if (Test-Path $backup) { Remove-Item -Recurse -Force $backup }
    Move-Item -Path $target -Destination $backup
    Move-Item -Path $staged -Destination $target
  } catch {
    Write-Log "替换失败：$($_.Exception.Message)（立即回滚）"
    if ((Test-Path $backup) -and -not (Test-Path $target)) {
      Move-Item -Path $backup -Destination $target -ErrorAction SilentlyContinue
    }
    if (Test-Path $exe) { Start-Process -FilePath $exe -WorkingDirectory $target }
    exit 1
  }
} else {
  Write-Log "回滚：备份换回 $target"
  try {
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Move-Item -Path $backup -Destination $target
  } catch {
    Write-Log "回滚失败：$($_.Exception.Message)（备份 $backup）"
    exit 1
  }
}

# ③ 起新实例（绿色版：直接跑目录里的 Chassis.exe）
if (-not (Test-Path $exe)) {
  Write-Log "目标目录里没有 Chassis.exe：$target"
  exit 1
}
Start-Process -FilePath $exe -WorkingDirectory $target
Start-Sleep -Seconds 8
if (Get-Process -Name 'Chassis' -ErrorAction SilentlyContinue) {
  Write-Log "新实例已就绪：$target"
  exit 0
}

# ④ 连启动都做不到：replace 模式下自动回滚（boot_guard 之外的兜底）
Write-Log "新实例未在 8 秒内起来"
if ($mode -eq 'replace' -and (Test-Path $backup)) {
  Write-Log "自动回滚到备份"
  try {
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Move-Item -Path $backup -Destination $target
    $restored = Join-Path $target 'Chassis.exe'
    if (Test-Path $restored) { Start-Process -FilePath $restored -WorkingDirectory $target }
  } catch {
    Write-Log "自动回滚失败：$($_.Exception.Message)"
  }
}
exit 1
"#;

/// 脱离壳进程树启动 helper（不等待、不接管输出；壳退出不会杀它）。
fn spawn_helper(data_root: &Path, args: &[String]) -> Result<(), String> {
    spawn_helper_with(install_kind(), data_root, args)
}

fn spawn_helper_with(kind: InstallKind, data_root: &Path, args: &[String]) -> Result<(), String> {
    let script = helper_script_of(kind, data_root);
    if !script.exists() {
        return Err("helper 脚本不存在".to_string());
    }
    // 两者都是系统自带：macOS `/bin/sh`、Windows PowerShell（不引第三方依赖）
    let mut command = match kind {
        InstallKind::MacBundle => {
            let mut command = Command::new("/bin/sh");
            command.arg(&script);
            command
        }
        InstallKind::WindowsDir => {
            let mut command = Command::new("powershell");
            command.arg("-NoProfile").arg("-ExecutionPolicy").arg("Bypass").arg("-File").arg(&script);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(CREATE_NO_WINDOW); // 别在用户面前闪一屏黑框
            }
            command
        }
    };
    command.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    command.spawn().map(|_| ()).map_err(|err| format!("启动 helper 失败：{err}"))
}

// ── 应用 / 守卫 ────────────────────────────────────────────────

/// 应用候选包：校验已在 `verify_staged` 完成，这里写台账 → 生成 helper → 交出去 → 延时退出。
///
/// 返回后调用方要把 `{ ok, restarting: true }` 回给内核（壳会在 `EXIT_DELAY_MS` 后退出）。
pub fn apply(app: &tauri::AppHandle, data_root: &Path, candidate: &Path) -> Result<Value, String> {
    let staged = verify_staged(candidate)?;
    let target = install_target().ok_or_else(|| "开发态（未打包）不支持应用自更新".to_string())?;
    if target == staged.path {
        return Err("候选包与当前安装位置相同".to_string());
    }
    let parent = target.parent().ok_or_else(|| "定位不到安装位置的父目录".to_string())?;
    if !is_writable(parent) {
        return Err(format!("安装位置不可写：{}（把 App 放到可写目录再试）", parent.display()));
    }

    let backup = backup_path(&target);
    let pending = PendingUpdate {
        from_version: version().to_string(),
        to_version: staged.version.clone(),
        target: target.display().to_string(),
        backup: backup.display().to_string(),
        attempts: 0,
        requested_at: now_ms(),
    };
    write_pending(data_root, &pending)?;
    write_helper(data_root)?;

    let args = vec![
        "replace".to_string(),
        std::process::id().to_string(),
        pending.target.clone(),
        staged.path.display().to_string(),
        pending.backup.clone(),
        helper_log(data_root).display().to_string(),
    ];
    if let Err(err) = spawn_helper(data_root, &args) {
        // helper 起不来就别退出：留在当前版本，把台账撤掉（否则下次启动会误判成待验证更新）
        let _ = std::fs::remove_file(pending_file(data_root));
        return Err(err);
    }

    // 先让响应发出去，再退出进程（退出会顺带停掉内核：整个应用一起重启）
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(EXIT_DELAY_MS));
        handle.exit(0);
    });

    Ok(json!({
        "ok": true,
        "restarting": true,
        "from": pending.from_version,
        "to": pending.to_version,
        "target": pending.target,
    }))
}

/// 启动守卫：在**进程最早**阶段调用（早于 Tauri 装配与内核）。
///
/// 语义与内核 `boot_guard` 一致：
///  - 台账不存在 ⇒ `None`；
///  - 存在 ⇒ 本次启动尝试次数 +1；达到 2 次还没确认成功 ⇒ 判定坏包，交 helper 换回备份并重启；
///  - 其余情况只记账（走到「内核就绪」后由 `mark_boot_success` 清台账）。
///
/// 返回 `Some(Outcome)` 时，调用方要按 `restart` 决定是否退出进程。
pub struct BootOutcome {
    pub detail: String,
    /// 需要退出进程（helper 已在等着换回备份并重新 open）
    pub restart: bool,
}

pub fn boot_guard(data_root: &Path) -> Option<BootOutcome> {
    boot_guard_with(data_root, install_target().as_deref(), &|args| spawn_helper(data_root, args))
}

/// `boot_guard` 的可测版本：安装位置与「交 helper」都可注入
/// （单测跑在 `target/debug` 下，永远不是正经安装位；真 spawn 会在测试进程活着时一直等）。
fn boot_guard_with(
    data_root: &Path,
    install: Option<&Path>,
    spawn: &dyn Fn(&[String]) -> Result<(), String>,
) -> Option<BootOutcome> {
    // 只有打包态才参与：开发态（`target/debug/launcher-shell`）与真正的安装
    // **共用同一个数据目录** —— 让 dev 跑一遍就记账、甚至去回滚生产安装，是绝不该发生的事。
    if install.is_none() {
        return None;
    }
    let mut pending = read_pending(data_root)?;
    // 台账只在「这次启动的正是待验证的新版本」时生效：版本对不上说明替换根本没发生
    // （helper 失败 / 人工换回 / 用户自己装了别的包），台账已经过期。
    if pending.to_version != version() {
        let _ = std::fs::remove_file(pending_file(data_root));
        return Some(BootOutcome {
            detail: format!(
                "发现过期的应用更新台账（候选 v{}，当前 v{}）：已丢弃",
                pending.to_version,
                version()
            ),
            restart: false,
        });
    }
    pending.attempts += 1;
    let _ = write_pending(data_root, &pending);

    if pending.attempts >= 2 {
        let target = PathBuf::from(&pending.target);
        let backup = PathBuf::from(&pending.backup);
        if !backup.exists() {
            // 备份没了：回不去，只能清掉台账（否则每次启动都会再判一次）
            let _ = std::fs::remove_file(pending_file(data_root));
            return Some(BootOutcome {
                detail: format!(
                    "候选包 v{} 连续 {} 次未就绪，但备份不存在（{}）—— 保持现状",
                    pending.to_version, pending.attempts, pending.backup
                ),
                restart: false,
            });
        }
        if write_helper(data_root).is_err() {
            return Some(BootOutcome {
                detail: "候选包连续未就绪，但 helper 脚本写入失败 —— 请手动换回备份".to_string(),
                restart: false,
            });
        }
        let args = vec![
            "restore".to_string(),
            std::process::id().to_string(),
            pending.target.clone(),
            String::new(),
            pending.backup.clone(),
            helper_log(data_root).display().to_string(),
        ];
        if let Err(err) = spawn(&args) {
            return Some(BootOutcome { detail: format!("候选包连续未就绪，但 helper 启动失败：{err}"), restart: false });
        }
        return Some(BootOutcome {
            detail: format!(
                "候选包 v{} 连续 {} 次启动未就绪，正在回滚到 v{}（{}）",
                pending.to_version,
                pending.attempts,
                pending.from_version,
                target.display()
            ),
            restart: true,
        });
    }

    Some(BootOutcome {
        detail: format!(
            "检测到待验证的应用更新 v{} → v{}（第 {} 次启动；走到内核就绪即确认成功）",
            pending.from_version, pending.to_version, pending.attempts
        ),
        restart: false,
    })
}

/// 走到「内核就绪」后调用：确认本次启动成功，清掉台账（回滚也就不会再发生）。
pub fn mark_boot_success(data_root: &Path) -> Option<String> {
    mark_boot_success_in(data_root, install_target().as_deref())
}

fn mark_boot_success_in(data_root: &Path, install: Option<&Path>) -> Option<String> {
    if install.is_none() {
        return None;
    }
    let pending = read_pending(data_root)?;
    let _ = std::fs::remove_file(pending_file(data_root));
    Some(format!("应用更新 v{} → v{} 已确认生效", pending.from_version, pending.to_version))
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
        let dir = std::env::temp_dir().join(format!("shell-update-{label}-{}", now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 造一个结构完整的候选 `.app`（二进制是 `#!/bin/sh` 脚本，`--hot-probe` 输出给定版本）。
    #[cfg(unix)]
    fn fake_app(dir: &Path, version: &str, plist_version: &str) -> PathBuf {
        let app = dir.join("Fake.app");
        let macos = app.join("Contents").join("MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        let binary = macos.join(SHELL_EXE);
        std::fs::write(
            &binary,
            format!(
                "#!/bin/sh\nprintf '%s' '{{\"version\":\"{version}\",\"hotVersion\":\"{SHELL_HOT_VERSION}\",\"platform\":\"macos\"}}'\n"
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(
            app.join("Contents").join("Info.plist"),
            format!(
                "<?xml version=\"1.0\"?><plist><dict><key>CFBundleShortVersionString</key><string>{plist_version}</string></dict></plist>"
            ),
        )
        .unwrap();
        app
    }

    #[test]
    fn bundle_is_located_from_exe_path() {
        let found = bundle_of(Path::new("/Applications/Chassis.app/Contents/MacOS/launcher-shell"));
        assert_eq!(found.as_deref(), Some(Path::new("/Applications/Chassis.app")));
        assert!(bundle_of(Path::new("/repo/target/debug/launcher-shell")).is_none(), "开发态不是 bundle");
        assert!(bundle_of(Path::new("/Applications/Foo.app/Contents/MacOS")).is_none(), "目录不是可执行文件");
    }

    #[test]
    fn plist_string_reads_version() {
        let plist = "<dict><key>CFBundleShortVersionString</key><string>1.2.3</string></dict>";
        assert_eq!(plist_string(plist, "CFBundleShortVersionString").as_deref(), Some("1.2.3"));
        assert!(plist_string(plist, "CFBundleVersion").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn staged_app_passes_probe_and_cross_checks_versions() {
        let dir = temp_dir("staged");
        let good = fake_app(&dir, "0.2.0", "0.2.0");
        let staged = verify_staged(&good).expect("结构与版本自洽的候选包应放行");
        assert_eq!(staged.version, "0.2.0");

        // 二进制自报 0.2.0，plist 写 0.3.0：包拼装事故 ⇒ 必须拒绝
        let mismatched = fake_app(&dir.join("mismatch"), "0.2.0", "0.3.0");
        let err = verify_staged(&mismatched).expect_err("版本不一致必须拒绝");
        assert!(err.contains("不一致"), "{err}");

        // 缺二进制
        let broken = dir.join("Broken.app");
        std::fs::create_dir_all(broken.join("Contents").join("MacOS")).unwrap();
        assert!(verify_staged(&broken).is_err());

        // 自检退出码非 0
        let failing = dir.join("Failing.app");
        let macos = failing.join("Contents").join("MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        let binary = macos.join(SHELL_EXE);
        std::fs::write(&binary, "#!/bin/sh\nexit 3\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(
            failing.join("Contents").join("Info.plist"),
            "<key>CFBundleShortVersionString</key><string>0.2.0</string>",
        )
        .unwrap();
        assert!(verify_staged(&failing).is_err(), "跑不起来的候选包必须拒绝");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 假安装位置（单测跑在 `target/debug` 下，真 `install_target()` 是 None）。
    const FAKE_BUNDLE: &str = "/Applications/Chassis.app";

    /// 当前版本的 pending（版本必须与 `version()` 一致，否则会被当成过期台账丢弃）。
    fn pending_now(dir: &Path) -> PendingUpdate {
        PendingUpdate {
            from_version: "0.0.9".to_string(),
            to_version: version().to_string(),
            target: dir.join("Chassis.app").display().to_string(),
            backup: dir.join("Chassis.app.chassis-backup").display().to_string(),
            attempts: 0,
            requested_at: now_ms(),
        }
    }

    #[test]
    fn boot_guard_only_touches_packaged_installs() {
        let dir = temp_dir("guard-dev");
        write_pending(&dir, &pending_now(&dir)).unwrap();
        // 开发态（非 .app）连台账都不该碰：它与 /Applications 那份共用同一个数据目录，
        // 跑一遍 dev 就去记账、甚至回滚生产安装，是绝不该发生的事。
        assert!(boot_guard_with(&dir, None, &|_| Ok(())).is_none());
        assert_eq!(read_pending(&dir).unwrap().attempts, 0, "开发态不得记账");
        assert!(mark_boot_success_in(&dir, None).is_none(), "开发态也不清台账");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn boot_guard_discards_stale_ledger() {
        let dir = temp_dir("guard-stale");
        let mut pending = pending_now(&dir);
        pending.to_version = "9.9.9".to_string();
        write_pending(&dir, &pending).unwrap();

        let outcome = boot_guard_with(&dir, Some(Path::new(FAKE_BUNDLE)), &|_| Ok(())).expect("有过期台账");
        assert!(outcome.detail.contains("已丢弃"), "{}", outcome.detail);
        assert!(!outcome.restart);
        assert!(read_pending(&dir).is_none(), "过期台账要清掉（否则每次启动都判一次）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn boot_guard_counts_attempts_then_rolls_back() {
        let dir = temp_dir("guard");
        let bundle = Some(Path::new(FAKE_BUNDLE));
        let spawned = std::cell::RefCell::new(Vec::<Vec<String>>::new());
        let spawn = |args: &[String]| {
            spawned.borrow_mut().push(args.to_vec());
            Ok(())
        };
        write_pending(&dir, &pending_now(&dir)).unwrap();

        let first = boot_guard_with(&dir, bundle, &spawn).expect("第一次启动要记账");
        assert!(first.detail.contains("第 1 次启动"), "{}", first.detail);
        assert!(!first.restart, "第一次不退出");
        assert_eq!(read_pending(&dir).unwrap().attempts, 1);

        // 备份不存在 ⇒ 回不去，只清台账（别每次启动都判一次）
        let second = boot_guard_with(&dir, bundle, &spawn).expect("第二次要处理");
        assert!(second.detail.contains("备份不存在"), "{}", second.detail);
        assert!(!second.restart);
        assert!(read_pending(&dir).is_none(), "台账已清");

        // 备份存在 ⇒ 交 helper 回滚，并要求调用方退出
        std::fs::write(dir.join("Chassis.app.chassis-backup"), b"old").unwrap();
        write_pending(&dir, &pending_now(&dir)).unwrap();
        let _ = boot_guard_with(&dir, bundle, &spawn);
        let third = boot_guard_with(&dir, bundle, &spawn).expect("第二次要回滚");
        assert!(third.restart, "回滚要退出进程：{}", third.detail);
        assert!(third.detail.contains("正在回滚"), "{}", third.detail);
        let last = spawned.borrow().last().cloned().expect("必须把回滚交给 helper");
        assert_eq!(last.first().map(String::as_str), Some("restore"), "回滚模式：{last:?}");

        // 成功路径：清台账
        write_pending(&dir, &pending_now(&dir)).unwrap();
        let done = mark_boot_success_in(&dir, bundle).expect("确认成功应有说明");
        assert!(done.contains("已确认生效"), "{done}");
        assert!(boot_guard_with(&dir, bundle, &spawn).is_none(), "台账清了就不再干预");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Windows 安装形态：`Chassis.exe` + `resources/` 才算安装位；开发态（`launcher-shell.exe`）不算。
    #[test]
    fn windows_install_dir_is_recognized_by_structure() {
        let dir = temp_dir("win-install");
        let install = dir.join("Chassis");
        std::fs::create_dir_all(install.join("resources")).unwrap();
        let exe = install.join(APP_EXE);
        std::fs::write(&exe, b"stub").unwrap();
        assert_eq!(install_target_of(InstallKind::WindowsDir, &exe).as_deref(), Some(install.as_path()));

        // 缺 resources/ ⇒ 不是正经安装位
        let bare = dir.join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        let bare_exe = bare.join(APP_EXE);
        std::fs::write(&bare_exe, b"stub").unwrap();
        assert!(install_target_of(InstallKind::WindowsDir, &bare_exe).is_none(), "缺 resources 不算安装位");

        // 开发态二进制名（launcher-shell.exe）⇒ 一律拒绝（与 macOS 的「不是 .app」同一条规矩）
        let dev = dir.join("debug");
        std::fs::create_dir_all(dev.join("resources")).unwrap();
        let dev_exe = dev.join("launcher-shell.exe");
        std::fs::write(&dev_exe, b"stub").unwrap();
        assert!(install_target_of(InstallKind::WindowsDir, &dev_exe).is_none(), "开发态不能当安装位");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Windows 候选包：结构（`Chassis.exe`）+ 自检（报告的 `platform` 必须同源）。
    #[cfg(unix)]
    #[test]
    fn windows_staged_package_is_verified_by_structure_and_platform() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("win-staged");

        let good = dir.join("candidate");
        std::fs::create_dir_all(&good).unwrap();
        let exe = good.join(APP_EXE);
        std::fs::write(&exe, "#!/bin/sh\nprintf '%s' '{\"version\":\"0.2.0\",\"platform\":\"windows\"}'\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let staged = verify_staged_with(InstallKind::WindowsDir, &good).expect("结构 + 平台自洽应放行");
        assert_eq!(staged.version, "0.2.0");

        // 拿错平台的包（自检报 macos）⇒ 拒绝
        let wrong = dir.join("wrong-platform");
        std::fs::create_dir_all(&wrong).unwrap();
        let wrong_exe = wrong.join(APP_EXE);
        std::fs::write(&wrong_exe, "#!/bin/sh\nprintf '%s' '{\"version\":\"0.2.0\",\"platform\":\"macos\"}'\n").unwrap();
        std::fs::set_permissions(&wrong_exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = verify_staged_with(InstallKind::WindowsDir, &wrong).expect_err("平台不符必须拒绝");
        assert!(err.contains("平台"), "{err}");

        // 缺 Chassis.exe ⇒ 拒绝
        let empty = dir.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(verify_staged_with(InstallKind::WindowsDir, &empty).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 两种形态各写各的 helper（Windows 的 ps1 **必须带 BOM**：PS 5.1 否则按 ANSI 解、中文日志乱码）。
    #[test]
    fn helper_scripts_are_written_per_install_kind() {
        let dir = temp_dir("helper");

        let sh = write_helper_with(InstallKind::MacBundle, &dir).unwrap();
        assert_eq!(sh.file_name().unwrap(), "swap.sh");
        let text = std::fs::read_to_string(&sh).unwrap();
        assert!(text.starts_with("#!/bin/sh"), "必须显式 /bin/sh（macOS 没有 bash 4 特性）");
        assert!(text.contains("kill -0"), "等旧进程退出是替换的前提");
        assert!(text.contains("xattr -dr com.apple.quarantine"), "未公证包要摘 quarantine");
        assert!(text.contains("pgrep -f"), "启动失败要能自愈");

        let ps1 = write_helper_with(InstallKind::WindowsDir, &dir).unwrap();
        assert_eq!(ps1.file_name().unwrap(), "swap.ps1");
        let text = std::fs::read_to_string(&ps1).unwrap();
        assert!(text.starts_with('\u{feff}'), "PS 5.1 要 BOM 才按 UTF-8 读");
        assert!(text.contains("Get-Process -Id $targetPid"), "等旧进程退出（$PID 是只读自动变量，参数名不能叫 pid）");
        assert!(text.contains("Move-Item"), "替换 = 整目录换位");
        assert!(text.contains("Start-Process"), "换完要起新实例");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
