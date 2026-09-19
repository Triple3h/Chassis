//! 端口占用扫描：拿到「谁在监听哪个端口」，再补上进程信息。
//!
//! 平台实现：
//! - **macOS**：`/usr/sbin/lsof` 的**字段模式**（`-F pcn`）—— 这是 lsof 为机器解析提供的输出，
//!   进程名带空格也不会错列（普通表格输出会）；TCP 与 UDP 分两次调用，协议由调用方标定，
//!   因此解析器完全不需要协议字段（也就绕开了 lsof「字段值重复时省略」的粘连问题）。
//! - **Windows**：`netstat -ano`（所有 Windows 自带），一行一个 socket，自带协议 / 状态 / PID。
//! - 其它平台：明确报「不支持」，不做静默降级。
//!
//! 解析器是纯函数（`parse_lsof` / `parse_netstat` / `split_addr_port`），可以脱机单测。

use std::collections::HashSet;

use crate::model::PortEntry;
use crate::procs;

/// 扫描范围：只看监听（TCP LISTEN + UDP bind）
pub const SCOPE_LISTEN: &str = "listen";
/// 扫描范围：全部 socket（含 established 之类的连接）
pub const SCOPE_ALL: &str = "all";

/// 解析出来的原始 socket 记录（还没补进程信息）。
#[derive(Debug, Clone, PartialEq)]
pub struct RawSocket {
    pub pid: i32,
    pub process: String,
    pub address: String,
    pub port: u16,
    pub protocol: String,
    pub state: String,
}

pub fn normalize_scope(raw: &str) -> &'static str {
    if raw == SCOPE_ALL {
        SCOPE_ALL
    } else {
        SCOPE_LISTEN
    }
}

/// 扫描 + 补进程信息 → 最终返回给界面的形态（按端口升序）。
pub fn scan_ports(scope: &str) -> Result<Vec<PortEntry>, String> {
    let scope = normalize_scope(scope);
    let mut sockets = scan_raw(scope)?;
    dedup_sockets(&mut sockets);

    let pids: Vec<i32> = sockets.iter().map(|socket| socket.pid).collect();
    let info = procs::lookup(&pids);

    let mut entries: Vec<PortEntry> = sockets
        .into_iter()
        .map(|socket| {
            let meta = info.get(&socket.pid);
            PortEntry {
                port: socket.port,
                protocol: socket.protocol,
                address: socket.address,
                state: socket.state,
                pid: socket.pid,
                // sysinfo 拿不到全名时回落 lsof 的命令名（后者可能被截断）
                process: meta.map(|m| m.name.clone()).unwrap_or(socket.process),
                user: meta.and_then(|m| m.user.clone()),
                memory: meta.map(|m| m.memory),
                risk: meta.map(|m| m.risk.as_str().to_string()).unwrap_or_else(|| "safe".to_string()),
                self_related: meta.map(|m| m.self_related).unwrap_or(false),
            }
        })
        .collect();
    entries.sort_by(|a, b| a.port.cmp(&b.port).then_with(|| a.pid.cmp(&b.pid)));
    Ok(entries)
}

/// 同一 (协议, 端口, 进程) 只保留一条：IPv4/IPv6 双绑定、或多 fd 复用时去重。
fn dedup_sockets(sockets: &mut Vec<RawSocket>) {
    let mut seen = HashSet::new();
    sockets.retain(|socket| seen.insert((socket.protocol.clone(), socket.port, socket.pid)));
}

// ── 平台扫描 ──────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn scan_raw(scope: &str) -> Result<Vec<RawSocket>, String> {
    let mut sockets = lsof_call(scope, true, "tcp")?;
    sockets.extend(lsof_call(scope, false, "udp")?);
    Ok(sockets)
}

/// 一次 lsof 调用：`tcp=true` 查 TCP（listen 模式下附加 `-sTCP:LISTEN`），否则查 UDP。
///
/// UDP 没有「监听」这个状态（socket 一 bind 就能收包），`-sTCP:LISTEN` 也只作用于 TCP 选择器，
/// 所以 listen 模式 = `-iTCP -sTCP:LISTEN -iUDP` 的语义，这里拆成两次调用更直白。
#[cfg(target_os = "macos")]
fn lsof_call(scope: &str, tcp: bool, protocol: &str) -> Result<Vec<RawSocket>, String> {
    let mut command = std::process::Command::new("/usr/sbin/lsof");
    command.args(["-nP", "-Fpcn"]); // -n 不解析主机名 / -P 不解析端口名 / -F 字段模式
    if tcp {
        command.arg("-iTCP");
        if scope != SCOPE_ALL {
            command.arg("-sTCP:LISTEN");
        }
    } else {
        command.arg("-iUDP");
    }
    let output = command.output().map_err(|err| format!("无法执行 lsof：{err}"))?;
    // lsof 没找到任何条目时退出码是 1（不是错误）；真出不来结果才是问题
    let text = String::from_utf8_lossy(&output.stdout);
    // UDP 没有「监听」这个状态（bind 了就能收包），只有 TCP 的 `-sTCP:LISTEN` 语义配得上它
    let default_state = if tcp && scope != SCOPE_ALL { "listen" } else { "" };
    Ok(parse_lsof(&text, protocol, default_state))
}

