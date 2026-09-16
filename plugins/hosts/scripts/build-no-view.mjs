import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 逐个构建 src/no-view/*.ts。
 *
 * 为什么不用 `vite build` 的多入口一次构建：Rollup 会把被两个脚本共用的模块
 * （这里 src/no-view/_hosts-file.ts）拆成 `dist/assets/_hosts-file-xxx.mjs`，
 * 入口文件里只剩一条相对 import。宿主只把 `dist/<name>.mjs` 当 Worker 入口拉起，
 * 这条跨文件依赖一旦因为复制、打包遗漏、路径变化而断掉，命令就整个废了。
 * 每个入口单独构建一次，能保证产物自包含。
 *
 * 用法：node scripts/build-no-view.mjs（由 package.json 的 build 脚本调用）
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(root, 'src', 'no-view')
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')

const entries = readdirSync(srcDir)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.startsWith('_'))
  .map((name) => name.replace(/\.ts$/, ''))

if (!entries.length) {
  console.error('src/no-view 下没有可构建的脚本入口')
  process.exit(1)
}

for (const name of entries) {
  execFileSync(process.execPath, [viteBin, 'build', '--config', 'vite.worker.config.ts'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PLUGIN_WORKER_ENTRY: name },
  })
}
