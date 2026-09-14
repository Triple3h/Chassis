# 脚手架模板（可直接复制）

新建 `plugins/<name>/` 时，把下面文件按需复制并改掉名字。这些模板都来自本仓库已在跑的插件，不是示意代码。

## 目录

```
plugins/<name>/
├── package.json
├── vite.config.ts
├── vite.worker.config.ts      # 有 no-view / script 命令才需要
├── tsconfig.json
├── index.html
├── src/
│   ├── main.ts
│   ├── App.vue
│   ├── styles/app.css
│   └── core/                  # 纯逻辑（算法、解析、存储）
└── test/                      # 用 scripts/run-ts.mjs 跑的单测
```

## package.json

```json
{
  "name": "sofast-<name>",
  "title": "<命令面板里显示的插件名>",
  "author": "<作者>",
  "description": "<一句话说明>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "categories": ["tool"],
  "commands": [
    {
      "name": "<command>",
      "title": "<命令标题>",
      "mode": "view",
      "searchable": true,
      "placeholder": "<搜索框提示>"
    },
    { "name": "<script-command>", "title": "<脚本标题>", "mode": "script" }
  ],
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit -p tsconfig.json && vite build && vite build --config vite.worker.config.ts",
    "typecheck": "vue-tsc --noEmit -p tsconfig.json",
    "test": "node ../../scripts/run-ts.mjs test/core.test.ts",
    "preview": "vite preview"
  },
  "dependencies": {
    "@sofastapp/api": "^0.0.3",
    "vue": "^3.5.42"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.3.3",
    "@types/node": "^22.10.2",
    "@vitejs/plugin-vue": "^6.0.8",
    "tailwindcss": "^4.3.3",
    "typescript": "^5.9.2",
    "vite": "^7.3.6",
    "vue-tsc": "^3.3.11"
  }
}
```

没有 script/no-view 命令时，`build` 去掉最后一段；不要 `@types/node`。

## vite.config.ts（UI）

```ts
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { manifestPlugin } from '../../scripts/manifest-plugin.mjs'
import { devFsAllow, sharedAliases } from '../../scripts/vite-shared.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root,
  base: './',                                   // 宿主本地托管，必须相对路径
  plugins: [vue(), tailwindcss(), manifestPlugin({ root })],
  resolve: { alias: sharedAliases(root) },      // 让 shared/ 里的 import 能解析到本插件的 node_modules
  server: { fs: { allow: devFsAllow(root) } },  // dev 下允许读仓库根（shared/）
  worker: { format: 'es' },
  build: {
    outDir: path.resolve(root, 'dist'),
    emptyOutDir: true,                          // UI 构建可以清空
    target: 'es2022',
    assetsInlineLimit: 4096,                    // 大资源（如 wasm）别内联
    chunkSizeWarningLimit: 4096,
  },
})
```

## vite.worker.config.ts（no-view / script）

> 一个配置只打**一个**入口，入口由环境变量 `SOFAST_WORKER_ENTRY` 选，批量构建交给 `scripts/build-no-view.mjs`。
>
> **为什么不用 Rollup 的多入口**：两个脚本共用的模块（比如 `_hosts-file.ts`）会被拆成 `dist/assets/*.mjs`，入口里只剩一条相对 import。宿主只把 `dist/<name>.mjs` 当 Worker 入口拉起，这条跨文件依赖一旦因为复制、打包遗漏而断掉，命令就整个废了。逐入口各构建一次，才能保证「一个文件就是一个命令」。
>
> 只有**一个** script 命令时可以直接 `vite build --config vite.worker.config.ts`，不会拆 chunk。

```ts
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

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
    .filter((name) => !name.startsWith('_'))   // 下划线开头是纯辅助模块，只被入口内联
}

const entries = discoverEntries()
if (!entries.length) throw new Error('src/no-view 下没有可构建的脚本入口')

const wanted = process.env.SOFAST_WORKER_ENTRY?.trim()
const entry = wanted && entries.includes(wanted) ? wanted : entries[0]

export default defineConfig({
  root,
  build: {
    outDir: path.resolve(root, 'dist'),
    emptyOutDir: false,                        // ★ 不能清掉 UI 产物
    target: 'node20',
    minify: false,
    lib: {
      entry: path.join(root, 'src', 'no-view', `${entry}.ts`),
      formats: ['es'],
      fileName: () => `${entry}.mjs`,          // ★ 产物名必须与 commands[].name 一致
    },
    rollupOptions: {
      external: ['worker_threads', /^node:.*/], // ★ Node 内置模块保持 external
      output: { manualChunks: undefined },
    },
  },
})
```

