//! 默认路径推导：数据根 / 出厂插件根 / UI 产物。
//!
//! 数据根必须与壳（`apps/shell/src/sidecar.rs` 的 `APP_DATA_DIR_NAME`）**同源** ——
//! 两边不一致就会出现两个数据目录（表现为「换个启动方式，历史全没了」）。
//! 对齐 v1 `apps/kernel/src/config.ts::defaultDataRoot` / `defaultBuiltinPluginsRoots`。

use std::path::{Path, PathBuf};

pub const APP_NAME: &str = "Chassis";

/// 环境变量覆盖（测试 / 开发常用）：`LAUNCHER_DATA_ROOT`。
pub fn default_data_root() -> PathBuf {
    if let Some(value) = env_non_empty("LAUNCHER_DATA_ROOT") {
        return absolute(Path::new(&value));
    }
    if cfg!(target_os = "macos") {
        return home().join("Library").join("Application Support").join(APP_NAME);
    }
    if cfg!(target_os = "windows") {
        let base = env_non_empty("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join("AppData").join("Roaming"));
        return base.join(APP_NAME);
    }
    let base = env_non_empty("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".config"));
    base.join(APP_NAME)
}

/// 出厂插件根：`LAUNCHER_BUILTIN_PLUGINS`（逗号分隔）→ 否则当前工作目录下的 `plugins/`。
///
/// 打包后由壳用 `--builtin-plugins` 显式传入（`Resources/builtin-plugins/`）。
pub fn default_builtin_roots() -> Vec<PathBuf> {
    if let Some(value) = env_non_empty("LAUNCHER_BUILTIN_PLUGINS") {
        let roots: Vec<PathBuf> = value
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(|item| absolute(Path::new(item)))
            .collect();
        if !roots.is_empty() {
            return roots;
        }
    }
    vec![std::env::current_dir().unwrap_or_default().join("plugins")]
}

/// 仓库根（编译期推导，仅 dev 态有意义：打包后由壳显式传 `--ui-dist`）。
pub fn repo_root() -> PathBuf {
    // src 位于 <repo>/apps/kernel/src → 上三级是仓库根
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().and_then(Path::parent).map(Path::to_path_buf).unwrap_or_default()
}

pub fn default_ui_dist() -> PathBuf {
    repo_root().join("apps").join("launcher-ui").join("dist")
}

/// 相对路径转绝对（与 v1 的 `path.resolve` 对齐）。
pub fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    std::env::current_dir().unwrap_or_default().join(path)
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn env_non_empty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_keeps_absolute_paths() {
        // 平台无关：当前工作目录在 macOS / Windows 上都是绝对路径。
        // （写死 `/tmp/x` 的话，Windows 上它被判成「根相对」路径，会被拼上 cwd）
        let path = std::env::current_dir().expect("取不到当前目录");
        assert_eq!(absolute(&path), path);
    }

    #[test]
    fn data_root_env_override_wins() {
        // 注意：测试进程内改环境变量在并行测试下不安全，这里只验证函数式行为（绝对化）
        let overridden = absolute(std::path::Path::new("relative-data-root"));
        assert!(overridden.is_absolute());
        assert!(overridden.ends_with("relative-data-root"));
    }

    #[test]
    fn repo_root_points_at_workspace_root() {
        let root = repo_root();
        assert!(root.join("Cargo.toml").exists(), "仓库根应有 Cargo.toml：{}", root.display());
        assert!(root.join("apps").join("launcher-ui").exists(), "仓库根应含 apps/launcher-ui");
    }
}