#[cfg(windows)]
fn scan_raw(scope: &str) -> Result<Vec<RawSocket>, String> {
    let output = std::process::Command::new("netstat")
        .args(["-ano"])
        .output()
        .map_err(|err| format!("无法执行 netstat：{err}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut sockets = parse_netstat(&text);
    if scope != SCOPE_ALL {
        // listen 模式：TCP 只看 LISTENING，UDP 全保留（没有状态概念）
        sockets.retain(|socket| socket.protocol == "udp" || socket.state == "listen");
    }
    Ok(sockets)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn scan_raw(_scope: &str) -> Result<Vec<RawSocket>, String> {
    Err("当前平台暂不支持端口扫描（已支持 macOS 与 Windows）".to_string())
}

// ── 解析器（纯函数） ──────────────────────────────────────────────────

/// 解析 `lsof -Fpcn` 的字段输出。字段含义：`p` = PID、`c` = 命令名、`n` = 地址。
///
/// lsof 的字段输出是「变化才输出」的增量流（同名进程的 `c` 可能省略），所以这里对 `process`
/// 采取沿用语义 —— 这正是 lsof 省略字段的含义（值没变）。
pub fn parse_lsof(text: &str, protocol: &str, default_state: &str) -> Vec<RawSocket> {
    let mut sockets = Vec::new();
    let mut pid: i32 = 0;
    let mut process = String::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let (tag, rest) = line.split_at(1);
        match tag {
            "p" => {
                pid = rest.trim().parse().unwrap_or(0);
            }
            "c" => {
                process = rest.to_string();
            }
            "n" => {
                if pid <= 0 {
                    continue;
                }
                let name = rest.trim();
                // 全量模式下连接是 `本地->对端` 的形式，只在「本地端」登记
                let local = name.split("->").next().unwrap_or(name);
                let Some((address, port)) = split_addr_port(local) else { continue };
                let state = if name.contains("->") { "established" } else { default_state };
                sockets.push(RawSocket {
                    pid,
                    process: process.clone(),
                    address,
                    port,
                    protocol: protocol.to_string(),
                    state: state.to_string(),
                });
            }
            _ => {}
        }
    }
    sockets
}

/// 解析 `netstat -ano`：`TCP  0.0.0.0:135  0.0.0.0:0  LISTENING  1234` 这样的数据行。
///
/// 表头行（中英文都算）与汇总行第一列不是协议名，会被直接跳过。
pub fn parse_netstat(text: &str) -> Vec<RawSocket> {
    let mut sockets = Vec::new();
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let Some(protocol) = fields.next() else { continue };
        let protocol = protocol.to_ascii_lowercase();
        if protocol != "tcp" && protocol != "udp" {
            continue;
        }
        let Some(local) = fields.next() else { continue };
        let _remote = fields.next();
        let rest: Vec<&str> = fields.collect();
        // TCP 行：状态 + PID；UDP 行没有状态列，PID 直接跟在远程地址后
        let (state, pid_text) = if protocol == "tcp" {
            (normalize_state(rest.first().copied().unwrap_or("")), rest.get(1).copied().unwrap_or(""))
        } else {
            (String::new(), rest.first().copied().unwrap_or(""))
        };
        let Ok(pid) = pid_text.parse::<i32>() else { continue };
        let Some((address, port)) = split_addr_port(local) else { continue };
        sockets.push(RawSocket { pid, process: String::new(), address, port, protocol, state });
    }
    sockets
}

fn normalize_state(raw: &str) -> String {
    match raw.to_ascii_lowercase().as_str() {
        "listening" => "listen".to_string(),
        other => other.to_string(),
    }
}

/// `*:3000` / `[::1]:5173` / `127.0.0.1:8080` → `("*" | "::1" | "127.0.0.1", 端口号)`。
///
/// 从右往左找最后一个冒号（IPv6 地址本身带冒号，方括号是 lsof / netstat 的分界标记）。
pub fn split_addr_port(text: &str) -> Option<(String, u16)> {
    let text = text.trim();
    let (address, port) = text.rsplit_once(':')?;
    let port: u16 = port.trim().parse().ok()?;
    let address = address.trim().trim_start_matches('[').trim_end_matches(']');
    if address.is_empty() {
        return None;
    }
    Some((address.to_string(), port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_addr_port_handles_v4_v6_wildcard() {
        assert_eq!(split_addr_port("*:3000"), Some(("*".to_string(), 3000)));
        assert_eq!(split_addr_port("127.0.0.1:5173"), Some(("127.0.0.1".to_string(), 5173)));
        assert_eq!(split_addr_port("[::1]:8080"), Some(("::1".to_string(), 8080)));
        assert_eq!(split_addr_port("[::]:80"), Some(("::".to_string(), 80)));
        assert_eq!(split_addr_port("0.0.0.0:0"), Some(("0.0.0.0".to_string(), 0)));
        assert_eq!(split_addr_port("bad"), None);
        assert_eq!(split_addr_port("noport:"), None);
        assert_eq!(split_addr_port(":3000"), None, "没有地址的条目丢弃");
    }

    #[test]
    fn lsof_field_output_is_parsed() {
        let text = "p1234\ncnode\nn*:3000\nn127.0.0.1:5173\np4321\ncnginx\nn*:80\n";
        let sockets = parse_lsof(text, "tcp", "listen");
        assert_eq!(sockets.len(), 3);
        assert_eq!(sockets[0].pid, 1234);
        assert_eq!(sockets[0].process, "node");
        assert_eq!(sockets[0].port, 3000);
        assert_eq!(sockets[0].address, "*");
        assert_eq!(sockets[0].state, "listen");
        assert_eq!(sockets[1].port, 5173);
        assert_eq!(sockets[2].process, "nginx");
    }

    #[test]
    fn lsof_omitted_command_name_is_carried_over() {
        // lsof 对同名进程会省略 c 字段（值没变）—— 沿用上一个名字才是正确解析
        let text = "p111\ncnode\nn*:3000\np222\nn*:3001\n";
        let sockets = parse_lsof(text, "tcp", "listen");
        assert_eq!(sockets.len(), 2);
        assert_eq!(sockets[1].process, "node");
        assert_eq!(sockets[1].pid, 222);
    }

    #[test]
    fn lsof_established_keeps_only_local_end() {
        let text = "p999\ncnode\nn127.0.0.1:52345->127.0.0.1:3000\n";
        let sockets = parse_lsof(text, "tcp", "");
        assert_eq!(sockets.len(), 1);
        assert_eq!(sockets[0].address, "127.0.0.1");
        assert_eq!(sockets[0].port, 52345, "端口是本地端，不是对端");
        assert_eq!(sockets[0].state, "established");
    }

    #[test]
    fn lsof_ignores_entries_without_pid() {
        let text = "cnode\nn*:3000\n";
        assert!(parse_lsof(text, "tcp", "listen").is_empty());
    }

    #[test]
    fn netstat_output_is_parsed_and_state_normalized() {
        let text = "\
活动连接\n\
  协议  本地地址          外部地址        状态           PID\n\
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1136\n\
  TCP    127.0.0.1:5173         127.0.0.1:52000        ESTABLISHED     23456\n\
  TCP    [::]:445               [::]:0                 LISTENING       4\n\
  UDP    0.0.0.0:500            *:*                                    1234\n\
  UDP    [::]:5353              *:*                                    987\n";
        let sockets = parse_netstat(text);
        assert_eq!(sockets.len(), 5);
        assert_eq!(sockets[0].protocol, "tcp");
        assert_eq!(sockets[0].state, "listen");
        assert_eq!(sockets[0].pid, 1136);
        assert_eq!(sockets[0].port, 135);
        assert_eq!(sockets[1].state, "established");
        assert_eq!(sockets[2].address, "::");
        assert_eq!(sockets[3].protocol, "udp");
        assert_eq!(sockets[3].state, "");
        assert_eq!(sockets[3].pid, 1234);
        assert_eq!(sockets[4].port, 5353);
    }

    #[test]
    fn netstat_skips_table_headers() {
        let text = "Proto  Local Address  Foreign Address  State  PID\n";
        assert!(parse_netstat(text).is_empty());
    }

    #[test]
    fn udp_entries_never_claim_listen_state() {
        // lsof 调用方对 UDP 传空 default_state；这里的契约是「协议不带状态时 state 为空」
        let sockets = parse_lsof("p1\ncfoo\nn*:5353\n", "udp", "");
        assert_eq!(sockets[0].state, "");
        assert_eq!(sockets[0].protocol, "udp");
    }

    #[test]
    fn dedup_merges_dual_stack_bindings() {
        let mut sockets = vec![
            RawSocket { pid: 1, process: "n".into(), address: "*".into(), port: 3000, protocol: "tcp".into(), state: "listen".into() },
            RawSocket { pid: 1, process: "n".into(), address: "::".into(), port: 3000, protocol: "tcp".into(), state: "listen".into() },
            RawSocket { pid: 1, process: "n".into(), address: "*".into(), port: 3000, protocol: "udp".into(), state: "".into() },
        ];
        dedup_sockets(&mut sockets);
        assert_eq!(sockets.len(), 2, "同协议同端口同进程去重；不同协议保留");
    }
}
