//! 内核错误：`code + message`（对齐 v1 `LauncherError` 的错误码表，见 `docs/plugin-spec.md` §7.3）。

#[derive(Debug, Clone)]
pub struct KernelError {
    pub code: &'static str,
    pub message: String,
}

impl KernelError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("NOT_FOUND", message)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new("TIMEOUT", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("INTERNAL", message)
    }

    pub fn bad_args(message: impl Into<String>) -> Self {
        Self::new("BAD_ARGS", message)
    }
}

impl std::fmt::Display for KernelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}（{}）", self.message, self.code)
    }
}

impl std::error::Error for KernelError {}

pub type Result<T> = std::result::Result<T, KernelError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_contains_code_and_message() {
        let err = KernelError::not_found("命令不存在");
        assert_eq!(err.code, "NOT_FOUND");
        assert_eq!(err.to_string(), "命令不存在（NOT_FOUND）");
    }
}
