//! 系统 hosts 文件的读写（v1 `src/no-view/_hosts-file.ts` 的 Rust 版）。
//!
//! 写的是什么：调用方给的是**托管区文本**（`# >>> host-manager >>>` … `# <<< host-manager <<<`），
//! 这一层现读一遍磁盘、只把标记之间那一段换掉（`splice_region`）——
//! 系统行、VPN 启动时自己加的行都在区外，逐字节原样留着。
//!
//! 安全边界（这一层能改系统文件，必须自己收紧）：
//!   1. **目标路径不可由调用方指定** —— 只认 `LAUNCHER_HOSTS_PATH`（测试用）与平台默认值。
//!      否则「支持提权写文件」的脚本就成了任意文件写入的跳板。
//!   2. 写入前先备份，写入后回读校验；内容为空、或算出来与磁盘一致（没有改动）都不写。
//!   3. 提权一律走系统自带对话框（osascript / pkexec / UAC），不自己存密码。
//!   4. 备份、待生效文件只落 `data_path`（N2）：安装目录是只读的，升级/重装会覆盖它。

use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const REGION_BEGIN: &str = "# >>> host-manager >>>";
pub const REGION_END: &str = "# <<< host-manager <<<";
/// 提权对话框可能等用户输密码，给足时间
pub const ELEVATE_TIMEOUT_MS: u64 = 120_000;
const MAX_HOSTS_BYTES: u64 = 4 * 1024 * 1024;
const KEEP_BACKUPS: usize = 30;
const BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

// ── 行模型（v1 `hosts.ts` 的 splitKeepEol）──────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub text: String,
    pub nl: String,
}

/// 按 `\n` 切行并保留行尾（`\r\n` 也认）；最后一行没有换行符时 `nl` 为空串。
pub fn split_keep_eol(text: &str) -> Vec<Row> {
    let bytes = text.as_bytes();
    let mut rows = Vec::new();
    let mut start = 0usize;
    for index in 0..bytes.len() {
        if bytes[index] != b'\n' {
            continue;
        }
        let crlf = index > start && bytes[index - 1] == b'\r';
        let text_end = if crlf { index - 1 } else { index };
        rows.push(Row {
            text: text[start..text_end].to_string(),
            nl: if crlf { "\r\n" } else { "\n" }.to_string(),
        });
        start = index + 1;
    }
    if start < bytes.len() {
        rows.push(Row { text: text[start..].to_string(), nl: String::new() });
    }
    rows
}

pub fn join_rows(rows: &[Row]) -> String {
    let mut out = String::new();
    for row in rows {
        out.push_str(&row.text);
        out.push_str(&row.nl);
    }
    out
}

