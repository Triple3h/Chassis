//! 命令 `refresh`（no-view）：重建应用索引（v1 `src/no-view/refresh.ts`）。

use launcher_plugin_app_launcher::{index_age_days, now_ms, runtime, scan_applications, AppIndex, INDEX_KEY};
use launcher_plugin_sdk::{json, Context, Level, Result};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    if !cfg!(target_os = "macos") {
        return ctx.done(json!({ "ok": false, "reason": "仅支持 macOS" }));
    }
    let storage = ctx.storage();
    let before = storage
        .get(INDEX_KEY)
        .ok()
        .flatten()
        .and_then(|value| serde_json::from_value::<AppIndex>(value).ok())
        .map(|index| index_age_days(&index));

    ctx.progress(0.1, json!({ "step": "scan" }))?;
    let result = runtime().block_on(scan_applications());
    ctx.progress(0.75, json!({ "step": "save", "apps": result.apps.len() }))?;

    let payload = AppIndex { version: 1, scanned_at: now_ms(), apps: result.apps.clone() };
    match serde_json::to_value(&payload).map_err(|err| launcher_plugin_sdk::SdkError::new("INTERNAL", err.to_string())) {
        Ok(value) => storage.set(INDEX_KEY, value)?,
        Err(err) => return Err(err),
    }
    ctx.log(
        &format!("索引已重建：{} 个应用（{}ms）", result.apps.len(), result.duration_ms),
        None,
        Level::Info,
    )?;
    ctx.done(json!({
        "ok": true,
        "apps": result.apps.len(),
        "durationMs": result.duration_ms,
        "previousIndexAgeDays": before,
        "dirs": result.scanned_dirs,
        "dataPath": ctx.data_path().to_string_lossy(),
    }))
}
