//! 命令 `read-image`（script）：把本地图片读成 base64 交回 View（v1 `src/no-view/read-image.ts`）。
//!
//! args:
//!   `{ listOnly: true, withinMinutes?: number, limit?: number }` → 只列候选（不带 base64）
//!   `{ path: '/Users/x/Desktop/截图.png' }`                      → 读取指定文件
//!
//! 解码不在这里：View 侧拿到 base64 后交给 zxing-wasm 扫二维码。

use launcher_plugin_sdk::{json, Context, Level, Result, Value};
use launcher_plugin_totp::{default_scan_dirs, read_image_file, scan_recent_images, ScanOptions};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    let args = ctx.raw_args().clone();
    let dirs = default_scan_dirs();
    let dirs_json: Vec<String> = dirs.iter().map(|dir| dir.to_string_lossy().to_string()).collect();

    if let Some(path) = args.get("path").and_then(Value::as_str) {
        return match read_image_file(path) {
            Ok(file) => {
                ctx.log(&format!("read-image: 读取指定文件 {}", file.path), None, Level::Info)?;
                ctx.done(json!({ "ok": true, "files": [file], "dirs": dirs_json }))
            }
            Err(message) => {
                ctx.log(&format!("read-image: 失败 {message}"), None, Level::Error)?;
                ctx.done(json!({ "ok": false, "files": [], "dirs": dirs_json, "error": message }))
            }
        };
    }

    // v1 的 `Number(x) || 30`：0 / 缺失 / 非数字都回落到默认值
    let within = positive(args.get("withinMinutes")).unwrap_or(30).clamp(1, 24 * 60);
    let limit = positive(args.get("limit")).unwrap_or(8).clamp(1, 20) as usize;
    let candidates = scan_recent_images(&ScanOptions {
        within_minutes: Some(within),
        limit: Some(limit),
        dirs: Some(dirs),
        now: None,
    });
    ctx.log(&format!("read-image: 扫描最近截图 count={}", candidates.len()), None, Level::Info)?;

    if args.get("listOnly").and_then(Value::as_bool) == Some(true) {
        return ctx.done(json!({ "ok": true, "files": candidates, "dirs": dirs_json }));
    }
    if candidates.is_empty() {
        return ctx.done(json!({ "ok": true, "files": [], "dirs": dirs_json }));
    }
    // 不带 listOnly 时直接读最新的一张，方便一键导入
    match read_image_file(&candidates[0].path) {
        Ok(file) => ctx.done(json!({ "ok": true, "files": [file], "dirs": dirs_json })),
        Err(message) => {
            ctx.log(&format!("read-image: 失败 {message}"), None, Level::Error)?;
            ctx.done(json!({ "ok": false, "files": [], "dirs": dirs_json, "error": message }))
        }
    }
}

fn positive(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_i64()?;
    (number != 0).then_some(number)
}
