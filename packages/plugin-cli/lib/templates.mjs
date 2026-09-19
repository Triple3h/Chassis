/**
 * 脚手架模板（来源：仓库里在跑的插件，不是示意代码）。
 *
 * 目标：生成物**开箱可构建**，且清单能过 `@launcher/plugin-manifest` 的校验
 * （守护用例见 `test/scaffold.test.ts`）。
 *
 * 路径类模板（vite.config / Cargo.toml / app.css）里的相对引用不写死 `../../`，由
 * `scaffold.mjs` 按「插件目录 → 仓库内目标」算好后经 `rel` 传入 —— `--out` 指向深处/浅处都成立。
 */

/** 依赖版本与仓库其它插件保持一致（升依赖时只改这一处） */
const VUE = '^3.5.42'
const DEV_DEPENDENCIES = {
  '@tailwindcss/vite': '^4.3.3',
  '@types/node': '^22.10.2',
  '@vitejs/plugin-vue': '^6.0.8',
  tailwindcss: '^4.3.3',
  typescript: '^5.9.2',
  vite: '^7.3.6',
  'vue-tsc': '^3.3.11',
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

/**
 * 清单（`package.json`，plugin-spec §2）。
 * `commands` 由调用方按形态拼好传入 —— 这里的字段全部在 `scripts/lib/manifest-keys.mjs` 白名单内。
 */
export function manifest({ id, title, author, description, icon, capabilities, commands, hasView, hasScript }) {
  const scripts = {}
  const dependencies = {}
  const devDependencies = {}

  if (hasView) {
    Object.assign(scripts, {
      dev: 'vite',
      typecheck: 'vue-tsc --noEmit -p tsconfig.json',
      'build:view': 'vue-tsc --noEmit -p tsconfig.json && vite build',
      preview: 'vite preview',
    })
    Object.assign(dependencies, { '@launcher/api': 'workspace:*', '@launcher/ui': 'workspace:*', vue: VUE })
    Object.assign(devDependencies, DEV_DEPENDENCIES)
  }
  if (hasScript) {
    scripts['build:scripts'] =
      `cargo build --release -p launcher-plugin-${id} && node ../../scripts/build-plugin.mjs ${id} --copy-scripts --keep-dist`
  }
  scripts.build = hasView ? (hasScript ? 'npm run build:view && npm run build:scripts' : 'npm run build:view') : 'npm run build:scripts'
  if (hasScript) devDependencies['@types/node'] = DEV_DEPENDENCIES['@types/node']

  return json({
    name: id,
    title,
    author,
    description,
    version: '0.1.0',
    private: true,
    type: 'module',
    apiVersion: '2',
    icon,
    categories: ['tool'],
    // 只声明实际用到的能力（spec-check 会反查调用与声明的差集）；示例见 src/App.vue 顶部注释
    capabilities,
    commands,
    scripts,
    dependencies,
    devDependencies,
  })
}

export function viteConfig({ rel }) {
  return `import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { manifestPlugin } from '${rel.scriptsLib}/manifest-plugin.mjs'
import { devFsAllow, pluginAliases } from '${rel.scriptsLib}/vite-plugin-vue.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root,
  base: './', // 宿主本地托管，必须相对路径
  plugins: [vue(), tailwindcss(), manifestPlugin({ root })],
  resolve: { alias: pluginAliases(root) }, // vue 去重：包内 SFC 与本插件共用同一份运行时
  server: { fs: { allow: devFsAllow(root) } }, // dev 下允许读仓库根（packages/ui）
  worker: { format: 'es' },
  build: {
    outDir: path.resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 4096,
  },
})
`
}

export function tsconfig() {
  return json({
    extends: '../../tsconfig.vue-plugin.json',
    compilerOptions: {
      baseUrl: '.',
      paths: {
        vue: ['./node_modules/vue'],
        '@launcher/api': ['./node_modules/@launcher/api'],
      },
    },
    include: ['src/**/*.ts', 'src/**/*.d.ts', 'src/**/*.vue'],
  })
}

export function indexHtml(title) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`
}

export function mainTs() {
  return `import { createApp } from 'vue'
import './styles/app.css'
import App from './App.vue'

createApp(App).mount('#app')
`
}

export function appCss({ rel }) {
  return `@import "tailwindcss";
@import "${rel.themeCss}";

/* Tailwind v4 不会自动跨目录扫描，必须显式声明 */
@source "../";
@source "${rel.uiDir}";
`
}

export function appVue({ title, scriptCommand }) {
  const scriptHint = scriptCommand
    ? `
// 逻辑层命令（见 src/bin/）：失败形态是 reject，调用点自己接住
// import { exec } from '@launcher/api'
// const res = (await exec.run({ command: '${scriptCommand}', args: { text: 'hi' } }).catch(() => null)) as
//   | { ok: boolean; echo?: string }
//   | null
`
    : ''
  return `<script setup lang="ts">
import { ref } from 'vue'
import AppShell from '@launcher/ui/AppShell.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'

/**
 * ${title} 的插件页。
 *
 * 宿主能力按需启用 —— 先在 package.json 的 capabilities 里声明，再从 @launcher/api 引：
 *   hostUi（读写宿主搜索框 / footer）、storage（插件私有 KV）、exec（调本插件逻辑层命令）…
 * 每个调用都要想清楚失败路径（Promise 以 LauncherError 拒绝）。
 */${scriptHint}
const hits = ref(0)
</script>

<template>
  <AppShell>
    <header class="flex items-center gap-2 border-b border-line px-3 py-2.5">
      <span class="grid h-7 w-7 place-items-center rounded-[9px] border border-line bg-panel-2 text-accent">
        <UiIcon name="wand" :size="15" />
      </span>
      <div class="min-w-0">
        <div class="truncate text-[13px] font-semibold">${title}</div>
        <div class="truncate text-[11px] text-faint">脚手架骨架 · 从 src/App.vue 开始</div>
      </div>
    </header>

    <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6">
      <div class="text-[12.5px] text-muted">把这里换成你的界面。</div>
      <button class="launcher-btn primary" @click="hits += 1">按钮（点了 {{ hits }} 次）</button>
    </div>
  </AppShell>
</template>
`
}

export function cargoToml({ id, title, sdkPath }) {
  return `[package]
name = "launcher-plugin-${id}"
version = "0.1.0"
edition = "2021"
description = "${title}（Chassis 插件逻辑层）"
license = "MIT"
publish = false

[dependencies]
launcher-plugin-sdk = { path = "${sdkPath}" }

[[bin]]
name = "%%BIN_NAME%%"
path = "src/bin/%%BIN_NAME%%.rs"
`
}

export function libRs({ title }) {
  return `//! ${title} 的逻辑层纯逻辑（可单测）。bin 只做胶水：解析上下文 → 调这里 → 回结果。
//!
//! 宿主把 view 侧 \`exec.run({ command, args })\` 的 args 原样交给 bin（\`ctx.raw_args()\`）；
//! 这里保持「不碰 IO 与上下文」——这样 \`cargo test -p\` 能直接覆盖。

use launcher_plugin_sdk::{json, Result, Value};

/// 示例：把 args.text 原样回显。换成你自己的逻辑。
pub fn handle(args: &Value) -> Result<Value> {
    let text = args.get("text").and_then(Value::as_str).unwrap_or_default();
    Ok(json!({ "ok": true, "echo": text }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handle_echoes_text() {
        let out = handle(&json!({ "text": "hi" })).unwrap();
        assert_eq!(out.get("echo").and_then(Value::as_str), Some("hi"));
    }
}
`
}

export function binRs({ id, command }) {
  const lib = `launcher_plugin_${id.replace(/-/g, '_')}`
  return `//! 命令 \`${command}\`（script）：一次性执行 —— \`ctx.done(..)\` 交回结果后进程即退出。
//!
//! stdout 只准协议行（NDJSON）；日志走 \`ctx.log\`，别裸 \`println!\`。
//! 常驻搜索源（contributes: true）另有 \`--mode search\` 入口，见 docs/plugin-dev-guide.md §2.2。

use launcher_plugin_sdk::{Context, Level, Result};

fn main() {
    launcher_plugin_sdk::run(dispatch)
}

fn dispatch(ctx: &Context) -> Result<()> {
    let args = ctx.raw_args().clone();
    let result = ${lib}::handle(&args)?;
    ctx.log("${command}: 完成", None, Level::Info)?;
    ctx.done(result)
}
`
}
