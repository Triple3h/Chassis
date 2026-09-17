//! 插件改名链（对齐 v1 `apps/kernel/src/legacy.ts`）。
//!
//! 每项 = 「当前 id + 它的历代旧 id」（从新到旧）。两处迁移都是**单跳**查表：
//! `plugin.rs` 反查一次旧数据目录（`legacy_data_dir_ids`），`history.rs` 换一次前缀
//! （`legacy_id_to_current`）—— 只记上一代的话，两代之前的用户（`sofast-hosts`）会停在中途。

use std::collections::HashMap;

pub const RENAME_CHAINS: &[&[&str]] = &[
    &["host-manager", "hosts", "sofast-hosts"],
    &["totp", "sofast-totp"],
    &["text-diff", "sofast-text-diff"],
    &["json-tools", "sofast-json-tools"],
];

/// 当前 id → 直接前任（数据目录的第一个候选；`plugin.rs` 按它接手旧目录）。
pub fn legacy_plugin_id(id: &str) -> Option<&'static str> {
    RENAME_CHAINS.iter().find(|chain| chain[0] == id).and_then(|chain| chain.get(1).copied())
}

/// 当前 id → 全部历代旧 id（从近到远）：旧数据目录得逐个试，才能接住两代之前的用户。
pub fn legacy_data_dir_ids(id: &str) -> Vec<&'static str> {
    RENAME_CHAINS
        .iter()
        .find(|chain| chain[0] == id)
        .map(|chain| chain[1..].to_vec())
        .unwrap_or_default()
}

/// 旧 id → 当前 id（**每一个**历代旧 id 都直接指向当前 id，单跳查表一次迁到底）。
pub fn current_plugin_id(old: &str) -> Option<&'static str> {
    RENAME_CHAINS.iter().find_map(|chain| chain[1..].contains(&old).then_some(chain[0]))
}

/// 旧 → 新 的完整映射（历史 / 固定项迁移用）。
pub fn legacy_id_to_current() -> HashMap<String, String> {
    let mut map = HashMap::new();
    for chain in RENAME_CHAINS {
        for old in &chain[1..] {
            map.insert((*old).to_string(), chain[0].to_string());
        }
    }
    map
}

/// 当前 id → 直接前任 的映射（`LEGACY_PLUGIN_IDS` 的等价物）。
pub fn legacy_plugin_ids() -> HashMap<String, String> {
    let mut map = HashMap::new();
    for chain in RENAME_CHAINS {
        if let Some(previous) = chain.get(1) {
            map.insert(chain[0].to_string(), (*previous).to_string());
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_generation_chain_resolves_in_one_hop() {
        assert_eq!(legacy_data_dir_ids("host-manager"), vec!["hosts", "sofast-hosts"]);
        assert_eq!(current_plugin_id("sofast-hosts"), Some("host-manager"));
        assert_eq!(current_plugin_id("hosts"), Some("host-manager"));
        assert_eq!(legacy_plugin_id("host-manager"), Some("hosts"));
    }

    #[test]
    fn unknown_ids_have_no_legacy() {
        assert!(legacy_data_dir_ids("app-launcher").is_empty());
        assert!(current_plugin_id("app-launcher").is_none());
    }

    #[test]
    fn mapping_covers_every_generation() {
        let map = legacy_id_to_current();
        assert_eq!(map.len(), 5, "4 条链一共 5 个旧 id（host-manager 有 2 个历代 id）");
        assert_eq!(map.get("sofast-json-tools").map(String::as_str), Some("json-tools"));
    }
}
