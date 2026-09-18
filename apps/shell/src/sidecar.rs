//! 内核进程管理（requirements §4.1 / §6.2）：
//! 拉起 Node sidecar、转发日志、崩溃重启、退出清理。

use crate::ipc::Link;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const MAX_RESTARTS: u32 = 3;

/// 内核因热更新主动重启（收到 `kernel/restarting` 通知后置位）。
///
/// 语义：**计划内重启** —— 不计入崩溃重启预算（否则连续几次热更新就会撞上 MAX_RESTARTS），
/// 且重启后必须把窗口重新导航到新端口（内核端口每次启动都变）。
static HOT_RESTARTING: AtomicBool = AtomicBool::new(false);

/// 记录内核的热更新重启意图（由 `primitives::dispatch` 调用）。
pub fn note_hot_restart(params: &serde_json::Value) {
    HOT_RESTARTING.store(true, Ordering::SeqCst);
    let reason = params.get("reason").and_then(|value| value.as_str()).unwrap_or("hot-update");
    let version = params.get("version").and_then(|value| value.as_str()).unwrap_or("?");
    crate::logging::log(&format!("[shell] 内核请求热更新重启（reason={reason}，version={version}）"));
}

/// 把主窗口导航到内核托管的 UI。
///
/// 启动与**内核重启**两条路共用：内核重启后端口会变，不重新导航 = UI 停在旧端口白屏。
pub fn navigate_main_window(app: &tauri::AppHandle, port: u16) {
    let url = format!("http://127.0.0.1:{port}");
    if let Some(window) = app.get_webview_window("main") {
        match url.parse() {
            Ok(parsed) => {
                let _ = window.navigate(parsed);
            }
            Err(err) => crate::logging::log(&format!("[shell] URL 解析失败：{err}")),
        }
    }
}

// ── 内核外置（热更新的落点）──────────────────────────────────────
//
// 内核热更新要替换二进制；替换 `.app` 内的文件会**破坏代码签名**（macOS 上可能直接起不来）。
// 所以打包态的壳优先使用数据目录里的一份**外置副本**：热更新只动数据目录，签名 / TCC 都不受影响
// （内核不直接调 TCC API，读选中文本 / 截图都走壳原语，责任进程仍然是壳）。

/// 数据目录下的外置内核目录
const EXTERNAL_KERNEL_SUBDIR: &str = "kernel";
/// 外置副本的台账（记录投放来源 + 投放时的 App 版本）
const EXTERNAL_STATE_FILE: &str = "kernel.json";
/// 与内核同源的外置 UI 目录（内核托管 UI：一致性由同一份台账保证）
const EXTERNAL_UI_SUBDIR: &str = "ui";

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExternalKernelState {
    /// 投放时的 App 版本：**变了就重投**（新 App 自带的内核优先，热更新成果作废）
    source_app_version: String,
    /// `bundled`（首次投放）| `hot-update`（被内核热更新替换过；投放时仍是 bundled）
    source: String,
    installed_at: i64,
    bundled_kernel: String,
}

/// 内核定位结果。
enum KernelLocation {
    /// 打包态：包内二进制（会先投放成数据目录里的外置副本再启动）
    Bundled(PathBuf),
    /// 开发态 / 显式覆盖：直接用，不做外置（免得作者的本地构建被数据目录的旧副本挡住）
    Direct(PathBuf),
}

fn kernel_exe_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "launcher-kernel.exe"
    } else {
        "launcher-kernel"
    }
}

