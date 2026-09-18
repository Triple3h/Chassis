//! 命令 `clip-io`（script）：面板（`history` view）的后端。
//!
//! iframe 里读不到本地文件、也写不了图片剪贴板，所以「列出历史 / 贴回 / 固定 / 删除 / 清空 /
//! 暂停 / 取缩略图」全走这里。args：`{ op: 'list' | 'paste' | 'pin' | 'delete' | 'clear' | 'pause' | 'image', ... }`
//!
//! 业务级失败（条目没了、平台不支持）一律 `done({ ok:false, error })` 而不是 `fail`：
//! 面板要能把这句话直接显示给用户。

use launcher_plugin_sdk::{json, Context, Level, Result, Value};
use launcher_plugin_clipboard_history::{
    ensure_dirs, entry_to_value, filter_entries, load_entries, load_state, lock_store, now_ms, save_entries,
    save_state, Entry, Kind,
};
// `blob_dir` 只在 Windows 的写回路径里用（拼缩略图路径）
#[cfg(windows)]
use launcher_plugin_clipboard_history::blob_dir;

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let dir = ctx.data_path().to_path_buf();
    if let Err(err) = ensure_dirs(&dir) {
        return ctx.done(json!({ "ok": false, "error": err }));
    }
    let args = ctx.raw_args().clone();
    let op = args.get("op").and_then(Value::as_str).unwrap_or("list").to_string();

    match op.as_str() {
        "list" => op_list(ctx, &dir, &args),
        "image" => op_image(ctx, &dir, &args),
        // 下面这些都要改历史文件：抢锁（事件驱动的 record 也可能正在写）
        other => {
            let Some(_lock) = lock_store(&dir) else {
                return ctx.done(json!({ "ok": false, "error": "正忙，稍后再试" }));
            };
            match other {
                "paste" => op_paste(ctx, &dir, &args),
                "pin" => op_pin(ctx, &dir, &args),
                "delete" => op_delete(ctx, &dir, &args),
                "clear" => op_clear(ctx, &dir, &args),
                "pause" => op_pause(ctx, &dir, &args),
                unknown => ctx.done(json!({ "ok": false, "error": format!("未知操作：{unknown}") })),
            }
        }
    }
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn op_list(ctx: &Context, dir: &std::path::Path, args: &Value) -> Result<()> {
    let query = str_arg(args, "query").unwrap_or("").to_string();
    let kind = str_arg(args, "kind").and_then(Kind::parse);
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(200).clamp(1, 1000) as usize;
    let entries = load_entries(dir);
    let now = now_ms();
    let items: Vec<Value> = filter_entries(&entries, &query, kind, limit)
        .iter()
        .map(|entry| entry_to_value(entry, now))
        .collect();
    let state = load_state(dir);
    ctx.done(json!({
        "ok": true,
        "entries": items,
        "total": entries.len(),
        "pausedUntil": state.pause_until,
        "now": now,
    }))
}

fn op_image(ctx: &Context, dir: &std::path::Path, args: &Value) -> Result<()> {
    let Some(id) = str_arg(args, "id") else {
        return ctx.done(json!({ "ok": false, "error": "缺少 id" }));
    };
    let entry = load_entries(dir).into_iter().find(|entry| entry.id == id);
    let Some(entry) = entry else {
        return ctx.done(json!({ "ok": false, "error": "这条历史已经不在了" }));
    };
    let Some(blob) = entry.blob.clone() else {
        return ctx.done(json!({ "ok": false, "error": "这条不是图片" }));
    };
    let path = dir.join(blob.replace('/', &std::path::MAIN_SEPARATOR.to_string()));
    match std::fs::read(&path) {
        Ok(bytes) => {
            use base64::Engine;
            let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
            ctx.done(json!({ "ok": true, "id": id, "data": data, "mime": "image/png" }))
        }
        Err(_) => ctx.done(json!({ "ok": false, "error": "缩略图已被清理（图片可能超过了容量上限）" })),
    }
}

fn op_paste(ctx: &Context, dir: &std::path::Path, args: &Value) -> Result<()> {
    let Some(id) = str_arg(args, "id") else {
        return ctx.done(json!({ "ok": false, "error": "缺少 id" }));
    };
    let mut entries = load_entries(dir);
    let Some(index) = entries.iter().position(|entry| entry.id == id) else {
        return ctx.done(json!({ "ok": false, "error": "这条历史已经不在了" }));
    };
    let entry = entries[index].clone();

    if let Err(err) = write_back(dir, &entry) {
        ctx.log(&format!("clip-io: 写回失败 {err}"), None, Level::Warn)?;
        return ctx.done(json!({ "ok": false, "error": err }));
    }
    // 记下这次写回：**壳马上会收到一次变化通知**，靠它把「自己贴出去的那条」挡在库外
    let mut state = load_state(dir);
    state.last_written_hash = entry.hash.clone();
    let _ = save_state(dir, &state);

    entries[index] = Entry { uses: entry.uses + 1, created_at: now_ms(), ..entry.clone() };
    let _ = save_entries(dir, &entries);
    ctx.done(json!({ "ok": true, "kind": entry.kind.as_str(), "id": id }))
}

