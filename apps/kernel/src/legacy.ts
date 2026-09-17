/**
 * 插件改名链（2026-09-16：四个 Vue 插件去掉 `sofast-` 前缀；2026-09-17：hosts → host-manager）。
 *
 * 每项 = 「当前 id + 它的历代旧 id」（从新到旧）。为什么要记整条链：两处迁移都是**单跳**查表
 * （`plugin.ts` 反查一次旧数据目录，`history.renamePlugin` 换一次前缀），只记上一代的话，
 * 两代之前的用户（`sofast-hosts`）迁到上一代（`hosts`）就停住，历史项照样置灰。
 */
const RENAME_CHAINS: ReadonlyArray<readonly [string, ...string[]]> = [
  ['host-manager', 'hosts', 'sofast-hosts'],
  ['totp', 'sofast-totp'],
  ['text-diff', 'sofast-text-diff'],
  ['json-tools', 'sofast-json-tools'],
]

/**
 * 当前 id → 直接前任（数据目录的第一个候选）。
 * 方向是 **新 id → 旧 id**：`plugin.ts` 装配某个插件时按新 id 找一个能接手的旧数据目录
 * （`adoptLegacyDataDir`：新目录不存在、旧目录还在 ⇒ 整体复制，只复制不删除）。
 *
 * 历史 / 固定项要的是反过来的表（旧 → 新），用 `LEGACY_ID_TO_CURRENT`，别混用。
 * 两处迁移都是单向、一次性的；旧目录与旧条目留由用户自行清理。
 */
export const LEGACY_PLUGIN_IDS: Record<string, string> = Object.fromEntries(
  RENAME_CHAINS.flatMap(([current, ...older]) => {
    const prev = older[0]
    return prev === undefined ? [] : [[current, prev] as [string, string]]
  }),
)

/** 当前 id → 全部历代旧 id（从近到远）：旧数据目录得逐个试，才能接住两代之前的用户 */
export function legacyDataDirIds(id: string): string[] {
  const chain = RENAME_CHAINS.find(([current]) => current === id)
  return chain ? [...chain.slice(1)] : []
}

/**
 * 旧 id → 当前 id（历史 / 固定项迁移用）。
 * **每一个**历代旧 id 都直接指向当前 id，所以单跳查表就能一次迁到底。
 */
export const LEGACY_ID_TO_CURRENT: Record<string, string> = Object.fromEntries(
  RENAME_CHAINS.flatMap(([current, ...older]) => older.map((old) => [old, current] as const)),
)
