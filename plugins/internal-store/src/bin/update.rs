//! 命令 `update`（script，产物名 = `update`，plugin-spec §2.2 的 N1）。
//!
//! args:
//!   `{ mode: 'check', installed: [{ id, version }], kernel }` → 拉插件索引 + 比对，
//!                                                            返回**已装插件的全量状态**（`hasUpdate` 标记有没有新版；
//!                                                            界面默认列出当前版本、有更新的高亮）
//!   `{ mode: 'download', id }`                                → 下载插件包 + sha256 校验，返回本地 zip 路径
//!   `{ mode: 'check-kernel', current, hotVersion }`           → 拉内核索引 + 比对（kernel-latest 通道）
//!   `{ mode: 'download-kernel', current, hotVersion }`        → 下载内核包 + sha256 + 解压（launcher-kernel + ui/）
//!   `{ mode: 'check-app', current, shellHotVersion }`         → 拉应用索引 + 比对（app-latest 通道）
//!   `{ mode: 'download-app', current, shellHotVersion }`      → 下载应用包 + sha256 + 解压（Chassis.app/）
//!
//! **只接受 id / 版本号，不接受 URL**：下载地址一律从索引里取（杜绝「被诱导下载任意包」）。
//! **出网**：更新源是 GitHub。策略 = **先直连，连不上再降级到 `launcher_plugin_sdk::proxy` 探测到的
//! HTTP 代理**（环境变量 → 系统设置）—— 直连通常更快、也不惊动代理；被墙时又能自动救回来。
//! 安装动作不在这里 —— 那是 view 侧发起的（`pluginAction('installZip')` / `pluginAction('applyKernelUpdate')`）：
//! 安装会杀掉正在执行命令的子进程（热更新还会重启内核），view 跑在宿主 webview 里不受影响。

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use launcher_plugin_internal_store::{
    collect_app_update, collect_kernel_update, collect_plugins, current_arch, current_platform, download_name,
    extract_npm_zip, host_of, is_allowed_host, npm_index_url, parse_app_registry, parse_kernel_registry,
    parse_registry, pick_asset, proxy_urls, registry_from_npm_manifest, sha256_hex, unzip_app_bundle,
    unzip_kernel_bundle, AppRegistry, InstalledPlugin, KernelRegistry, RegistryAsset, APP_REGISTRY_URL,
    KERNEL_REGISTRY_URL, MAX_DOWNLOAD_BYTES, REGISTRY_URL,
};
use launcher_plugin_sdk::{json, proxy, Context, Level, Result, Value};

/// 索引很小（几 KB），超时给短一点；附件最大 60MB，读超时给足。
const TIMEOUT_INDEX: Duration = Duration::from_secs(10);
const TIMEOUT_ASSET: Duration = Duration::from_secs(60);
/// npm 索引：境内镜像，失败要快（后面还有 GitHub 通道兜底）。
const TIMEOUT_NPM_INDEX: Duration = Duration::from_secs(5);
/// 直连尝试的连接阶段超时：被墙时 TCP 会一路挂到请求超时，给短一点让降级来得快
/// （**有代理兜底才敢这么压**；没探测到代理时不动，免得「慢但能用」的网络被判死）。
const TIMEOUT_DIRECT_CONNECT: Duration = Duration::from_secs(5);

/// 本次执行内「直连已确定不通」：索引把直连试挂了，后面的附件就别再白等一遍。
static DIRECT_BROKEN: AtomicBool = AtomicBool::new(false);

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let args = ctx.raw_args().clone();
    // 更新源在 GitHub：先把出网策略记一笔，用户报「连不上」时一眼能看出走的哪条路
    let route = match proxy_url() {
        Some(url) => format!("更新源连接：先直连，连不上降级到代理 {url}"),
        None => "更新源连接：直连（未探测到代理）".to_string(),
    };
    ctx.log(&route, None, Level::Info)?;
    match args.get("mode").and_then(Value::as_str).unwrap_or("check") {
        "check" => check(ctx, &args),
        "download" => download(ctx, &args),
        "check-kernel" => check_kernel(ctx, &args),
        "download-kernel" => download_kernel(ctx, &args),
        "check-app" => check_app(ctx, &args),
        "download-app" => download_app(ctx, &args),
        other => ctx.done(json!({ "ok": false, "error": format!("未知 mode：{other}") })),
    }
}

