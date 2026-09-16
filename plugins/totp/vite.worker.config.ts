import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { sharedAliases } from '../shared/build/vite-shared.mjs'

/**
 * No-View / Script 命令的构建配置：把 src/no-view/*.ts 各自打成 dist/<name>.mjs，
 * 文件名必须与 package.json 里 commands[].name 一致，宿主才能按名字找到入口。
 *
 * 关键点：
 *  - emptyOutDir: false —— 绝不能清掉前面 UI 构建产出的 index.html / assets；
 *  - node 内置模块与 worker_threads 保持 external，交给宿主 Node 运行时提供。
 */

const root = path.dirname(fileURLToPath(import.meta.url))

function discoverInputs(): Record<string, string> {
  const inputs: Record<string, string> = {}
  const dir = path.join(root, 'src', 'no-view')
  let items: ReturnType<typeof readdirSync> = []
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    return inputs
  }
  for (const item of items) {
    if (!item.isFile() || !item.name.endsWith('.ts')) continue
    if (item.name.endsWith('.d.ts')) continue
    const name = item.name.replace(/\.ts$/, '')
    // 辅助模块不单独出包，只作为入口的依赖被内联
    if (name.startsWith('_') || name === 'find-image') continue
    inputs[name] = path.join(dir, item.name)
  }
  if (!Object.keys(inputs).length) {
    throw new Error('src/no-view 下没有可构建的脚本入口')
  }
  return inputs
}

export default defineConfig({
  root,
  resolve: { alias: sharedAliases(root) },
  build: {
    outDir: path.resolve(root, 'dist'),
    emptyOutDir: false,
    target: 'node20',
    minify: false,
    rollupOptions: {
      external: ['worker_threads', /^node:.*/],
      input: discoverInputs(),
      output: {
        entryFileNames: '[name].mjs',
        chunkFileNames: 'assets/[name]-[hash].mjs',
        manualChunks: undefined,
      },
    },
  },
})