/// 文件主换行符：`\r\n` 出现次数多于裸 `\n` 时用 CRLF（v1 同款）。
pub fn detect_eol(text: &str) -> &'static str {
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let bytes = text.as_bytes();
    for index in 0..bytes.len() {
        if bytes[index] == b'\n' {
            if index > 0 && bytes[index - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
    }
    if crlf > lf {
        "\r\n"
    } else {
        "\n"
    }
}

// ── 托管区（v1 `blocks.ts` 的 splitRegion / spliceRegion / removeOutsideLines）──

#[derive(Debug, Clone, PartialEq)]
pub struct RegionParts {
    pub found: bool,
    pub head: String,
    pub region: String,
    pub tail: String,
}

pub fn split_region(file_text: &str) -> RegionParts {
    let rows = split_keep_eol(file_text);
    let mut begin: Option<usize> = None;
    let mut end: Option<usize> = None;
    for (index, row) in rows.iter().enumerate() {
        let text = row.text.trim();
        if begin.is_none() && text == REGION_BEGIN {
            begin = Some(index);
            continue;
        }
        if begin.is_some() && end.is_none() && text == REGION_END {
            end = Some(index);
            break;
        }
    }
    let Some(begin) = begin else {
        return RegionParts { found: false, head: file_text.to_string(), region: String::new(), tail: String::new() };
    };
    RegionParts {
        found: true,
        head: join_rows(&rows[..begin]),
        region: join_rows(&rows[begin..end.map_or(rows.len(), |value| value + 1)]),
        tail: join_rows(end.map_or(&[][..], |value| &rows[value + 1..])),
    }
}

/// 区外两段 + 托管区三段拼接：托管区前后各保证一个空行分隔，已有的不重复补。
fn with_separators(mut head: Vec<Row>, region: Vec<Row>, tail: Vec<Row>, eol: &str) -> Vec<Row> {
    if region.is_empty() {
        head.extend(tail);
        return head;
    }
    let mut out = head;
    // 文件末尾没有换行符时先补上，否则标记会粘在最后一行后面
    if let Some(last) = out.last_mut() {
        if last.nl.is_empty() {
            last.nl = eol.to_string();
        }
    }
    let last_trimmed = out.last().map(|row| !row.text.trim().is_empty()).unwrap_or(false);
    if !out.is_empty() && last_trimmed {
        out.push(Row { text: String::new(), nl: eol.to_string() });
    }
    out.extend(region);
    let first_tail_trimmed = tail.first().map(|row| !row.text.trim().is_empty()).unwrap_or(false);
    if first_tail_trimmed {
        out.push(Row { text: String::new(), nl: eol.to_string() });
    }
    out.extend(tail);
    out
}

/// 把托管区换成 `region`（空串 = 移除托管区）；区外内容原样保留。
pub fn splice_region(file_text: &str, region: &str) -> String {
    let parts = split_region(file_text);
    let eol = detect_eol(file_text);
    let head_source = if parts.found { parts.head.as_str() } else { file_text };
    let tail_source = if parts.found { parts.tail.as_str() } else { "" };
    join_rows(&with_separators(
        split_keep_eol(head_source),
        split_keep_eol(region),
        split_keep_eol(tail_source),
        eol,
    ))
}

/// 从**托管区之外**删掉指定的行（逐字匹配、每行最多删一次）。
///
/// 对不上的行静默跳过 —— 宁可那条记录留在外面，也不能误删一行别人的东西。
pub fn remove_outside_lines(file_text: &str, remove: &[String]) -> String {
    if remove.is_empty() {
        return file_text.to_string();
    }
    let parts = split_region(file_text);
    let mut drop_list: Vec<String> = remove.to_vec();
    let mut filter = |text: &str| -> String {
        if drop_list.is_empty() || text.is_empty() {
            return text.to_string();
        }
        let kept: Vec<Row> = split_keep_eol(text)
            .into_iter()
            .filter(|row| {
                let whole = format!("{}{}", row.text, row.nl);
                match drop_list.iter().position(|item| item == &whole) {
                    Some(index) => {
                        drop_list.remove(index);
                        false
                    }
                    None => true,
                }
            })
            .collect();
        join_rows(&kept)
    };
    let head = filter(&parts.head);
    let tail = filter(&parts.tail);
    format!("{head}{}{tail}", parts.region)
}

// ── 路径 ────────────────────────────────────────────────────────

fn home_dir() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/"))
}

/// 展开开头的 `~`（用户写 `LAUNCHER_HOSTS_PATH` 时习惯这么写）。
fn expand_home(input: &str) -> PathBuf {
    if input == "~" {
        return home_dir();
    }
    if let Some(rest) = input.strip_prefix("~/").or_else(|| input.strip_prefix("~\\")) {
        return home_dir().join(rest);
    }
    PathBuf::from(input)
}

/// 系统 hosts 路径（可用环境变量覆盖，测试与自定义安装场景用）。
pub fn resolve_hosts_path() -> PathBuf {
    if let Ok(override_value) = std::env::var("LAUNCHER_HOSTS_PATH") {
        let trimmed = override_value.trim();
        if !trimmed.is_empty() {
            return expand_home(trimmed);
        }
    }
    if cfg!(target_os = "windows") {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        return PathBuf::from(root).join("System32").join("drivers").join("etc").join("hosts");
    }
    PathBuf::from("/etc/hosts")
}

pub fn platform_string() -> String {
    match std::env::consts::OS {
        "macos" => "darwin".to_string(),
        "windows" => "win32".to_string(),
        other => other.to_string(),
    }
}

pub fn backup_dir_of(data_path: &Path) -> PathBuf {
    data_path.join("backups")
}

// ── 编解码（BOM + UTF-8 / 逐字节 latin1）────────────────────────

/// 合法 UTF-8 就按 utf8；否则逐字节映射（latin1 往返无损，中文显示成乱码但绝不会写坏文件）。
fn decode_bytes(bytes: &[u8]) -> (String, bool, bool) {
    let (bom, body) = if bytes.starts_with(&BOM) { (true, &bytes[BOM.len()..]) } else { (false, bytes) };
    match std::str::from_utf8(body) {
        Ok(text) => (text.to_string(), bom, false),
        Err(_) => (body.iter().map(|byte| *byte as char).collect(), bom, true),
    }
}

fn encode_text(text: &str, bom: bool, binary: bool) -> Vec<u8> {
    let mut out = Vec::new();
    if bom {
        out.extend_from_slice(&BOM);
    }
    if binary {
        for ch in text.chars() {
            out.push(ch as u8);
        }
    } else {
        out.extend_from_slice(text.as_bytes());
    }
    out
}

