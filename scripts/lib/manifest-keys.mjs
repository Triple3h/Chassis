/**
 * 发布到 dist 的清单字段（字段裁剪的**唯一**白名单）。
 *
 * 两套工具链共用：Vite 插件（`manifest-plugin.mjs`，Vue 插件）与 esbuild 构建器
 * （`build-plugin.mjs`，内置插件）。历史上两边各写了一份，加字段时必然漏一个
 * （`essential` 就是这么发现的）—— 现在只在这里维护。
 *
 * `apiVersion` / `capabilities` 是启动台的硬要求（plugin-spec §3.1）：
 * 少一个就 `MANIFEST_INVALID`、少声明能力就 `CAPABILITY_UNKNOWN`。
 */
export const MANIFEST_KEYS = [
  'name',
  'title',
  'author',
  'version',
  'description',
  'categories',
  'commands',
  'icon',
  'homepage',
  'license',
  'keywords',
  'apiVersion',
  'capabilities',
  // 底座基础能力（不可禁用）：只有出厂 bundle 会声明，但必须一起进产物
  'essential',
  // 不计入「最近使用」（底座自身入口用）
  'history',
]
