//! 命令 `files`（贡献型搜索源）：文件名搜索。
//!
//! 后端由平台决定（m5 计划 §B2.6）：macOS = Spotlight（`mdfind`），
//! Windows = 复用已装 Everything，否则用自建索引。

use launcher_plugin_file_search::{backend, icon_for, parent_of, pretty_path};
use launcher_plugin_sdk::{json, Context, Result, Value};

/// v1 的 `LIMIT`：结果条数上限（宿主还会按最佳匹配分区再筛一遍）
const LIMIT: usize = 8;

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    // 后端是进程内单例（Windows 上需要 dataPath 落索引，所以先建好再进闭包）
    let backend = backend(ctx);
    ctx.on_query(move |query, _token| {
        // handler 跑在 SDK 的 executor 线程里，后端内部按需 block_on / 读内存索引
        let hits = backend.search_name(query, LIMIT);
        Ok(hits.into_iter().map(to_result_item).collect())
    })
}

fn to_result_item(hit: launcher_plugin_file_search::FileHit) -> Value {
    let mut item = json!({
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
    });
    // 二级面板（`plugin-spec` §9.2 的 `detail`，纯文本）：文本类前若干行 / 其余元数据。
    // 只对**最终展示的这几条**算，且读不到就不带这个字段（preview.rs 有成本与降级说明）。
    let detail = launcher_plugin_file_search::preview::detail_of(&hit.path);
    if !detail.is_empty() {
        item["detail"] = Value::String(detail);
    }
    item
}