// ── 读 ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub name: String,
    pub size: u64,
    pub mtime: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostsReadResult {
    pub ok: bool,
    pub path: String,
    pub content: String,
    pub size: u64,
    pub mtime: i64,
    pub bom: bool,
    /// binary 表示文件不是合法 UTF-8，内容按字节直译，中文注释会显示异常
    pub encoding: &'static str,
    /// 当前进程有没有直接写权限；false 表示保存时需要提权
    pub writable: bool,
    pub platform: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backups: Option<Vec<BackupInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn empty_read_result(target: &Path, error: Option<String>) -> HostsReadResult {
    HostsReadResult {
        ok: false,
        path: target.to_string_lossy().to_string(),
        content: String::new(),
        size: 0,
        mtime: 0,
        bom: false,
        encoding: "utf8",
        writable: false,
        platform: platform_string(),
        backups: None,
        error,
    }
}

fn mtime_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// 当前进程对目标文件可不可写（access(2)，按真实用户判断，不看权限位）。
pub fn is_writable(path: &Path) -> bool {
    use std::ffi::CString;
    let Ok(raw) = CString::new(path.as_os_str().as_encoded_bytes()) else { return false };
    // access(2)：与 v1 的 accessSync(target, W_OK) 等价
    unsafe { libc::access(raw.as_ptr(), libc::W_OK) == 0 }
}

pub fn read_hosts_file(target: Option<&Path>) -> HostsReadResult {
    let target = target.map(PathBuf::from).unwrap_or_else(resolve_hosts_path);
    if !target.exists() {
        return empty_read_result(&target, Some(format!("文件不存在：{}", target.display())));
    }
    let Ok(metadata) = std::fs::metadata(&target) else {
        return empty_read_result(&target, Some("无法读取文件信息".to_string()));
    };
    if metadata.len() > MAX_HOSTS_BYTES {
        let mut result = empty_read_result(&target, None);
        result.size = metadata.len();
        result.error = Some(format!("文件异常大（{:.1}MB），已拒绝读取", metadata.len() as f64 / 1_048_576.0));
        return result;
    }
    let Ok(bytes) = std::fs::read(&target) else {
        return empty_read_result(&target, Some("读取失败".to_string()));
    };
    let (text, bom, binary) = decode_bytes(&bytes);
    HostsReadResult {
        ok: true,
        path: target.to_string_lossy().to_string(),
        content: text,
        size: bytes.len() as u64,
        mtime: mtime_ms(&target),
        bom,
        encoding: if binary { "binary" } else { "utf8" },
        writable: is_writable(&target),
        platform: platform_string(),
        backups: None,
        error: None,
    }
}

// ── 备份 ────────────────────────────────────────────────────────

fn is_backup_name(name: &str) -> bool {
    // `^hosts-[\w.-]+\.txt$`：备份名来自 UI，必须挡掉路径穿越
    let Some(rest) = name.strip_prefix("hosts-") else { return false };
    let Some(stem) = rest.strip_suffix(".txt") else { return false };
    !stem.is_empty()
        && stem.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.')
}

pub fn list_backups(data_path: &Path) -> Vec<BackupInfo> {
    let dir = backup_dir_of(data_path);
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_backup_name(&name) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else { continue };
        out.push(BackupInfo { name: name.clone(), size: metadata.len(), mtime: mtime_ms(&entry.path()) });
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out
}

pub fn read_backup(data_path: &Path, name: &str) -> Result<String, String> {
    if !is_backup_name(name) {
        return Err("备份文件名不合法".to_string());
    }
    std::fs::read_to_string(backup_dir_of(data_path).join(name)).map_err(|err| err.to_string())
}

/// 备份当前文件，返回备份名；原文件不存在则返回 None。
pub fn backup_hosts(data_path: &Path, target: &Path) -> Result<Option<(String, PathBuf)>, String> {
    if !target.exists() {
        return Ok(None);
    }
    let dir = backup_dir_of(data_path);
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let stamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S-%3fZ").to_string();
    let mut name = format!("hosts-{stamp}.txt");
    // 同一毫秒内连写两次时，时间戳文件名会撞车 —— 撞了就加序号，别互相覆盖
    let mut seq = 2;
    while dir.join(&name).exists() {
        name = format!("hosts-{stamp}-{seq}.txt");
        seq += 1;
    }
    let dest = dir.join(&name);
    std::fs::copy(target, &dest).map_err(|err| err.to_string())?;

    let all = list_backups(data_path);
    for old in all.into_iter().skip(KEEP_BACKUPS) {
        let _ = std::fs::remove_file(dir.join(&old.name));
    }
    Ok(Some((name, dest)))
}

// ── 提权 ────────────────────────────────────────────────────────

/// shell 单引号转义：路径里有空格、引号都安全。
fn shq(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn psq(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn manual_command(pending: &Path, target: &Path) -> String {
    let pending = pending.to_string_lossy();
    let target = target.to_string_lossy();
    if cfg!(target_os = "windows") {
        return format!("Copy-Item -Force {} {}", psq(&pending), psq(&target));
    }
    format!("sudo cp {} {} && sudo chmod 644 {}", shq(&pending), shq(&target), shq(&target))
}

/// 走系统自带对话框提权（macOS osascript / Linux pkexec / Windows UAC）。
///
/// 阻塞式调用（v1 是 `execFileSync`）：单次执行、最长 120s，超时由 `kill_on_drop` 收尾。
pub fn elevate(pending: &Path, target: &Path) -> Result<(), String> {
    let pending = pending.to_string_lossy().to_string();
    let target = target.to_string_lossy().to_string();

    if cfg!(target_os = "macos") {
        let shell = format!("/bin/cp {} {} && /bin/chmod 644 {}", shq(&pending), shq(&target), shq(&target));
        // `serde_json` 的字符串字面量恰好是合法的 AppleScript 字符串（转义规则一致，与 v1 同款技巧）
        let script = format!("do shell script {} with administrator privileges", serde_json::to_string(&shell).unwrap_or_default());
        let mut process = std::process::Command::new("/usr/bin/osascript");
        process.arg("-e").arg(script);
        return run_blocking(process, Duration::from_millis(ELEVATE_TIMEOUT_MS));
    }
    if cfg!(target_os = "windows") {
        // 内层命令转成 UTF-16LE base64，绕开 Start-Process 参数重新拼接的引号地狱
        let inner = format!("Copy-Item -LiteralPath {} -Destination {} -Force", psq(&pending), psq(&target));
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(utf16le_bytes(&inner));
        let outer = format!(
            "Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList '-NoProfile','-EncodedCommand','{encoded}'"
        );
        let mut process = std::process::Command::new("powershell.exe");
        process.args(["-NoProfile", "-NonInteractive", "-Command", &outer]);
        return run_blocking(process, Duration::from_millis(ELEVATE_TIMEOUT_MS));
    }
    let mut process = std::process::Command::new("/usr/bin/pkexec");
    process.args(["/bin/cp", &pending, &target]);
    run_blocking(process, Duration::from_millis(ELEVATE_TIMEOUT_MS))
}

fn utf16le_bytes(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 2);
    for unit in text.encode_utf16() {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

/// 跑一个子进程（阻塞），超时/失败都回 stderr 文本（v1 的 `stderrOf`）。
fn run_blocking(command: std::process::Command, timeout: Duration) -> Result<(), String> {
    let label = command.get_program().to_string_lossy().to_string();
    let args: Vec<String> = command.get_args().map(|arg| arg.to_string_lossy().to_string()).collect();
    // 用 tokio 的 timeout + kill_on_drop 收尾：超时不会留下孤儿进程
    let runtime = crate::runtime();
    runtime.block_on(async move {
        let child = match tokio::process::Command::new(&label).args(&args).kill_on_drop(true).spawn() {
            Ok(child) => child,
            Err(err) => return Err(err.to_string()),
        };
        match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Ok(Ok(output)) => {
                if output.status.success() {
                    Ok(())
                } else {
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    Err(if stderr.is_empty() { format!("退出码 {}", output.status.code().unwrap_or(-1)) } else { stderr })
                }
            }
            Ok(Err(err)) => Err(err.to_string()),
            Err(_) => Err("提权命令超时".to_string()),
        }
    })
}

/// SDK 是纯 std 线程模型：需要并发/超时的插件自建一份 runtime（与 file-search 同款）。
pub fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("创建插件 runtime 失败")
    })
}

