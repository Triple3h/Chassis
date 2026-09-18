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

#[derive(Debug, Clone, Serialize)]
pub struct UpdateEntry {
    pub id: String,
    pub title: String,
    pub current: String,
    pub latest: String,
    pub notes: Option<String>,
    pub min_kernel_ok: bool,
    pub asset: RegistryAsset,
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

/// 只认「已装 ∩ 索引里有」的 id；版本不更新则不出现（essential 的过滤在调用方做）。
pub fn collect_updates(
    registry: &Registry,
    installed: &[InstalledPlugin],
    platform: &str,
    arch: &str,
    kernel: Option<&str>,
) -> Vec<UpdateEntry> {
    let mut updates: Vec<UpdateEntry> = Vec::new();
    for plugin in installed {
        let Some(entry) = registry.plugins.get(&plugin.id) else {
            continue;
        };
        if !is_newer(&entry.version, &plugin.version) {
            continue;
        }
        let Some(asset) = pick_asset(entry, platform, arch) else {
            continue;
        };
        updates.push(UpdateEntry {
            id: plugin.id.clone(),
            title: entry.title.clone(),
            current: plugin.version.clone(),
            latest: entry.version.clone(),
            notes: entry.notes.clone(),
            min_kernel_ok: kernel_satisfied(entry.min_kernel.as_deref(), kernel),
            asset: asset.clone(),
        });
    }
    updates.sort_by(|a, b| a.id.cmp(&b.id));
    updates
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

/// 解压内核更新包（结构 = `launcher-kernel(.exe)` + `ui/`）。
///
/// 三件事必须做对：**防路径穿越**（`enclosed_name`）、**恢复可执行位**（zip 记了 unix 权限，
/// 不恢复则内核二进制起不来）、**结构校验**（缺二进制 / 缺 `ui/index.html` 直接拒绝）。
pub fn unzip_kernel_bundle(zip_path: &Path, target_dir: &Path) -> std::result::Result<KernelBundle, String> {
    let file = std::fs::File::open(zip_path).map_err(|err| format!("无法打开更新包：{err}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|err| format!("更新包不是合法 zip：{err}"))?;
    // 目标目录先清干净：混入上一次的半成品会被内核的结构校验放过去
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

/// 传输面白名单：更新源是固定仓库，Release 附件会 302 到 `objects.githubusercontent.com`。
/// 命令**不接受 URL 入参**，这条只是最后一道兜底（防止索引被换成别的域）。
pub fn is_allowed_host(url: &str) -> bool {
    let Some(host) = host_of(url) else {
        return false;
    };
    host == "github.com" || host.ends_with(".github.com") || host.ends_with(".githubusercontent.com")
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
    fn updates_only_cover_installed_plugins() {
        let registry = parse_registry(&registry_raw(1)).unwrap();
        let installed = vec![
            InstalledPlugin { id: "totp".to_string(), version: "0.4.0".to_string() },
            InstalledPlugin { id: "snips".to_string(), version: "0.2.0".to_string() },
            InstalledPlugin { id: "not-in-registry".to_string(), version: "0.1.0".to_string() },
        ];
        let updates = collect_updates(&registry, &installed, "macos", "arm64", Some("0.1.0"));
        assert_eq!(updates.len(), 1, "只有版本真的更新的那个：{updates:?}");
        assert_eq!(updates[0].id, "totp");
        assert_eq!(updates[0].current, "0.4.0");
        assert_eq!(updates[0].latest, "0.5.0");
        assert_eq!(updates[0].notes.as_deref(), Some("修复倒计时漂移"));
        assert!(updates[0].min_kernel_ok);
    }

    #[test]
    fn min_kernel_gates_updates() {
        let mut registry = parse_registry(&registry_raw(1)).unwrap();
        registry.plugins.get_mut("totp").unwrap().min_kernel = Some("9.9.9".to_string());
        let installed = vec![InstalledPlugin { id: "totp".to_string(), version: "0.4.0".to_string() }];
        let updates = collect_updates(&registry, &installed, "macos", "arm64", Some("0.1.0"));
        assert_eq!(updates.len(), 1, "仍然列出，但标记 minKernelOk=false");
        assert!(!updates[0].min_kernel_ok, "内核版本不够 ⇒ 不给「更新」按钮");

        // 拿不到内核版本时放行
        let updates = collect_updates(&registry, &installed, "macos", "arm64", None);
        assert!(updates[0].min_kernel_ok);
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
        assert!(!is_allowed_host("https://evil.example.com/y.zip"));
        assert!(!is_allowed_host("不是 URL"));
        assert_eq!(host_of("https://github.com:443/a").as_deref(), Some("github.com"));
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
}