fn op_pin(ctx: &Context, dir: &std::path::Path, args: &Value) -> Result<()> {
    let Some(id) = str_arg(args, "id") else {
        return ctx.done(json!({ "ok": false, "error": "缺少 id" }));
    };
    let pinned = args.get("pinned").and_then(Value::as_bool).unwrap_or(true);
    let mut entries = load_entries(dir);
    let Some(index) = entries.iter().position(|entry| entry.id == id) else {
        return ctx.done(json!({ "ok": false, "error": "这条历史已经不在了" }));
    };
    entries[index] = Entry { pinned, ..entries[index].clone() };
    if let Err(err) = save_entries(dir, &entries) {
        return ctx.done(json!({ "ok": false, "error": err }));
    }
    ctx.done(json!({ "ok": true, "pinned": pinned }))
}

fn op_delete(ctx: &Context, dir: &std::path::Path, args: &Value) -> Result<()> {
    let Some(id) = str_arg(args, "id") else {
        return ctx.done(json!({ "ok": false, "error": "缺少 id" }));
    };
    let mut entries = load_entries(dir);
    let before = entries.len();
    let doomed = entries.iter().find(|entry| entry.id == id).cloned();
    entries.retain(|entry| entry.id != id);
    if entries.len() == before {
        return ctx.done(json!({ "ok": false, "error": "这条历史已经不在了" }));
    }
    if let Err(err) = save_entries(dir, &entries) {
        return ctx.done(json!({ "ok": false, "error": err }));
    }
    // blob 一起删（没被引用的缩略图留着只是占地方）
    if let Some(blob) = doomed.and_then(|entry| entry.blob) {
        let path = dir.join(blob.replace('/', &std::path::MAIN_SEPARATOR.to_string()));
        let _ = std::fs::remove_file(path);
    }
    ctx.done(json!({ "ok": true, "total": entries.len() }))
}

fn op_clear(ctx: &Context, dir: &std::path::Path, args: &Value) -> Result<()> {
    // 默认只清「未固定」；`all: true` 连固定项一起清（面板里会二次确认）
    let all = args.get("all").and_then(Value::as_bool).unwrap_or(false);
    let mut entries = load_entries(dir);
    let doomed: Vec<Entry> = if all {
        entries.drain(..).collect()
    } else {
        let (kept, removed): (Vec<Entry>, Vec<Entry>) = entries.into_iter().partition(|entry| entry.pinned);
        entries = kept;
        removed
    };
    if let Err(err) = save_entries(dir, &entries) {
        return ctx.done(json!({ "ok": false, "error": err }));
    }
    for entry in doomed {
        if let Some(blob) = entry.blob {
            let path = dir.join(blob.replace('/', &std::path::MAIN_SEPARATOR.to_string()));
            let _ = std::fs::remove_file(path);
        }
    }
    ctx.done(json!({ "ok": true, "total": entries.len() }))
}

/// 暂停记录：`minutes = 0` 恢复、负数 = 直到手动恢复。
fn op_pause(ctx: &Context, dir: &std::path::Path, args: &Value) -> Result<()> {
    let minutes = args.get("minutes").and_then(Value::as_i64).unwrap_or(0);
    let mut state = load_state(dir);
    state.pause_until = match minutes {
        0 => 0,
        negative if negative < 0 => i64::MAX,
        value => now_ms() + value * 60_000,
    };
    if let Err(err) = save_state(dir, &state) {
        return ctx.done(json!({ "ok": false, "error": err }));
    }
    ctx.done(json!({ "ok": true, "pausedUntil": state.pause_until }))
}

/// 把一条历史写回剪贴板（Windows 专属能力；其它平台明确拒绝，面板据此提示）。
#[cfg(windows)]
fn write_back(dir: &std::path::Path, entry: &Entry) -> std::result::Result<(), String> {
    use launcher_plugin_clipboard_history::clipboard::{write_payload, Payload};

    let payload = match entry.kind {
        Kind::Text => Payload::Text(entry.text.clone().unwrap_or_default()),
        Kind::File => Payload::Files(entry.paths.clone().unwrap_or_default()),
        Kind::Image => {
            let Some(blob) = entry.blob.clone() else {
                return Err("这条图片的缩略图已经不在了".to_string());
            };
            let path = blob_dir(dir).join(blob.rsplit('/').next().unwrap_or_default());
            let png = std::fs::read(&path).map_err(|_| "这条图片的缩略图已经不在了".to_string())?;
            Payload::Image { png, width: entry.width.unwrap_or(0), height: entry.height.unwrap_or(0) }
        }
    };
    write_payload(&payload)
}

#[cfg(not(windows))]
fn write_back(_dir: &std::path::Path, _entry: &Entry) -> std::result::Result<(), String> {
    Err("剪贴板历史只在 Windows 上可用".to_string())
}