// ── 写入权限：免授权（ACL）──────────────────────────────────────
//
// 背景：macOS 的 /etc/hosts 属 root:wheel 644，写一次弹一次系统授权框。
// uTools / SwitchHosts 那类工具之所以「不弹窗」，不是绕过了权限系统，而是**一次性**
// 把文件的写权限授给当前账户（Windows = 文件属性里勾「写入」；macOS = POSIX ACL
// `chmod +a`），之后以普通用户身份直写。这里走同一条路：
// 授权一次 → 之后保存不再弹窗；随时可撤销，恢复系统默认。
//
// 安全边界：ACL 一开，任何以该用户身份运行的程序都能改 hosts（DNS 劫持的常见落脚点）。
// 所以要是个**显式开关**（UI 里写清楚、能一键撤回），不是悄悄做的默认行为。

/// `chmod +a` 用的 ACL 文本（macOS 实测接受 `user:<name> allow write` 这种写法）。
pub fn write_acl_entry(username: &str) -> String {
    format!("user:{username} allow write")
}

/// 当前登录用户名：取进程 euid 对应的账户名，取不到再回落到环境变量。
///
/// **必须在插件进程（普通用户身份）里解析**：提权后的 shell 里 `$(whoami)` 是 root，
/// 拼进 ACL 就成了「给 root 加权限」——等于白做。
pub fn current_username() -> Option<String> {
    #[cfg(unix)]
    if let Some(name) = unix_username() {
        return Some(name);
    }
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(unix)]
fn unix_username() -> Option<String> {
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    let mut scratch = vec![0u8; 1024];
    let status = unsafe {
        libc::getpwuid_r(
            libc::geteuid(),
            &mut entry,
            scratch.as_mut_ptr() as *mut libc::c_char,
            scratch.len(),
            &mut found,
        )
    };
    if status != 0 || found.is_null() || entry.pw_name.is_null() {
        return None;
    }
    let text = unsafe { std::ffi::CStr::from_ptr(entry.pw_name) }.to_str().ok()?;
    let name = text.trim();
    if name.is_empty() {
        return None;
    }
    Some(name.to_string())
}