/// 出网代理（进程内只探测一次）：系统代理 / 环境变量都不是 HTTP 客户端会自己读的 ——
/// 直连被墙时会白等一个超时（用户看到的就是 `Operation timed out (os error 60)`）。
fn proxy_url() -> Option<&'static str> {
    static PROXY: OnceLock<Option<String>> = OnceLock::new();
    PROXY.get_or_init(proxy::detect).as_deref()
}

/// 连接类失败给一句可操作提示（这行字会原样出现在更新页上，光看 os error 没法排查）。
fn failure_hint() -> String {
    match proxy_url() {
        Some(url) => format!("（直连与代理 {url} 都不通，请确认网络与代理是否可用）"),
        None => "（未探测到代理：如开着代理软件，请在系统设置里开启「系统代理」后重试）".to_string(),
    }
}

/// 只有「连不上」才值得换代理重试：HTTP 状态码（404 / 403）说明直连已经通了，换条路也是这个结果。
fn should_fallback(err: &ureq::Error) -> bool {
    matches!(err, ureq::Error::Transport(_))
}

/// GET 一次：**直连优先 → 连接类失败且有代理时降级重试一次**（HTTP 状态码直接上报，不重试）。
fn get(ctx: &Context, url: &str, timeout: Duration) -> std::result::Result<ureq::Response, String> {
    if !is_allowed_host(url) {
        return Err(format!("更新源域名不在白名单：{}", host_of(url).unwrap_or_default()));
    }
    let proxy = proxy_url();
    let mut direct_error: Option<String> = None;
    if !DIRECT_BROKEN.load(Ordering::Relaxed) {
        let connect = proxy.map(|_| TIMEOUT_DIRECT_CONNECT);
        match agent(ctx, None, connect, timeout).get(url).call() {
            Ok(response) => return checked(response),
            Err(ureq::Error::Status(code, _)) => return Err(format!("请求失败：HTTP {code}")),
            Err(err) if should_fallback(&err) && proxy.is_some() => {
                DIRECT_BROKEN.store(true, Ordering::Relaxed);
                direct_error = Some(err.to_string());
            }
            Err(err) => return Err(format!("请求失败：{err}{}", failure_hint())),
        }
    }
    let Some(proxy) = proxy else {
        let detail = direct_error.map(|err| format!("：{err}")).unwrap_or_default();
        return Err(format!("请求失败{detail}{}", failure_hint()));
    };
    if let Some(err) = &direct_error {
        let _ = ctx.log(&format!("直连失败，改用代理 {proxy} 重试：{err}"), None, Level::Warn);
    }
    match agent(ctx, Some(proxy), None, timeout).get(url).call() {
        Ok(response) => checked(response),
        Err(ureq::Error::Status(code, _)) => Err(format!("请求失败：HTTP {code}")),
        Err(err) => Err(format!("请求失败：{err}{}", failure_hint())),
    }
}

/// ureq 会自动跟随 302（npmmirror tarball → `cdn.npmmirror.com`）——
/// 白名单只检查首个 URL 是不够的，落地的最终地址也要再查一次。
fn checked(response: ureq::Response) -> std::result::Result<ureq::Response, String> {
    let final_url = response.get_url();
    if is_allowed_host(final_url) {
        Ok(response)
    } else {
        Err(format!("重定向到非白名单域名：{}", host_of(final_url).unwrap_or_default()))
    }
}

/// 出网 Agent：`proxy` 为 `None` 即直连；`connect` 只压连接阶段，读 / 写仍吃整体 `timeout`。
fn agent(ctx: &Context, proxy: Option<&str>, connect: Option<Duration>, timeout: Duration) -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new().timeout(timeout);
    if let Some(connect) = connect {
        builder = builder.timeout_connect(connect);
    }
    if let Some(url) = proxy {
        match ureq::Proxy::new(url) {
            Ok(proxy) => builder = builder.proxy(proxy),
            Err(err) => {
                let _ = ctx.log(&format!("代理地址不可用，本次走直连：{url}（{err}）"), None, Level::Warn);
            }
        }
    }
    builder.build()
}