/// 内核定位（优先级从高到低）：
///  1. `LAUNCHER_KERNEL_ENTRY`（测试与开发覆盖）
///  2. 包内 `Resources/kernel/<exe>`（打包态）
///  3. `target/{release,debug}/<exe>`（开发态）
fn locate_kernel(app: &AppHandle) -> Result<KernelLocation, String> {
    if let Ok(path) = std::env::var("LAUNCHER_KERNEL_ENTRY") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(KernelLocation::Direct(path));
        }
        return Err(format!("LAUNCHER_KERNEL_ENTRY 指向的文件不存在：{}", path.display()));
    }

    let exe_name = kernel_exe_name();
    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in [
            resource_dir.join("kernel").join(exe_name),
            resource_dir.join("resources").join("kernel").join(exe_name),
        ] {
            if candidate.exists() {
                return Ok(KernelLocation::Bundled(candidate));
            }
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        let mut cursor: Option<&Path> = exe.parent();
        let mut hops = 0;
        while let Some(dir) = cursor {
            for profile in ["release", "debug"] {
                let candidate = dir.join("target").join(profile).join(exe_name);
                if candidate.exists() {
                    return Ok(KernelLocation::Direct(candidate));
                }
            }
            cursor = dir.parent();
            hops += 1;
            if hops > 6 {
                break;
            }
        }
    }

    Err("找不到内核（先执行 pnpm build:kernel，或设置 LAUNCHER_KERNEL_ENTRY）".to_string())
}

/// 确保数据目录里的外置副本可用；返回（要启动的内核路径，外置是否生效）。
///
/// 台账语义：`sourceAppVersion` 等于当前 App 版本 ⇒ 保留现有副本（可能已被热更新替换过）；
/// 不等（App 升级）或缺失 ⇒ 用包内版本重投（App 自带的内核优先），热更新成果顺带作废。
fn ensure_external_kernel(app: &AppHandle, bundled: &Path) -> (PathBuf, bool) {
    let dir = data_root(app).join(EXTERNAL_KERNEL_SUBDIR);
    let exe = dir.join(kernel_exe_name());
    let app_version = app.package_info().version.to_string();

    let state: Option<ExternalKernelState> = std::fs::read_to_string(dir.join(EXTERNAL_STATE_FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok());
    let fresh = state.as_ref().map(|item| item.source_app_version == app_version).unwrap_or(false);
    if exe.exists() && fresh {
        return (exe, true);
    }
    if let Some(previous) = state.as_ref() {
        if previous.source_app_version != app_version {
            crate::logging::log(&format!(
                "[shell] App 已从 {} 升到 {app_version}：丢弃外置内核（含热更新版本），改用包内版本",
                previous.source_app_version
            ));
        }
    }

    match install_external(app, bundled, &dir, &exe, &app_version) {
        Ok(()) => (exe, true),
        Err(err) => {
            crate::logging::log(&format!("[shell] 外置内核投放失败（回落到包内）：{err}"));
            (bundled.to_path_buf(), false)
        }
    }
}

fn install_external(app: &AppHandle, bundled: &Path, dir: &Path, exe: &Path, app_version: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|err| format!("创建外置内核目录失败：{err}"))?;

    // 二进制：先写临时文件再 rename —— 半截文件不会被下次启动当成可用内核
    let tmp = dir.join(format!("{}.installing", kernel_exe_name()));
    let _ = std::fs::remove_file(&tmp);
    std::fs::copy(bundled, &tmp).map_err(|err| format!("复制内核失败：{err}"))?;
    set_executable(&tmp)?;
    std::fs::rename(&tmp, exe).map_err(|err| format!("落位内核失败：{err}"))?;

    // UI：与内核同一份台账（「新内核 + 旧 UI」比不更新更糟）
    //
    // 来源要问 `ui_dist_dir`（打包态 = `Resources/ui/`），不能按 `bundled.parent()` 猜：
    // 内核在 `Resources/kernel/` 下、UI 在 `Resources/ui/` 下，**两者不同层**。
    // 早先按 parent 找永远落空 ⇒ 外置副本只有内核、UI 赖在 .app 里，
    // 内核热更新重启后就成「新内核 + 旧 UI」——恰好是这条设计要防的事。
    let bundled_ui = ui_dist_dir(app);
    if bundled_ui.join("index.html").exists() {
        let target = dir.join(EXTERNAL_UI_SUBDIR);
        let staging = dir.join(format!("{EXTERNAL_UI_SUBDIR}.installing"));
        let old = dir.join(format!("{EXTERNAL_UI_SUBDIR}.old"));
        let _ = std::fs::remove_dir_all(&staging);
        let _ = std::fs::remove_dir_all(&old);
        copy_tree(&bundled_ui, &staging).map_err(|err| format!("复制 UI 失败：{err}"))?;
        if target.exists() {
            std::fs::rename(&target, &old).map_err(|err| format!("暂存旧 UI 失败：{err}"))?;
        }
        std::fs::rename(&staging, &target).map_err(|err| format!("落位 UI 失败：{err}"))?;
        let _ = std::fs::remove_dir_all(&old);
    } else {
        crate::logging::log("[shell] 包内 UI 缺失：外置副本不含 UI（内核热更新将无法同包替换 UI）");
    }

    let state = ExternalKernelState {
        source_app_version: app_version.to_string(),
        source: "bundled".to_string(),
        installed_at: now_ms(),
        bundled_kernel: bundled.display().to_string(),
    };
    if let Ok(text) = serde_json::to_string_pretty(&state) {
        let _ = std::fs::write(dir.join(EXTERNAL_STATE_FILE), text);
    }
    crate::logging::log(&format!("[shell] 外置内核已投放：{}（App {app_version}）", exe.display()));
    Ok(())
}

