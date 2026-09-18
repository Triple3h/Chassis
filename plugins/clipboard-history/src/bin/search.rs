//! 命令 `search`（贡献型搜索源）：在启动台里直接搜剪贴板历史。
//!
//! 常驻（`--mode search`）：宿主每次输入下发 `{type:'query'}`，200ms 内要回结果。
//! 索引就是磁盘上的历史文件 —— 缓存住、按 mtime 失效即可（`record` 与 `clip-io` 都可能改它）。
//!
//! 空输入**不给结果**：启动台空输入时那一屏是「已固定 + 已安装插件」，不该被历史刷满。

use std::path::Path;
use std::sync::Mutex;

use launcher_plugin_sdk::{json, Context, Result, Value};
use launcher_plugin_clipboard_history::{
    filter_entries, load_entries, now_ms, settings_from, subtitle_of, title_of, Entry, Kind, Settings,
};

/// 单次贡献的上限（内核还会再筛一遍，这里先收口）
const LIMIT: usize = 8;

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let settings = settings_from(ctx.settings());
    let dir = ctx.data_path().to_path_buf();
    let cache: &'static Mutex<Cache> = Box::leak(Box::new(Mutex::new(Cache::empty())));

    ctx.on_query(move |query, _token| {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let entries = cache.lock().unwrap_or_else(|err| err.into_inner()).entries(&dir, &settings);
        let now = now_ms();
        Ok(filter_entries(&entries, query, None, LIMIT)
            .iter()
            .map(|entry| to_item(entry, now))
            .collect())
    })
}

/// 历史文件的缓存：只在 mtime 变了才重读（一次输入 80ms 一次，500 条 JSONL 不该每次都解析）。
struct Cache {
    mtime: i64,
    entries: Vec<Entry>,
}

impl Cache {
    fn empty() -> Self {
        Self { mtime: -1, entries: Vec::new() }
    }

    fn entries(&mut self, dir: &Path, settings: &Settings) -> Vec<Entry> {
        let mtime = mtime_of(&launcher_plugin_clipboard_history::store_file(dir));
        if mtime == self.mtime && !self.entries.is_empty() {
            return self.entries.clone();
        }
        let mut entries = load_entries(dir);
        // 上限裁剪只影响内存视图；真正的落盘裁剪在 record 里做
        if entries.len() > settings.max_entries {
            let keep_from = entries.len() - settings.max_entries;
            entries = entries.split_off(keep_from);
        }
        self.entries = entries.clone();
        self.mtime = mtime;
        entries
    }
}

fn mtime_of(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as i64)
        .unwrap_or(-1)
}

/// 结果项（plugin-spec §9.3）。`id` 必须稳定：固定 / 历史都按它对齐。
fn to_item(entry: &Entry, now: i64) -> Value {
    let mut item = json!({
        "id": entry.id,
        "title": title_of(entry),
        "subtitle": subtitle_of(entry, now),
        "icon": icon_of(entry),
    });
    match entry.kind {
        // 文本直接走宿主的 copy（用户按回车就是「贴这条」）
        Kind::Text => {
            item["action"] = json!({ "type": "copy", "text": entry.text.clone().unwrap_or_default() })
        }
        // 图片要走插件：iframe / 宿主 API 都写不了图片剪贴板
        Kind::Image => {
            item["action"] =
                json!({ "type": "command", "command": "clip-io", "args": { "op": "paste", "id": entry.id } })
        }
        Kind::File => {
            let target = entry.paths.as_ref().and_then(|paths| paths.first().cloned()).unwrap_or_default();
            item["action"] = json!({ "type": "open", "target": target, "targetKind": "path" })
        }
    }
    item["actions"] = json!([
        { "type": "command", "command": "clip-io", "args": { "op": "paste", "id": entry.id } },
        { "type": "command", "command": "clip-io", "args": { "op": "delete", "id": entry.id } },
    ]);
    item
}

fn icon_of(entry: &Entry) -> &'static str {
    match entry.kind {
        Kind::Text => "clipboard",
        Kind::Image => "image",
        Kind::File => "folder",
    }
}
