# 脚手架模板（可直接复制）

新建 `plugins/<name>/` 时，把下面文件按需复制并改掉名字。这些模板都来自本仓库已在跑的插件，不是示意代码。

## 目录

```
plugins/<name>/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── index.html
├── Cargo.toml                 # 有 no-view / script 命令才需要（crate 根 = 插件目录）
├── src/
│   ├── main.ts
│   ├── App.vue
│   ├── styles/app.css
│   ├── core/                  # view 侧纯逻辑（算法、解析、存储）
│   ├── lib.rs                 # 逻辑层纯逻辑（可单测；有逻辑层才需要）
│   └── bin/<name>.rs          # 每个 no-view / script 命令一个 bin
└── test/                      # 用 scripts/run-ts.mjs 跑的单测
```

## package.json

```json
{
  "name": "<name>",
  "title": "<命令面板里显示的插件名>",
  "author": "<作者>",
  "description": "<一句话说明>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "categories": ["tool"],
  // 可选：只在一个平台能跑时**必须**声明（省略 = 全平台）
  // "platforms": ["macos"],        // macos | windows | linux（照 Rust target_os 写，不是 darwin/win32）
  // "arch": ["x64"],               // x64 | arm64，省略 = 不限制
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
    "build": "npm run build:view && npm run build:scripts",
    "build:view": "vue-tsc --noEmit -p tsconfig.json && vite build",
    "build:scripts": "cargo build --release -p launcher-plugin-<id> && node ../../scripts/build-plugin.mjs <id> --copy-scripts --keep-dist",
    "typecheck": "vue-tsc --noEmit -p tsconfig.json",
    "test": "node ../../scripts/run-ts.mjs test/core.test.ts",
    "test:scripts": "cargo test -p launcher-plugin-<id>",
    "preview": "vite preview"
  },
  "dependencies": {
    "@launcher/api": "workspace:*",
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

没有 no-view/script 命令时：`build` 只留 `build:view`，也不要 `Cargo.toml` 与 `@types/node`。

新字段（`platforms` / `arch` 等）别忘了同步 `scripts/lib/manifest-keys.mjs` 的白名单 —— 不在白名单里的字段会被构建裁掉。

## vite.config.ts（UI）

```ts
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { manifestPlugin } from '../../scripts/lib/manifest-plugin.mjs'
import { devFsAllow, pluginAliases } from '../../scripts/lib/vite-plugin-vue.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root,
  base: './',                                   // 宿主本地托管，必须相对路径
  plugins: [vue(), tailwindcss(), manifestPlugin({ root })],
  resolve: { alias: pluginAliases(root) },      // vue 去重：包内 SFC 与本插件共用同一份运行时
  server: { fs: { allow: devFsAllow(root) } },  // dev 下允许读仓库根（packages/ui）
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

## 逻辑层构建（no-view / script → Rust 可执行产物）

`package.json` 的两条脚本（根 `scripts/build-all.mjs` 按它们驱动构建）：

```json
"build:view": "vue-tsc --noEmit -p tsconfig.json && vite build",
"build:scripts": "cargo build --release -p launcher-plugin-<id> && node ../../scripts/build-plugin.mjs <id> --copy-scripts --keep-dist"
```

- crate 根 = 插件目录（`Cargo.toml` 与 `package.json` 同层），源码在 `src/`；`[[bin]] name` = `commands[].name`；`cargo build --release` 产出仓库根 `target/release/<bin>`（新插件记得把 `plugins/<id>` 加进根 `Cargo.toml` members）。
- `scripts/build-plugin.mjs <id> --copy-scripts` 把它拷成 `dist/<name>`（0755）；`--keep-dist` = 别删上一步 vite 的产物（**顺序：先 view 后 scripts**）。
- 一个 bin 天然自包含：v1 时代那套「逐入口构建、防止 Rollup 拆 chunk」的配置整段作废。

> v1 历史：`.mjs` 产物用 `vite.worker.config.ts` + `PLUGIN_WORKER_ENTRY` 逐入口构建；底座从 M5 起**不再支持** `.mjs`（`apiVersion` 必须是 `"2"`）。