/// 递归复制目录（std 没有现成的；ui 体积小，够用）。
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = to.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn set_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path).map_err(|err| format!("读取权限失败：{err}"))?.permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).map_err(|err| format!("设置可执行权限失败：{err}"))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

pub struct Sidecar {
    child: Mutex<Option<Child>>,
    link: Arc<Link>,
    restarts: AtomicU32,
    quitting: AtomicBool,
}

impl Sidecar {
    pub fn new(link: Arc<Link>) -> Self {
        Self {
            child: Mutex::new(None),
            link,
            restarts: AtomicU32::new(0),
            quitting: AtomicBool::new(false),
        }
    }

    pub fn start(&self, app: &AppHandle) -> Result<(), String> {
        let data_root = data_root(app);
        let builtin = builtin_plugins_dir(app);
        // 打包态：先落一份外置副本（热更新只动数据目录，不碰 .app 签名与 TCC 授权）；
        // 开发态：直接用本地构建产物（不然作者的重新 build 会被数据目录的旧副本挡住）。
        let (entry, ui_dist) = match locate_kernel(app)? {
            KernelLocation::Bundled(bundled) => {
                let (external, active) = ensure_external_kernel(app, &bundled);
                let external_ui = external.parent().map(|parent| parent.join(EXTERNAL_UI_SUBDIR));
                let ui = match (active, external_ui) {
                    (true, Some(ui)) if ui.join("index.html").exists() => ui,
                    _ => ui_dist_dir(app),
                };
                (external, ui)
            }
            KernelLocation::Direct(path) => (path, ui_dist_dir(app)),
        };

        // v2：内核本身就是可执行文件（Rust）—— 不再需要找用户的 Node、也不再拼解释器参数
        let mut command = Command::new(&entry);
        command
            .arg("--data-root")
            .arg(&data_root)
            .arg("--builtin-plugins")
            .arg(&builtin)
            .arg("--ui-dist")
            .arg(&ui_dist)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command
            .spawn()
            .map_err(|err| format!("无法启动内核（{}）：{err}", entry.display()))?;

        let stdin = child.stdin.take().ok_or("无法获取内核 stdin")?;
        let stdout = child.stdout.take().ok_or("无法获取内核 stdout")?;
        let stderr = child.stderr.take().ok_or("无法获取内核 stderr")?;

        self.link.attach(stdin, stdout, app.clone());

        // 内核日志 → 壳的日志文件（内核自己保证协议只走 stdout）
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    crate::logging::log(&line);
                }
            }
        });

        if let Ok(mut slot) = self.child.lock() {
            *slot = Some(child);
        }
        crate::logging::log(&format!("[shell] 内核已启动：{}", entry.display()));
        Ok(())
    }

    /// 等待内核就绪（拿到 UI 端口）。
    ///
    /// 两个必须处理的现实：
    ///  - 内核可能在 `listen()` 之前就收到询问 ⇒ 必须看 `ready` 标志，且端口 > 0 才算数；
    ///  - 字段名以 `uiPort` 为准（兼容旧的 `ui`），历史上这里不匹配导致热键永不注册。
    pub fn wait_ready(&self, timeout: Duration) -> Result<u16, String> {
        let started = std::time::Instant::now();
        let mut last = String::from("（无响应）");
        while started.elapsed() < timeout {
            match self.link.request("kernel/ready", serde_json::json!({}), Duration::from_millis(500)) {
                Ok(value) => {
                    let ready = value.get("ready").and_then(|v| v.as_bool()).unwrap_or(true);
                    let port = value
                        .get("uiPort")
                        .or_else(|| value.get("ui"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    if ready && port > 0 {
                        return Ok(port as u16);
                    }
                    last = format!("内核尚未就绪：{value}");
                }
                Err(err) => last = err,
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        Err(format!("内核启动超时（{last}）"))
    }

    /// 内核是否还活着；挂了就按策略重启（§6.2：不许白屏）
    pub fn supervise(self: &Arc<Self>, app: AppHandle) {
        let this = Arc::clone(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(2));
            if this.quitting.load(Ordering::SeqCst) {
                return;
            }
            let exited = {
                let mut guard = match this.child.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                match guard.as_mut() {
                    Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                    None => true,
                }
            };
            if !exited {
                continue;
            }
            this.link.detach();
            // 热更新重启：计划内行为 ⇒ 不计崩溃预算（否则连续几次热更新就撞上 MAX_RESTARTS）
            let hot_restart = HOT_RESTARTING.swap(false, Ordering::SeqCst);
            let count = this.restarts.fetch_add(1, Ordering::SeqCst) + 1;
            if hot_restart {
                this.restarts.store(0, Ordering::SeqCst);
            } else if count > MAX_RESTARTS {
                crate::logging::log(&format!("[shell] 内核连续退出 {count} 次，不再重启"));
                return;
            }
            let label = if hot_restart { "热更新".to_string() } else { format!("第 {count} 次") };
            crate::logging::log(&format!("[shell] 内核已退出，正在重启（{label}）"));
            if let Err(err) = this.start(&app) {
                crate::logging::log(&format!("[shell] 内核重启失败：{err}"));
                continue;
            }
            // 端口每次启动都变 ⇒ 重启后必须重新导航窗口（不导航 = UI 停在旧端口白屏）
            match this.wait_ready(Duration::from_secs(20)) {
                Ok(port) => {
                    crate::logging::log(&format!("[shell] 内核重启就绪：UI 端口 {port}"));
                    navigate_main_window(&app, port);
                }
                Err(err) => crate::logging::log(&format!("[shell] 内核重启后未就绪：{err}")),
            }
        });
    }

    /// 手动重载内核（错误面板 / 托盘菜单用）
    #[allow(dead_code)]
    pub fn restart(self: &Arc<Self>, app: &AppHandle) -> Result<(), String> {
        self.kill();
        self.restarts.store(0, Ordering::SeqCst);
        self.start(app)
    }

    pub fn kill(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            *guard = None;
        }
        self.link.detach();
    }

    pub fn shutdown(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        // 先好好说一声（内核会 flush 历史/配置），再兜底 kill
        let _ = self.link.request("app/shutdown", serde_json::json!({}), Duration::from_millis(800));
        std::thread::sleep(Duration::from_millis(120));
        self.kill();
    }
}