fn check(ctx: &Context, args: &Value) -> Result<()> {
    let installed: Vec<InstalledPlugin> = args
        .get("installed")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("id").and_then(Value::as_str)?;
                    let version = item.get("version").and_then(Value::as_str).unwrap_or("0.0.0");
                    Some(InstalledPlugin { id: id.to_string(), version: version.to_string() })
                })
                .collect()
        })
        .unwrap_or_default();
    let kernel = args.get("kernel").and_then(Value::as_str).map(str::to_string);

    let registry = match fetch_index(ctx) {
        Ok(registry) => registry,
        Err(message) => {
            ctx.log(&format!("检查更新失败：{message}"), None, Level::Warn)?;
            return ctx.done(json!({ "ok": false, "stage": "index", "error": message }));
        }
    };
    let plugins = collect_plugins(&registry, &installed, current_platform(), current_arch(), kernel.as_deref());
    let updatable = plugins.iter().filter(|item| item.has_update).count();
    ctx.log(&format!("检查更新完成：已列 {} 个插件，其中 {updatable} 个有新版本", plugins.len()), None, Level::Info)?;
    ctx.done(json!({ "ok": true, "checkedAt": now_ms(), "plugins": plugins }))
}

fn download(ctx: &Context, args: &Value) -> Result<()> {
    let Some(id) = args.get("id").and_then(Value::as_str) else {
        return ctx.done(json!({ "ok": false, "stage": "args", "error": "缺少 id" }));
    };
    let registry = match fetch_index(ctx) {
        Ok(registry) => registry,
        Err(message) => return ctx.done(json!({ "ok": false, "stage": "index", "error": message })),
    };
    let Some(entry) = registry.plugins.get(id) else {
        return ctx.done(json!({ "ok": false, "stage": "index", "error": format!("索引里没有插件：{id}") }));
    };
    let Some(asset) = pick_asset(entry, current_platform(), current_arch()) else {
        return ctx.done(json!({
            "ok": false, "stage": "platform",
            "error": format!("{} {} 没有适配当前平台的产物", entry.title, entry.version),
        }));
    };
    if !is_allowed_host(&asset.url) {
        return ctx.done(json!({
            "ok": false, "stage": "source",
            "error": format!("更新源域名不在白名单：{}", host_of(&asset.url).unwrap_or_default()),
        }));
    }

    let directory = ctx.data_path().join("downloads");
    if let Err(err) = std::fs::create_dir_all(&directory) {
        return ctx.done(json!({ "ok": false, "stage": "io", "error": format!("无法创建下载目录：{err}") }));
    }
    let path = directory.join(download_name(id, &entry.version, current_platform(), current_arch()));

    match fetch_verified(ctx, asset, &path) {
        Ok((bytes, digest)) => {
            ctx.log(&format!("已下载 {id} {}（{} 字节）", entry.version, bytes), None, Level::Info)?;
            ctx.done(json!({
                "ok": true, "id": id, "version": entry.version, "path": path, "sha256": digest, "bytes": bytes,
            }))
        }
        Err(message) => {
            let _ = std::fs::remove_file(&path);
            ctx.log(&format!("下载 {id} 失败：{message}"), None, Level::Warn)?;
            ctx.done(json!({ "ok": false, "stage": "download", "error": message }))
        }
    }
}

// ── 内核更新（kernel-latest 通道）────────────────────────────────