/// 目标文件的 ACL 里有没有本插件加的那条（`/bin/ls -le` 只读检测，不需要提权）。
pub fn has_write_acl(target: &Path, username: &str) -> bool {
    if cfg!(target_os = "windows") {
        return false;
    }
    let Ok(output) = std::process::Command::new("/bin/ls").arg("-le").arg(target).output() else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let needle = write_acl_entry(username);
    String::from_utf8_lossy(&output.stdout).lines().any(|line| line.contains(&needle))
}

/// 提权加 / 撤 ACL（macOS 走 osascript 系统授权框，Linux 走 pkexec）。
///
/// 幂等：目标状态已经达成（grant 时已有 / revoke 时本来就没有）时不弹框、直接成功 ——
/// `chmod -a` 删不存在的条目会以 "No ACL present" 退出，靠这层判断绕开。
///
/// 返回「是否真的执行了提权命令」（false = 已经是目标状态）。
pub fn apply_write_acl(target: &Path, grant: bool) -> Result<bool, String> {
    let username = current_username().ok_or_else(|| "取不到当前用户名，无法设置写入权限".to_string())?;
    if has_write_acl(target, &username) == grant {
        return Ok(false);
    }
    if cfg!(target_os = "windows") {
        return Err("Windows 上暂不支持「免授权写入」（M6 平台化时用 icacls 补上）".to_string());
    }
    let flag = if grant { "+a" } else { "-a" };
    let entry = write_acl_entry(&username);
    let target_text = target.to_string_lossy().to_string();

    if cfg!(target_os = "macos") {
        let shell = format!("/bin/chmod {flag} {} {}", shq(&entry), shq(&target_text));
        // `serde_json` 的字符串字面量恰好是合法的 AppleScript 字符串（与 elevate 同款技巧）
        let script = format!("do shell script {} with administrator privileges", serde_json::to_string(&shell).unwrap_or_default());
        let mut process = std::process::Command::new("/usr/bin/osascript");
        process.arg("-e").arg(script);
        run_blocking(process, Duration::from_millis(ELEVATE_TIMEOUT_MS))?;
        return Ok(true);
    }
    let mut process = std::process::Command::new("/usr/bin/pkexec");
    process.args(["/bin/chmod", flag, &entry, &target_text]);
    run_blocking(process, Duration::from_millis(ELEVATE_TIMEOUT_MS))?;
    Ok(true)
}

/// 展示用的等价命令（面板里写「自己动手也可以这么做」）。
pub fn permission_command(target: &Path, grant: bool, username: &str) -> String {
    let entry = write_acl_entry(username);
    let target_text = target.to_string_lossy();
    if cfg!(target_os = "windows") {
        let verb = if grant { "/grant" } else { "/remove" };
        return format!("icacls {} {verb} \"%USERNAME%:(W)\"", psq(&target_text));
    }
    let flag = if grant { "+a" } else { "-a" };
    format!("/bin/chmod {flag} {} {}", shq(&entry), shq(&target_text))
}

// ── 写 ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOptions {
    /// 要写进去的托管区文本（含首尾标记；空串 = 移除托管区）
    #[serde(default)]
    pub region: String,
    /// 顺带从**托管区之外**删掉的行（逐字匹配）
    #[serde(default)]
    pub remove: Vec<String>,
    #[serde(skip)]
    pub data_path: PathBuf,
    /// 仅供测试注入；正常运行永远用 `resolve_hosts_path()`
    #[serde(skip)]
    pub target: Option<PathBuf>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub backup: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostsWriteResult {
    pub ok: bool,
    pub method: &'static str,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn verify(target: &Path, expected: &[u8]) -> bool {
    std::fs::read(target).map(|actual| actual == expected).unwrap_or(false)
}