/// 数据目录名 = 应用名（2026-09-16 起从 `Launcher` 改成 `Chassis`）
pub const APP_DATA_DIR_NAME: &str = "Chassis";
/// 改名前的数据目录名 —— 只用于一次性接手（macOS：`Launcher` → `Chassis`），别再往这里写东西。
/// Windows 是 M6 全新发布，没有历史目录要接手，所以这条链路只在 macOS 编。
#[cfg(target_os = "macos")]
const LEGACY_DATA_DIR_NAME: &str = "Launcher";

pub fn data_root(app: &AppHandle) -> PathBuf {
    if let Ok(path) = std::env::var("LAUNCHER_DATA_ROOT") {
        return PathBuf::from(path);
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(APP_DATA_DIR_NAME);
        }
    }
    // Windows：`%APPDATA%\Chassis`。
    //
    // 刻意**不用** `app.path().app_data_dir()`：它按 bundle identifier 拼目录
    // （`%APPDATA%\app.launcher.desktop`），与内核 `paths.rs::default_data_root` 的
    // 「应用名」口径分叉 —— 结果就是「换个启动方式，历史全没了」。
    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join(APP_DATA_DIR_NAME);
        }
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// 应用名从 Launcher 改成 Chassis 时，把老数据目录一次性接手过来。
///
/// **只复制、不移动**：老目录原样留着，出问题随时能回退（自己动手、或把 `APP_DATA_DIR_NAME` 指回去）。
/// 只在「新目录不存在、老目录存在」时动手 ⇒ 重复启动是廉价 no-op；用户自己删掉老目录也不影响。
///
/// 调用必须排在 `logging::init` 之前：日志初始化会在数据目录里建 `logs/`，
/// 那会让「新目录已存在」成立 —— 迁移从此再也不跑，用户看到的是"历史全没了"。
/// 返回 `Some((老目录, 复制文件数))` 表示这次真的迁移过，供调用方落日志。
pub fn adopt_legacy_data_dir(current: &Path) -> Option<(PathBuf, usize)> {
    #[cfg(target_os = "macos")]
    {
        let legacy = current.parent()?.join(LEGACY_DATA_DIR_NAME);
        if current.exists() || !legacy.exists() {
            return None;
        }
        match copy_dir(&legacy, current) {
            Ok(count) => Some((legacy, count)),
            Err(err) => {
                eprintln!("[shell] 接手旧数据目录失败（将用空目录启动）：{err}");
                None
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = current;
        None
    }
}

/// 递归复制目录（std 没有现成的），返回复制成功的文件数。
/// 只服务 macOS 的一次性改名接手（Windows 无历史目录）。
#[cfg(target_os = "macos")]
fn copy_dir(from: &Path, to: &Path) -> std::io::Result<usize> {
    std::fs::create_dir_all(to)?;
    let mut count = 0;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = to.join(entry.file_name());
        if file_type.is_dir() {
            count += copy_dir(&entry.path(), &target)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &target)?;
            count += 1;
        }
        // 符号链接等其它类型直接跳过：数据目录里不该有，宁缺勿错
    }
    Ok(count)
}

