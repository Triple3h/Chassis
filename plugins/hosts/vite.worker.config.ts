import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { sharedAliases } from '../shared/build/vite-shared.mjs'

/**
 * No-View / Script 命令的构建配置：把 src/no-view/<name>.ts 打成 dist/<name>.mjs，
 * 文件名必须与 package.json 里 commands[].name 一致，宿主才能按名字找到入口。
 *
 * 关键点：
 *  - emptyOutDir: false —— 绝不能清掉前面 UI 构建产出的 index.html / assets；
 *  - node 内置模块与 worker_threads 保持 external，交给宿主 Node 运行时提供；
 *  - 下划线开头的文件是纯辅助模块，只被入口内联，不单独出包。
 *
 * 入口由环境变量 PLUGIN_WORKER_ENTRY 指定，没给就取第一个。
 * 真正的批量构建在 scripts/build-no-view.mjs —— 它**逐个入口各跑一次构建**。
 * 为什么不用 Rollup 的多入口一次搞定：两个脚本共用的模块（这里是 _hosts-file.ts）
 * 会被拆成 `dist/assets/_hosts-file-xxx.mjs`，入口里只剩一条相对 import；
 * 宿主只把 `dist/<name>.mjs` 当 Worker 入口拉起，这条跨文件依赖一旦因为复制、
 * 打包遗漏或路径变化而断掉，整个命令就废了。所以每个 .mjs 必须自包含。
 */
const root = path.dirname(fileURLToPath(import.meta.url))

function discoverEntries(): string[] {
  const dir = path.join(root, 'src', 'no-view')
  let items: ReturnType<typeof readdirSync> = []
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return items
    .filter((item) => item.isFile() && item.name.endsWith('.ts') && !item.name.endsWith('.d.ts'))
    .map((item) => item.name.replace(/\.ts$/, ''))
    .filter((name) => !name.startsWith('_'))
}

const entries = discoverEntries()
if (!entries.length) {
  throw new Error('src/no-view 下没有可构建的脚本入口')
}

const wanted = process.env.PLUGIN_WORKER_ENTRY?.trim()
const entry = wanted && entries.includes(wanted) ? wanted : entries[0]

export default defineConfig({
  root,
  resolve: { alias: sharedAliases(root) },
  build: {
    outDir: path.resolve(root, 'dist'),
    emptyOutDir: false,
    target: 'node20',
    minify: false,
    lib: {
      entry: path.join(root, 'src', 'no-view', `${entry}.ts`),
      formats: ['es'],
      fileName: () => `${entry}.mjs`,
    },
    rollupOptions: {
      external: ['worker_threads', /^node:.*/],
      output: { manualChunks: undefined },
    },
  },
})
