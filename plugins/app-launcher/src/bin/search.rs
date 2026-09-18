//! 命令 `search`（贡献型搜索源）：返回命中的应用（v1 `src/no-view/search.ts`）。
//!
//! 索引优先级：内存 → 宿主 storage（`app-index`）→ 现场扫描。
//! 宿主只给 200ms 预算，首次扫描必然超时 —— 但那没关系：内核的**延迟补位**会把这批结果
//! 通过 `search/results` 推给界面（见 `docs/m5-rust-and-windows.md` 与 kernel 的 `on_late_result`）。

use std::sync::{Arc, Mutex};

use launcher_plugin_app_launcher::{
    home_dir, now_ms, runtime, scan_applications, search_apps, AppEntry, AppIndex, IconCache, INDEX_KEY,
};
use launcher_plugin_sdk::{json, Context, Result, Storage, Value};

/// v1 的 `LIMIT`：插件侧粗排的上限（内核还会再筛）
const LIMIT: usize = 10;

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let storage = ctx.storage();
    let icons = Arc::new(IconCache::new(ctx.data_path().join("icons")));
    let index: Arc<Mutex<Vec<AppEntry>>> = Arc::new(Mutex::new(Vec::new()));

    // v1：`void ensureIndex()` —— worker 一起来就在后台准备索引，避免首次输入白屏
    {
        let storage = storage.clone();
        let index = index.clone();
        std::thread::spawn(move || {
            let apps = runtime().block_on(load_or_scan(&storage));
            if !apps.is_empty() {
                *index.lock().unwrap_or_else(|err| err.into_inner()) = apps;
            }
        });
    }

    let home = home_dir();
    ctx.on_query(move |query, _token| {
        let apps = ensure_index(&storage, &index);
        if apps.is_empty() {
            return Ok(Vec::new());
        }
        let hits = search_apps(&apps, query, LIMIT);
        let items = hits
            .into_iter()
            .map(|hit| runtime().block_on(to_item(&hit.app, hit.score, &icons, &home)))
            .collect();
        Ok(items)
    })
}

fn ensure_index(storage: &Storage, index: &Mutex<Vec<AppEntry>>) -> Vec<AppEntry> {
    {
        let guard = index.lock().unwrap_or_else(|err| err.into_inner());
        if !guard.is_empty() {
            return guard.clone();
        }
    }
    let apps = runtime().block_on(load_or_scan(storage));
    *index.lock().unwrap_or_else(|err| err.into_inner()) = apps.clone();
    apps
}

/// 宿主 storage 里有现成索引就用它；否则扫一遍并写回。
async fn load_or_scan(storage: &Storage) -> Vec<AppEntry> {
    if let Ok(Some(value)) = storage.get(INDEX_KEY) {
        if let Ok(saved) = serde_json::from_value::<AppIndex>(value) {
            if !saved.apps.is_empty() {
                return saved.apps;
            }
        }
    }
    if !cfg!(any(target_os = "macos", windows)) {
        return Vec::new();
    }
    let result = scan_applications().await;
    let payload = AppIndex { version: 1, scanned_at: now_ms(), apps: result.apps.clone() };
    if let Ok(value) = serde_json::to_value(&payload) {
        let _ = storage.set(INDEX_KEY, value);
    }
    result.apps
}

async fn to_item(app: &AppEntry, score: f64, icons: &IconCache, home: &str) -> Value {
    let icon = icons.data_url(app.icon_file.as_deref()).await;
    let folder = parent_of(&app.path);
    let folder = if !home.is_empty() && folder.starts_with(home) { format!("~{}", &folder[home.len()..]) } else { folder };
    let alias = app.aliases.iter().find(|value| !value.is_empty() && *value != &app.name);

    let mut item = json!({
        "id": format!("app:{}", app.path),
        "title": app.name,
        "subtitle": alias.unwrap_or(&folder),
        "score": score,
        "action": { "type": "open", "target": app.path, "targetKind": "app" },
        "actions": [
            { "type": "open", "target": parent_of(&app.path), "targetKind": "path" },
            { "type": "copy", "text": app.path },
        ],
    });
    // v1 是 `...(icon ? { icon } : {})`：没有图标时**不带这个字段**（而不是 null）
    if let Some(icon) = icon {
        item["icon"] = Value::String(icon);
    }
    item
}

/// 所在目录（两种路径分隔符都认：macOS 的 `.app` 与 Windows 的 `.lnk` 共用这一段）
fn parent_of(path: &str) -> String {
    match path.rfind(['/', '\\']) {
        Some(0) => path[..1].to_string(),
        Some(index) => path[..index].to_string(),
        None => ".".to_string(),
    }
}
