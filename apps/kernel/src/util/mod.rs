pub mod fsx;
pub mod text;

/// 当前 epoch 毫秒（对齐 v1 `Date.now()`）。
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}