fn check_kernel(ctx: &Context, args: &Value) -> Result<()> {
    let current = args.get("current").and_then(Value::as_str).unwrap_or_default().to_string();
    if current.is_empty() {
        return ctx.done(json!({
            "ok": false, "stage": "args",
            "error": "缺少 current（当前内核版本，由 view 从 ctx.host.info() 读取）",
        }));
    }
    let hot = args.get("hotVersion").and_then(Value::as_str).map(str::to_string);
    let registry = match fetch_kernel_index(ctx) {
        Ok(registry) => registry,
        Err(message) => {
            ctx.log(&format!("检查内核更新失败：{message}"), None, Level::Warn)?;
            return ctx.done(json!({ "ok": false, "stage": "index", "error": message }));
        }
    };
    match collect_kernel_update(&registry, &current, current_platform(), current_arch(), hot.as_deref()) {
        Some(update) => {
            ctx.log(&format!("发现内核新版本 {} → {}", update.current, update.latest), None, Level::Info)?;
            ctx.done(json!({ "ok": true, "checkedAt": now_ms(), "update": update }))
        }
        None => ctx.done(json!({ "ok": true, "checkedAt": now_ms(), "update": null })),
    }
}

fn download_kernel(ctx: &Context, args: &Value) -> Result<()> {
    let current = args.get("current").and_then(Value::as_str).unwrap_or_default().to_string();
    let hot = args.get("hotVersion").and_then(Value::as_str).map(str::to_string);
    let registry = match fetch_kernel_index(ctx) {
        Ok(registry) => registry,
        Err(message) => return ctx.done(json!({ "ok": false, "stage": "index", "error": message })),
    };
    let Some(update) = collect_kernel_update(&registry, &current, current_platform(), current_arch(), hot.as_deref()) else {
        return ctx.done(json!({
            "ok": false, "stage": "index",
            "error": "没有可用的内核更新（当前已是最新，或没有适配当前平台的产物）",
        }));
    };
    if !is_allowed_host(&update.asset.url) {
        return ctx.done(json!({
            "ok": false, "stage": "source",
            "error": format!("更新源域名不在白名单：{}", host_of(&update.asset.url).unwrap_or_default()),
        }));
    }

    let directory = ctx.data_path().join("downloads").join("kernel");
    if let Err(err) = std::fs::create_dir_all(&directory) {
        return ctx.done(json!({ "ok": false, "stage": "io", "error": format!("无法创建下载目录：{err}") }));
    }
    let path = directory.join(format!("launcher-kernel-{}-{}-{}.zip", update.latest, current_platform(), current_arch()));

    let (bytes, digest) = match fetch_verified(ctx, &update.asset, &path) {
        Ok(value) => value,
        Err(message) => {
            let _ = std::fs::remove_file(&path);
            ctx.log(&format!("下载内核更新包失败：{message}"), None, Level::Warn)?;
            return ctx.done(json!({ "ok": false, "stage": "download", "error": message }));
        }
    };

    let out_dir = directory.join(format!("kernel-{}", update.latest));
    match unzip_kernel_bundle(&path, &out_dir) {
        Ok(bundle) => {
            ctx.log(&format!("内核更新包已就绪：v{}（{} 字节）", update.latest, bytes), None, Level::Info)?;
            ctx.done(json!({
                "ok": true,
                "version": update.latest,
                "current": update.current,
                "path": bundle.binary,
                "uiPath": bundle.ui,
                "sha256": digest,
                "bytes": bytes,
            }))
        }
        Err(message) => {
            ctx.log(&format!("解压内核更新包失败：{message}"), None, Level::Warn)?;
            ctx.done(json!({ "ok": false, "stage": "unzip", "error": message }))
        }
    }
}

// ── 应用（壳）自更新（app-latest 通道）──────────────────────────

