//! 命令 `update`（script，产物名 = `update`，plugin-spec §2.2 的 N1）。
//!
//! args:
//!   `{ mode: 'check', installed: [{ id, version }], kernel }` → 拉插件索引 + 比对，返回可更新列表
//!   `{ mode: 'download', id }`                                → 下载插件包 + sha256 校验，返回本地 zip 路径
//!   `{ mode: 'check-kernel', current, hotVersion }`           → 拉内核索引 + 比对（kernel-latest 通道）
//!   `{ mode: 'download-kernel', current, hotVersion }`        → 下载内核包 + sha256 + 解压（launcher-kernel + ui/）
//!
//! **只接受 id / 版本号，不接受 URL**：下载地址一律从索引里取（杜绝「被诱导下载任意包」）。
//! 安装动作不在这里 —— 那是 view 侧发起的（`pluginAction('installZip')` / `pluginAction('applyKernelUpdate')`）：
//! 安装会杀掉正在执行命令的子进程（热更新还会重启内核），view 跑在宿主 webview 里不受影响。

use std::io::{Read, Write};
use std::time::Duration;

use launcher_plugin_internal_store::{
    collect_kernel_update, collect_updates, current_arch, current_platform, download_name, host_of, is_allowed_host,
    parse_kernel_registry, parse_registry, pick_asset, sha256_hex, unzip_kernel_bundle, InstalledPlugin, KernelRegistry,
    RegistryAsset, KERNEL_REGISTRY_URL, MAX_DOWNLOAD_BYTES, REGISTRY_URL,
};
use launcher_plugin_sdk::{json, Context, Level, Result, Value};

/// 索引很小（几 KB），超时给短一点；附件最大 60MB，读超时给足。
const TIMEOUT_INDEX: Duration = Duration::from_secs(10);
const TIMEOUT_ASSET: Duration = Duration::from_secs(60);

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let args = ctx.raw_args().clone();
    match args.get("mode").and_then(Value::as_str).unwrap_or("check") {
        "check" => check(ctx, &args),
        "download" => download(ctx, &args),
        "check-kernel" => check_kernel(ctx, &args),
        "download-kernel" => download_kernel(ctx, &args),
        other => ctx.done(json!({ "ok": false, "error": format!("未知 mode：{other}") })),
    }
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

    let registry = match fetch_index() {
        Ok(registry) => registry,
        Err(message) => {
            ctx.log(&format!("检查更新失败：{message}"), None, Level::Warn)?;
            return ctx.done(json!({ "ok": false, "stage": "index", "error": message }));
        }
    };
    let updates = collect_updates(&registry, &installed, current_platform(), current_arch(), kernel.as_deref());
    ctx.log(&format!("检查更新完成：{} 个插件有新版本", updates.len()), None, Level::Info)?;
    ctx.done(json!({ "ok": true, "checkedAt": now_ms(), "updates": updates }))
}

fn download(ctx: &Context, args: &Value) -> Result<()> {
    let Some(id) = args.get("id").and_then(Value::as_str) else {
        return ctx.done(json!({ "ok": false, "stage": "args", "error": "缺少 id" }));
    };
    let registry = match fetch_index() {
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

    match fetch_asset(asset, &path) {
        Ok(bytes) => {
            let digest = match std::fs::read(&path) {
                Ok(content) => sha256_hex(&content),
                Err(err) => {
                    return ctx.done(json!({ "ok": false, "stage": "io", "error": format!("读取已下载文件失败：{err}") }))
                }
            };
            if !digest.eq_ignore_ascii_case(&asset.sha256) {
                // 校验不通过的文件绝不留下：下一次安装不能用它，用户也不知道它坏
                let _ = std::fs::remove_file(&path);
                ctx.log(&format!("{id} 更新包校验失败（索引 {} / 实际 {}）", asset.sha256, digest), None, Level::Error)?;
                return ctx.done(json!({ "ok": false, "stage": "verify", "error": "文件校验失败（已删除，请重试）" }));
            }
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
    let registry = match fetch_kernel_index() {
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
    let registry = match fetch_kernel_index() {
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

    let bytes = match fetch_asset(&update.asset, &path) {
        Ok(bytes) => bytes,
        Err(message) => {
            let _ = std::fs::remove_file(&path);
            ctx.log(&format!("下载内核更新包失败：{message}"), None, Level::Warn)?;
            return ctx.done(json!({ "ok": false, "stage": "download", "error": message }));
        }
    };
    let digest = match std::fs::read(&path) {
        Ok(content) => sha256_hex(&content),
        Err(err) => {
            return ctx.done(json!({ "ok": false, "stage": "io", "error": format!("读取已下载文件失败：{err}") }))
        }
    };
    if !digest.eq_ignore_ascii_case(&update.asset.sha256) {
        // 校验不通过的文件绝不留下：坏包一旦被 apply 就是「内核替换失败」
        let _ = std::fs::remove_file(&path);
        ctx.log(&format!("内核更新包校验失败（索引 {} / 实际 {}）", update.asset.sha256, digest), None, Level::Error)?;
        return ctx.done(json!({ "ok": false, "stage": "verify", "error": "文件校验失败（已删除，请重试）" }));
    }

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

fn fetch_kernel_index() -> std::result::Result<KernelRegistry, String> {
    let raw = fetch_text(KERNEL_REGISTRY_URL, TIMEOUT_INDEX)?;
    parse_kernel_registry(&raw)
}

fn fetch_index() -> std::result::Result<launcher_plugin_internal_store::Registry, String> {
    let raw = fetch_text(REGISTRY_URL, TIMEOUT_INDEX)?;
    parse_registry(&raw)
}

fn fetch_text(url: &str, timeout: Duration) -> std::result::Result<String, String> {
    if !is_allowed_host(url) {
        return Err(format!("更新源域名不在白名单：{}", host_of(url).unwrap_or_default()));
    }
    ureq::get(url)
        .timeout(timeout)
        .call()
        .map_err(|err| format!("请求失败：{err}"))?
        .into_string()
        .map_err(|err| format!("读取响应失败：{err}"))
}

/// 流式落盘 + 大小上限：索引里的 `bytes` 只是参考值，实际以读到的字节数为准。
fn fetch_asset(asset: &RegistryAsset, path: &std::path::Path) -> std::result::Result<u64, String> {
    let response = ureq::get(&asset.url)
        .timeout(TIMEOUT_ASSET)
        .call()
        .map_err(|err| format!("请求失败：{err}"))?;
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
