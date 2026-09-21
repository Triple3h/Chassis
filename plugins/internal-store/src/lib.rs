//! `internal-store` 的**纯逻辑**（跨平台可单测）：索引解析 / 版本比较 / 按平台挑产物 / 哈希校验。
//!
//! 网络与文件 IO 在 `bin/update.rs`（唯一的可执行产物，plugin-spec §2.2 的 N1）。
//! 索引格式见 `docs/plugin-spec.md` 附录「更新源（registry.json）」。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use semver::Version;
use serde::{Deserialize, Serialize};

/// 更新源：编译期常量。**固定 tag**（`plugins-latest`）而不是 `releases/latest` ——
/// 后者会被 App 的 `v*` Release 抢走，插件索引就 404 了。
pub const REGISTRY_URL: &str =
    "https://github.com/triple3h/Chassis/releases/download/plugins-latest/registry.json";

/// 仓库占位（公开仓库地址确定后只改这一处 + CI 的 `--repo`）。
pub const REPO: &str = "triple3h/Chassis";
pub const RELEASE_TAG: &str = "plugins-latest";

/// 内核更新源：**独立固定 tag**（与 App 的 `v*`、插件的 `plugins-latest` 三方互不干扰）。
pub const KERNEL_REGISTRY_URL: &str =
    "https://github.com/triple3h/Chassis/releases/download/kernel-latest/kernel-registry.json";
pub const KERNEL_RELEASE_TAG: &str = "kernel-latest";

/// 索引 schema：未知版本**拒绝**（不猜测，避免按错的结构读出坏的下载地址）。
pub const REGISTRY_SCHEMA: u64 = 1;

/// 主源基址（索引里的每个资产 URL 都以它开头）。
pub const PRIMARY_BASE: &str = "https://github.com/triple3h/Chassis";

/// 国内镜像基址（Gitee 同名仓库 / 同名 tag / 同名文件名，由 CI 的 `scripts/sync-release-to-gitee.mjs` 同步）。
/// 客户端**优先走镜像**，拿不到（连不上 / HTTP 错 / sha256 不符）再降级主源 —— 见 `bin/update.rs`。
pub const MIRROR_BASE: &str = "https://gitee.com/triple3h/Chassis";

/// GitHub 加速代理：把主源 URL 原样拼在代理域名后面（`https://<代理>/https://github.com/...`）。
///
/// **只给附件用，索引绝不走代理**。索引是信任根 —— 它决定「下载什么、校验值是多少」；
/// 一旦它能被第三方改写，攻击者就能把 url 指向白名单内的任意仓库（GitHub / Gitee 都免费可建）、
/// 再配上自己算的 sha256，sha256 校验就形同虚设了。
/// 附件则反过来：sha256 来自**可信通道的索引**，代理改一个字节都会被拒 ⇒
/// 「不可信的加速通道 + 可信的哈希」才是安全的组合（`bin/update.rs::asset_candidates`）。
///
/// 为什么值得：Gitee 镜像要靠跨境同步（CI 常失败、要本机补），而这几个代理即时可用。
/// 实测（2026-09-21 国内网络，下 16MB 应用包）：ghfast.top 3.27MB/s（8 秒下完）、gh-proxy.com 309KB/s。
/// 前者主力、后者备份，都不可用还有 Gitee 镜像与 GitHub 主源兜底。
pub const PROXY_BASES: [&str; 2] = ["https://ghfast.top", "https://gh-proxy.com"];

/// 主源 URL 的后半段（`/releases/download/...`）；不是主源 URL（含将来可能出现的其它域）返回 `None`。
/// 大小写不敏感：索引由 CI 用 `GITHUB_REPOSITORY` 拼出，owner 是 `Triple3h`，与这里的 `triple3h` 不同。
fn primary_suffix(url: &str) -> Option<&str> {
    let prefix = PRIMARY_BASE.to_lowercase();
    if !url.to_lowercase().starts_with(&prefix) {
        return None;
    }
    // prefix 全是 ASCII ⇒ 前 prefix.len() 字节必然是字符边界
    Some(&url[prefix.len()..])
}

/// 把主源 URL 换成镜像 URL（非主源 URL 返回 `None`）。
pub fn mirror_url(url: &str) -> Option<String> {
    Some(format!("{MIRROR_BASE}{}", primary_suffix(url)?))
}

/// 主源 URL → 各加速代理的候选（非主源 URL 返回空：索引里的其它域不该被拼到代理后面）。
pub fn proxy_urls(url: &str) -> Vec<String> {
    if primary_suffix(url).is_none() {
        return Vec::new();
    }
    PROXY_BASES.iter().map(|base| format!("{base}/{url}")).collect()
}

/// 下载大小上限：内核侧 zip 解压上限是 200MB / 单文件 50MB，这里卡在 60MB。
pub const MAX_DOWNLOAD_BYTES: u64 = 60 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub schema: u64,
    #[serde(default)]
    pub generated_at: Option<String>,
    #[serde(default)]
    pub plugins: HashMap<String, RegistryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub title: String,
    pub version: String,
    #[serde(default)]
    pub api_version: Option<String>,
    #[serde(default)]
    pub min_kernel: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub assets: Vec<RegistryAsset>,
}

/// 一个平台一份产物：逻辑层是原生产物（Rust 可执行文件），不可能跨平台共用。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryAsset {
    /// 省略 / 空数组 = 不限制（与 plugin-spec §3.5 的 `platforms` 同义）
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub arch: Vec<String>,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledPlugin {
    pub id: String,
    pub version: String,
}

