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
        let node = node_binary();
        let data_root = data_root(app);
        let builtin = builtin_plugins_dir(app);
        let ui_dist = ui_dist_dir(app);

        let mut command = Command::new(&node);
        command
            .arg(&entry)
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
            .map_err(|err| format!("无法启动内核（{}）：{err}", node.display()))?;

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
        crate::logging::log(&format!("[shell] 内核已启动：{}（node {}）", entry.display(), node.display()));
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

    // 打包后：<resource_dir>/kernel/kernel.mjs
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("kernel").join("kernel.mjs");
        if bundled.exists() {
            return Ok(bundled);
        }
        let bundled_alt = resource_dir.join("resources").join("kernel").join("kernel.mjs");
        if bundled_alt.exists() {
            return Ok(bundled_alt);
        }
    }

    // 开发态：从可执行文件往上找 apps/kernel/dist/kernel.mjs
    if let Ok(exe) = std::env::current_exe() {
        let mut cursor: Option<&Path> = exe.parent();
        let mut hops = 0;
        while let Some(dir) = cursor {
            let candidate = dir.join("apps").join("kernel").join("dist").join("kernel.mjs");
            if candidate.exists() {
                return Ok(candidate);
            }
            cursor = dir.parent();
            hops += 1;
            if hops > 6 {
                break;
            }
        }
    }

    // 再兜底：当前工作目录
    let cwd_candidate = PathBuf::from("apps/kernel/dist/kernel.mjs");
    if cwd_candidate.exists() {
        return Ok(cwd_candidate);
    }

    Err("找不到内核入口（先执行 npm run build:kernel，或设置 LAUNCHER_KERNEL_ENTRY）".to_string())
}

/// 找 Node：GUI 启动时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
/// 所以必须显式搜索 homebrew / nvm / fnm / volta / asdf 等常见位置。
fn node_binary() -> PathBuf {
    if let Ok(path) = std::env::var("LAUNCHER_NODE") {
        let explicit = PathBuf::from(&path);
        if explicit.exists() {
            return explicit;
        }
    }

    for candidate in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        "/opt/local/bin/node",
    ] {
        let path = PathBuf::from(candidate);
        if path.exists() {
            return path;
        }
    }

    let home = std::env::var_os("HOME").map(PathBuf::from);

    // nvm / fnm：按版本号排序取最新
    if let Some(home) = home.as_ref() {
        for (dir, suffix) in [
            (home.join(".nvm/versions/node"), "bin/node"),
            (home.join(".local/share/fnm/node-versions"), "installation/bin/node"),
        ] {
            if let Some(path) = newest_node_under(&dir, suffix) {
                return path;
            }
        }
        for candidate in [
            home.join(".volta/bin/node"),
            home.join(".asdf/shims/node"),
            home.join(".local/bin/node"),
        ] {
            if candidate.exists() {
                return candidate;
            }
        }
    }

    PathBuf::from("node")
}

/// 在形如 `~/.nvm/versions/node/v22.1.0/bin/node` 的目录里取版本号最大的那个
fn newest_node_under(dir: &Path, suffix: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut versions: Vec<(Vec<u64>, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let candidate = entry.path().join(suffix);
        if !candidate.exists() {
            continue;
        }
        let numbers: Vec<u64> = name
            .trim_start_matches('v')
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect();
        versions.push((numbers, candidate));
    }
    versions.sort_by(|a, b| a.0.cmp(&b.0));
    versions.pop().map(|(_, path)| path)
}

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
                .join("Launcher");
        }
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
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
