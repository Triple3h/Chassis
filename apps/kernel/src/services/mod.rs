//! 插件可见的服务层（requirements §7.1 / plugin-spec §7.2）。
//!
//! 两条通道（view 桥与逻辑层 RPC）**共用同一份实现**（v1 `services/storage.ts` 的注释：
//! 「加一个方法要改两处」的教训）；能力校验留在各自入口（桥 / 插件管理在装配期裁剪）。

pub mod host_ui;
pub mod primitives;
pub mod quicklink;
pub mod settings;
pub mod storage;
pub mod system_stats;

use std::time::Instant;

use serde_json::Value;

use crate::audit::{AuditInput, AuditLog};
use crate::contract::ErrorShape;
use crate::error::Result;

/// 每个「插件 → 宿主」的调用都必须过这里（P6 / §7.7）：
/// 计时 + 记审计（成功与失败都记；args 由审计层做打码与截断）。
pub async fn audited<T, F>(
    audit: &AuditLog,
    plugin_id: &str,
    channel: &'static str,
    method: &str,
    capability: &str,
    args: Option<Value>,
    action: F,
) -> Result<T>
where
    F: std::future::Future<Output = Result<T>>,
{
    let started = Instant::now();
    let outcome = action.await;
    let ms = started.elapsed().as_millis() as i64;
    let capability = (!capability.is_empty()).then(|| capability.to_string());
    match &outcome {
        Ok(_) => {
            audit.record(AuditInput {
                plugin_id: plugin_id.to_string(),
                channel,
                method: method.to_string(),
                ok: true,
                ms,
                capability,
                error: None,
                args,
            });
        }
        Err(err) => {
            audit.record(AuditInput {
                plugin_id: plugin_id.to_string(),
                channel,
                method: method.to_string(),
                ok: false,
                ms,
                capability,
                error: Some(ErrorShape { code: err.code.to_string(), message: err.message.clone() }),
                args,
            });
        }
    }
    outcome
}