/// 检查应用更新。`current` / `shellHotVersion` 由 view 从 `pluginAction('shellInfo')` 读
/// （壳是唯一知道自己版本与安装位置的角色）。
///
/// 索引里两个平台都有产物（macOS `.app` zip / Windows 绿色版 zip），按 `current_platform()` 挑；
/// 「能不能装」由壳回答（`canSelfUpdate`）—— 这里只负责「源里有没有适配当前平台的包」。
fn check_app(ctx: &Context, args: &Value) -> Result<()> {
    let current = args.get("current").and_then(Value::as_str).unwrap_or_default().to_string();
    if current.is_empty() {
        return ctx.done(json!({
            "ok": false, "stage": "args",
            "error": "缺少 current（当前应用版本，由 view 从 pluginAction('shellInfo') 读取）",
        }));
    }
    let hot = args.get("shellHotVersion").and_then(Value::as_str).map(str::to_string);
    let registry = match fetch_app_index(ctx) {
        Ok(registry) => registry,
        Err(message) => {
            ctx.log(&format!("检查应用更新失败：{message}"), None, Level::Warn)?;
            return ctx.done(json!({ "ok": false, "stage": "index", "error": message }));
        }
    };
    match collect_app_update(&registry, &current, current_platform(), current_arch(), hot.as_deref()) {
        Some(update) => {
            ctx.log(&format!("发现应用新版本 {} → {}", update.current, update.latest), None, Level::Info)?;
            ctx.done(json!({ "ok": true, "checkedAt": now_ms(), "update": update }))
        }
        None => ctx.done(json!({ "ok": true, "checkedAt": now_ms(), "update": null })),
    }
}

fn download_app(ctx: &Context, args: &Value) -> Result<()> {
    let current = args.get("current").and_then(Value::as_str).unwrap_or_default().to_string();
    let hot = args.get("shellHotVersion").and_then(Value::as_str).map(str::to_string);
    let registry = match fetch_app_index(ctx) {
        Ok(registry) => registry,
        Err(message) => return ctx.done(json!({ "ok": false, "stage": "index", "error": message })),
    };
    let Some(update) = collect_app_update(&registry, &current, current_platform(), current_arch(), hot.as_deref()) else {
        return ctx.done(json!({
            "ok": false, "stage": "index",
            "error": "没有可用的应用更新（当前已是最新，或没有适配当前平台的产物）",
        }));
    };
    if !is_allowed_host(&update.asset.url) {
        return ctx.done(json!({
            "ok": false, "stage": "source",
            "error": format!("更新源域名不在白名单：{}", host_of(&update.asset.url).unwrap_or_default()),
        }));
    }

    let directory = ctx.data_path().join("downloads").join("app");
    if let Err(err) = std::fs::create_dir_all(&directory) {
        return ctx.done(json!({ "ok": false, "stage": "io", "error": format!("无法创建下载目录：{err}") }));
    }
    let path = directory.join(format!("Chassis-{}-{}-{}.zip", update.latest, current_platform(), current_arch()));

    let (bytes, digest) = match fetch_verified(ctx, &update.asset, &path) {
        Ok(value) => value,
        Err(message) => {
            let _ = std::fs::remove_file(&path);
            ctx.log(&format!("下载应用更新包失败：{message}"), None, Level::Warn)?;
            return ctx.done(json!({ "ok": false, "stage": "download", "error": message }));
        }
    };

    let out_dir = directory.join(format!("app-{}", update.latest));
    match unzip_app_bundle(&path, &out_dir) {
        Ok(bundle) => {
            ctx.log(&format!("应用更新包已就绪：v{}（{} 字节）", update.latest, bytes), None, Level::Info)?;
            ctx.done(json!({
                "ok": true,
                "version": update.latest,
                "current": update.current,
                "appPath": bundle.app,
                "sha256": digest,
                "bytes": bytes,
            }))
        }
        Err(message) => {
            ctx.log(&format!("解压应用更新包失败：{message}"), None, Level::Warn)?;
            ctx.done(json!({ "ok": false, "stage": "unzip", "error": message }))
        }
    }
}

fn fetch_app_index(ctx: &Context) -> std::result::Result<AppRegistry, String> {
    fetch_with_npm(ctx, "app", "应用", APP_REGISTRY_URL, parse_app_registry)
}

fn fetch_kernel_index(ctx: &Context) -> std::result::Result<KernelRegistry, String> {
    fetch_with_npm(ctx, "kernel", "内核", KERNEL_REGISTRY_URL, parse_kernel_registry)
}

fn fetch_index(ctx: &Context) -> std::result::Result<launcher_plugin_internal_store::Registry, String> {
    fetch_with_npm(ctx, "plugins", "插件", REGISTRY_URL, parse_registry)
}