fn builtin_plugins_dir(app: &AppHandle) -> PathBuf {
    if let Ok(path) = std::env::var("LAUNCHER_BUILTIN_PLUGINS") {
        return PathBuf::from(path);
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("builtin-plugins");
        if bundled.exists() {
            return bundled;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cursor: Option<&Path> = exe.parent();
        let mut hops = 0;
        while let Some(dir) = cursor {
            let candidate = dir.join("plugins");
            if candidate.exists() {
                // 开发态（从仓库里跑）：全部出厂插件都在 plugins/ 下
                return candidate;
            }
            cursor = dir.parent();
            hops += 1;
            if hops > 6 {
                break;
            }
        }
    }
    PathBuf::from("plugins")
}

fn ui_dist_dir(app: &AppHandle) -> PathBuf {
    if let Ok(path) = std::env::var("LAUNCHER_UI_DIST") {
        return PathBuf::from(path);
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("ui");
        if bundled.exists() {
            return bundled;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cursor: Option<&Path> = exe.parent();
        let mut hops = 0;
        while let Some(dir) = cursor {
            let candidate = dir.join("apps").join("launcher-ui").join("dist");
            if candidate.exists() {
                return candidate;
            }
            cursor = dir.parent();
            hops += 1;
            if hops > 6 {
                break;
            }
        }
    }
    PathBuf::from("apps/launcher-ui/dist")
}
