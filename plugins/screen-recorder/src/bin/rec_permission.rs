//! rec-permission：查询 / 申请「屏幕录制」权限（macOS TCC）。
//! 第一次申请会弹系统提示；用户拒绝过就只能在系统设置里手动勾，这里给出引导文案。

use launcher_plugin_screen_recorder as rec;
use launcher_plugin_sdk::{json, Context, Level, Result, Value};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    if !rec::platform_supported() {
        return ctx.done(json!({
            "supported": false,
            "granted": false,
            "hint": "当前平台不支持系统级录屏（macOS 才有 TCC 屏幕录制权限）",
        }));
    }

    let before = rec::screen_capture_granted().unwrap_or(false);
    let mut requested = false;
    let mut granted = before;
    if !before {
        requested = true;
        let immediate = rec::request_screen_capture();
        // 系统提示是异步的：立刻再查一次，多数情况仍是 false，需要用户去设置里勾
        granted = immediate || rec::screen_capture_granted().unwrap_or(false);
    }

    let needs_manual = requested && !granted;
    let _ = ctx.log(
        &format!("rec-permission: granted={granted} requested={requested}"),
        None,
        Level::Info,
    );
    ctx.done(json!({
        "supported": true,
        "granted": granted,
        "requested": requested,
        "needsManual": needs_manual,
        "hint": if granted {
            Value::String(String::new())
        } else {
            Value::String("到 系统设置 → 隐私与安全性 → 屏幕录制 里勾选 Chassis（勾完请退出并重新打开启动台）".into())
        },
    }))
}
