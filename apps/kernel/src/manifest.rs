//! 插件清单与校验（v1 `packages/plugin-manifest` 的 Rust 版本；plugin-spec §3）。
//!
//! 两处 M5 差异（ADR-0005 / plugin-spec §11）：
//! - `apiVersion` 接受 `"1"` 与 `"2"`；`"1"` 的**逻辑层产物（`.mjs`）不再支持**（找不到可执行产物 → `ENTRY_MISSING`）
//! - 产物查找顺序 = 可执行产物：`<name>` / `<name>.exe` / `workers/<name>` / `workers/<name>.exe`

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const API_VERSIONS_SUPPORTED: [&str; 2] = ["1", "2"];

/// 能力清单（唯一真源；新增能力是 minor 变更，三处一起改）
pub const CAPABILITIES: [&str; 10] = [
    "hostUi",
    "storage",
    "clipboard.read",
    "clipboard.write",
    "clipboard.watch",
    "shell.open",
    "exec.spawn",
    "notify.show",
    "screenshot",
    "quicklink",
];

/// 安装时需要向用户展示并可由用户拒绝的高风险能力（plugin-spec §8 规则 3）
pub const HIGH_RISK_CAPABILITIES: [&str; 5] = ["exec.spawn", "clipboard.read", "clipboard.watch", "shell.open", "screenshot"];

/// 服务名 → 所需能力（装配期裁剪用，也用于审计里的 capability 字段）
pub fn service_capability(service: &str) -> Option<&'static str> {
    match service {
        "storage" => Some("storage"),
        "hostUi" => Some("hostUi"),
        "clipboard" => Some("clipboard.write"),
        "shell" => Some("shell.open"),
        "exec" => Some("exec.spawn"),
        "notify" => Some("notify.show"),
        "screenshot" => Some("screenshot"),
        "quicklink" => Some("quicklink"),
        _ => None,
    }
}

pub fn is_known_capability(name: &str) -> bool {
    CAPABILITIES.contains(&name)
}

pub fn is_high_risk_capability(name: &str) -> bool {
    HIGH_RISK_CAPABILITIES.contains(&name)
}

/// 列表分隔用的安全文本（去掉首尾空白与空项）。
pub fn sanitize_string_list(values: &[String], max: usize) -> Vec<String> {
    values.iter().filter(|item| !item.trim().is_empty()).take(max).cloned().collect()
}

/// 逻辑层命令的产物查找顺序（v2：可执行产物）。
pub fn script_entry_candidates(name: &str) -> Vec<String> {
    vec![name.to_string(), format!("{name}.exe"), format!("workers/{name}"), format!("workers/{name}.exe")]
}

/// 平台标识（plugin-spec §3.5）：与 Rust `std::env::consts::OS` 同口径，
/// 便于作者照 `#[cfg(target_os = "windows")]` 的心智写清单。
/// 注意**不等于** `host.info().platform`（那是 Node 口径 `darwin` / `win32`，为兼容契约保留）。
pub const PLATFORMS: [&str; 3] = ["macos", "windows", "linux"];

/// CPU 架构标识（`std::env::consts::ARCH` 归一：`x86_64` → `x64`、`aarch64` → `arm64`）。
pub const ARCHS: [&str; 2] = ["x64", "arm64"];

/// 声明列表的长度上限（防畸形清单；合法值只有有限个，此上限只是兜底）
const MAX_PLATFORM_ITEMS: usize = 8;

/// 当前操作系统（`PLATFORMS` 取值之一；未知系统原样返回，天然不匹配任何显式声明）。
pub fn current_platform() -> &'static str {
    std::env::consts::OS
}

/// 当前 CPU 架构（`ARCHS` 取值之一；未知架构原样返回）。
pub fn current_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

/// 全局命令 id：`${pluginId}:${name}`。
pub fn global_command_id(plugin_id: &str, name: &str) -> String {
    format!("{plugin_id}:{name}")
}