pub fn write_hosts_file(opts: &WriteOptions) -> HostsWriteResult {
    let target = opts.target.clone().unwrap_or_else(resolve_hosts_path);
    let mode = opts.mode.clone().unwrap_or_else(|| "auto".to_string());
    let mut result = HostsWriteResult {
        ok: false,
        method: "none",
        path: target.to_string_lossy().to_string(),
        changed: None,
        backup: None,
        backup_path: None,
        pending_path: None,
        command: None,
        verified: None,
        error: None,
    };

    // 保留原文件的编码与 BOM：先探一次
    let before = read_hosts_file(Some(&target));
    let (bom, binary) = if before.ok {
        (before.bom, before.encoding == "binary")
    } else if target.exists() {
        // 文件在、但读不出来（超大 / 权限异常）：不冒险覆盖它
        result.error = Some(before.error.unwrap_or_else(|| "无法读取目标文件，已中止写入".to_string()));
        return result;
    } else {
        (false, false)
    };

    // 只换托管区：区外内容（系统行 / 别的程序写的行）逐字节原样保留
    let current = if before.ok { before.content } else { String::new() };
    let next = splice_region(&remove_outside_lines(&current, &opts.remove), &opts.region);
    if next == current {
        // 托管区与磁盘上的一致：不写、不备份、不弹授权框
        result.ok = true;
        result.changed = Some(false);
        return result;
    }
    if next.trim().is_empty() {
        result.error = Some("内容为空，已阻止写入（空 hosts 会让本机解析全部失效）".to_string());
        return result;
    }

    let data = encode_text(&next, bom, binary);

    if opts.backup != Some(false) {
        match backup_hosts(&opts.data_path, &target) {
            Ok(Some((name, path))) => {
                result.backup = Some(name);
                result.backup_path = Some(path.to_string_lossy().to_string());
            }
            Ok(None) => {}
            Err(err) => {
                result.error = Some(format!("备份失败，已中止写入：{err}"));
                return result;
            }
        }
    }

    if mode != "privileged" {
        match std::fs::write(&target, &data) {
            Ok(()) => {
                result.ok = true;
                result.method = "direct";
                result.changed = Some(true);
                result.verified = Some(verify(&target, &data));
                return result;
            }
            Err(err) => {
                let permission_denied = err.kind() == std::io::ErrorKind::PermissionDenied;
                if !permission_denied {
                    result.error = Some(err.to_string());
                    return result;
                }
                if mode == "direct" {
                    result.error = Some("当前进程没有写权限，可改用「管理员写入」重试".to_string());
                    return result;
                }
            }
        }
    }

    // 提权路径：先把内容落到数据目录，再让系统对话框以管理员身份拷过去
    let pending = opts.data_path.join("pending-hosts.txt");
    if let Err(err) = std::fs::create_dir_all(&opts.data_path).and_then(|()| std::fs::write(&pending, &data)) {
        result.error = Some(format!("无法写入待生效文件：{err}"));
        return result;
    }

    if let Err(detail) = elevate(&pending, &target) {
        let canceled = detail.to_lowercase().contains("user canceled")
            || detail.to_lowercase().contains("user cancelled")
            || detail.contains("-128");
        result.method = "manual";
        result.pending_path = Some(pending.to_string_lossy().to_string());
        result.command = Some(manual_command(&pending, &target));
        result.error = Some(if canceled { "已取消管理员授权".to_string() } else { format!("提权失败：{}", if detail.is_empty() { "未知原因" } else { &detail }) });
        return result;
    }

    let verified = verify(&target, &data);
    result.ok = verified;
    result.method = "privileged";
    result.changed = Some(true);
    result.verified = Some(verified);
    if !verified {
        result.error = Some("提权命令执行完了，但回读内容与预期不一致，请到备份里确认".to_string());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("host-mgr-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn split_and_join_keep_eol() {
        let rows = split_keep_eol("a\r\nb\nc");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], Row { text: "a".to_string(), nl: "\r\n".to_string() });
        assert_eq!(rows[1], Row { text: "b".to_string(), nl: "\n".to_string() });
        assert_eq!(rows[2], Row { text: "c".to_string(), nl: String::new() });
        assert_eq!(join_rows(&rows), "a\r\nb\nc");
        assert_eq!(detect_eol("a\r\nb\r\n"), "\r\n");
        assert_eq!(detect_eol("a\nb\n"), "\n");
    }

    #[test]
    fn splice_replaces_region_and_keeps_outside_byte_for_byte() {
        let file = "# system line\n10.1.1.1 vpn.example\n\n# >>> host-manager >>>\n10.0.0.1 old\n# <<< host-manager <<<\n\n# tail comment\n";
        let region = "# >>> host-manager >>>\n10.0.0.2 new\n# <<< host-manager <<<\n";
        let next = splice_region(file, region);
        assert!(next.contains("# system line"), "区外系统行必须原样保留");
        assert!(next.contains("10.1.1.1 vpn.example"), "VPN 行必须原样保留");
        assert!(next.contains("10.0.0.2 new"));
        assert!(!next.contains("10.0.0.1 old"));
        assert!(next.contains("# tail comment"));
    }

    #[test]
    fn splice_appends_region_when_missing() {
        let file = "127.0.0.1\tlocalhost\n";
        let region = "# >>> host-manager >>>\n10.0.0.1 dev\n# <<< host-manager <<<\n";
        let next = splice_region(file, region);
        assert!(next.starts_with("127.0.0.1\tlocalhost\n"), "原有内容在最前：{next:?}");
        assert!(next.contains(REGION_BEGIN) && next.contains(REGION_END));
        // 区域前后各有一个空行分隔
        assert!(next.contains("localhost\n\n# >>>"), "缺少分隔空行：{next:?}");
    }

    #[test]
    fn splice_with_empty_region_removes_it() {
        let file = "keep\n# >>> host-manager >>>\n10.0.0.1 x\n# <<< host-manager <<<\n";
        let next = splice_region(file, "");
        assert_eq!(next, "keep\n");
    }

    #[test]
    fn region_split_reports_bounds() {
        let parts = split_region("a\n# >>> host-manager >>>\nmid\n# <<< host-manager <<<\nb\n");
        assert!(parts.found);
        assert_eq!(parts.head, "a\n");
        assert_eq!(parts.region, "# >>> host-manager >>>\nmid\n# <<< host-manager <<<\n");
        assert_eq!(parts.tail, "b\n");
        assert!(!split_region("no region here").found);
    }

    #[test]
    fn remove_outside_lines_only_touches_outside_and_each_line_once() {
        let file = "10.0.0.9\tdrop-me\n10.0.0.9\tdrop-me\n# >>> host-manager >>>\n10.0.0.9\tdrop-me\n# <<< host-manager <<<\n";
        let next = remove_outside_lines(file, &[format!("10.0.0.9\tdrop-me\n")]);
        // 区外两次出现只删第一处；区内那份不动
        assert_eq!(next.matches("drop-me").count(), 2, "next = {next:?}");
        assert!(next.starts_with("10.0.0.9\tdrop-me\n"), "删的是第一处：{next:?}");
        assert!(next.ends_with("10.0.0.9\tdrop-me\n# <<< host-manager <<<\n"));
    }

    #[test]
    fn remove_outside_lines_skips_unmatched() {
        let file = "a\nb\n";
        assert_eq!(remove_outside_lines(file, &["nope\n".to_string()]), file);
        assert_eq!(remove_outside_lines(file, &[]), file);
    }

    #[test]
    fn decode_and_encode_round_trip_binary() {
        let bytes = vec![0x41, 0xFF, 0x42]; // 非法 UTF-8
        let (text, bom, binary) = decode_bytes(&bytes);
        assert!(binary);
        assert!(!bom);
        assert_eq!(encode_text(&text, bom, binary), bytes, "逐字节往返必须无损");

        let utf8 = vec![0xEF, 0xBB, 0xBF, 0xE4, 0xB8, 0xAD];
        let (text, bom, binary) = decode_bytes(&utf8);
        assert!(bom);
        assert!(!binary);
        assert_eq!(text, "中");
        assert_eq!(encode_text(&text, bom, binary), utf8);
    }

    #[test]
    fn read_write_round_trip_with_backup() {
        let dir = tmp("write");
        let data_path = dir.join("data");
        let target = dir.join("hosts");
        std::fs::write(&target, "127.0.0.1\tlocalhost\n").unwrap();

        let opts = WriteOptions {
            region: format!("{REGION_BEGIN}\n10.0.0.1 dev\n{REGION_END}\n"),
            remove: Vec::new(),
            data_path: data_path.clone(),
            target: Some(target.clone()),
            mode: Some("direct".to_string()),
            backup: None,
        };
        let result = write_hosts_file(&opts);
        assert!(result.ok, "error = {:?}", result.error);
        assert_eq!(result.method, "direct");
        assert_eq!(result.changed, Some(true));
        assert_eq!(result.verified, Some(true));
        assert!(result.backup.is_some(), "写入前必须备份");
        let written = std::fs::read_to_string(&target).unwrap();
        assert!(written.contains("127.0.0.1\tlocalhost"));
        assert!(written.contains("10.0.0.1 dev"));

        // 再写一次同样的内容：不算改动，不写、不备份
        let again = write_hosts_file(&opts);
        assert!(again.ok);
        assert_eq!(again.changed, Some(false));
        assert!(again.backup.is_none(), "没改动就不该再备份");

        assert_eq!(list_backups(&data_path).len(), 1);
        let backup = list_backups(&data_path)[0].name.clone();
        assert!(read_backup(&data_path, &backup).unwrap().contains("localhost"));
        assert!(read_backup(&data_path, "../evil").is_err(), "备份名必须挡路径穿越");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_blocks_empty_content() {
        let dir = tmp("empty");
        let target = dir.join("hosts");
        std::fs::write(&target, format!("{REGION_BEGIN}\n10.0.0.1 x\n{REGION_END}\n")).unwrap();
        let opts = WriteOptions {
            region: String::new(),
            remove: Vec::new(),
            data_path: dir.join("data"),
            target: Some(target.clone()),
            mode: Some("direct".to_string()),
            backup: Some(false),
        };
        let result = write_hosts_file(&opts);
        assert!(!result.ok);
        assert!(result.error.unwrap().contains("内容为空"));
        assert!(std::fs::read_to_string(&target).unwrap().contains("10.0.0.1"), "被阻止时不得改动文件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_names_and_retention() {
        let dir = tmp("backup");
        let target = dir.join("hosts");
        std::fs::write(&target, "x\n").unwrap();
        assert!(!is_backup_name("hosts-../etc/passwd.txt"));
        assert!(!is_backup_name("other.txt"));
        assert!(is_backup_name("hosts-2026-09-17T16-00-00-000Z.txt"));
        // 保留最近 30 份
        let backups = backup_dir_of(&dir);
        std::fs::create_dir_all(&backups).unwrap();
        for index in 0..35 {
            std::fs::write(backups.join(format!("hosts-2026-01-01T00-00-{index:02}-000Z.txt")), "old").unwrap();
        }
        let (name, _) = backup_hosts(&dir, &target).unwrap().unwrap();
        assert!(name.starts_with("hosts-"));
        assert_eq!(list_backups(&dir).len(), KEEP_BACKUPS, "超过 30 份要清理最旧的");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn acl_entry_and_permission_command_shape() {
        assert_eq!(write_acl_entry("alice"), "user:alice allow write");
        let grant = permission_command(Path::new("/etc/hosts"), true, "alice");
        assert!(grant.contains("chmod +a"), "{grant}");
        assert!(grant.contains("'user:alice allow write'"), "ACL 文本要带引号：{grant}");
        assert!(grant.contains("'/etc/hosts'"), "{grant}");
        let revoke = permission_command(Path::new("/etc/hosts"), false, "alice");
        assert!(revoke.contains("chmod -a"), "{revoke}");
    }

    #[test]
    fn current_username_resolves_to_something() {
        let name = current_username().expect("取不到当前用户名");
        assert!(!name.is_empty() && !name.contains(char::is_whitespace), "用户名异常：{name:?}");
    }

    /// 自己拥有的文件上验证 ACL 的加 → 检测 → 撤（**不碰系统文件、也不触发提权**；
    /// `apply_write_acl` 会走 osascript 弹授权框，单测里绝不能调它）。
    #[cfg(target_os = "macos")]
    #[test]
    fn acl_round_trip_on_owned_file() {
        let dir = tmp("acl");
        let file = dir.join("hosts");
        std::fs::write(&file, "x\n").unwrap();
        let user = current_username().unwrap();
        assert!(!has_write_acl(&file, &user), "新文件不该有我们的 ACL");

        let add = std::process::Command::new("/bin/chmod")
            .arg("+a")
            .arg(write_acl_entry(&user))
            .arg(&file)
            .status()
            .unwrap();
        assert!(add.success());
        assert!(has_write_acl(&file, &user), "加完 ACL 后应能检测到");

        let remove = std::process::Command::new("/bin/chmod")
            .arg("-a")
            .arg(write_acl_entry(&user))
            .arg(&file)
            .status()
            .unwrap();
        assert!(remove.success());
        assert!(!has_write_acl(&file, &user), "撤掉后应检测不到");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn is_writable_tracks_mode_bits() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return; // root 下 access(W_OK) 恒真，测不出东西
        }
        let dir = tmp("writable");
        let file = dir.join("hosts");
        std::fs::write(&file, "x\n").unwrap();
        assert!(is_writable(&file));
        let mut perms = std::fs::metadata(&file).unwrap().permissions();
        perms.set_mode(0o444);
        std::fs::set_permissions(&file, perms).unwrap();
        assert!(!is_writable(&file), "只读文件应判为不可写");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