/// 一个已装插件的**当前状态**（不只是有更新的那些）：界面默认列出全部当前版本，
/// 有更新的靠 `has_update` 高亮。产物地址不在这里 —— 下载是 `download` 模式自己重新拉索引
/// （安装路径不接受 URL 入参，这条口径不能在返回结构里开口子）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginState {
    pub id: String,
    pub title: String,
    pub current: String,
    pub latest: String,
    pub notes: Option<String>,
    /// 索引里版本更新**且本平台有产物**（装不上就不算可更新）
    pub has_update: bool,
    pub min_kernel_ok: bool,
}

pub fn parse_registry(raw: &str) -> std::result::Result<Registry, String> {
    let registry: Registry = serde_json::from_str(raw).map_err(|err| format!("registry.json 无法解析：{err}"))?;
    if registry.schema != REGISTRY_SCHEMA {
        return Err(format!(
            "registry.json 的 schema 不受支持：{}（本客户端只认 {REGISTRY_SCHEMA}）",
            registry.schema
        ));
    }
    Ok(registry)
}

/// 挑出适配当前平台的产物（第一个命中的）。
pub fn pick_asset<'a>(entry: &'a RegistryEntry, platform: &str, arch: &str) -> Option<&'a RegistryAsset> {
    entry.assets.iter().find(|asset| matches(&asset.platforms, platform) && matches(&asset.arch, arch))
}

fn matches(declared: &[String], current: &str) -> bool {
    declared.is_empty() || declared.iter().any(|item| item == current)
}

/// semver 严格比较：解析不出（非 semver 的版本号）⇒ 不提示更新（宁可漏，不可乱装）。
pub fn is_newer(latest: &str, current: &str) -> bool {
    let (Ok(latest), Ok(current)) = (Version::parse(latest), Version::parse(current)) else {
        return false;
    };
    latest > current
}

/// `minKernel` 判定：拿不到内核版本 / 版本号非 semver ⇒ 放行（只是少一道保护，不该让用户装不了）。
pub fn kernel_satisfied(min_kernel: Option<&str>, kernel: Option<&str>) -> bool {
    let Some(min) = min_kernel else {
        return true;
    };
    let Some(kernel) = kernel else {
        return true;
    };
    let (Ok(min), Ok(kernel)) = (Version::parse(min), Version::parse(kernel)) else {
        return true;
    };
    kernel >= min
}

/// 只认「已装 ∩ 索引里有」的 id（索引里查不到的跳过 —— **不猜**；essential 的过滤在调用方做）。
/// 顺序 = 有更新的在前，其余按 id（界面直接照此渲染）。
pub fn collect_plugins(
    registry: &Registry,
    installed: &[InstalledPlugin],
    platform: &str,
    arch: &str,
    kernel: Option<&str>,
) -> Vec<PluginState> {
    let mut states: Vec<PluginState> = Vec::new();
    for plugin in installed {
        let Some(entry) = registry.plugins.get(&plugin.id) else {
            continue;
        };
        let has_update = is_newer(&entry.version, &plugin.version) && pick_asset(entry, platform, arch).is_some();
        states.push(PluginState {
            id: plugin.id.clone(),
            title: entry.title.clone(),
            current: plugin.version.clone(),
            latest: entry.version.clone(),
            notes: entry.notes.clone(),
            has_update,
            min_kernel_ok: kernel_satisfied(entry.min_kernel.as_deref(), kernel),
        });
    }
    states.sort_by(|a, b| b.has_update.cmp(&a.has_update).then_with(|| a.id.cmp(&b.id)));
    states
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(bytes);
    digest.iter().fold(String::with_capacity(64), |mut acc, byte| {
        use std::fmt::Write;
        let _ = write!(&mut acc, "{byte:02x}");
        acc
    })
}

pub fn download_name(id: &str, version: &str, platform: &str, arch: &str) -> String {
    format!("{id}-{version}-{platform}-{arch}.zip")
}

// ── 内核热更新（kernel-latest 索引 + 更新包）─────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelRegistry {
    pub schema: u64,
    #[serde(default)]
    pub generated_at: Option<String>,
    pub kernel: KernelEntry,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelEntry {
    pub version: String,
    /// 产物对应的热更新机制版本（诊断展示）
    #[serde(default)]
    pub hot_version: Option<String>,
    /// 客户端热更新机制低于此值 ⇒ 提示但不给「更新」按钮
    #[serde(default)]
    pub min_hot_version: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub assets: Vec<RegistryAsset>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelUpdate {
    pub current: String,
    pub latest: String,
    pub notes: Option<String>,
    pub hot_version: Option<String>,
    pub min_hot_version: Option<String>,
    /// 客户端机制版本是否满足（不满足 ⇒ 界面不给「更新」，别装出一个装不上的包）
    pub hot_ok: bool,
    pub asset: RegistryAsset,
}

/// 内核更新包解压后的落点（binary = 要交给 `/api/hot/binary` 的路径）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KernelBundle {
    pub binary: PathBuf,
    pub ui: PathBuf,
}

pub fn parse_kernel_registry(raw: &str) -> std::result::Result<KernelRegistry, String> {
    let registry: KernelRegistry =
        serde_json::from_str(raw).map_err(|err| format!("kernel-registry.json 无法解析：{err}"))?;
    if registry.schema != REGISTRY_SCHEMA {
        return Err(format!(
            "kernel-registry.json 的 schema 不受支持：{}（本客户端只认 {REGISTRY_SCHEMA}）",
            registry.schema
        ));
    }
    Ok(registry)
}

