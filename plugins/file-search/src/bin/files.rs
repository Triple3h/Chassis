//! 命令 `files`（贡献型搜索源）：用 Spotlight 索引搜文件名（v1 `src/no-view/files.ts`）。

use launcher_plugin_file_search::{icon_for, parent_of, pretty_path, runtime, search_files};
use launcher_plugin_sdk::{json, Context, Result, Value};

/// v1 的 `LIMIT`：结果条数上限（宿主还会按最佳匹配分区再筛一遍）
const LIMIT: usize = 8;

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    ctx.on_query(|query, _token| {
        // 只有 macOS 有 Spotlight（Windows / Linux 上这个命令不产出贡献，见 m5 计划 §B）
        if !cfg!(target_os = "macos") {
            return Ok(Vec::new());
        }
        // handler 不在 tokio runtime 里，block_on 是安全的（见 lib.rs 的 `runtime()`）
        let hits = runtime().block_on(search_files(query, LIMIT));
        Ok(hits.into_iter().map(to_result_item).collect())
    })
}

fn to_result_item(hit: launcher_plugin_file_search::FileHit) -> Value {
    json!({
        "id": format!("file:{}", hit.path),
        "title": hit.name,
        "subtitle": pretty_path(&parent_of(&hit.path)),
        "icon": icon_for(&hit.path),
        "score": hit.score,
        "action": { "type": "open", "target": hit.path, "targetKind": "path" },
        "actions": [
            { "type": "command", "command": "reveal", "args": { "path": hit.path } },
            { "type": "copy", "text": hit.path },
        ],
    })
}
