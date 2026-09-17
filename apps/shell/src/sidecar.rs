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
        let entry = kernel_entry(app)?;
        let data_root = data_root(app);
        let builtin = builtin_plugins_dir(app);
        let ui_dist = ui_dist_dir(app);

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
            let count = this.restarts.fetch_add(1, Ordering::SeqCst) + 1;
            if count > MAX_RESTARTS {
                crate::logging::log(&format!("[shell] 内核连续退出 {count} 次，不再重启"));
                return;
            }
            crate::logging::log(&format!("[shell] 内核已退出，正在重启（第 {count} 次）"));
            if let Err(err) = this.start(&app) {
                crate::logging::log(&format!("[shell] 内核重启失败：{err}"));
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

fn kernel_entry(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("LAUNCHER_KERNEL_ENTRY") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!("LAUNCHER_KERNEL_ENTRY 指向的文件不存在：{}", path.display()));
    }

    let exe_name = if cfg!(target_os = "windows") { "launcher-kernel.exe" } else { "launcher-kernel" };

    // 打包后：<resource_dir>/kernel/launcher-kernel
    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in [
            resource_dir.join("kernel").join(exe_name),
            resource_dir.join("resources").join("kernel").join(exe_name),
        ] {
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    // 开发态：从可执行文件往上找 target/{release,debug}/launcher-kernel
    if let Ok(exe) = std::env::current_exe() {
        let mut cursor: Option<&Path> = exe.parent();
        let mut hops = 0;
        while let Some(dir) = cursor {
            for profile in ["release", "debug"] {
                let candidate = dir.join("target").join(profile).join(exe_name);
                if candidate.exists() {
                    return Ok(candidate);
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

/// 数据目录名 = 应用名（2026-09-16 起从 `Launcher` 改成 `Chassis`）
pub const APP_DATA_DIR_NAME: &str = "Chassis";
/// 改名前的数据目录名 —— 只用于一次性接手，别再往这里写东西
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

/// 递归复制目录（std 没有现成的），返回复制成功的文件数
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
