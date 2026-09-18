//! CLI 参数解析（对齐 v1 `main.ts::parseArgs`；壳启动内核时传参，见 requirements §4.1）。
//!
//! 支持 `--key value`、`--key=value`、裸 flag 三种写法；
//! `--builtin-plugins` 接受逗号分隔的多个目录（内置 + 预置）。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::paths;

#[derive(Debug, Clone)]
pub struct CliOptions {
    pub data_root: PathBuf,
    /// 出厂插件根目录（可多个；dev 态默认是 cwd/plugins/）
    pub builtin_roots: Vec<PathBuf>,
    /// UI 静态产物目录；`--no-ui` 时为 None
    pub ui_dist: Option<PathBuf>,
    /// UI dev server 地址（反代模式）
    pub ui_dev_url: Option<String>,
    /// 不连壳（开发 / 测试：只有 HTTP 服务）
    pub standalone: bool,
}

impl CliOptions {
    pub fn parse<I: IntoIterator<Item = String>>(argv: I) -> Self {
        let mut values: HashMap<String, String> = HashMap::new();
        let mut flags: HashSet<String> = HashSet::new();

        let mut iter = argv.into_iter().peekable();
        while let Some(item) = iter.next() {
            let Some(key) = item.strip_prefix("--") else { continue };
            if key.is_empty() {
                continue;
            }
            if let Some((name, inline)) = key.split_once('=') {
                values.insert(name.to_string(), inline.to_string());
                continue;
            }
            // 下一个不以 `--` 开头 ⇒ 当作本参数的值（与 v1 语义一致）
            let has_value = matches!(iter.peek(), Some(next) if !next.starts_with("--"));
            if has_value {
                let value = iter.next().unwrap_or_default();
                values.insert(key.to_string(), value);
            } else {
                flags.insert(key.to_string());
            }
        }

        let data_root = values
            .get("data-root")
            .map(|value| paths::absolute(Path::new(value)))
            .unwrap_or_else(paths::default_data_root);

        let ui_dist = if flags.contains("no-ui") {
            None
        } else {
            Some(
                values
                    .get("ui-dist")
                    .map(|value| paths::absolute(Path::new(value)))
                    .unwrap_or_else(paths::default_ui_dist),
            )
        };

        let builtin_roots = values
            .get("builtin-plugins")
            .map(|value| split_roots(value))
            .filter(|roots| !roots.is_empty())
            .unwrap_or_else(paths::default_builtin_roots);

        Self {
            data_root,
            builtin_roots,
            ui_dist,
            ui_dev_url: values.get("ui-dev").cloned(),
            standalone: flags.contains("standalone"),
        }
    }
}

fn split_roots(value: &str) -> Vec<PathBuf> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(|item| paths::absolute(Path::new(item)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> CliOptions {
        CliOptions::parse(args.iter().map(|item| item.to_string()))
    }

    #[test]
    fn parses_key_value_and_flags() {
        let options = parse(&["--data-root", "/tmp/data", "--standalone", "--no-ui"]);
        // 解析会做绝对化（Windows 上 `/tmp/data` 是「根相对」路径，会被拼上盘符），
        // 所以断言「是绝对路径 + 尾部组件一致」，不写死字符串
        assert!(options.data_root.is_absolute(), "data-root 必须绝对化：{:?}", options.data_root);
        assert!(options.data_root.ends_with(Path::new("tmp").join("data")));
        assert!(options.standalone);
        assert!(options.ui_dist.is_none());
    }

    #[test]
    fn parses_inline_equals_form() {
        let options = parse(&["--ui-dev=http://127.0.0.1:5173", "--ui-dist=/tmp/ui"]);
        assert_eq!(options.ui_dev_url.as_deref(), Some("http://127.0.0.1:5173"));
        let ui_dist = options.ui_dist.expect("ui-dist 应当有值");
        assert!(ui_dist.is_absolute() && ui_dist.ends_with("ui"), "ui-dist = {}", ui_dist.display());
    }

    #[test]
    fn builtin_plugins_accepts_comma_separated_roots() {
        let options = parse(&["--builtin-plugins", "/a/plugins, /b/preinstalled"]);
        assert_eq!(options.builtin_roots.len(), 2);
        assert!(options.builtin_roots[0].ends_with(Path::new("a").join("plugins")));
        assert!(options.builtin_roots[1].ends_with(Path::new("b").join("preinstalled")));
    }

    #[test]
    fn flag_followed_by_another_flag_is_not_consumed_as_value() {
        let options = parse(&["--standalone", "--no-ui"]);
        assert!(options.standalone);
        assert!(options.ui_dist.is_none());
    }
}
