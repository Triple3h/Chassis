#!/usr/bin/env node
/**
 * 插件脚手架 CLI：一条命令生成插件工程骨架。
 *
 * 用法（仓库根）：
 *   pnpm create:plugin <id> [--title 标题] [--mode view|script|full] [--command 命令名]
 *                          [--out 目录] [--author 作者] [--description 描述] [--icon 图标]
 *                          [--capabilities a,b] [--force] [--no-workspace]
 *
 * 生成物开箱可构建：清单能过 @launcher/plugin-manifest 的校验（单测守护），含逻辑层时
 * 顺带登记根 Cargo.toml members（漏登记 = 产物静默缺失，plugin-dev-guide §5.4）。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import {
  buildFiles,
  computeRel,
  findRepoRoot,
  registerWorkspaceMember,
  resolveOptions,
  writeFiles,
} from './lib/scaffold.mjs'

const HELP = `用法：pnpm create:plugin <id> [选项]

  <id>                   插件 id（kebab-case，= 目录名，如 my-plugin）
  --title <文本>         命令面板里显示的插件名（默认由 id 生成）
  --mode <形态>          view（默认，纯 UI 页）| script（纯逻辑层）| full（UI + 逻辑层）
  --command <名>         逻辑层命令名（= 产物 dist/<名>；script 默认 = id，full 默认 <id>-run）
  --out <目录>           输出根目录（默认 ./plugins）
  --author <名>          作者（默认取 git config user.name）
  --description <文本>   一句话说明
  --icon <名>            清单图标（lucide 名，见 packages/ui/lib/icons.ts；默认 puzzle）
  --capabilities <a,b>   初始能力清单（默认空；只声明实际用到的）
  --force                目标目录已存在时覆盖
  --no-workspace         不登记根 Cargo.toml 的 members（含逻辑层时默认登记）
`

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--force') flags.force = true
    else if (arg === '--no-workspace') flags.workspace = false
    else if (arg === '--help' || arg === '-h') flags.help = true
    else if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 缺少取值`)
      flags[key] = value
      i += 1
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

function defaultAuthor() {
  const git = spawnSync('git', ['config', 'user.name'], { encoding: 'utf-8' })
  const name = (git.stdout ?? '').trim()
  return name || process.env.USER || 'unknown'
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  if (flags.help) {
    console.log(HELP)
    return
  }
  if (positional.length === 0) {
    console.error(HELP)
    process.exitCode = 1
    return
  }

  const outRoot = path.resolve(flags.out ?? 'plugins')
  const opts = resolveOptions({
    id: positional[0],
    mode: flags.mode,
    title: flags.title,
    command: flags.command,
    author: flags.author ?? defaultAuthor(),
    description: flags.description,
    icon: flags.icon,
    capabilities: typeof flags.capabilities === 'string' ? flags.capabilities.split(',') : [],
  })

  const pluginDir = path.join(outRoot, opts.id)
  const repoRoot = findRepoRoot(outRoot) ?? findRepoRoot(process.cwd())
  const rel = repoRoot ? computeRel(pluginDir, repoRoot) : undefined

  const written = writeFiles(pluginDir, buildFiles(opts, rel), { force: flags.force === true })
  const shape = { view: 'view（纯 UI 页）', script: 'script（纯逻辑层）', full: 'full（UI + 逻辑层）' }[opts.mode]

  const lines = [`\n✔ 已生成 ${path.relative(process.cwd(), pluginDir) || opts.id}（${shape} · ${written.length} 个文件）`]
  for (const file of written) lines.push(`   ${file}`)

  if (opts.hasScript) {
    if (flags.workspace === false) {
      lines.push(`\n⚠ 跳过了 Cargo.toml 登记（--no-workspace）；漏登记 = «cargo build -p» 找不到包`)
    } else if (repoRoot) {
      const member = registerWorkspaceMember(pluginDir, repoRoot)
      const where = member?.memberPath ?? path.relative(repoRoot, pluginDir)
      lines.push(
        member?.changed
          ? `\n已登记根 Cargo.toml members：${where}`
          : `\n根 Cargo.toml 已包含 ${where}（未改动）`,
      )
    } else {
      lines.push(`\n⚠ 没找到仓库根（含 packages/plugin-sdk-rs 的目录）：Cargo.toml 的 members 需要自己登记`)
    }
  }

  if (!repoRoot) {
    lines.push(
      `\n⚠ 目标不在本仓库内：模板里的相对引用（vite 配置的 scripts/lib、Cargo.toml 的 SDK path、app.css 的 theme.css）` +
        `\n   与 workspace 依赖（@launcher/api / @launcher/ui）需要按你的工程布局调整 —— 见 docs/plugin-dev-guide.md §4。`,
    )
  }

  lines.push(
    `\n下一步：`,
    `  pnpm install        # 让新包的依赖进 node_modules`,
    `  pnpm build:plugins  # 构建（view 走 Vite，逻辑层走 cargo）`,
    `  pnpm spec-check     # 插件规范自检（清单 / 能力 / 产物）`,
    `  装进启动台：插件目录可打 zip 用「设置 → 插件 → 安装」装；调试用 pnpm dev（见 docs/plugin-dev-guide.md §3.4）`,
  )
  console.log(lines.join('\n'))
}

try {
  main()
} catch (err) {
  console.error(`\n✘ ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}
