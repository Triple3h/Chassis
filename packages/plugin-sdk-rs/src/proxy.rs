//! 出网代理探测：**环境变量 → 系统设置**，给需要访问被墙源的插件用。
//!
//! 为什么需要它：系统代理（macOS「网络 → 代理」里那份，Clash / Surge 等会写进去）是系统级设置，
//! Rust 的 HTTP 客户端不会自动读取 —— 浏览器能上网、插件却连不上 GitHub，就是这里。
//!
//! 优先级（先命中先用）：
//!   1. `HTTPS_PROXY` / `https_proxy` → `ALL_PROXY` / `all_proxy` → `HTTP_PROXY` / `http_proxy`
//!   2. macOS：`scutil --proxy`（HTTPS 代理优先，其次 HTTP 代理）
//!   3. Windows：注册表 `Internet Settings`（`ProxyEnable` + `ProxyServer`）
//!
//! 只认 **HTTP 代理**（`http://host:port`）—— SOCKS 需要客户端专门支持（本仓库的 ureq 没开该特性）、
//! PAC 得执行脚本，一律当作「没探测到」。探测不到 = 直连，与历史行为一致。

use std::collections::HashMap;

/// 探测本机可用的 HTTP 代理（环境变量 → 系统设置）；没有则 `None`（直连）。
pub fn detect() -> Option<String> {
    env_proxy().or_else(system_proxy)
}

/// 环境变量里的代理（跨平台，大小写两种写法都认）。
fn env_proxy() -> Option<String> {
    const KEYS: [&str; 6] =
        ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"];
    KEYS.iter().find_map(|key| std::env::var(key).ok().and_then(|value| normalize(&value)))
}

/// 归一化成 `http://host:port`：`[userinfo@]host:port` 补 scheme；https / socks 等不认（返回 `None`）。
fn normalize(raw: &str) -> Option<String> {
    let value = raw.trim();
    let (scheme, rest) = match value.split_once("://") {
        Some((scheme, rest)) => (Some(scheme), rest),
        None => (None, value),
    };
    if let Some(scheme) = scheme {
        if !scheme.eq_ignore_ascii_case("http") {
            return None;
        }
    }
    let address = rest.trim_end_matches('/');
    if address.is_empty() {
        return None;
    }
    Some(format!("http://{address}"))
}