/// npm 索引包（npmmirror 上的 package manifest）→ **验签后**的 registry 原文。
fn fetch_npm_registry_text(ctx: &Context, channel: &str) -> std::result::Result<String, String> {
    let url = npm_index_url(channel);
    let response = get(ctx, &url, TIMEOUT_NPM_INDEX)?;
    let raw = response.into_string().map_err(|err| format!("读取 npm 索引失败：{err}"))?;
    registry_from_npm_manifest(&raw)
}

/// **npm 优先，失败回落自有通道**（加速代理 → GitHub）。npm 失败只记 Info：
/// 首发 / npmmirror 尚未同步时属正常，不该在用户日志里冒充错误。
fn fetch_with_npm<T>(
    ctx: &Context,
    channel: &str,
    label: &str,
    fallback_url: &str,
    parse: fn(&str) -> std::result::Result<T, String>,
) -> std::result::Result<T, String> {
    match fetch_npm_registry_text(ctx, channel) {
        Ok(text) => match parse(&text) {
            Ok(registry) => {
                let _ = ctx.log(&format!("{label}索引来自 npm（registry.npmmirror.com，已验签）"), None, Level::Info);
                return Ok(registry);
            }
            Err(err) => {
                let _ = ctx.log(&format!("npm 的{label}索引不可用，回落自有通道：{err}"), None, Level::Info);
            }
        },
        Err(err) => {
            let _ = ctx.log(&format!("npm 的{label}索引不可用，回落自有通道：{err}"), None, Level::Info);
        }
    }
    let raw = fetch_text(ctx, fallback_url, TIMEOUT_INDEX)?;
    parse(&raw)
}

/// 候选地址：加速代理（仅附件）→ 主源；非主源 URL 只有它自己。
fn candidates(url: &str, with_proxies: bool) -> Vec<String> {
    let mut list = if with_proxies { proxy_urls(url) } else { Vec::new() };
    list.push(url.to_string());
    list
}

/// 索引的候选：**只有主源，不走加速代理**。
///
/// 索引是信任根（决定「下载什么、校验值是多少」）：让它走第三方通道，攻击者就能把 url 指到
/// 白名单内的任意仓库、再配上自己算的 sha256 ⇒ 校验形同虚设。
/// npm 索引是唯一例外，但它是**独立封装 + ed25519 验签**，不是「把索引 URL 拼到代理后面」。
fn index_candidates(url: &str) -> Vec<String> {
    candidates(url, false)
}

/// 附件的候选：**加速代理 → 主源**。
///
/// 代理不可信没关系 —— 每个候选下完都要跟**索引里的 sha256**（可信通道来的）比对，
/// 篡改 / 半截 / 换包都会被 `fetch_verified` 拒掉并自动换下一个候选。
fn asset_candidates(url: &str) -> Vec<String> {
    candidates(url, true)
}

fn fetch_text(ctx: &Context, url: &str, timeout: Duration) -> std::result::Result<String, String> {
    let mut failures: Vec<String> = Vec::new();
    for candidate in index_candidates(url) {
        if !is_allowed_host(&candidate) {
            return Err(format!("更新源域名不在白名单：{}", host_of(&candidate).unwrap_or_default()));
        }
        match get(ctx, &candidate, timeout) {
            Ok(response) => {
                // 走的是哪个源写进日志：真机上排查「国内下载源到底有没有生效」全靠这行
                let host = host_of(&candidate).unwrap_or_default();
                let note = if failures.is_empty() {
                    (format!("索引来自 {host}"), Level::Info)
                } else {
                    (format!("前面的源不可用，索引改用 {host}"), Level::Warn)
                };
                let _ = ctx.log(&note.0, None, note.1);
                return response.into_string().map_err(|err| format!("读取响应失败：{err}"));
            }
            Err(err) => failures.push(format!("{} {err}", host_of(&candidate).unwrap_or_default())),
        }
    }
    Err(failures.join("；"))
}