## tsconfig.json

```json
{
  "extends": "../../tsconfig.vue-plugin.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "vue": ["./node_modules/vue"],
      "@launcher/api": ["./node_modules/@launcher/api"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.d.ts", "src/**/*.vue"]
}
```

## src/styles/app.css

```css
@import "tailwindcss";
@import "../../../../packages/ui/styles/theme.css";

/* Tailwind v4 不会自动跨目录扫描，必须显式声明 */
@source "../";
@source "../../../../packages/ui";
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

## 逻辑层命令（Rust crate：crate 根 = 插件目录）

`Cargo.toml`（插件根）：

```toml
[package]
name = "launcher-plugin-<id>"
version = "0.1.0"
edition = "2021"

[dependencies]
launcher-plugin-sdk = { path = "../../packages/plugin-sdk-rs" }

[[bin]]
name = "<name>"                        # = commands[].name（产物就是 dist/<name>）
path = "src/bin/<name>.rs"
```

`src/lib.rs` 放纯逻辑（可单测），`src/bin/<name>.rs` 是胶水：

```rust
use launcher_plugin_sdk::{json, run, Context, Level, Result};

fn main() {
    run(dispatch)                       // Err / panic 由 SDK 自动转 fail，不用自己兜
}

fn dispatch(ctx: &Context) -> Result<()> {
    let path = ctx.raw_args().get("path").and_then(|value| value.as_str()).unwrap_or_default();
    let files = launcher_plugin_<id>::read_something(path)?;
    ctx.log("<name>: 完成", Some(&json!({ "pluginPath": ctx.plugin_path().to_string_lossy() })), Level::Info)?;
    ctx.done(json!({ "ok": true, "files": files }))
}
```

要点：

- 一次性执行（`run`）：`ctx.done` 之后必须返回/退出；**不要**自己 daemon 化。
- 常驻搜索源（`contributes: true`）：用 `ctx.on_query(|query, token| Ok(vec![...]))`，见 `packages/plugin-sdk-rs/examples/echo.rs` 的 `feed`。
- 设置项：`ctx.settings_str("key")` / `ctx.settings_bool("key")`（由宿主启动时注入快照）；私有数据写 `ctx.data_path()`。
- stdout **只准**协议行：日志走 `ctx.log`，别裸 `println!`。

## 手工拉起逻辑层产物（脱离宿主）

宿主做的事就是「spawn `dist/<name>` + 注入 base64 上下文」，手工复现：

```bash
CTX=$(printf '%s' '{"command":"<name>","args":{"path":"/tmp/x"},"pluginId":"demo","pluginPath":"'"$PWD"'","dataPath":"/tmp/demo-data"}' | base64)
LAUNCHER_PLUGIN_ID=demo LAUNCHER_DATA_PATH=/tmp/demo-data \
  ./dist/<name> --mode run --launcher-context "$CTX"
```

> `--launcher-context` 是 **base64(JSON)**（URL-safe 与标准两种都认），缺失字段用 `LAUNCHER_PLUGIN_ID` / `LAUNCHER_DATA_PATH` 兜底；
> 常驻搜索源加 `--mode search`（stdin 收 `{"type":"query",...}`）。
> 输出是 NDJSON 协议行：`{"type":"log"|"progress"|"result"|"done",...}` —— 能打出 `"type":"result"` 就说明产物没问题，问题在宿主侧调用。

## UI 侧调用 script

```ts
import { exec } from '@launcher/api'

const res = (await exec
  .run({ command: '<script-command>', args: { listOnly: true }, timeoutMs: 12_000 })
  .catch(() => null)) as { ok: boolean; files: Array<{ name: string; data?: string }> } | null
if (!res) {
  // 宿主不可用 / 脚本失败 / 超时：给提示，引导用户走手工路径
}
```

`exec.run` 的失败形态是 **reject**（`LauncherError`：`NOT_FOUND` / `TIMEOUT` / `SCRIPT_ERROR`）——
需要「失败即空值」就自己在调用点接 `.catch(() => null)`，别让抛错冒泡成未捕获异常。
