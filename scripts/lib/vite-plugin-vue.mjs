import path from 'node:path'

/**
 * Vue 插件（`plugins/{totp,hosts,text-diff,json-tools}`）的构建期别名。
 *
 * 为什么需要：`@launcher/ui`（`packages/ui`）不在插件的 `node_modules` 之下，
 * 从包内文件 `import 'vue'` 时按 pnpm 的严格结构会解析到另一份实例，
 * 所以显式把 `vue` 指向插件自己的 `node_modules` —— 保证 SFC 与插件代码共用一个运行时。
 *
 * `@launcher/api` / `@launcher/ui` 都是工作区包，走标准解析（pnpm 符号链接），无需别名。
 */
export function pluginAliases(pluginRoot) {
  const dep = (name) => path.resolve(pluginRoot, 'node_modules', name)
  return {
    vue: dep('vue'),
  }
}

/** fs.allow：开发服务器要读插件目录之外的 `packages/ui` —— 放开到仓库根 */
export function devFsAllow(pluginRoot) {
  return [path.resolve(pluginRoot, '..', '..')]
}
