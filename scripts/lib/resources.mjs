/** 组装 sidecar 运行时要用的资源：kernel / ui / builtin-plugins */
import fs from 'node:fs'
import path from 'node:path'

function copy(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true })
}

/**
 * 把构建产物拷进 apps/shell/resources/。
 * 运行时壳按 `app.path().resource_dir()` 查找 —— 打包后即 `Contents/Resources/`。
 */
export function assembleResources(repoRoot) {
  const resources = path.join(repoRoot, 'apps', 'shell', 'resources')
  const kernelEntry = path.join(repoRoot, 'apps', 'kernel', 'dist', 'kernel.mjs')
  const uiDist = path.join(repoRoot, 'apps', 'launcher-ui', 'dist')

  if (!fs.existsSync(kernelEntry)) throw new Error(`找不到内核产物：${kernelEntry}（先跑 npm run build:kernel）`)
  if (!fs.existsSync(path.join(uiDist, 'index.html'))) {
    throw new Error(`找不到 UI 产物：${uiDist}（先跑 npm run build:ui）`)
  }

  copy(kernelEntry, path.join(resources, 'kernel', 'kernel.mjs'))
  copy(uiDist, path.join(resources, 'ui'))

  const builtin = path.join(resources, 'builtin-plugins')
  fs.rmSync(builtin, { recursive: true, force: true })
  fs.mkdirSync(builtin, { recursive: true })
  let count = 0
  // 出厂预装 = 内置插件（plugins/）+ 预置插件（presets/）。
  // 源码分成两个目录管理，运行时都在同一个「出厂 bundle」目录里，内核一视同仁。
  for (const root of ['plugins', 'presets']) {
    const pluginsRoot = path.join(repoRoot, root)
    if (!fs.existsSync(pluginsRoot)) continue
    for (const name of fs.readdirSync(pluginsRoot)) {
      const dist = path.join(pluginsRoot, name, 'dist')
      if (!fs.existsSync(path.join(dist, 'package.json'))) continue
      fs.cpSync(dist, path.join(builtin, name), { recursive: true })
      count += 1
    }
  }

  return { resources, pluginCount: count }
}