/// 挑出适配当前平台的内核产物。
pub fn pick_kernel_asset<'a>(entry: &'a KernelEntry, platform: &str, arch: &str) -> Option<&'a RegistryAsset> {
    entry.assets.iter().find(|asset| matches(&asset.platforms, platform) && matches(&asset.arch, arch))
}

/// 判断「有没有内核可更新」；没有则返回 `None`（同插件口径：非 semver / 版本不新都不提示）。
pub fn collect_kernel_update(
    registry: &KernelRegistry,
    current: &str,
    platform: &str,
    arch: &str,
    hot_version: Option<&str>,
) -> Option<KernelUpdate> {
    let entry = &registry.kernel;
    if !is_newer(&entry.version, current) {
        return None;
    }
    let asset = pick_kernel_asset(entry, platform, arch)?;
    Some(KernelUpdate {
        current: current.to_string(),
        latest: entry.version.clone(),
        notes: entry.notes.clone(),
        hot_version: entry.hot_version.clone(),
        min_hot_version: entry.min_hot_version.clone(),
        hot_ok: hot_satisfied(entry.min_hot_version.as_deref(), hot_version),
        asset: asset.clone(),
    })
}

/// `minHotVersion` 判定：拿不到客户端机制版本 / 非 semver ⇒ 放行（同 `kernel_satisfied` 的口径）。
pub fn hot_satisfied(min_hot: Option<&str>, client: Option<&str>) -> bool {
    let (Some(min), Some(client)) = (min_hot, client) else {
        return true;
    };
    let (Ok(min), Ok(client)) = (Version::parse(min), Version::parse(client)) else {
        return true;
    };
    client >= min
}

pub fn kernel_exe_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "launcher-kernel.exe"
    } else {
        "launcher-kernel"
    }
}

/// 解压 zip 到目录：**防路径穿越**（`enclosed_name`）+ **恢复 unix 权限位**
/// （zip 记了权限，不恢复则二进制起不来）。内核包与应用包共用这一段。
fn extract_zip(zip_path: &Path, target_dir: &Path) -> std::result::Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|err| format!("无法打开更新包：{err}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|err| format!("更新包不是合法 zip：{err}"))?;
    // 目标目录先清干净：混入上一次的半成品会被结构校验放过去
    let _ = std::fs::remove_dir_all(target_dir);
    std::fs::create_dir_all(target_dir).map_err(|err| format!("无法创建解压目录：{err}"))?;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|err| format!("读取更新包条目失败：{err}"))?;
        let Some(relative) = entry.enclosed_name() else {
            return Err(format!("更新包里有非法路径（路径穿越）：{}", entry.name()));
        };
        let out = target_dir.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|err| format!("创建目录失败：{err}"))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|err| format!("创建目录失败：{err}"))?;
        }
        let mut output = std::fs::File::create(&out).map_err(|err| format!("写入失败：{err}"))?;
        std::io::copy(&mut entry, &mut output).map_err(|err| format!("解压失败：{err}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode));
            }
        }
    }
    Ok(())
}

/// 解压内核更新包（结构 = `launcher-kernel(.exe)` + `ui/`）：解压 + 结构校验
/// （缺二进制 / 缺 `ui/index.html` 直接拒绝 —— 装上去只会得到「内核起不来」）。
pub fn unzip_kernel_bundle(zip_path: &Path, target_dir: &Path) -> std::result::Result<KernelBundle, String> {
    extract_zip(zip_path, target_dir)?;
    let binary = target_dir.join(kernel_exe_name());
    if !binary.exists() {
        return Err(format!("更新包里没有 {}（结构应为 launcher-kernel + ui/）", kernel_exe_name()));
    }
    let ui = target_dir.join("ui");
    if !ui.join("index.html").exists() {
        return Err("更新包里缺少 ui/index.html（内核与 UI 必须同包）".to_string());
    }
    Ok(KernelBundle { binary, ui })
}

// ── 应用（壳）自更新（app-latest 索引 + 整包替换）─────────────────

/// 应用更新源：**独立固定 tag**。App 的 `v*` 是「给人下载的换包通道」，
/// 这里是**给客户端内置源用的自更新通道** —— 两者互不顶替（与内核 / 插件三方独立）。
pub const APP_REGISTRY_URL: &str =
    "https://github.com/triple3h/Chassis/releases/download/app-latest/app-registry.json";
pub const APP_RELEASE_TAG: &str = "app-latest";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRegistry {
    pub schema: u64,
    #[serde(default)]
    pub generated_at: Option<String>,
    pub app: AppEntry,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    pub version: String,
    /// 产物对应的壳自更新机制版本（诊断展示）
    #[serde(default)]
    pub shell_hot_version: Option<String>,
    /// 客户端壳自更新机制低于此值 ⇒ 提示但不给「更新」按钮
    #[serde(default)]
    pub min_shell_hot_version: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub assets: Vec<RegistryAsset>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdate {
    pub current: String,
    pub latest: String,
    pub notes: Option<String>,
    pub shell_hot_version: Option<String>,
    pub min_shell_hot_version: Option<String>,
    /// 客户端壳自更新机制是否满足（不满足 ⇒ 界面不给「更新」，别装出一个换不上的包）
    pub hot_ok: bool,
    pub asset: RegistryAsset,
}

/// 应用更新包解压后的落点（`app` = 候选安装目录，交给壳的 `shell.applyUpdate`：
/// macOS 是 `Chassis.app`，Windows 是绿色版目录）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppBundle {
    pub app: PathBuf,
}