## scripts/build-no-view.mjs（有 2 个以上 script 入口时必需）

`package.json` 的 `build` 末段改成 `node scripts/build-no-view.mjs`。

```js
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 逐个构建 src/no-view/*.ts，保证每个 dist/<name>.mjs 自包含（不产生跨文件 import） */
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
    env: { ...process.env, SOFAST_WORKER_ENTRY: name },
  })
}
```

> 验证自包含：构建完 `grep -h '^import' dist/*.mjs`，应该只看得到 `node:*` 与 `worker_threads`。
> 另外 Vite 的 `defineConfig` **不接受配置数组**（CLI 报 `config must export or return an object`），多配置只能像上面这样在脚本里循环。

## tsconfig.json

```json
{
  "extends": "../../shared/tsconfig.base.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["../../shared/*"],
      "vue": ["./node_modules/vue"],
      "@sofastapp/api": ["./node_modules/@sofastapp/api"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.d.ts", "src/**/*.vue", "../../shared/**/*.ts", "../../shared/**/*.vue"]
}
```

## src/styles/app.css

```css
@import "tailwindcss";
@import "../../../../shared/styles/theme.css";

/* Tailwind v4 不会自动跨目录扫描，必须显式声明 */
@source "../";
@source "../../../../shared";
```

## index.html / src/main.ts

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>插件标题</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

```ts
import { createApp } from 'vue'
import './styles/app.css'
import App from './App.vue'

createApp(App).mount('#app')
```

## script 命令入口（`src/no-view/<name>.ts`）

```ts
/// <reference types="node" />
import { ctx, done, log, onError } from '@sofastapp/api/node'
import { readSomething } from './find-something'   // 纯逻辑放同目录的辅助模块，便于单测

onError()

void (async () => {
  const { args, pluginPath } = ctx()
  try {
    const result = readSomething(String((args as { path?: string })?.path ?? ''))
    log('<name>: 完成', { pluginPath })
    done({ ok: true, files: [result] })
  } catch (err) {
    done({ ok: false, files: [], error: err instanceof Error ? err.message : String(err) })
  }
})()
```

## 用 worker_threads 端到端验证 script 产物（脱离宿主）

```js
// node tools/run-script.mjs <dist/xxx.mjs 绝对路径> '<args json>'
import { Worker } from 'node:worker_threads'
const [entry, argsJson] = process.argv.slice(2)
const worker = new Worker(entry, {
  workerData: { command: '<name>', args: JSON.parse(argsJson ?? '{}'), pluginPath: '/tmp/fake-plugin' },
})
const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(1) }, 15000)
worker.on('message', (m) => {
  if (m.type === 'log') { console.log('LOG', m.message, JSON.stringify(m.data)); return }
  if (m.type !== 'result') return            // done(x) 会发 { type:'result', data:x }
  clearTimeout(timer)
  console.log('RESULT', JSON.stringify(m.data).slice(0, 500))
  worker.terminate()
})
worker.on('error', (e) => { clearTimeout(timer); console.error('WORKER-ERROR', e.message); process.exit(1) })
```

> 注意 `new Worker()` 的第一个参数必须是**绝对路径**；传 `file://` 字符串会抛 `ERR_WORKER_PATH`。

## UI 侧调用 script

```ts
import { runScript } from '@shared/lib/platform'

const res = await runScript<{ ok: boolean; files: Array<{ name: string; data?: string }> }>(
  '<script-command>',
  { listOnly: true },
  12_000,
)
if (!res) {
  // 宿主不可用或版本太低：给提示，引导用户走手工路径
}
```

`runScript` 已内置超时与降级（返回 `null` 表示宿主没应答），不要再裸调 `Backend.run`。
