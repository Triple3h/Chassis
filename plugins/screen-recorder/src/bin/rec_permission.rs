//! rec-permission：录制环境体检 —— 权限 + 后端就绪度 + 能力矩阵，面板进页面问一次。
//! macOS：屏幕录制 TCC（`CGPreflightScreenCaptureAccess`，可主动申请）；
//! Windows：没有系统级「屏幕录制」授权，只探 ffmpeg 在不在。

use launcher_plugin_screen_recorder as rec;
use launcher_plugin_sdk::{json, Context, Level, Result, Value};

fn main() {
    launcher_plugin_sdk::run(dispatch);
}

fn dispatch(ctx: &Context) -> Result<()> {
    // 主动申请：macOS 第一次会弹系统提示（用户拒过就只能去系统设置里勾）
    let request = ctx.raw_args().get("request").and_then(Value::as_bool).unwrap_or(false);
    let permission = rec::backend::permission(request);
    let (ready, ready_hint) = rec::backend::readiness();
    let features = rec::features();

    let _ = ctx.log(
        &format!(
            "rec-permission: backend={} granted={} ready={} requested={}",
            rec::backend::backend_name(),
            permission.granted,
            ready,
            permission.requested
        ),
        None,
        Level::Info,
    );
    ctx.done(json!({
        "supported": permission.supported,
        "granted": permission.granted,
        "requested": permission.requested,
        "needsManual": permission.needs_manual,
        "hint": permission.hint,
        "settingsUrl": permission.settings_url,
        "micSettingsUrl": rec::backend::microphone_settings_url(),
        "backend": rec::backend::backend_name(),
        "platform": std::env::consts::OS,
        "ready": ready,
        "readyHint": ready_hint,
        "features": features,
    }))
}