pub fn parse_app_registry(raw: &str) -> std::result::Result<AppRegistry, String> {
    let registry: AppRegistry = serde_json::from_str(raw).map_err(|err| format!("app-registry.json 无法解析：{err}"))?;
    if registry.schema != REGISTRY_SCHEMA {
        return Err(format!(
            "app-registry.json 的 schema 不受支持：{}（本客户端只认 {REGISTRY_SCHEMA}）",
            registry.schema
        ));
    }
    Ok(registry)
}

/// 挑出适配当前平台的应用产物（第一个命中的）。
pub fn pick_app_asset<'a>(entry: &'a AppEntry, platform: &str, arch: &str) -> Option<&'a RegistryAsset> {
    entry.assets.iter().find(|asset| matches(&asset.platforms, platform) && matches(&asset.arch, arch))
}

/// 「有没有应用可更新」：口径与内核 / 插件通道一致（非 semver / 版本不新 ⇒ `None`）。
///
/// 两个平台都有产物（macOS `.app` zip / Windows 绿色版 zip），按 `platforms` 挑；
/// 「能不能装」由壳回答（`app.info.canSelfUpdate` = 打包态 + 安装位置可写）——
/// Windows 上壳会把替换交给独立 helper（`swap.ps1`），见 `apps/shell/src/update.rs`。
pub fn collect_app_update(
    registry: &AppRegistry,
    current: &str,
    platform: &str,
    arch: &str,
    shell_hot: Option<&str>,
) -> Option<AppUpdate> {
    let entry = &registry.app;
    if !is_newer(&entry.version, current) {
        return None;
    }
    let asset = pick_app_asset(entry, platform, arch)?;
    Some(AppUpdate {
        current: current.to_string(),
        latest: entry.version.clone(),
        notes: entry.notes.clone(),
        shell_hot_version: entry.shell_hot_version.clone(),
        min_shell_hot_version: entry.min_shell_hot_version.clone(),
        hot_ok: hot_satisfied(entry.min_shell_hot_version.as_deref(), shell_hot),
        asset: asset.clone(),
    })
}

/// 解压应用更新包并做**通用结构**校验，返回交给壳的候选目录。
///
/// 两种结构都接受（**选哪个由壳按平台判定**，这里只保证解压结果不是垃圾）：
///  - macOS：最外层一个 `X.app`（要 `Contents/MacOS/launcher-shell` + `Info.plist`）；
///  - Windows：绿色版目录（要 `Chassis.exe`，`resources/` 随包）。
///
/// 这里只做**结构与存在性**校验：候选包「能不能跑」由壳侧的 `--hot-probe` 自检回答
/// （见 `apps/shell/src/update.rs`），那是唯一的权威判据。
pub fn unzip_app_bundle(zip_path: &Path, target_dir: &Path) -> std::result::Result<AppBundle, String> {
    extract_zip(zip_path, target_dir)?;
    if let Some(app) = find_app_dir(target_dir)? {
        let binary = app.join("Contents").join("MacOS").join("launcher-shell");
        if !binary.exists() {
            return Err(format!(
                "更新包里没有 Contents/MacOS/launcher-shell（结构应为 Chassis.app/Contents/…）：{}",
                app.display()
            ));
        }
        if !app.join("Contents").join("Info.plist").exists() {
            return Err("更新包里缺少 Contents/Info.plist（不是完整的 .app）".to_string());
        }
        return Ok(AppBundle { app });
    }
    // Windows 绿色版：zip 根就是应用目录（`Chassis.exe` + `resources/`，与 pack-win.mjs 同源）
    if target_dir.join("Chassis.exe").exists() {
        return Ok(AppBundle { app: target_dir.to_path_buf() });
    }
    Err("更新包里既没有 .app 也没有 Chassis.exe（结构应为 Chassis.app/Contents/… 或绿色版目录）".to_string())
}

/// 在解压结果里找唯一一个 `.app`（`ditto --keepParent` 出来的结构 = 最外层一个 `X.app/`）；
/// 没有 `.app` ⇒ `None`（可能是 Windows 绿色版结构，交给调用方判断）。
fn find_app_dir(root: &Path) -> std::result::Result<Option<PathBuf>, String> {
    let mut found: Option<PathBuf> = None;
    for entry in std::fs::read_dir(root).map_err(|err| format!("读取解压目录失败：{err}"))?.flatten() {
        let path = entry.path();
        if path.is_dir() && path.extension().map(|ext| ext == "app").unwrap_or(false) {
            if found.is_some() {
                return Err("更新包里不止一个 .app（结构应为 Chassis.app/）".to_string());
            }
            found = Some(path);
        }
    }
    Ok(found)
}

pub fn current_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

pub fn current_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}

/// 传输面白名单：更新源是固定仓库（主源 GitHub / 国内镜像 Gitee）与其加速代理，
/// 附件会 302 到各自的 CDN。
/// 命令**不接受 URL 入参**，这条只是最后一道兜底（防止索引被换成别的域）。
pub fn is_allowed_host(url: &str) -> bool {
    let Some(host) = host_of(url) else {
        return false;
    };
    host == "github.com"
        || host.ends_with(".github.com")
        || host.ends_with(".githubusercontent.com")
        || host == "gitee.com"
        || host.ends_with(".gitee.com")
        // 加速代理（只用于附件下载；索引不走它们 —— 见 `PROXY_BASES`）。
        // **精确匹配**：绝不写成「`.top` 结尾」那种 —— 那是把整个 TLD 放进来当更新源。
        || PROXY_BASES.iter().any(|base| host_of(base).as_deref() == Some(host.as_str()))
}

