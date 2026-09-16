import path from 'node:path'

/**
 * Vue 插件（`plugins/{totp,hosts,text-diff,json-tools}`）的构建期别名。
 *
 * 为什么需要：`plugins/shared/` 位于各插件的 `node_modules` 之外（pnpm 不做提升），
 * 从 shared 文件里 `import 'vue'` / `import('@launcher/api')` 时 Node 解析一路向上找不到依赖，
 * 所以显式指向插件自己的 `node_modules` —— 顺带做依赖去重。
 *
 * `@launcher/api` 是仓库内的工作区包（`packages/plugin-api`，未发布）。
 */
export function sharedAliases(pluginRoot) {
  const dep = (name) => path.resolve(pluginRoot, 'node_modules', name)
  return {
    '@shared': path.resolve(pluginRoot, '..', 'shared'),
    vue: dep('vue'),
    '@launcher/api': dep('@launcher/api'),
  }
}

/** fs.allow：开发服务器要读插件目录之外的 `plugins/shared` */
export function devFsAllow(pluginRoot) {
  return [path.resolve(pluginRoot, '..')]
}