pub fn split_global_command_id(id: &str) -> Option<(String, String)> {
    let index = id.find(':')?;
    if index == 0 || index == id.len() - 1 {
        return None;
    }
    Some((id[..index].to_string(), id[index + 1..].to_string()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CommandMode {
    #[serde(rename = "view")]
    View,
    #[serde(rename = "no-view")]
    NoView,
    #[serde(rename = "script")]
    Script,
}

impl CommandMode {
    pub fn as_str(self) -> &'static str {
        match self {
            CommandMode::View => "view",
            CommandMode::NoView => "no-view",
            CommandMode::Script => "script",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandDecl {
    pub name: String,
    pub title: String,
    pub mode: CommandMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub searchable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keywords: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contributes: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SettingValue {
    Bool(bool),
    Str(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingDecl {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<SettingValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<SettingOption>>,
}

/// 「进行中会话」声明（清单顶层 `session`，plugin-spec §3.6）：
/// 插件在这里点名三条 script 命令，内核据此在托盘菜单里给它挂一块控制区
/// （状态行显示实时时长 + 暂停 / 结束两个操作）。**不认识会话内容的语义** ——
/// 时长、暂停态都由 `status` 命令回报（`{ active, activeMs, paused }`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDecl {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub name: String,
    pub title: String,
    pub version: String,
    pub api_version: String,
    pub capabilities: Vec<String>,
    pub commands: Vec<CommandDecl>,
    /// 恒为 `"module"`（校验时拒绝其它值）
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keywords: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub categories: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub essential: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<Vec<SettingDecl>>,
    /// 支持的操作系统白名单（plugin-spec §3.5）；`None` = 不限制
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<String>>,
    /// 支持的 CPU 架构白名单；`None` = 不限制
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arch: Option<Vec<String>>,
    /// 进行中会话（托盘控制区）；`None` = 这个插件没有「会话」这个概念
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionDecl>,
}

impl PluginManifest {
    /// 平台 / 架构两个维度是否都匹配当前运行环境（未声明的维度不限制）。
    pub fn supports_runtime(&self) -> bool {
        dimension_matches(self.platforms.as_deref(), current_platform()) && dimension_matches(self.arch.as_deref(), current_arch())
    }

    /// 不匹配时的人话原因（给日志与安装失败提示用）；匹配则返回 `None`。
    pub fn unsupported_reason(&self) -> Option<String> {
        if !dimension_matches(self.platforms.as_deref(), current_platform()) {
            return Some(describe_mismatch("platforms", self.platforms.as_deref(), current_platform()));
        }
        if !dimension_matches(self.arch.as_deref(), current_arch()) {
            return Some(describe_mismatch("arch", self.arch.as_deref(), current_arch()));
        }
        None
    }
}

/// `None` = 没声明 ⇒ 不限制；`Some(list)` = 命中任一即通过。
fn dimension_matches(declared: Option<&[String]>, current: &str) -> bool {
    match declared {
        None => true,
        Some(list) => list.iter().any(|item| item == current),
    }
}

fn describe_mismatch(field: &str, declared: Option<&[String]>, current: &str) -> String {
    let list = declared.unwrap_or_default().join(", ");
    format!("{field} 声明 [{list}]，当前是 {current}")
}

/// 宽容判定（给 `scan()` 在校验之前用）：只有「声明合法且明确不含当前运行环境」才返回原因。
///
/// 写得非法（`platforms: "windows"` / 空数组 / 未知值）一律返回 `None` ⇒ **不跳过**，
/// 交给 `load()` 里的 `validate_manifest()` 报 `MANIFEST_INVALID`，
/// 这样用户在设置页能看见"清单写错了"，而不是插件无声无息地消失。
pub fn raw_platform_mismatch(raw: &Value) -> Option<String> {
    match raw_dimension_mismatch(raw, "platforms", &PLATFORMS, current_platform()) {
        // 声明非法：不跳过，交给 validate_manifest 报 MANIFEST_INVALID
        Err(()) => None,
        Ok(Some(reason)) => Some(reason),
        Ok(None) => match raw_dimension_mismatch(raw, "arch", &ARCHS, current_arch()) {
            Ok(Some(reason)) => Some(reason),
            _ => None,
        },
    }
}

/// 返回 `Ok(Some(原因))` = 不匹配；`Ok(None)` = 没声明或声明非法（不参与过滤）。
fn raw_dimension_mismatch(
    raw: &Value,
    field: &str,
    known: &[&str],
    current: &str,
) -> std::result::Result<Option<String>, ()> {
    let Some(value) = raw.get(field) else { return Ok(None) };
    let Some(items) = value.as_array() else { return Err(()) };
    if items.is_empty() {
        return Err(());
    }
    let mut list: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        let Some(text) = item.as_str() else { return Err(()) };
        if !known.contains(&text) {
            return Err(());
        }
        list.push(text.to_string());
    }
    if list.iter().any(|item| item == current) {
        Ok(None)
    } else {
        Ok(Some(describe_mismatch(field, Some(&list), current)))
    }
}

/// 平台 / 架构声明的校验（plugin-spec §3.5）：可选；给了就必须是**非空**的已知值数组。
fn validate_platform_list(
    raw: &serde_json::Map<String, Value>,
    field: &str,
    known: &[&str],
) -> std::result::Result<Option<Vec<String>>, ManifestIssue> {
    let Some(value) = raw.get(field) else { return Ok(None) };
    let Some(items) = value.as_array() else {
        return Err(ManifestIssue::new("MANIFEST_INVALID", format!("{field} 必须是非空数组（省略 = 不限制）")));
    };
    if items.is_empty() {
        return Err(ManifestIssue::new("MANIFEST_INVALID", format!("{field} 必须是非空数组（省略 = 不限制）")));
    }
    if items.len() > MAX_PLATFORM_ITEMS {
        return Err(ManifestIssue::new("MANIFEST_INVALID", format!("{field} 不得超过 {MAX_PLATFORM_ITEMS} 项")));
    }
    let mut list = Vec::with_capacity(items.len());
    for item in items {
        let Some(text) = item.as_str() else {
            return Err(ManifestIssue::new("MANIFEST_INVALID", format!("{field} 必须是字符串数组")));
        };
        if !known.contains(&text) {
            return Err(ManifestIssue::new(
                "MANIFEST_INVALID",
                format!("{field} 含未知取值：{text}（已知：{}）", known.join(", ")),
            ));
        }
        list.push(text.to_string());
    }
    Ok(Some(list))
}

#[derive(Debug, Clone)]
pub struct ManifestIssue {
    pub code: &'static str,
    pub message: String,
}

impl ManifestIssue {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

const MAX_COMMANDS: usize = 32;
const MAX_SETTINGS: usize = 16;
const MAX_SETTING_OPTIONS: usize = 32;

/// 清单校验（plugin-spec §3.3）：纯函数，不触碰文件系统。
pub fn validate_manifest(raw: &Value) -> std::result::Result<PluginManifest, ManifestIssue> {
    let Some(object) = raw.as_object() else {
        return Err(ManifestIssue::new("MANIFEST_INVALID", "package.json 顶层必须是对象"));
    };
    let text_at = |key: &str| object.get(key).and_then(Value::as_str);

    let Some(name) = text_at("name") else {
        return Err(ManifestIssue::new("MANIFEST_INVALID", "name 必须是字符串"));
    };
    if !is_plugin_id(name) {
        return Err(ManifestIssue::new(
            "MANIFEST_INVALID",
            format!("name 不符合 /^[a-z0-9][a-z0-9-]{{1,38}}[a-z0-9]$/（收到 {name:?}）"),
        ));
    }
    let Some(title) = text_at("title") else {
        return Err(ManifestIssue::new("MANIFEST_INVALID", "title 必须是 1–40 字符"));
    };
    if title.is_empty() || title.chars().count() > 40 {
        return Err(ManifestIssue::new("MANIFEST_INVALID", "title 必须是 1–40 字符"));
    }
    let Some(version) = text_at("version") else {
        return Err(ManifestIssue::new("MANIFEST_INVALID", "version 必须是 semver"));
    };
    if !is_semver(version) {
        return Err(ManifestIssue::new("MANIFEST_INVALID", format!("version 必须是 semver（收到 {version:?}）")));
    }
    if let Some(kind) = object.get("type").and_then(Value::as_str) {
        if kind != "module" {
            return Err(ManifestIssue::new("MANIFEST_INVALID", "type 必须是 \"module\""));
        }
    }

    let Some(api_version) = text_at("apiVersion") else {
        return Err(ManifestIssue::new("MANIFEST_INVALID", "apiVersion 必填（接受 \"1\" 与 \"2\"）"));
    };
    if !API_VERSIONS_SUPPORTED.contains(&api_version) {
        return Err(ManifestIssue::new(
            "API_VERSION_UNSUPPORTED",
            format!("插件声明需要 apiVersion {api_version}，当前底座支持 {}", API_VERSIONS_SUPPORTED.join(" / ")),
        ));
    }

    let capabilities = match object.get("capabilities") {
        None => return Err(ManifestIssue::new("MANIFEST_INVALID", "capabilities 必填（可以是空数组）")),
        Some(Value::Array(items)) => {
            let mut list = Vec::new();
            for item in items {
                let Some(cap) = item.as_str() else {
                    return Err(ManifestIssue::new("MANIFEST_INVALID", "capabilities 必须是字符串数组"));
                };
                if !is_known_capability(cap) {
                    return Err(ManifestIssue::new(
                        "CAPABILITY_UNKNOWN",
                        format!("使用了未知能力：{cap}（已知：{}）", CAPABILITIES.join(", ")),
                    ));
                }
                list.push(cap.to_string());
            }
            list
        }
        Some(_) => return Err(ManifestIssue::new("MANIFEST_INVALID", "capabilities 必须是字符串数组")),
    };

    let Some(Value::Array(commands_raw)) = object.get("commands") else {
        return Err(ManifestIssue::new("MANIFEST_INVALID", "commands 必须是非空数组"));
    };
    if commands_raw.is_empty() {
        return Err(ManifestIssue::new("MANIFEST_INVALID", "commands 必须是非空数组"));
    }
    if commands_raw.len() > MAX_COMMANDS {
        return Err(ManifestIssue::new("MANIFEST_INVALID", format!("commands 不得超过 {MAX_COMMANDS} 条")));
    }
    let mut commands = Vec::new();
    let mut seen = Vec::new();
    for (index, item) in commands_raw.iter().enumerate() {
        let command = validate_command(item, index)?;
        if seen.contains(&command.name) {
            return Err(ManifestIssue::new("MANIFEST_INVALID", format!("命令名重复：{}", command.name)));
        }
        seen.push(command.name.clone());
        commands.push(command);
    }

    // `session`（plugin-spec §3.6）：托盘「进行中会话」区的三个入口。
    // 引用必须落在**本插件已声明的 script 命令**上 —— 内核会主动拉起它们。
    let session = match object.get("session") {
        None => None,
        Some(value) => {
            let Some(object) = value.as_object() else {
                return Err(ManifestIssue::new("MANIFEST_INVALID", "session 必须是对象"));
            };
            let name_at = |key: &str| -> std::result::Result<String, ManifestIssue> {
                let Some(text) = object.get(key).and_then(Value::as_str) else {
                    return Err(ManifestIssue::new("MANIFEST_INVALID", format!("session.{key} 必须是命令名")));
                };
                let Some(command) = commands.iter().find(|command| command.name == text) else {
                    return Err(ManifestIssue::new(
                        "MANIFEST_INVALID",
                        format!("session.{key} 指向不存在的命令：{text}"),
                    ));
                };
                if command.mode != CommandMode::Script {
                    return Err(ManifestIssue::new(
                        "MANIFEST_INVALID",
                        format!("session.{key} 必须是 script 命令（内核会主动拉起它，view 命令拉不动）：{text}"),
                    ));
                }
                Ok(text.to_string())
            };
            let status = name_at("status")?;
            let pause = match object.get("pause") {
                Some(_) => Some(name_at("pause")?),
                None => None,
            };
            let stop = match object.get("stop") {
                Some(_) => Some(name_at("stop")?),
                None => None,
            };
            if pause.is_none() && stop.is_none() {
                return Err(ManifestIssue::new("MANIFEST_INVALID", "session 至少要给 pause 或 stop 之一（只有状态行的会话没有意义）"));
            }
            Some(SessionDecl { status, pause, stop })
        }
    };

    let mut manifest = PluginManifest {
        name: name.to_string(),
        title: title.to_string(),
        version: version.to_string(),
        api_version: api_version.to_string(),
        capabilities,
        commands,
        kind: "module".to_string(),
        description: None,
        author: None,
        icon: None,
        keywords: None,
        categories: None,
        essential: None,
        history: None,
        settings: None,
        platforms: None,
        arch: None,
        session,
    };

    if let Some(value) = object.get("description") {
        let Some(text) = value.as_str() else {
            return Err(ManifestIssue::new("MANIFEST_INVALID", "description 必须是 ≤200 字符的字符串"));
        };
        if text.chars().count() > 200 {
            return Err(ManifestIssue::new("MANIFEST_INVALID", "description 必须是 ≤200 字符的字符串"));
        }
        manifest.description = Some(text.to_string());
    }
    if let Some(value) = object.get("author") {
        let Some(text) = value.as_str() else {
            return Err(ManifestIssue::new("MANIFEST_INVALID", "author 必须是字符串"));
        };
        manifest.author = Some(text.to_string());
    }
    if let Some(value) = object.get("icon") {
        let Some(text) = value.as_str() else {
            return Err(ManifestIssue::new("MANIFEST_INVALID", "icon 必须是字符串"));
        };
        manifest.icon = Some(text.to_string());
    }
    if let Some(value) = object.get("keywords") {
        let Some(items) = value.as_array() else {
            return Err(ManifestIssue::new("MANIFEST_INVALID", "keywords 必须是 ≤10 个字符串"));
        };
        if items.len() > 10 || items.iter().any(|item| !item.is_string()) {
            return Err(ManifestIssue::new("MANIFEST_INVALID", "keywords 必须是 ≤10 个字符串"));
        }
        manifest.keywords = Some(items.iter().filter_map(Value::as_str).map(str::to_string).collect());
    }
    if let Some(value) = object.get("categories") {
        let Some(items) = value.as_array() else {
            return Err(ManifestIssue::new("MANIFEST_INVALID", "categories 必须是字符串数组"));
        };
        if items.iter().any(|item| !item.is_string()) {
            return Err(ManifestIssue::new("MANIFEST_INVALID", "categories 必须是字符串数组"));
        }
        manifest.categories = Some(items.iter().filter_map(Value::as_str).map(str::to_string).collect());
    }
    if let Some(value) = object.get("essential") {
        let Some(flag) = value.as_bool() else {
            return Err(ManifestIssue::new("MANIFEST_INVALID", "essential 必须是布尔值"));
        };
        manifest.essential = Some(flag);
    }
    if let Some(value) = object.get("history") {
        let Some(flag) = value.as_bool() else {
            return Err(ManifestIssue::new("MANIFEST_INVALID", "history 必须是布尔值"));
        };
        manifest.history = Some(flag);
    }
    if let Some(value) = object.get("settings") {
        let Some(items) = value.as_array() else {
            return Err(ManifestIssue::new("MANIFEST_INVALID", "settings 必须是数组"));
        };
        if items.len() > MAX_SETTINGS {
            return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings 不得超过 {MAX_SETTINGS} 条")));
        }
        let mut settings = Vec::new();
        let mut seen_keys: Vec<String> = Vec::new();
        for (index, item) in items.iter().enumerate() {
            let decl = validate_setting(item, index)?;
            if seen_keys.contains(&decl.key) {
                return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings.key 重复：{}", decl.key)));
            }
            seen_keys.push(decl.key.clone());
            settings.push(decl);
        }
        manifest.settings = Some(settings);
    }
    // 平台 / 架构声明（plugin-spec §3.5）：可选，给了就必须是已知值的非空数组
    manifest.platforms = validate_platform_list(object, "platforms", &PLATFORMS)?;
    manifest.arch = validate_platform_list(object, "arch", &ARCHS)?;

    Ok(manifest)
}

fn validate_command(raw: &Value, index: usize) -> std::result::Result<CommandDecl, ManifestIssue> {
    let Some(object) = raw.as_object() else {
        return Err(ManifestIssue::new("MANIFEST_INVALID", format!("commands[{index}] 必须是对象")));
    };
    let Some(name) = object.get("name").and_then(Value::as_str) else {
        return Err(ManifestIssue::new("MANIFEST_INVALID", format!("commands[{index}].name 不符合 /^[a-z0-9][a-z0-9-]{{0,38}}$/")));
    };
    if !is_command_name(name) {
        return Err(ManifestIssue::new("MANIFEST_INVALID", format!("commands[{index}].name 不符合 /^[a-z0-9][a-z0-9-]{{0,38}}$/")));
    }
    let Some(title) = object.get("title").and_then(Value::as_str) else {
        return Err(ManifestIssue::new("MANIFEST_INVALID", format!("commands[{index}].title 必须是 1–40 字符")));
    };
    if title.is_empty() || title.chars().count() > 40 {
        return Err(ManifestIssue::new("MANIFEST_INVALID", format!("commands[{index}].title 必须是 1–40 字符")));
    }
    let mode = match object.get("mode").and_then(Value::as_str) {
        Some("view") => CommandMode::View,
        Some("no-view") => CommandMode::NoView,
        Some("script") => CommandMode::Script,
        _ => return Err(ManifestIssue::new("MANIFEST_INVALID", format!("commands[{index}].mode 必须是 view | no-view | script"))),
    };

    let mut command = CommandDecl {
        name: name.to_string(),
        title: title.to_string(),
        mode,
        subtitle: None,
        icon: None,
        searchable: None,
        placeholder: None,
        keywords: None,
        contributes: None,
        capabilities: None,
        hidden: None,
    };
    if let Some(value) = object.get("subtitle") {
        let Some(text) = value.as_str() else {
            return Err(ManifestIssue::new("MANIFEST_INVALID", format!("commands[{index}].subtitle 必须是 ≤60 字符的字符串")));
        };
        if text.chars().count() > 60 {
            return Err(ManifestIssue::new("MANIFEST_INVALID", format!("commands[{index}].subtitle 必须是 ≤60 字符的字符串")));
        }
        command.subtitle = Some(text.to_string());
    }
    if let Some(value) = object.get("icon") {
        let Some(text) = value.as_str() else {
            return Err(ManifestIssue::new("MANIFEST_INVALID", format!("commands[{index}].icon 必须是字符串")));
        };
        command.icon = Some(text.to_string());
    }
    for field in ["searchable", "contributes", "hidden"] {
        if let Some(value) = object.get(field) {
            let Some(flag) = value.as_bool() else {
                return Err(ManifestIssue::new("MANIFEST_INVALID", format!("commands[{index}].{field} 必须是布尔")));
            };
            match field {
                "searchable" => command.searchable = Some(flag),
                "contributes" => command.contributes = Some(flag),
                _ => command.hidden = Some(flag),
            }
        }
    }
    if let Some(value) = object.get("placeholder") {
        let Some(text) = value.as_str() else {
            return Err(ManifestIssue::new("MANIFEST_INVALID", format!("commands[{index}].placeholder 必须是字符串")));
        };
        command.placeholder = Some(text.to_string());
    }
    if let Some(value) = object.get("keywords") {
        let Some(items) = value.as_array() else {
            return Err(ManifestIssue::new("MANIFEST_INVALID", format!("commands[{index}].keywords 必须是 ≤10 个字符串")));
        };
        if items.len() > 10 || items.iter().any(|item| !item.is_string()) {
            return Err(ManifestIssue::new("MANIFEST_INVALID", format!("commands[{index}].keywords 必须是 ≤10 个字符串")));
        }
        command.keywords = Some(items.iter().filter_map(Value::as_str).map(str::to_string).collect());
    }
    if let Some(value) = object.get("capabilities") {
        let Some(items) = value.as_array() else {
            return Err(ManifestIssue::new("MANIFEST_INVALID", format!("commands[{index}].capabilities 必须是字符串数组")));
        };
        let mut list = Vec::new();
        for item in items {
            let Some(cap) = item.as_str() else {
                return Err(ManifestIssue::new("MANIFEST_INVALID", format!("commands[{index}].capabilities 必须是字符串数组")));
            };
            if !is_known_capability(cap) {
                return Err(ManifestIssue::new(
                    "CAPABILITY_UNKNOWN",
                    format!("commands[{index}] 使用了未知能力：{cap}（已知：{}）", CAPABILITIES.join(", ")),
                ));
            }
            list.push(cap.to_string());
        }
        command.capabilities = Some(list);
    }
    Ok(command)
}

fn validate_setting(raw: &Value, index: usize) -> std::result::Result<SettingDecl, ManifestIssue> {
    let Some(object) = raw.as_object() else {
        return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}] 必须是对象")));
    };
    let Some(key) = object.get("key").and_then(Value::as_str) else {
        return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}].key 不符合 /^[a-z][a-z0-9-]{{0,31}}$/")));
    };
    if !is_setting_key(key) {
        return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}].key 不符合 /^[a-z][a-z0-9-]{{0,31}}$/")));
    }
    let kind = match object.get("type").and_then(Value::as_str) {
        Some(value @ ("select" | "switch" | "text")) => value.to_string(),
        _ => return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}].type 必须是 select | switch | text"))),
    };
    let Some(title) = object.get("title").and_then(Value::as_str) else {
        return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}].title 必须是 1–40 字符")));
    };
    if title.is_empty() || title.chars().count() > 40 {
        return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}].title 必须是 1–40 字符")));
    }

    let mut decl = SettingDecl { key: key.to_string(), kind: kind.clone(), title: title.to_string(), description: None, default: None, options: None };
    if let Some(value) = object.get("description") {
        let Some(text) = value.as_str() else {
            return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}].description 必须是 ≤120 字符的字符串")));
        };
        if text.chars().count() > 120 {
            return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}].description 必须是 ≤120 字符的字符串")));
        }
        decl.description = Some(text.to_string());
    }
    if let Some(value) = object.get("options") {
        if kind != "select" {
            return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}]：只有 type=select 才能声明 options")));
        }
        let Some(items) = value.as_array() else {
            return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}].options 必须是 2–{MAX_SETTING_OPTIONS} 项")));
        };
        if items.len() < 2 || items.len() > MAX_SETTING_OPTIONS {
            return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}].options 必须是 2–{MAX_SETTING_OPTIONS} 项")));
        }
        let mut options = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        for (option_index, item) in items.iter().enumerate() {
            let Some(option) = item.as_object() else {
                return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}].options[{option_index}] 必须是对象")));
            };
            let value = option.get("value").and_then(Value::as_str).unwrap_or_default();
            let label = option.get("label").and_then(Value::as_str).unwrap_or_default();
            if value.is_empty() {
                return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}].options[{option_index}].value 必须是非空字符串")));
            }
            if label.is_empty() || label.chars().count() > 40 {
                return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}].options[{option_index}].label 必须是 1–40 字符")));
            }
            if seen.contains(&value.to_string()) {
                return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}].options 值重复：{value}")));
            }
            seen.push(value.to_string());
            options.push(SettingOption { value: value.to_string(), label: label.to_string() });
        }
        decl.options = Some(options);
    }
    if kind == "select" && decl.options.is_none() {
        return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}]：type=select 必须提供 options")));
    }
    if let Some(value) = object.get("default") {
        if kind == "switch" {
            let Some(flag) = value.as_bool() else {
                return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}].default 必须是布尔（type=switch）")));
            };
            decl.default = Some(SettingValue::Bool(flag));
        } else {
            let Some(text) = value.as_str() else {
                return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}].default 必须是字符串（type={kind}）")));
            };
            if kind == "select" && !decl.options.as_ref().is_some_and(|options| options.iter().any(|option| option.value == text)) {
                return Err(ManifestIssue::new("MANIFEST_INVALID", format!("settings[{index}].default 不在 options 里：{text}")));
            }
            decl.default = Some(SettingValue::Str(text.to_string()));
        }
    }
    Ok(decl)
}