pub fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split('/').next()?;
    // 去掉可能的 userinfo 与端口
    let host = authority.rsplit('@').next()?.split(':').next()?;
    Some(host.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry_raw(schema: u64) -> String {
        format!(
            r#"{{
  "schema": {schema},
  "generatedAt": "2026-09-18T00:00:00Z",
  "plugins": {{
    "totp": {{
      "title": "双重验证器",
      "version": "0.5.0",
      "apiVersion": "2",
      "notes": "修复倒计时漂移",
      "assets": [
        {{ "platforms": ["macos"], "arch": ["arm64"], "url": "https://github.com/o/r/releases/download/plugins-latest/totp-0.5.0-macos-arm64.zip", "sha256": "aa", "bytes": 1 }},
        {{ "platforms": ["windows"], "arch": ["x64"], "url": "https://github.com/o/r/releases/download/plugins-latest/totp-0.5.0-windows-x64.zip", "sha256": "bb", "bytes": 2 }}
      ]
    }},
    "snips": {{
      "title": "代码片段",
      "version": "0.2.0",
      "assets": [{{ "url": "https://github.com/o/r/releases/download/plugins-latest/snips-0.2.0.zip", "sha256": "cc", "bytes": 3 }}]
    }}
  }}
}}"#
        )
    }

    #[test]
    fn unknown_schema_is_rejected() {
        let err = parse_registry(&registry_raw(2)).unwrap_err();
        assert!(err.contains("schema"), "未知 schema 必须拒绝：{err}");
        assert!(parse_registry(&registry_raw(1)).is_ok());
        assert!(parse_registry("{ 不是 json").is_err());
    }

    #[test]
    fn semver_comparison_decides_updates() {
        assert!(is_newer("0.5.0", "0.4.0"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("0.4.0", "0.5.0"), "索引更旧 ⇒ 不提示");
        assert!(!is_newer("0.5.0", "0.5.0"), "同版本 ⇒ 不提示");
        assert!(!is_newer("nightly", "0.5.0"), "非 semver ⇒ 不提示");
        assert!(!is_newer("0.5.0", "nightly"));
    }

    #[test]
    fn asset_is_picked_by_platform_and_arch() {
        let registry = parse_registry(&registry_raw(1)).unwrap();
        let totp = registry.plugins.get("totp").unwrap();
        let mac = pick_asset(totp, "macos", "arm64").unwrap();
        assert!(mac.url.ends_with("macos-arm64.zip"));
        let win = pick_asset(totp, "windows", "x64").unwrap();
        assert!(win.url.ends_with("windows-x64.zip"));
        assert!(pick_asset(totp, "linux", "x64").is_none(), "没有该平台的产物 ⇒ 不给更新");
        assert!(pick_asset(totp, "macos", "x64").is_none(), "架构不符 ⇒ 不给更新");
        // 未声明平台 / 架构 = 不限制
        let snips = registry.plugins.get("snips").unwrap();
        assert!(pick_asset(snips, "linux", "arm64").is_some());
    }

    #[test]
    fn plugin_states_cover_all_installed_in_registry() {
        let registry = parse_registry(&registry_raw(1)).unwrap();
        let installed = vec![
            InstalledPlugin { id: "totp".to_string(), version: "0.4.0".to_string() },
            InstalledPlugin { id: "snips".to_string(), version: "0.2.0".to_string() },
            InstalledPlugin { id: "not-in-registry".to_string(), version: "0.1.0".to_string() },
        ];
        let states = collect_plugins(&registry, &installed, "macos", "arm64", Some("0.1.0"));
        assert_eq!(states.len(), 2, "全量展示：索引里查得到就列出（不分有没有更新）：{states:?}");
        assert_eq!(states[0].id, "totp", "有更新的排前面");
        assert!(states[0].has_update);
        assert_eq!(states[0].current, "0.4.0");
        assert_eq!(states[0].latest, "0.5.0");
        assert_eq!(states[0].notes.as_deref(), Some("修复倒计时漂移"));
        assert!(states[0].min_kernel_ok);
        assert_eq!(states[1].id, "snips");
        assert!(!states[1].has_update, "版本相同 ⇒ 只展示当前版本，不给更新");
        assert!(!states.iter().any(|item| item.id == "not-in-registry"), "索引里没有的跳过（不猜）");
    }

    /// 「索引里有新版本、但本平台没有产物」⇒ 不可更新（宁可漏，不可乱装）。
    #[test]
    fn no_asset_for_platform_means_not_updatable() {
        let registry = parse_registry(&registry_raw(1)).unwrap();
        let installed = vec![InstalledPlugin { id: "totp".to_string(), version: "0.4.0".to_string() }];
        let states = collect_plugins(&registry, &installed, "linux", "x64", Some("0.1.0"));
        assert_eq!(states.len(), 1, "仍然列出当前版本");
        assert!(!states[0].has_update, "没有本平台产物 ⇒ 不给「更新」按钮");
    }

    #[test]
    fn min_kernel_gates_updates() {
        let mut registry = parse_registry(&registry_raw(1)).unwrap();
        registry.plugins.get_mut("totp").unwrap().min_kernel = Some("9.9.9".to_string());
        let installed = vec![InstalledPlugin { id: "totp".to_string(), version: "0.4.0".to_string() }];
        let states = collect_plugins(&registry, &installed, "macos", "arm64", Some("0.1.0"));
        assert_eq!(states.len(), 1, "仍然列出，但标记 minKernelOk=false");
        assert!(states[0].has_update);
        assert!(!states[0].min_kernel_ok, "内核版本不够 ⇒ 不给「更新」按钮");

        // 拿不到内核版本时放行
        let states = collect_plugins(&registry, &installed, "macos", "arm64", None);
        assert!(states[0].min_kernel_ok);
    }

    #[test]
    fn plugin_state_serializes_camel_case() {
        // view 读的是 `minKernelOk` / `hasUpdate`；曾因漏 rename_all 序列化成 `min_kernel_ok`，
        // 更新页把每个插件条目都判成「底座版本过低」（插件通道首次真实使用才暴露）
        let state = PluginState {
            id: "json-tools".to_string(),
            title: "JSON 工具箱".to_string(),
            current: "0.1.0".to_string(),
            latest: "0.2.0".to_string(),
            notes: None,
            has_update: true,
            min_kernel_ok: true,
        };
        let raw = serde_json::to_string(&state).unwrap();
        assert!(raw.contains("\"minKernelOk\":true"), "序列化必须是 camelCase：{raw}");
        assert!(raw.contains("\"hasUpdate\":true"), "序列化必须是 camelCase：{raw}");
        assert!(!raw.contains("min_kernel_ok"), "snake_case 字段 view 读不到：{raw}");
    }

    #[test]
    fn sha256_matches_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(sha256_hex(b"").len(), 64);
    }

    #[test]
    fn only_fixed_domains_are_allowed() {
        assert!(is_allowed_host("https://github.com/o/r/releases/download/x/y.zip"));
        assert!(is_allowed_host("https://objects.githubusercontent.com/x"));
        assert!(is_allowed_host("https://gitee.com/triple3h/Chassis/releases/download/app-latest/x.zip"));
        assert!(is_allowed_host("https://foruda.gitee.com/attach_file/1/x.zip"));
        // 加速代理（只给附件用）：放行的是**精确域名**
        assert!(is_allowed_host("https://ghfast.top/https://github.com/o/r/releases/download/x/y.zip"));
        assert!(is_allowed_host("https://gh-proxy.com/https://github.com/o/r/releases/download/x/y.zip"));
        assert!(!is_allowed_host("https://ghfast.top.evil.example.com/x.zip"), "后缀伪装不得放行");
        assert!(!is_allowed_host("https://evil-ghfast.top/x.zip"), "同 TLD 的别的域不得放行");
        assert!(!is_allowed_host("https://evil.example.com/y.zip"));
        assert!(!is_allowed_host("https://github.com.evil.example.com/y.zip"));
        assert!(!is_allowed_host("不是 URL"));
        assert_eq!(host_of("https://github.com:443/a").as_deref(), Some("github.com"));
    }

    /// 代理候选由主源 URL 推导（形态 = 代理域名 + `/` + 完整主源 URL）；别的域不拼代理。
    #[test]
    fn proxy_urls_only_apply_to_primary_urls() {
        let url = "https://github.com/Triple3h/Chassis/releases/download/app-latest/x.zip";
        assert_eq!(
            proxy_urls(url),
            vec![format!("https://ghfast.top/{url}"), format!("https://gh-proxy.com/{url}")]
        );
        assert!(proxy_urls("https://gitee.com/triple3h/Chassis/x").is_empty());
        assert!(proxy_urls("https://example.com/x.zip").is_empty());
    }

    /// 镜像 URL 由主源 URL 推导；索引里的 owner 大小写与常量可能不同（CI 用 `GITHUB_REPOSITORY`）。
    #[test]
    fn mirror_url_swaps_gitee_case_insensitively() {
        assert_eq!(
            mirror_url("https://github.com/Triple3h/Chassis/releases/download/app-latest/Chassis-0.1.6-macos-arm64.zip").as_deref(),
            Some("https://gitee.com/triple3h/Chassis/releases/download/app-latest/Chassis-0.1.6-macos-arm64.zip")
        );
        assert_eq!(
            mirror_url("https://github.com/triple3h/Chassis/releases/download/plugins-latest/registry.json").as_deref(),
            Some("https://gitee.com/triple3h/Chassis/releases/download/plugins-latest/registry.json")
        );
        // 别的域（含 Gitee 自己）：不动，交给调用方只用原 URL
        assert_eq!(mirror_url("https://gitee.com/triple3h/Chassis/x"), None);
        assert_eq!(mirror_url("https://example.com/x.zip"), None);
        assert_eq!(mirror_url("不是 URL"), None);
    }

    #[test]
    fn download_name_carries_platform() {
        assert_eq!(download_name("totp", "0.5.0", "macos", "arm64"), "totp-0.5.0-macos-arm64.zip");
    }

    fn kernel_registry_raw(schema: u64) -> String {
        format!(
            r#"{{
  "schema": {schema},
  "generatedAt": "2026-09-18T00:00:00Z",
  "kernel": {{
    "version": "0.2.0",
    "hotVersion": "0.1.0",
    "minHotVersion": "0.1.0",
    "notes": "路由热替换更稳",
    "assets": [
      {{ "platforms": ["macos"], "arch": ["arm64"], "url": "https://github.com/o/r/releases/download/kernel-latest/launcher-kernel-0.2.0-macos-arm64.zip", "sha256": "aa", "bytes": 1 }},
      {{ "platforms": ["windows"], "arch": ["x64"], "url": "https://github.com/o/r/releases/download/kernel-latest/launcher-kernel-0.2.0-windows-x64.zip", "sha256": "bb", "bytes": 2 }}
    ]
  }}
}}"#
        )
    }

    #[test]
    fn kernel_registry_gates_by_version_and_platform() {
        let registry = parse_kernel_registry(&kernel_registry_raw(1)).unwrap();
        let update = collect_kernel_update(&registry, "0.1.0", "macos", "arm64", Some("0.1.0")).expect("应有内核更新");
        assert_eq!(update.current, "0.1.0");
        assert_eq!(update.latest, "0.2.0");
        assert_eq!(update.notes.as_deref(), Some("路由热替换更稳"));
        assert!(update.hot_ok);
        assert!(update.asset.url.ends_with("macos-arm64.zip"), "按平台挑产物");
        assert_eq!(update.asset.sha256, "aa");

        assert!(collect_kernel_update(&registry, "0.2.0", "macos", "arm64", Some("0.1.0")).is_none(), "同版本不提示");
        assert!(collect_kernel_update(&registry, "0.3.0", "macos", "arm64", Some("0.1.0")).is_none(), "索引更旧不提示");
        assert!(collect_kernel_update(&registry, "0.1.0", "linux", "x64", Some("0.1.0")).is_none(), "没有该平台产物");
        assert!(parse_kernel_registry(&kernel_registry_raw(9)).is_err(), "未知 schema 拒绝");
    }

    #[test]
    fn min_hot_version_gates_kernel_update() {
        let mut registry = parse_kernel_registry(&kernel_registry_raw(1)).unwrap();
        registry.kernel.min_hot_version = Some("0.5.0".to_string());
        let update = collect_kernel_update(&registry, "0.1.0", "macos", "arm64", Some("0.1.0")).unwrap();
        assert!(!update.hot_ok, "机制版本不够 ⇒ 界面不给「更新」按钮");

        assert!(hot_satisfied(None, Some("0.1.0")), "没声明下限 ⇒ 放行");
        assert!(hot_satisfied(Some("0.1.0"), None), "拿不到客户端版本 ⇒ 放行");
        assert!(hot_satisfied(Some("0.1.0"), Some("0.2.0")));
        assert!(!hot_satisfied(Some("0.2.0"), Some("0.1.0")));
    }

    fn write_bundle_zip(zip_path: &Path, with_ui: bool, traversal: bool) {
        use std::io::Write;
        let file = std::fs::File::create(zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let exec = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
        let plain = zip::write::SimpleFileOptions::default().unix_permissions(0o644);
        writer.start_file(kernel_exe_name(), exec).unwrap();
        writer.write_all(b"kernel-bytes").unwrap();
        if with_ui {
            writer.start_file("ui/index.html", plain).unwrap();
            writer.write_all(b"<html>").unwrap();
        }
        if traversal {
            writer.start_file("../evil.txt", plain).unwrap();
            writer.write_all(b"nope").unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn unzip_restores_structure_and_exec_bit() {
        let dir = std::env::temp_dir().join(format!("kernel-bundle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("bundle.zip");
        write_bundle_zip(&zip_path, true, false);

        let out = dir.join("out");
        let bundle = unzip_kernel_bundle(&zip_path, &out).expect("合法包应解压成功");
        assert_eq!(std::fs::read(&bundle.binary).unwrap(), b"kernel-bytes");
        assert_eq!(std::fs::read(bundle.ui.join("index.html")).unwrap(), b"<html>");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&bundle.binary).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "可执行位必须恢复（否则新内核起不来）");
        }

        let missing_ui = dir.join("no-ui.zip");
        write_bundle_zip(&missing_ui, false, false);
        let err = unzip_kernel_bundle(&missing_ui, &dir.join("out2")).expect_err("缺 ui 必须拒绝");
        assert!(err.contains("ui"), "错误信息要点出缺什么：{err}");

        let evil = dir.join("evil.zip");
        write_bundle_zip(&evil, true, true);
        let err = unzip_kernel_bundle(&evil, &dir.join("out3")).expect_err("路径穿越必须拒绝");
        assert!(err.contains("路径穿越"), "错误信息要说明原因：{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn app_registry_raw(schema: u64) -> String {
        format!(
            r#"{{
  "schema": {schema},
  "generatedAt": "2026-09-19T00:00:00Z",
  "app": {{
    "version": "0.2.0",
    "shellHotVersion": "0.1.0",
    "minShellHotVersion": "0.1.0",
    "notes": "截图下沉到壳",
    "assets": [
      {{ "platforms": ["macos"], "arch": ["arm64"], "url": "https://github.com/o/r/releases/download/app-latest/Chassis-0.2.0-macos-arm64.zip", "sha256": "aa", "bytes": 1 }},
      {{ "platforms": ["macos"], "arch": ["x64"], "url": "https://github.com/o/r/releases/download/app-latest/Chassis-0.2.0-macos-x64.zip", "sha256": "bb", "bytes": 2 }},
      {{ "platforms": ["windows"], "arch": ["x64"], "url": "https://github.com/o/r/releases/download/app-latest/Chassis-0.2.0-win-x64.zip", "sha256": "cc", "bytes": 3 }}
    ]
  }}
}}"#
        )
    }

    /// 应用通道的门槛：版本 / 平台 / 机制版本三条都要过（索引按平台挑产物）。
    #[test]
    fn app_registry_gates_by_version_platform_and_hot() {
        let registry = parse_app_registry(&app_registry_raw(1)).unwrap();
        let update = collect_app_update(&registry, "0.1.0", "macos", "arm64", Some("0.1.0")).expect("应有应用更新");
        assert_eq!(update.current, "0.1.0");
        assert_eq!(update.latest, "0.2.0");
        assert_eq!(update.notes.as_deref(), Some("截图下沉到壳"));
        assert!(update.hot_ok);
        assert!(update.asset.url.ends_with("macos-arm64.zip"), "按平台挑产物");

        assert!(collect_app_update(&registry, "0.2.0", "macos", "arm64", Some("0.1.0")).is_none(), "同版本不提示");
        assert!(collect_app_update(&registry, "0.3.0", "macos", "arm64", Some("0.1.0")).is_none(), "索引更旧不提示");
        let win = collect_app_update(&registry, "0.1.0", "windows", "x64", Some("0.1.0")).expect("Windows 也要能拿到更新");
        assert!(win.asset.url.ends_with("Chassis-0.2.0-win-x64.zip"), "按平台挑到绿色版：{}", win.asset.url);
        assert!(
            collect_app_update(&registry, "0.1.0", "windows", "arm64", Some("0.1.0")).is_none(),
            "索引里没有该架构的产物 ⇒ 不提示（宁可漏，不可乱装）"
        );
        assert!(parse_app_registry(&app_registry_raw(9)).is_err(), "未知 schema 拒绝");

        let mut low = parse_app_registry(&app_registry_raw(1)).unwrap();
        low.app.min_shell_hot_version = Some("9.9.9".to_string());
        let gated = collect_app_update(&low, "0.1.0", "macos", "arm64", Some("0.1.0")).unwrap();
        assert!(!gated.hot_ok, "壳自更新机制版本不够 ⇒ 界面不给「更新」");
    }

    fn write_app_zip(zip_path: &Path, with_binary: bool, with_plist: bool, traversal: bool) {
        use std::io::Write;
        let file = std::fs::File::create(zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let exec = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
        let plain = zip::write::SimpleFileOptions::default().unix_permissions(0o644);
        if with_binary {
            writer.start_file("Chassis.app/Contents/MacOS/launcher-shell", exec).unwrap();
            writer.write_all(b"shell-bytes").unwrap();
        }
        if with_plist {
            writer.start_file("Chassis.app/Contents/Info.plist", plain).unwrap();
            writer.write_all(b"<plist/>").unwrap();
        }
        if traversal {
            writer.start_file("../evil.txt", plain).unwrap();
            writer.write_all(b"nope").unwrap();
        }
        writer.finish().unwrap();
    }

    /// Windows 绿色版结构的 zip（`Chassis.exe` + `resources/…`：与 `pack-win.mjs` 的压法同源）
    fn write_app_zip_windows(zip_path: &Path, with_exe: bool) {
        use std::io::Write;
        let file = std::fs::File::create(zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let plain = zip::write::SimpleFileOptions::default().unix_permissions(0o644);
        if with_exe {
            writer.start_file("Chassis.exe", plain).unwrap();
            writer.write_all(b"shell-bytes").unwrap();
            writer.start_file("resources/kernel/launcher-kernel.exe", plain).unwrap();
            writer.write_all(b"kernel-bytes").unwrap();
        } else {
            writer.start_file("readme.txt", plain).unwrap();
            writer.write_all(b"nothing here").unwrap();
        }
        writer.finish().unwrap();
    }

    /// Windows 包解压：绿色版目录直接就是候选安装位置（交给壳按平台再校验一遍）
    #[test]
    fn unzip_app_bundle_accepts_windows_green_layout() {
        let dir = std::env::temp_dir().join(format!("app-bundle-win-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let zip_path = dir.join("Chassis-0.2.0-win-x64.zip");
        write_app_zip_windows(&zip_path, true);
        let out = dir.join("out");
        let bundle = unzip_app_bundle(&zip_path, &out).expect("绿色版结构应解压成功");
        assert_eq!(bundle.app, out, "候选位置 = 解压目录本身（里面是 Chassis.exe）");
        assert!(bundle.app.join("Chassis.exe").exists());

        let junk = dir.join("junk.zip");
        write_app_zip_windows(&junk, false);
        let err = unzip_app_bundle(&junk, &dir.join("out2")).expect_err("既没有 .app 也没有 Chassis.exe 必须拒绝");
        assert!(err.contains("Chassis.exe"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 应用包解压：结构校验 + 可执行位恢复（候选包自检要跑得起来）。
    #[test]
    fn unzip_app_bundle_keeps_exec_bit_and_rejects_junk() {
        let dir = std::env::temp_dir().join(format!("app-bundle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("Chassis-0.2.0-macos-arm64.zip");
        write_app_zip(&zip_path, true, true, false);

        let out = dir.join("out");
        let bundle = unzip_app_bundle(&zip_path, &out).expect("合法包应解压成功");
        assert!(bundle.app.ends_with("Chassis.app"), "{:?}", bundle.app);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let binary = bundle.app.join("Contents").join("MacOS").join("launcher-shell");
            let mode = std::fs::metadata(&binary).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "可执行位必须恢复（否则候选包自检跑不起来）");
        }

        let missing = dir.join("missing.zip");
        write_app_zip(&missing, false, true, false);
        assert!(unzip_app_bundle(&missing, &dir.join("out2")).is_err(), "缺壳二进制必须拒绝");

        let evil = dir.join("evil.zip");
        write_app_zip(&evil, true, true, true);
        let err = unzip_app_bundle(&evil, &dir.join("out3")).expect_err("路径穿越必须拒绝");
        assert!(err.contains("路径穿越"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
