//! 其它平台的占位后端：编得过、说得清、不假装能用。
//!
//! 清单已声明 `platforms: ["macos", "windows"]`（plugin-spec §3.5），内核扫描期就会跳过；
//! 这一份只是「万一被手工拉起」时的明确回执。

use std::path::Path;

use crate::{RecordOptions, RecordingState, ShotOptions};

pub const BACKEND: &str = "none";

#[derive(Debug, Clone)]
pub struct StartInfo {
    pub state: RecordingState,
    pub args: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct StartError {
    pub code: String,
    pub message: String,
    pub detail: String,
    pub retry_without_audio: bool,
}

#[derive(Debug, Clone)]
pub struct StopOutcome {
    pub stopped: bool,
    pub still_alive: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ShotInfo {
    pub path: Option<std::path::PathBuf>,
    pub size: Option<u64>,
    pub clipboard: bool,
    pub args: Vec<String>,
    /// 交给系统工具去做（Windows 的窗口 / 剪贴板截图）
    pub delegated: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Permission {
    pub supported: bool,
    pub granted: bool,
    pub requested: bool,
    pub needs_manual: bool,
    pub hint: String,
    pub settings_url: String,
}

pub fn backend_name() -> &'static str {
    BACKEND
}

pub fn readiness() -> (bool, String) {
    (false, "当前平台没有录屏后端（只有 macOS / Windows 有）".to_string())
}

pub fn features() -> crate::Features {
    crate::Features {
        audio: false,
        clicks: false,
        cursor: false,
        window_recording: false,
        region_pick: false,
        delegated_shot: false,
        delay_in_interactive: false,
        notes: vec!["当前平台没有录屏后端".to_string()],
    }
}

pub fn is_recorder_process(_pid: i32) -> bool {
    false
}

pub fn recorder_processes() -> Vec<i32> {
    Vec::new()
}

pub fn stop_orphans(_data_path: &Path) -> usize {
    0
}

pub fn start(_options: &RecordOptions, _out: &Path, _data_path: &Path) -> Result<StartInfo, StartError> {
    Err(StartError {
        code: "UNSUPPORTED".into(),
        message: readiness().1,
        detail: String::new(),
        retry_without_audio: false,
    })
}

pub fn apply_pause(_state: &RecordingState, _paused: bool) -> Result<(), String> {
    Err(readiness().1)
}

pub fn stop(state: &RecordingState, _data_path: &Path) -> StopOutcome {
    StopOutcome {
        stopped: false,
        still_alive: false,
        error: Some(format!("当前平台不支持停止录制（{}）", state.path)),
    }
}

pub fn shot(_options: &ShotOptions, _data_path: &Path) -> Result<ShotInfo, StartError> {
    Err(StartError {
        code: "UNSUPPORTED".into(),
        message: readiness().1,
        detail: String::new(),
        retry_without_audio: false,
    })
}

pub fn permission(_request: bool) -> Permission {
    Permission {
        supported: false,
        granted: false,
        requested: false,
        needs_manual: false,
        hint: readiness().1,
        settings_url: String::new(),
    }
}

pub fn microphone_settings_url() -> &'static str {
    ""
}

/// 录制子进程入口（只有 Windows 需要）：非 Windows 恒为 None
pub fn worker_entry() -> Option<i32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_backend_always_refuses() {
        assert_eq!(backend_name(), "none");
        assert!(!readiness().0);
        assert!(recorder_processes().is_empty());
        assert!(!is_recorder_process(1));
        assert!(worker_entry().is_none());
        let err = start(&RecordOptions::default(), Path::new("/tmp/a.mov"), Path::new("/tmp")).unwrap_err();
        assert_eq!(err.code, "UNSUPPORTED");
    }
}
