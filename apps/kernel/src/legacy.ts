/**
 * 插件改名映射（2026-09-16：四个 Vue 插件去掉 `sofast-` 前缀）。
 *
 * 方向是 **新 id → 旧 id**：`plugin.ts` 装配某个插件时按新 id 反查旧数据目录
 * （`adoptLegacyDataDir`：新目录不存在、旧目录还在 ⇒ 整体复制，只复制不删除）。
 *
 * 历史 / 固定项要的是反过来的表（旧 → 新），用 `LEGACY_ID_TO_CURRENT`，别混用。
 * 两处迁移都是单向、一次性的；旧目录与旧条目留由用户自行清理。
 */
export const LEGACY_PLUGIN_IDS: Record<string, string> = {
  totp: 'sofast-totp',
  hosts: 'sofast-hosts',
  'text-diff': 'sofast-text-diff',
  'json-tools': 'sofast-json-tools',
}

/** 旧 id → 新 id（历史 / 固定项迁移用，由 `LEGACY_PLUGIN_IDS` 反向生成） */
export const LEGACY_ID_TO_CURRENT: Record<string, string> = Object.fromEntries(
  Object.entries(LEGACY_PLUGIN_IDS).map(([current, legacy]) => [legacy, current]),
)