/// 一个下载候选：npm 的 tarball 要先解包，GitHub 的是直接可用的 zip。
struct DownloadCandidate {
    url: String,
    tgz: bool,
}

/// 资产的全部候选：npm（tgz）→ 索引里的 `mirrors`（原 GitHub URL，按代理 → GitHub）。
/// npmmirror 尚未同步 / tarball 404 时，同一份 sha256 仍能校验 GitHub 侧的 zip。
fn download_candidates(asset: &RegistryAsset) -> Vec<DownloadCandidate> {
    let primary_tgz = asset.format.as_deref() == Some("tgz");
    let mut list: Vec<DownloadCandidate> = asset_candidates(&asset.url)
        .into_iter()
        .map(|url| DownloadCandidate { url, tgz: primary_tgz })
        .collect();
    for mirror in &asset.mirrors {
        for url in asset_candidates(mirror) {
            list.push(DownloadCandidate { url, tgz: false });
        }
    }
    let mut seen = std::collections::HashSet::new();
    list.retain(|candidate| seen.insert(candidate.url.clone()));
    list
}

/// 下载 + 校验：依次尝试候选地址，**校验不过也换下一个** —— 坏包与「拿不到」同等对待。
///
/// 这里的 sha256 是整套方案的**安全支点**：npm/npmmirror 与加速代理都是第三方通道，
/// 但每个候选下完都要跟**已验签索引**里的摘要比对，改一个字节就被拒。
fn fetch_verified(
    ctx: &Context,
    asset: &RegistryAsset,
    path: &std::path::Path,
) -> std::result::Result<(u64, String), String> {
    let expected = asset.sha256.trim();
    if expected.is_empty() {
        // 索引没给摘要 ⇒ 无从校验，宁可不装（fail-closed；不该出现，出现就是索引坏了）
        return Err("索引里没有 sha256，拒绝下载（无法校验来源）".to_string());
    }
    let mut failures: Vec<String> = Vec::new();
    for candidate in download_candidates(asset) {
        let host = host_of(&candidate.url).unwrap_or_default();
        let temp = if candidate.tgz { path.with_extension("tgz") } else { path.to_path_buf() };
        let result = (|| -> std::result::Result<(u64, String), String> {
            fetch_asset(ctx, &candidate.url, &temp)?;
            if candidate.tgz {
                let entry = asset.entry.as_deref().ok_or("npm 资产缺少 entry（包内 zip 名）")?;
                let bytes = extract_npm_zip(&temp, entry, path, MAX_DOWNLOAD_BYTES)?;
                let content = std::fs::read(path).map_err(|err| format!("读取 zip 失败：{err}"))?;
                let digest = sha256_hex(&content);
                if digest.eq_ignore_ascii_case(expected) {
                    return Ok((bytes, digest));
                }
                return Err(format!("校验失败（索引 {expected} / 实际 {digest}）"));
            }
            let content = std::fs::read(&temp).map_err(|err| format!("读取文件失败：{err}"))?;
            let digest = sha256_hex(&content);
            if digest.eq_ignore_ascii_case(expected) {
                Ok((content.len() as u64, digest))
            } else {
                Err(format!("校验失败（索引 {expected} / 实际 {digest}）"))
            }
        })();
        match result {
            Ok((bytes, digest)) => {
                if candidate.tgz {
                    let _ = std::fs::remove_file(&temp);
                }
                let note = if failures.is_empty() {
                    (format!("更新包来自 {host}"), Level::Info)
                } else {
                    (format!("前面的源不可用，更新包改用 {host}"), Level::Warn)
                };
                let _ = ctx.log(&note.0, None, note.1);
                return Ok((bytes, digest));
            }
            Err(err) => failures.push(format!("{host} {err}")),
        }
        let _ = std::fs::remove_file(&temp);
        let _ = std::fs::remove_file(path);
    }
    Err(failures.join("；"))
}