#[cfg(target_os = "macos")]
fn system_proxy() -> Option<String> {
    let output = std::process::Command::new("/usr/sbin/scutil").arg("--proxy").output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_scutil(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(target_os = "windows")]
fn system_proxy() -> Option<String> {
    // `reg` 是系统自带命令：GUI 启动的进程没有 shell 环境变量，但 System32 在 PATH 里
    let output = std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_windows(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn system_proxy() -> Option<String> {
    // 其余平台只有环境变量这条路（GNOME / KDE 的代理设置没有稳定读取方式）
    None
}

/// 解析 `scutil --proxy` 的输出（形如 `HTTPEnable : 1` + `HTTPProxy : 127.0.0.1` + `HTTPPort : 7897`）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_scutil(raw: &str) -> Option<String> {
    let mut values: HashMap<&str, &str> = HashMap::new();
    for line in raw.lines() {
        if let Some((key, value)) = line.split_once(" : ") {
            values.insert(key.trim(), value.trim());
        }
    }
    for (flag, host_key, port_key) in
        [("HTTPSEnable", "HTTPSProxy", "HTTPSPort"), ("HTTPEnable", "HTTPProxy", "HTTPPort")]
    {
        if values.get(flag) != Some(&"1") {
            continue;
        }
        let (Some(host), Some(port)) = (values.get(host_key), values.get(port_key)) else {
            continue;
        };
        if host.is_empty() || port.is_empty() {
            continue;
        }
        return Some(format!("http://{host}:{port}"));
    }
    None
}

/// 解析 `reg query "…\Internet Settings"` 的输出；`ProxyServer` 也支持按协议分列的 `http=…;https=…`。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_windows(raw: &str) -> Option<String> {
    let mut enabled = false;
    let mut server = None;
    for line in raw.lines() {
        let Some((key, value)) = split_reg_line(line) else {
            continue;
        };
        match key {
            "ProxyEnable" => enabled = value == "0x1" || value == "1",
            "ProxyServer" => server = Some(value.to_string()),
            _ => {}
        }
    }
    if !enabled {
        return None;
    }
    let server = server?;
    let picked = if server.contains('=') {
        // `http=127.0.0.1:7897;https=127.0.0.1:7898`：更新源都是 https，优先 https 项
        let mut https = None;
        let mut http = None;
        for item in server.split(';') {
            let Some((proto, addr)) = item.split_once('=') else {
                continue;
            };
            let addr = addr.trim();
            match proto.trim().to_ascii_lowercase().as_str() {
                "https" => https = https.or(Some(addr.to_string())),
                "http" => http = http.or(Some(addr.to_string())),
                _ => {}
            }
        }
        https.or(http)?
    } else {
        server
    };
    normalize(&picked)
}

/// `    ProxyServer    REG_SZ    127.0.0.1:7897` → `("ProxyServer", "127.0.0.1:7897")`
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn split_reg_line(line: &str) -> Option<(&str, &str)> {
    for kind in ["REG_SZ", "REG_EXPAND_SZ", "REG_DWORD"] {
        if let Some(index) = line.find(kind) {
            let key = line[..index].trim();
            let value = line[index + kind.len()..].trim();
            if key.is_empty() || value.is_empty() {
                return None;
            }
            return Some((key, value));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `scutil --proxy` 的真实输出形状（macOS 26 + Clash Verge）。
    const SCUTIL_ALL: &str = r#"<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : *.local
  }
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}"#;

    #[test]
    fn scutil_prefers_https_proxy() {
        assert_eq!(parse_scutil(SCUTIL_ALL).as_deref(), Some("http://127.0.0.1:7897"));
    }

    #[test]
    fn scutil_falls_back_to_http_proxy() {
        let raw = SCUTIL_ALL.replace("HTTPSEnable : 1", "HTTPSEnable : 0");
        assert_eq!(parse_scutil(&raw).as_deref(), Some("http://127.0.0.1:7897"));
    }

    #[test]
    fn scutil_without_usable_proxy_is_none() {
        // 只有 SOCKS 与 PAC：客户端没开 socks 特性、PAC 无从执行 ⇒ 直连
        let socks_only = SCUTIL_ALL
            .replace("HTTPEnable : 1", "HTTPEnable : 0")
            .replace("HTTPSEnable : 1", "HTTPSEnable : 0");
        assert_eq!(parse_scutil(&socks_only), None);

        // 开关开着但端口缺失 ⇒ 不能拼出 `http://127.0.0.1:` 这种坏地址
        let no_port = SCUTIL_ALL.replace("HTTPPort : 7897", "HTTPPort : ");
        assert_eq!(parse_scutil(&no_port).as_deref(), Some("http://127.0.0.1:7897"), "HTTPS 那条仍然可用");

        assert_eq!(parse_scutil("<dictionary> {\n  ProxyAutoConfigEnable : 1\n}"), None);
        assert_eq!(parse_scutil(""), None);
    }

    const REG_ALL: &str = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7897\r\n    ProxyOverride    REG_SZ    <local>\r\n";

    #[test]
    fn windows_registry_reads_enabled_proxy() {
        assert_eq!(parse_windows(REG_ALL).as_deref(), Some("http://127.0.0.1:7897"));
    }

    #[test]
    fn windows_registry_respects_per_protocol_server() {
        let raw = REG_ALL.replace("127.0.0.1:7897\r", "http=127.0.0.1:7897;https=127.0.0.1:7898\r");
        assert_eq!(parse_windows(&raw).as_deref(), Some("http://127.0.0.1:7898"), "https 项优先");
        let http_only = REG_ALL.replace("127.0.0.1:7897\r", "http=127.0.0.1:7897\r");
        assert_eq!(parse_windows(&http_only).as_deref(), Some("http://127.0.0.1:7897"));
        let socks_only = REG_ALL.replace("127.0.0.1:7897\r", "socks=127.0.0.1:7897\r");
        assert_eq!(parse_windows(&socks_only), None, "只给了 SOCKS ⇒ 视作没有代理");
    }

    #[test]
    fn windows_registry_disabled_or_empty_is_none() {
        assert_eq!(parse_windows(&REG_ALL.replace("0x1", "0x0")), None);
        assert_eq!(parse_windows("HKEY_CURRENT_USER\\Software\r\n"), None);
    }

    #[test]
    fn normalize_accepts_http_only() {
        assert_eq!(normalize("127.0.0.1:7897").as_deref(), Some("http://127.0.0.1:7897"));
        assert_eq!(normalize("http://127.0.0.1:7897/").as_deref(), Some("http://127.0.0.1:7897"));
        assert_eq!(
            normalize("http://user:pass@127.0.0.1:7897").as_deref(),
            Some("http://user:pass@127.0.0.1:7897"),
            "带认证信息的原样保留"
        );
        assert_eq!(normalize("socks5://127.0.0.1:7897"), None, "SOCKS 不认（客户端没开该特性）");
        assert_eq!(normalize("https://127.0.0.1:7897"), None);
        assert_eq!(normalize("http://"), None);
        assert_eq!(normalize("   "), None);
    }

    #[test]
    fn env_proxy_is_picked_up() {
        // 用例内成对设置 / 清理：本机若本来就配了代理，这里设的值优先（HTTPS_PROXY 排第一）
        std::env::set_var("HTTPS_PROXY", "127.0.0.1:7897");
        assert_eq!(env_proxy().as_deref(), Some("http://127.0.0.1:7897"), "无 scheme 也要认");
        std::env::set_var("HTTPS_PROXY", "socks5://127.0.0.1:7897");
        assert_ne!(env_proxy().as_deref(), Some("socks5://127.0.0.1:7897"), "SOCKS 不能被当成可用代理");
        std::env::remove_var("HTTPS_PROXY");
    }
}
