//! 命令 `record`（script，`plugin-spec` §8.1）：壳通报「剪贴板变了」之后，由宿主拉起一次。
//!
//! args: `{ changeCount: number, kinds: ('text'|'image'|'file'|'unknown')[] }`
//!
//! 一次性执行：读一次剪贴板 → 入库 → `done` → 进程回收。它**不**常驻 —— 常驻的是壳的监听器，
//! 这正是这套设计的关键（插件进程会被宿主回收，壳不会）。
//!
//! 跳过（不入库）的情形：暂停中 / 同一次变化重复通知 / 空内容 / 超长 / 疑似密码 / 自己刚写回去的那条。

use launcher_plugin_sdk::{json, Context, Level, Result, Value};
use launcher_plugin_clipboard_history::{
    ensure_dirs, load_state, lock_store, now_ms, save_state, settings_from, State, Settings,
};
// 下面这些只有 Windows 那一支用得到（非 Windows 上 `capture` 直接返回不支持）
#[cfg(windows)]
use launcher_plugin_clipboard_history::{
    append_entry, hash_of, hash_text, is_sensitive, load_entries, prune_blobs, Entry, Kind, MergeOutcome,
    MAX_TEXT_CHARS,
};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let settings = settings_from(ctx.settings());
    let dir = ctx.data_path().to_path_buf();
    if let Err(err) = ensure_dirs(&dir) {
        return ctx.done(json!({ "ok": false, "error": err }));
    }
    // 面板（clip-io）可能正在改同一个文件：抢不到锁就放弃这一次，下一次复制会补上
    let Some(_lock) = lock_store(&dir) else {
        return ctx.done(json!({ "ok": false, "skipped": "busy" }));
    };

    let now = now_ms();
    let mut state = load_state(&dir);
    if state.is_paused(now) {
        return ctx.done(json!({ "ok": true, "skipped": "paused" }));
    }

    let change_count = ctx.raw_args().get("changeCount").and_then(Value::as_u64).unwrap_or(0);
    if change_count > 0 && change_count == state.last_change_count {
        return ctx.done(json!({ "ok": true, "skipped": "duplicate" }));
    }
    state.last_change_count = change_count;

    let outcome = capture(&dir, &mut state, &settings, now);
    let _ = save_state(&dir, &state);

    match outcome {
        Ok((label, total)) => {
            ctx.log(&format!("record: {label}（共 {total} 条）"), None, Level::Debug)?;
            ctx.done(json!({ "ok": true, "outcome": label, "total": total }))
        }
        Err(err) => ctx.done(json!({ "ok": false, "error": err })),
    }
}

/// 读剪贴板 → 造条目 → 落盘。返回（结果标签，入库后的总条数）。
#[cfg(windows)]
fn capture(dir: &std::path::Path, state: &mut State, settings: &Settings, now: i64) -> std::result::Result<(String, usize), String> {
    use launcher_plugin_clipboard_history::clipboard::{read_payload, Payload};

    let payload = match read_payload(settings.capture_images) {
        Ok(Some(payload)) => payload,
        Ok(None) => return Ok(("empty".to_string(), load_entries(dir).len())),
        Err(err) => return Err(err),
    };

    let entry = match payload {
        Payload::Text(text) => {
            if text.trim().is_empty() {
                return Ok(("empty".to_string(), load_entries(dir).len()));
            }
            if text.chars().count() > MAX_TEXT_CHARS {
                return Ok(("too-long".to_string(), load_entries(dir).len()));
            }
            if settings.ignore_sensitive && is_sensitive(&text) {
                return Ok(("sensitive".to_string(), load_entries(dir).len()));
            }
            let hash = hash_text(&text);
            Entry {
                id: Entry::id_of(Kind::Text, &hash),
                kind: Kind::Text,
                hash,
                created_at: now,
                pinned: false,
                uses: 1,
                text: Some(text),
                blob: None,
                width: None,
                height: None,
                paths: None,
            }
        }
        Payload::Image { png, width, height } => {
            let hash = hash_of(&png);
            let name = format!("{hash}.png");
            let path = launcher_plugin_clipboard_history::blob_dir(dir).join(&name);
            std::fs::write(&path, &png).map_err(|err| format!("保存图片失败：{err}"))?;
            Entry {
                id: Entry::id_of(Kind::Image, &hash),
                kind: Kind::Image,
                hash,
                created_at: now,
                pinned: false,
                uses: 1,
                text: None,
                blob: Some(format!("blobs/{name}")),
                width: Some(width),
                height: Some(height),
                paths: None,
            }
        }
        Payload::Files(paths) => {
            if paths.is_empty() {
                return Ok(("empty".to_string(), load_entries(dir).len()));
            }
            let hash = hash_text(&paths.join("\n"));
            Entry {
                id: Entry::id_of(Kind::File, &hash),
                kind: Kind::File,
                hash,
                created_at: now,
                pinned: false,
                uses: 1,
                text: None,
                blob: None,
                width: None,
                height: None,
                paths: Some(paths),
            }
        }
    };

    // 「贴一条历史 → 剪贴板变 → 又被记成新条目」：自己刚写回去的那条不再回记
    if !state.last_written_hash.is_empty() && state.last_written_hash == entry.hash {
        state.last_written_hash.clear();
        return Ok(("self-write".to_string(), load_entries(dir).len()));
    }
    state.last_written_hash.clear();

    let mut entries = load_entries(dir);
    let outcome = append_entry(dir, &mut entries, entry, settings);
    if matches!(outcome, MergeOutcome::Added) {
        prune_blobs(dir, &entries);
    }
    let label = match outcome {
        MergeOutcome::Added => "added",
        MergeOutcome::Merged => "merged",
        MergeOutcome::Skipped => "skipped",
    };
    Ok((label.to_string(), entries.len()))
}

/// 非 Windows：插件整包被 `platforms` 挡在扫描期之外，跑到这里只可能是手工拉起。
#[cfg(not(windows))]
fn capture(_dir: &std::path::Path, _state: &mut State, _settings: &Settings, _now: i64) -> std::result::Result<(String, usize), String> {
    Err("剪贴板历史只在 Windows 上可用".to_string())
}