/// 流式落盘 + 大小上限：索引里的 `bytes` 只是参考值，实际以读到的字节数为准。
fn fetch_asset(ctx: &Context, url: &str, path: &std::path::Path) -> std::result::Result<u64, String> {
    let response = get(ctx, url, TIMEOUT_ASSET)?;
    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(path).map_err(|err| format!("无法写入文件：{err}"))?;
    let mut total: u64 = 0;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer).map_err(|err| format!("下载中断：{err}"))?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > MAX_DOWNLOAD_BYTES {
            return Err("更新包超过大小上限（60MB）".to_string());
        }
        file.write_all(&buffer[..read]).map_err(|err| format!("写入失败：{err}"))?;
    }
    drop(file);
    Ok(total)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    /// 候选顺序：**索引不走加速代理**（信任根只走 GitHub），附件才带代理。
    #[test]
    fn only_assets_go_through_proxies() {
        let url = "https://github.com/Triple3h/Chassis/releases/download/app-latest/Chassis-0.1.6-macos-arm64.zip";
        assert_eq!(index_candidates(url), vec![url.to_string()]);
        assert_eq!(
            asset_candidates(url),
            vec![
                format!("https://ghfast.top/{url}"),
                format!("https://gh-proxy.com/{url}"),
                url.to_string(),
            ]
        );
        // 非主源 URL：既不变镜像、也不拼代理（别的域不该被塞进代理通道）
        assert_eq!(index_candidates("https://example.com/x.zip"), vec!["https://example.com/x.zip".to_string()]);
        assert_eq!(asset_candidates("https://example.com/x.zip"), vec!["https://example.com/x.zip".to_string()]);
    }

    /// npm 资产：候选 = npmmirror tarball → 原 GitHub URL 的代理 / GitHub（都是 zip）。
    /// npmmirror 没同步或 tarball 404 时，同一份 sha256 仍能在 GitHub 侧完成校验。
    #[test]
    fn npm_asset_falls_back_to_github_mirror() {
        let asset: RegistryAsset = serde_json::from_value(serde_json::json!({
            "platforms": ["macos"],
            "arch": ["arm64"],
            "url": "https://registry.npmmirror.com/@triple3h/chassis-app-macos-arm64/-/chassis-app-macos-arm64-0.1.11.tgz",
            "format": "tgz",
            "entry": "Chassis-0.1.11-macos-arm64.zip",
            "mirrors": ["https://github.com/triple3h/Chassis/releases/download/app-latest/Chassis-0.1.11-macos-arm64.zip"],
            "sha256": "aa",
            "bytes": 3
        }))
        .unwrap();

        let candidates = download_candidates(&asset);
        assert_eq!(candidates[0].url, asset.url);
        assert!(candidates[0].tgz, "npm 首个候选必须按 tarball 解包");
        assert!(
            candidates[1..].iter().all(|candidate| !candidate.tgz),
            "mirrors 里的 GitHub 都是 zip"
        );
        assert!(
            candidates.iter().any(|candidate| candidate.url.starts_with("https://github.com/")),
            "必须保留 GitHub 主源兜底"
        );
        assert!(
            candidates.iter().all(|candidate| !candidate.url.contains("gitee.com")),
            "Gitee 渠道已移除"
        );
    }

    /// 降级只认「连不上」：HTTP 状态码说明直连已经通了，换代理重试没有意义。
    #[test]
    fn fallback_only_for_connection_failures() {
        // 没人监听的本地端口 ⇒ connection refused（不依赖外网，秒回）
        let refused = ureq::get("http://127.0.0.1:9/").timeout(Duration::from_secs(2)).call().unwrap_err();
        assert!(should_fallback(&refused), "连不上必须允许降级：{refused}");

        // 本地假服务器回 404：直连是通的（只是这个地址没有）⇒ 不降级
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request); // 先收完请求再回：写一半就关会让对方吃到 RST（变成「连不上」）
            let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let _ = socket.flush();
            std::thread::sleep(Duration::from_millis(200)); // 等客户端把响应读完再关连接
        });
        let not_found =
            ureq::get(&format!("http://{addr}/registry.json")).timeout(Duration::from_secs(2)).call().unwrap_err();
        assert!(!should_fallback(&not_found), "HTTP 状态码不算连接失败：{not_found}");
        server.join().unwrap();
    }
}