fn is_lower_alnum(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit()
}

/// `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`
pub fn is_plugin_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() < 3 || bytes.len() > 40 {
        return false;
    }
    is_lower_alnum(bytes[0]) && is_lower_alnum(bytes[bytes.len() - 1]) && bytes.iter().all(|byte| is_lower_alnum(*byte) || *byte == b'-')
}

/// `^[a-z0-9][a-z0-9-]{0,38}$`
pub fn is_command_name(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.len() > 39 {
        return false;
    }
    is_lower_alnum(bytes[0]) && bytes.iter().all(|byte| is_lower_alnum(*byte) || *byte == b'-')
}

/// `^[a-z][a-z0-9-]{0,31}$`
pub fn is_setting_key(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.len() > 32 {
        return false;
    }
    bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

/// `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`
pub fn is_semver(text: &str) -> bool {
    let (core, prerelease) = match text.split_once('-') {
        Some((core, rest)) => (core, Some(rest)),
        None => (text, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit())) {
        return false;
    }
    match prerelease {
        None => true,
        Some(value) => {
            !value.is_empty()
                && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest_json() -> Value {
        json!({
            "name": "demo-plugin",
            "title": "演示",
            "version": "0.1.0",
            "type": "module",
            "apiVersion": "2",
            "capabilities": ["storage"],
            "commands": [
                { "name": "run", "title": "运行", "mode": "no-view" },
                { "name": "show", "title": "查看", "mode": "view", "searchable": true, "placeholder": "输入" }
            ]
        })
    }

    #[test]
    fn accepts_valid_manifest() {
        let manifest = validate_manifest(&manifest_json()).expect("合法清单应当通过");
        assert_eq!(manifest.name, "demo-plugin");
        assert_eq!(manifest.commands.len(), 2);
        assert_eq!(manifest.commands[0].mode, CommandMode::NoView);
        assert_eq!(manifest.api_version, "2");
    }

    #[test]
    fn accepts_both_api_versions_and_rejects_unknown() {
        let mut raw = manifest_json();
        raw["apiVersion"] = json!("1");
        assert!(validate_manifest(&raw).is_ok(), "apiVersion 1 仍可加载（只是逻辑层产物不支持）");

        raw["apiVersion"] = json!("3");
        let issue = validate_manifest(&raw).unwrap_err();
        assert_eq!(issue.code, "API_VERSION_UNSUPPORTED");

        raw["apiVersion"] = json!(2);
        assert_eq!(validate_manifest(&raw).unwrap_err().code, "MANIFEST_INVALID");
    }

    #[test]
    fn rejects_unknown_capability_and_duplicate_commands() {
        let mut raw = manifest_json();
        raw["capabilities"] = json!(["storage", "teleport"]);
        assert_eq!(validate_manifest(&raw).unwrap_err().code, "CAPABILITY_UNKNOWN");

        let mut raw = manifest_json();
        raw["commands"] = json!([
            { "name": "run", "title": "a", "mode": "no-view" },
            { "name": "run", "title": "b", "mode": "script" }
        ]);
        let issue = validate_manifest(&raw).unwrap_err();
        assert!(issue.message.contains("命令名重复"));
    }

    #[test]
    fn validates_settings_shapes() {
        let mut raw = manifest_json();
        raw["settings"] = json!([
            { "key": "engine", "type": "select", "title": "引擎", "options": [
                { "value": "a", "label": "A" }, { "value": "b", "label": "B" }
            ], "default": "b" }
        ]);
        let manifest = validate_manifest(&raw).expect("合法 settings 应当通过");
        assert_eq!(manifest.settings.unwrap()[0].default, Some(SettingValue::Str("b".to_string())));

        raw["settings"] = json!([{ "key": "engine", "type": "select", "title": "引擎", "default": "c",
            "options": [{ "value": "a", "label": "A" }, { "value": "b", "label": "B" }] }]);
        assert!(validate_manifest(&raw).unwrap_err().message.contains("不在 options 里"));

        raw["settings"] = json!([{ "key": "engine", "type": "select", "title": "引擎" }]);
        assert!(validate_manifest(&raw).unwrap_err().message.contains("必须提供 options"));
    }

    /// `session`（plugin-spec §3.6）：引用必须落在本插件已声明的 script 命令上 ——
    /// 内核会主动拉起它们，指错了就是托盘上点不动的死项。
    #[test]
    fn validates_session_declaration() {
        // 不声明 = 没有会话这个概念（现有插件一行都不用改）
        assert!(validate_manifest(&manifest_json()).unwrap().session.is_none());

        let mut raw = manifest_json();
        raw["commands"] = json!([
            { "name": "rec-start", "title": "开始", "mode": "script" },
            { "name": "rec-status", "title": "状态", "mode": "script" },
            { "name": "rec-stop", "title": "结束", "mode": "script" },
            { "name": "show", "title": "查看", "mode": "view" }
        ]);
        raw["session"] = json!({ "status": "rec-status", "stop": "rec-stop" });
        let manifest = validate_manifest(&raw).expect("合法 session 应当通过");
        let session = manifest.session.expect("session 要保留下来");
        assert_eq!(session.status, "rec-status");
        assert_eq!(session.pause, None, "没给 pause = 托盘里只能结束");
        assert_eq!(session.stop.as_deref(), Some("rec-stop"));

        // 指向不存在的命令
        let mut bad = raw.clone();
        bad["session"] = json!({ "status": "rec-status", "stop": "nope" });
        assert!(validate_manifest(&bad).unwrap_err().message.contains("不存在的命令"));

        // view 命令拉不起来：必须是 script
        let mut bad = raw.clone();
        bad["session"] = json!({ "status": "show", "stop": "rec-stop" });
        assert!(validate_manifest(&bad).unwrap_err().message.contains("script 命令"));

        // 只有状态行没有意义（点不动任何东西）
        let mut bad = raw;
        bad["session"] = json!({ "status": "rec-status" });
        assert!(validate_manifest(&bad).unwrap_err().message.contains("至少要给 pause 或 stop"));
    }

    #[test]
    fn platform_declaration_is_optional_and_validated() {
        // 不声明 = 不限制（现有 8 个插件一行都不用改）
        let manifest = validate_manifest(&manifest_json()).expect("未声明平台应当通过");
        assert_eq!(manifest.platforms, None);
        assert_eq!(manifest.arch, None);
        assert!(manifest.supports_runtime());
        assert!(manifest.unsupported_reason().is_none());

        let mut raw = manifest_json();
        raw["platforms"] = json!(["windows"]);
        raw["arch"] = json!(["x64"]);
        let manifest = validate_manifest(&raw).expect("合法声明应当通过");
        assert_eq!(manifest.platforms, Some(vec!["windows".to_string()]));
        assert_eq!(manifest.arch, Some(vec!["x64".to_string()]));

        // 空数组 = 非法（语义歧义：全平台还是全不支持？一律拒绝）
        raw["platforms"] = json!([]);
        assert!(validate_manifest(&raw).unwrap_err().message.contains("platforms 必须是非空数组"));
        // 未知取值
        raw["platforms"] = json!(["win"]);
        assert!(validate_manifest(&raw).unwrap_err().message.contains("platforms 含未知取值"));
        // 非数组
        raw["platforms"] = json!("windows");
        assert!(validate_manifest(&raw).unwrap_err().message.contains("platforms 必须是非空数组"));
        // 非字符串元素
        raw["platforms"] = json!([1]);
        assert!(validate_manifest(&raw).unwrap_err().message.contains("platforms 必须是字符串数组"));
        // arch 同样校验
        raw = manifest_json();
        raw["arch"] = json!(["arm"]);
        assert!(validate_manifest(&raw).unwrap_err().message.contains("arch 含未知取值"));
    }

    #[test]
    fn supports_runtime_matches_current_environment() {
        // 声明含当前环境 ⇒ 通过；不含 ⇒ 给出人话原因
        let mut raw = manifest_json();
        raw["platforms"] = json!([current_platform()]);
        assert!(validate_manifest(&raw).unwrap().supports_runtime());

        raw["platforms"] = json!(["macos", "windows", "linux"]);
        assert!(validate_manifest(&raw).unwrap().supports_runtime());

        // 反向取值：拿一个「不是当前平台」的已知值
        let other = PLATFORMS.iter().find(|name| **name != current_platform()).copied().unwrap();
        raw["platforms"] = json!([other]);
        let manifest = validate_manifest(&raw).unwrap();
        assert!(!manifest.supports_runtime());
        let reason = manifest.unsupported_reason().unwrap();
        assert!(reason.contains(other) && reason.contains(current_platform()), "原因要带上声明与现状：{reason}");

        // 两个维度独立：平台匹配但架构不匹配
        let other_arch = ARCHS.iter().find(|name| **name != current_arch()).copied().unwrap();
        raw["platforms"] = json!([current_platform()]);
        raw["arch"] = json!([other_arch]);
        let manifest = validate_manifest(&raw).unwrap();
        assert!(!manifest.supports_runtime());
        assert!(manifest.unsupported_reason().unwrap().starts_with("arch"));
    }

    #[test]
    fn raw_platform_mismatch_only_skips_when_declaration_is_valid() {
        let mut raw = manifest_json();

        // 未声明 ⇒ 不跳过
        assert!(raw_platform_mismatch(&raw).is_none());

        // 声明合法且不含当前平台 ⇒ 跳过（带原因）
        let other = PLATFORMS.iter().find(|name| **name != current_platform()).copied().unwrap();
        raw["platforms"] = json!([other]);
        assert!(raw_platform_mismatch(&raw).unwrap().contains(other));

        // 声明合法且含当前平台 ⇒ 不跳过
        raw["platforms"] = json!([other, current_platform()]);
        assert!(raw_platform_mismatch(&raw).is_none());

        // 声明非法 ⇒ 不跳过（留给 validate_manifest 报错，用户在设置页看得见）
        for bad in [json!("windows"), json!([]), json!(["win"]), json!([1])] {
            raw["platforms"] = bad;
            assert!(raw_platform_mismatch(&raw).is_none(), "非法声明不该被静默跳过");
        }

        // 平台通过、架构不匹配 ⇒ 仍然跳过
        raw = manifest_json();
        let other_arch = ARCHS.iter().find(|name| **name != current_arch()).copied().unwrap();
        raw["arch"] = json!([other_arch]);
        assert!(raw_platform_mismatch(&raw).unwrap().starts_with("arch"));
    }

    #[test]
    fn entry_candidates_are_executables() {
        let candidates = script_entry_candidates("read-image");
        assert!(candidates.contains(&"read-image".to_string()));
        assert!(candidates.contains(&"read-image.exe".to_string()));
        assert!(candidates.contains(&"workers/read-image".to_string()));
        assert!(!candidates.iter().any(|name| name.ends_with(".mjs")), "v2 不再接受 .mjs 产物");
    }

    #[test]
    fn id_and_key_regexes_match_v1() {
        assert!(is_plugin_id("abc"), "3 字符是合法下限（1 + 1~38 + 1）");
        assert!(is_plugin_id("host-manager"));
        assert!(!is_plugin_id("ab"));
        assert!(!is_plugin_id("Host-Manager"));
        assert!(!is_plugin_id(&"a".repeat(41)));
        assert!(is_command_name("read-image"));
        assert!(!is_command_name("-x"));
        assert!(is_setting_key("engine"));
        assert!(!is_setting_key("Engine"));
        assert!(is_semver("1.2.3"));
        assert!(is_semver("0.1.0-beta.1"));
        assert!(!is_semver("1.2"));
        assert!(!is_semver("v1.2.3"));
    }
}
