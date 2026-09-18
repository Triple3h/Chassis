//! 系统原语（v1 `services/shell.ts`；requirements §6.1 / §8.6）。
//!
//! 壳只提供原语、不做业务；这里做**参数校验 + 审计**，再转发给壳。
//! 宿主内部调用（窗口控制等）不审计插件。

use std::sync::Arc;

use serde_json::{json, Value};

use crate::audit::AuditLog;
use crate::error::{KernelError, Result};
use crate::link::ShellLink;
use crate::services::audited;

const ALLOWED_URL_PROTOCOLS: [&str; 3] = ["http:", "https:", "mailto:"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppUsage {
    pub rss: i64,
    pub cpu_ms: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accelerator: Option<String>,
    pub fallback: bool,
}

pub struct Primitives {
    link: ShellLink,
    audit: Arc<AuditLog>,
}

impl Primitives {
    pub fn new(link: ShellLink, audit: Arc<AuditLog>) -> Self {
        Self { link, audit }
    }

    pub fn link(&self) -> &ShellLink {
        &self.link
    }

    // ── 插件侧（带审计 + 参数校验）──────────────────────────────

    pub async fn shell_open_url(&self, plugin_id: &str, url: &str) -> Result<()> {
        audited(&self.audit, plugin_id, "ui", "ctx.shell.openUrl", "shell.open", Some(json!({ "url": url })), async {
            assert_http_url(url)?;
            self.link.request("open.url", Some(json!({ "url": url }))).await?;
            Ok(())
        })
        .await
    }

    pub async fn shell_open_path(&self, plugin_id: &str, target: &str) -> Result<()> {
        audited(&self.audit, plugin_id, "ui", "ctx.shell.openPath", "shell.open", Some(json!({ "target": target })), async {
            assert_path(target)?;
            self.link.request("open.path", Some(json!({ "path": target }))).await?;
            Ok(())
        })
        .await
    }

    pub async fn shell_reveal(&self, plugin_id: &str, target: &str) -> Result<()> {
        audited(&self.audit, plugin_id, "ui", "ctx.shell.reveal", "shell.open", Some(json!({ "target": target })), async {
            assert_path(target)?;
            self.link.request("open.reveal", Some(json!({ "path": target }))).await?;
            Ok(())
        })
        .await
    }

    pub async fn clipboard_read_text(&self, plugin_id: &str, channel: &'static str) -> Result<String> {
        audited(&self.audit, plugin_id, channel, "ctx.clipboard.readText", "clipboard.read", None, async {
            let value = self.link.request("clipboard.readText", None).await?;
            Ok(match value {
                Value::String(text) => text,
                other => other.get("text").and_then(Value::as_str).unwrap_or_default().to_string(),
            })
        })
        .await
    }

    pub async fn clipboard_write_text(&self, plugin_id: &str, channel: &'static str, text: &str) -> Result<()> {
        audited(
            &self.audit,
            plugin_id,
            channel,
            "ctx.clipboard.writeText",
            "clipboard.write",
            Some(json!({ "text": text })),
            async {
                self.link.request("clipboard.writeText", Some(json!({ "text": text }))).await?;
                Ok(())
            },
        )
        .await
    }

    pub async fn notify_show(
        &self,
        plugin_id: &str,
        channel: &'static str,
        title: &str,
        body: &str,
        silent: bool,
    ) -> Result<bool> {
        let args = json!({ "title": title, "body": body, "silent": silent });
        audited(&self.audit, plugin_id, channel, "ctx.notify.show", "notify.show", Some(args.clone()), async {
            let res = self.link.request("notify.show", Some(args)).await?;
            Ok(res.get("ok").and_then(Value::as_bool) != Some(false))
        })
        .await
    }

    /// 区域截图 → 系统剪贴板（requirements §8.6：只返回是否成功触发）。
    ///
    /// 平台实现（**都要落到系统剪贴板**，调用方不需要自己取图）：
    ///  - macOS：`screencapture -i -c`（系统自带的交互式区域截图）；
    ///  - Windows：唤起系统截图（`ms-screenclip:`，即 Win+Shift+S 那条），截完进剪贴板；
    ///  - 其余平台：返回 false（降级，UI 侧提示不可用）。
    pub async fn screenshot_start(&self, plugin_id: &str) -> Result<bool> {
        audited(&self.audit, plugin_id, "ui", "ctx.screenshot.start", "screenshot", None, async {
            #[cfg(target_os = "macos")]
            {
                let status = tokio::process::Command::new("screencapture")
                    .args(["-i", "-c"])
                    .status()
                    .await
                    .map_err(|err| KernelError::new("INTERNAL", format!("screencapture 启动失败：{err}")))?;
                return Ok(status.success());
            }
            #[cfg(windows)]
            {
                // explorer 处理 `ms-screenclip:` 协议：直接拉出截图覆盖层，不经过 cmd 窗口
                let status = tokio::process::Command::new("explorer")
                    .arg("ms-screenclip:")
                    .status()
                    .await
                    .map_err(|err| KernelError::new("INTERNAL", format!("explorer 启动失败：{err}")))?;
                return Ok(status.success());
            }
            #[cfg(not(any(target_os = "macos", windows)))]
            {
                Ok(false)
            }
        })
        .await
    }

    // ── 宿主内部（UI / 内核自己调用，不审计插件）────────────────

    /// 显示窗口，返回壳在**上屏之前**读到的前台选中文本（读不到就是 None）。
    pub async fn show_window(&self, focus: bool) -> Result<Option<String>> {
        let res = self.link.request("window.show", Some(json!({ "focus": focus }))).await?;
        let selection = res.get("selection").and_then(Value::as_str).unwrap_or_default();
        Ok((!selection.is_empty()).then(|| selection.to_string()))
    }

    pub async fn hide_window(&self) -> Result<()> {
        self.link.request("window.hide", None).await?;
        Ok(())
    }

    /// 无边框窗口：UI 在拖拽区 mousedown 时调用（系统接管后续移动）。
    pub async fn start_dragging(&self) -> Result<()> {
        self.link.request("window.startDragging", None).await?;
        Ok(())
    }

    pub async fn start_resize_dragging(&self, direction: &str) -> Result<()> {
        self.link.request("window.startResizeDragging", Some(json!({ "direction": direction }))).await?;
        Ok(())
    }

    /// 窗口当前是否可见。**问不到就返回 `None`，绝不退化成 `false`**
    /// （「壳没连上」与「窗口被藏起来了」是两件事）。
    pub async fn is_visible(&self) -> Option<bool> {
        if !self.link.is_connected() {
            return None;
        }
        match self.link.request("window.isVisible", None).await {
            Ok(value) => Some(value.as_bool().unwrap_or(false)),
            Err(_) => None,
        }
    }

    pub async fn set_height(&self, height: f64) -> Result<()> {
        self.link.request("window.setHeight", Some(json!({ "height": height }))).await?;
        Ok(())
    }

    pub async fn set_size(&self, width: f64, height: f64) -> Result<()> {
        self.link.request("window.setSize", Some(json!({ "width": width, "height": height }))).await?;
        Ok(())
    }

    /// 壳进程自身的占用（常驻内存 + 累计 CPU 毫秒）。
    /// 壳没连上 / 老版本壳不认 / 超时：一律 `None`，由调用方退化成「只报内核」。
    pub async fn app_usage(&self) -> Option<AppUsage> {
        if !self.link.is_connected() {
            return None;
        }
        // 800ms：串在 3s 一次的状态条请求里，别用默认 3s 超时拖住整次采样
        let res = self
            .link
            .request_with_timeout("app.usage", Some(json!({})), std::time::Duration::from_millis(800))
            .await
            .ok()?;
        if res.get("ok").and_then(Value::as_bool) == Some(false) {
            return None;
        }
        let rss = res.get("rss").and_then(Value::as_f64)?;
        let cpu_ms = res.get("cpuMs").and_then(Value::as_f64)?;
        if !rss.is_finite() || !cpu_ms.is_finite() || rss <= 0.0 {
            return None;
        }
        Some(AppUsage { rss: rss as i64, cpu_ms: cpu_ms as i64 })
    }

    pub async fn register_hotkey(&self, accelerator: &str) -> HotkeyResult {
        match self.link.request("hotkey.register", Some(json!({ "accelerator": accelerator }))).await {
            Ok(res) => HotkeyResult {
                ok: res.get("ok").and_then(Value::as_bool) != Some(false),
                reason: res.get("reason").and_then(Value::as_str).map(str::to_string),
                accelerator: res.get("accelerator").and_then(Value::as_str).map(str::to_string),
                fallback: res.get("fallback").and_then(Value::as_bool).unwrap_or(false),
            },
            Err(err) => HotkeyResult { ok: false, reason: Some(err.message), accelerator: None, fallback: false },
        }
    }

    pub async fn set_autostart(&self, enabled: bool) -> Result<()> {
        self.link.request("app.setAutostart", Some(json!({ "enabled": enabled }))).await?;
        Ok(())
    }

    /// 订阅 / 取消订阅系统剪贴板变化（plugin-spec §8.1）。
    ///
    /// 壳不支持（非 Windows）时返回 `false` —— 这是**预期内的降级**，不是错误：
    /// 内核据此不订阅，插件则必须能在「从未收到事件」时仍然可用。
    pub async fn clipboard_watch(&self, enabled: bool) -> bool {
        match self.link.request("clipboard.watch", Some(json!({ "enabled": enabled }))).await {
            Ok(res) => res.get("ok").and_then(Value::as_bool).unwrap_or(false),
            Err(_) => false,
        }
    }

    pub async fn set_tray_menu(&self, items: Value) -> Result<()> {
        self.link.request("tray.setMenu", Some(json!({ "items": items }))).await?;
        Ok(())
    }

    pub async fn quit(&self) -> Result<()> {
        self.link.request("app.quit", None).await?;
        Ok(())
    }
}

pub fn assert_http_url(url: &str) -> Result<()> {
    let lower = url.to_lowercase();
    let Some((scheme, _rest)) = lower.split_once(':') else {
        return Err(KernelError::bad_args(format!("非法 URL：{url}")));
    };
    if !ALLOWED_URL_PROTOCOLS.contains(&format!("{scheme}:").as_str()) {
        return Err(KernelError::bad_args(format!("只允许 http/https/mailto：{scheme}:")));
    }
    Ok(())
}

pub fn assert_path(target: &str) -> Result<()> {
    if target.trim().is_empty() {
        return Err(KernelError::bad_args("path 必须是非空字符串"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_guard_allows_only_http_https_mailto() {
        assert!(assert_http_url("https://example.com/a?b=1").is_ok());
        assert!(assert_http_url("http://127.0.0.1:8080").is_ok());
        assert!(assert_http_url("mailto:a@b.com").is_ok());
        assert_eq!(assert_http_url("file:///etc/passwd").unwrap_err().code, "BAD_ARGS");
        assert_eq!(assert_http_url("javascript:alert(1)").unwrap_err().code, "BAD_ARGS");
        assert_eq!(assert_http_url("not-a-url").unwrap_err().code, "BAD_ARGS");
    }

    #[test]
    fn path_guard_rejects_empty() {
        assert!(assert_path("/tmp/x").is_ok());
        assert_eq!(assert_path("   ").unwrap_err().code, "BAD_ARGS");
    }

    #[tokio::test]
    async fn visibility_and_usage_return_none_when_disconnected() {
        let link = ShellLink::new(Arc::new(|_| {}));
        let primitives = Primitives::new(link, Arc::new(AuditLog::new(std::path::Path::new("/tmp/nowhere-primitives"))));
        assert_eq!(primitives.is_visible().await, None, "壳未连接必须返回 None 而不是 false");
        assert!(primitives.app_usage().await.is_none());
    }
}
