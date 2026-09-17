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
  // v2：内核是 Rust 可执行文件（target/release/launcher-kernel），不再是 Node 的 kernel.mjs
  const kernelName = process.platform === 'win32' ? 'launcher-kernel.exe' : 'launcher-kernel'
  const kernelEntry = path.join(repoRoot, 'target', 'release', kernelName)
  const uiDist = path.join(repoRoot, 'apps', 'launcher-ui', 'dist')

  if (!fs.existsSync(kernelEntry)) throw new Error(`找不到内核产物：${kernelEntry}（先跑 pnpm build:kernel）`)
  if (!fs.existsSync(path.join(uiDist, 'index.html'))) {
    throw new Error(`找不到 UI 产物：${uiDist}（先跑 pnpm build:ui）`)
  }

  const kernelDir = path.join(resources, 'kernel')
  fs.mkdirSync(kernelDir, { recursive: true })
  // 先清掉上一次的产物（含 v1 留下的 kernel.mjs），只保留仓库里的 PLACEHOLDER.md
  for (const name of fs.readdirSync(kernelDir)) {
    if (name.endsWith('.md')) continue
    fs.rmSync(path.join(kernelDir, name), { recursive: true, force: true })
  }
  const kernelDest = path.join(kernelDir, kernelName)
  fs.copyFileSync(kernelEntry, kernelDest)
  // 可执行位必须带进 .app（copyFileSync 保留 mode，这里显式再设一次）
  if (process.platform !== 'win32') fs.chmodSync(kernelDest, 0o755)
  copy(uiDist, path.join(resources, 'ui'))

  const builtin = path.join(resources, 'builtin-plugins')
  fs.rmSync(builtin, { recursive: true, force: true })
  fs.mkdirSync(builtin, { recursive: true })
  // 出厂预装 = `plugins/` 下全部插件。目录里插件工具链有两套（内置 esbuild /
  // 移植件 Vite + Vue），但产物形态一致：有 dist/package.json 才算插件。
  let count = 0
  const pluginsRoot = path.join(repoRoot, 'plugins')
  if (fs.existsSync(pluginsRoot)) {
    for (const name of fs.readdirSync(pluginsRoot)) {
      const dist = path.join(pluginsRoot, name, 'dist')
      if (!fs.existsSync(path.join(dist, 'package.json'))) continue
      fs.cpSync(dist, path.join(builtin, name), { recursive: true })
      count += 1
    }
  }

  return { resources, pluginCount: count }
}
