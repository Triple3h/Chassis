//! 日志与进度：走协议行（stdout 只准出现协议；裸 print 会被宿主当协议解析失败转日志）。

use serde_json::Value;

use crate::protocol::{self, Level};
use crate::{Context, Result};

impl Context {
    /// `{ type:'log', level, message, data? }`（data 缺省时不出现字段，与 v1 一致）。
    pub fn log(&self, message: &str, data: Option<&Value>, level: Level) -> Result<()> {
        self.send(&protocol::log_line(level, message, data))
    }

    /// `{ type:'progress', p, data? }`（p 钳制到 0..1；宿主只记 debug 日志）。
    pub fn progress(&self, p: f64, data: Value) -> Result<()> {
        self.send(&protocol::progress_line(p, Some(&data)))
    }
}
