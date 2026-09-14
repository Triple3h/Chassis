#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * 规范自检（plugin-spec v1 的可执行化）—— 面向 `presets/` 下的预置插件。
 *
 * 为什么必须有：`docs/plugin-spec.md` §13 的检查清单一靠人肉就必然腐化 ——
 * 漏声明一个 capability、把备份写进安装目录、多入口构建把共用模块拆出去，
 * 这三类事故都不会在 dev 时暴露，只有在宿主里才炸。
 *
 * 用法（仓库根）：
 *   node presets/scripts/spec-check.mjs              # 检查 presets/ 下全部插件
 *   node presets/scripts/spec-check.mjs sofast-totp  # 只检查某个插件（目录名或路径）
 *
 * 对应关系（docs/first-batch-plugins.md §6）：
 *   G1 清单字段完整性 / N1 产物名一致 / N2 数据目录 / N3 能力声明 / 产物齐备 / 远程资源
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ------------------------------------------------------------------ 规则表 */

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const API_VERSIONS = ['1']
const MODES = ['view', 'no-view', 'script']
/** 与 packages/plugin-manifest/src/capabilities.ts 保持一致（唯一真源在底座） */
const CAPABILITIES = [
  'hostUi',
  'storage',
  'clipboard.read',
  'clipboard.write',
  'shell.open',
  'exec.spawn',
  'notify.show',
  'screenshot',
  'quicklink',
]
/** dist/package.json 允许出现的字段（§2.2 / §3.1） */
const DIST_MANIFEST_FIELDS = [
  'name',
  'title',
  'version',
  'type',
  'apiVersion',
  'capabilities',
  'commands',
  'description',
  'author',
  'icon',
  'keywords',
  'categories',
]

/**
 * 适配层导出 → 需要的 capability。
 * null = 纯本地能力，不需要声明。表里没有的导出名 = 工具本身要更新（报错）。
 */
const ADAPTER_EXPORTS = {
  '@shared/lib/platform': {
    readSession: null,
    inHost: null,
    HOST_TIMEOUT: null,
    getSearchContent: 'hostUi',
    setSearchContent: 'hostUi',
    clearSearchContent: 'hostUi',
    watchSearchContent: 'hostUi',
    setFooter: 'hostUi',
    triggerScreenshot: 'screenshot',
    runScript: 'exec.spawn',
    storage: 'storage',
  },
  '@shared/lib/host-node': {
    // 脚本侧：拉起脚本这件事本身由平台的 exec.spawn 覆盖，脚本内不再需要额外能力
    ctx: null,
    log: null,
    progress: null,
    done: null,
    fail: null,
    onError: null,
  },
}
const ADAPTER_MODULES = Object.keys(ADAPTER_EXPORTS)
/** 宿主 SDK 只允许适配层直接 import（RULE.mdc「宿主能力」第一条） */
const HOST_SDK_RE = /^@(launcher\/api|sofastapp\/api)(\/.*)?$/
/**
 * 允许出现的远程字符串（每一条都必须写清理由；打包进来的第三方库里带着 URL 很正常，
 * 关键是「运行时会不会真的去取」）。
 */
const REMOTE_ALLOW = [
  // Vue 生产构建里的错误文档链接：只是提示文字，不加载任何东西
  { re: /^https:\/\/vuejs\.org\/error-reference\//, why: 'Vue 错误文档链接（纯提示）' },
  // zxing-wasm 的 Emscripten locateFile 兜底：插件把 wasm 打进产物并用 wasmBinary 传入，走不到它
  { re: /^https:\/\/fastly\.jsdelivr\.net\/npm\/zxing-wasm@/, why: 'zxing-wasm 的 locateFile 兜底（wasm 已随包）' },
]
/** 这些上下文里的远程 URL 是「真的要去取」的，一律按违规处理 */
const REMOTE_LOAD_CONTEXT = [
  /fetch\s*\([^)]*$/,
  /import\s*\([^)]*$/,
  /importScripts\s*\([^)]*$/,
  /new\s+Worker\s*\([^)]*$/,
  /(?:src|href)\s*=\s*["'`][^"'`]*$/,
  /url\(\s*["'`]?[^)"'`]*$/,
  /@import[^;]*$/,
]
const WRITE_APIS = [
  'writeFileSync',
  'writeFile',
  'appendFileSync',
  'createWriteStream',
  'mkdirSync',
  'mkdir',
  'rmSync',
  'rmdirSync',
  'unlinkSync',
  'renameSync',
  'copyFileSync',
  'openSync',
]
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

/* ------------------------------------------------------------------ 工具 */

function walk(dir, filter, out = []) {
  let items = []
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const item of items) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) {
      if (item.name === 'node_modules') continue
      walk(full, filter, out)
    } else if (filter(full)) {
      out.push(full)
    }
  }
  return out
}

/** 去掉注释与字符串常量，避免把「注释里提到 pluginPath」当成违规 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
}

function rel(p) {
  return path.relative(repoRoot, p)
}

/* ------------------------------------------------------------------ 检查项 */

function checkManifest(pluginDir, report) {
  const pkgPath = path.join(pluginDir, 'package.json')
  if (!existsSync(pkgPath)) {
    report.fail('manifest', '缺少 package.json')
    return null
  }
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  } catch (err) {
    report.fail('manifest', `package.json 不是合法 JSON：${err.message}`)
    return null
  }

  const bad = (msg) => report.fail('manifest', msg)

  if (typeof pkg.name !== 'string' || !PLUGIN_ID_RE.test(pkg.name)) bad(`name 不合法：${String(pkg.name)}`)
  if (typeof pkg.title !== 'string' || !pkg.title.length || pkg.title.length > 40) bad('title 必须是 1–40 字符')
  if (typeof pkg.version !== 'string' || !SEMVER_RE.test(pkg.version)) bad(`version 不是 semver：${String(pkg.version)}`)
  if (pkg.type !== 'module') bad('type 必须是 "module"')
  if (!API_VERSIONS.includes(pkg.apiVersion)) bad(`apiVersion 必须是 ${API_VERSIONS.join('/')}（当前：${String(pkg.apiVersion)}）`)
  if (!Array.isArray(pkg.capabilities)) bad('capabilities 必填（可以是空数组）')
  else {
    for (const cap of pkg.capabilities) {
      if (!CAPABILITIES.includes(cap)) bad(`未知 capability：${cap}（已知：${CAPABILITIES.join(', ')}）`)
    }
  }
  if (typeof pkg.description === 'string' && pkg.description.length > 200) bad('description 不得超过 200 字符')

  const commands = pkg.commands
  if (!Array.isArray(commands) || commands.length === 0) bad('commands 必须是非空数组')
  else {
    if (commands.length > 32) bad(`commands 最多 32 条（当前 ${commands.length}）`)
    const seen = new Set()
    for (const cmd of commands) {
      const label = `commands[${cmd?.name ?? '?'}]`
      if (typeof cmd?.name !== 'string' || !COMMAND_NAME_RE.test(cmd.name)) bad(`${label}.name 不合法`)
      else if (seen.has(cmd.name)) bad(`${label} 命令名重复`)
      else seen.add(cmd.name)
      if (typeof cmd?.title !== 'string' || !cmd.title.length || cmd.title.length > 40) bad(`${label}.title 必须是 1–40 字符`)
      if (!MODES.includes(cmd?.mode)) bad(`${label}.mode 必须是 ${MODES.join(' / ')}`)
      if (typeof cmd?.subtitle === 'string' && cmd.subtitle.length > 60) bad(`${label}.subtitle 不得超过 60 字符`)
      if (cmd?.keywords !== undefined && (!Array.isArray(cmd.keywords) || cmd.keywords.length > 10)) bad(`${label}.keywords 最多 10 个`)
      if (cmd?.placeholder !== undefined && typeof cmd.placeholder !== 'string') bad(`${label}.placeholder 必须是字符串`)
      for (const field of ['searchable', 'contributes', 'hidden']) {
        if (cmd?.[field] !== undefined && typeof cmd[field] !== 'boolean') bad(`${label}.${field} 必须是 boolean`)
      }
      if (cmd?.capabilities !== undefined) {
        if (!Array.isArray(cmd.capabilities)) bad(`${label}.capabilities 必须是数组`)
        else
          for (const cap of cmd.capabilities) {
            if (!CAPABILITIES.includes(cap)) bad(`${label} 未知 capability：${cap}`)
          }
      }
    }
  }
  return pkg
}

function checkCapabilities(pluginDir, pkg, report) {
  if (!pkg || !Array.isArray(pkg.capabilities)) return
  const srcFiles = walk(path.join(pluginDir, 'src'), (f) => /\.(ts|vue|js)$/.test(f))
  const needed = new Set()
  const importRe = /import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g

  for (const file of srcFiles) {
    const raw = readFileSync(file, 'utf-8')
    const source = stripComments(raw)
    for (const match of source.matchAll(importRe)) {
      const [, typeOnly, clause, spec] = match
      if (HOST_SDK_RE.test(spec)) {
        report.fail('N3/降级', `${rel(file)} 直接 import 了宿主 SDK（${spec}）—— 必须经 shared/lib/platform.ts`)
        continue
      }
      if (!ADAPTER_MODULES.includes(spec)) continue
      if (typeOnly) continue
      const table = ADAPTER_EXPORTS[spec]
      const names = []
      for (const part of clause.replace(/[{}]/g, ' ').split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim()
        if (!name) continue
        if (name === '*' || /^[A-Za-z_$][\w$]*$/.test(name)) names.push(name)
      }
      for (const name of names) {
        if (!(name in table)) {
          report.fail('N3', `${rel(file)} 从 ${spec} 导入了未知的 ${name}（spec-check 的规则表要更新）`)
          continue
        }
        const cap = table[name]
        if (cap) needed.add(cap)
      }
    }
  }

  const declared = new Set(pkg.capabilities)
  for (const cap of needed) {
    if (!declared.has(cap)) report.fail('N3', `漏声明 capability：${cap}（src 里用到了，清单里没有）`)
  }
  for (const cap of declared) {
    if (!needed.has(cap)) report.fail('N3', `多声明 capability：${cap}（清单里有，src 里没用到）`)
  }
}

function checkDataDir(pluginDir, report) {
  const files = walk(path.join(pluginDir, 'src'), (f) => /\.(ts|vue|js)$/.test(f))
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf-8'))
    if (!source.includes('pluginPath')) continue
    let wrote = false
    for (const api of WRITE_APIS) {
      const re = new RegExp(`${api}\\s*\\(([^)]*)`, 'g')
      for (const match of source.matchAll(re)) {
        if (match[1].includes('pluginPath')) {
          report.fail('N2', `${rel(file)} 用 ${api}() 往 pluginPath（只读安装目录）写东西，必须写 dataPath`)
          wrote = true
        }
      }
    }
    if (!wrote) report.warn('N2', `${rel(file)} 出现了 pluginPath —— 确认只是读、不是写（写请用 dataPath）`)
  }
}

function checkArtifacts(pluginDir, pkg, report) {
  const dist = path.join(pluginDir, 'dist')
  if (!existsSync(dist)) {
    report.fail('产物', 'dist/ 不存在 —— 先跑 npm run build 再自检')
    return
  }
  if (!pkg) return

  const distManifestPath = path.join(dist, 'package.json')
  let distManifest = null
  if (!existsSync(distManifestPath)) {
    report.fail('产物', 'dist/package.json 缺失（dist 本身必须能直接安装）')
  } else {
    try {
      distManifest = JSON.parse(readFileSync(distManifestPath, 'utf-8'))
    } catch (err) {
      report.fail('产物', `dist/package.json 不是合法 JSON：${err.message}`)
    }
  }
  if (distManifest) {
    for (const key of Object.keys(distManifest)) {
      if (!DIST_MANIFEST_FIELDS.includes(key)) report.fail('产物', `dist/package.json 含不该发布的字段：${key}`)
    }
    for (const key of ['apiVersion', 'capabilities']) {
      if (distManifest[key] === undefined) report.fail('产物', `dist/package.json 缺 ${key}（裁剪脚本要同步 MANIFEST_KEYS）`)
    }
    if (JSON.stringify(distManifest.commands) !== JSON.stringify(pkg.commands)) {
      report.fail('产物', 'dist/package.json 的 commands 与源清单不一致 —— 重新构建')
    }
  }

  const commands = Array.isArray(pkg.commands) ? pkg.commands : []
  const hasView = commands.some((c) => c?.mode === 'view')
  if (hasView) {
    if (!existsSync(path.join(dist, 'index.html'))) report.fail('产物', '有 view 命令，但 dist/index.html 缺失')
    const assets = path.join(dist, 'assets')
    const assetFiles = existsSync(assets) ? readdirSync(assets) : []
    if (!assetFiles.length) report.fail('产物', '有 view 命令，但 dist/assets/ 是空的')
  }

  // N1：产物名 = 命令名，且产物必须自包含（只 import node: 内置模块）
  for (const cmd of commands) {
    if (!cmd || cmd.mode === 'view') continue
    const candidates = [`${cmd.name}.mjs`, `${cmd.name}.js`, `workers/${cmd.name}.mjs`, `workers/${cmd.name}.js`]
    const found = candidates.map((c) => path.join(dist, c)).find((p) => existsSync(p))
    if (!found) {
      report.fail('N1', `命令 ${cmd.name} 缺少同名产物（${candidates[0]}）`)
      continue
    }
    const lines = readFileSync(found, 'utf-8').split('\n').filter((line) => /^\s*(import|export .* from)\s/.test(line))
    for (const line of lines) {
      const spec = line.match(/from\s+['"]([^'"]+)['"]/)?.[1] ?? line.match(/import\s+['"]([^'"]+)['"]/)?.[1]
      if (!spec) continue
      if (spec.startsWith('.') || spec.startsWith('/')) {
        report.fail('N1', `${rel(found)} 依赖相对路径模块 ${spec} —— 产物必须自包含`)
        continue
      }
      if (!NODE_BUILTINS.has(spec)) report.fail('N1', `${rel(found)} import 了非内置模块 ${spec}（产物必须自包含）`)
    }
  }

  // §5.4：不得引用远程资源（wasm / 图标 / CDN 必须随包）
  // 判定分两档：真的会去取的（fetch/src/url()…）算违规；只是长在字符串里的算提示。
  const bundled = walk(dist, (f) => /\.(js|mjs|html|css|json)$/.test(f))
  for (const file of bundled) {
    if (path.basename(file) === 'package.json') continue
    const source = readFileSync(file, 'utf-8')
    for (const match of source.matchAll(/https?:\/\/[^\s"'`)\\]+/g)) {
      const url = match[0]
      if (/^https?:\/\/(www\.)?w3\.org\//.test(url) || /^https?:\/\/schemas\./.test(url)) continue
      const allow = REMOTE_ALLOW.find((item) => item.re.test(url))
      if (allow) {
        report.warn('§5.4', `${rel(file)} 已知例外：${url}（${allow.why}）`)
        continue
      }
      const before = source.slice(Math.max(0, (match.index ?? 0) - 120), match.index ?? 0)
      if (REMOTE_LOAD_CONTEXT.some((re) => re.test(before))) {
        report.fail('§5.4', `${rel(file)} 运行时加载远程资源：${url}`)
      } else {
        report.warn('§5.4', `${rel(file)} 字符串里出现远程 URL：${url}（确认不是运行时依赖）`)
      }
    }
  }
}

/* ------------------------------------------------------------------ 执行 */

function createReport(name) {
  return {
    name,
    failures: [],
    warnings: [],
    fail(code, message) {
      this.failures.push(`[${code}] ${message}`)
    },
    warn(code, message) {
      this.warnings.push(`[${code}] ${message}`)
    },
  }
}

/** presets/ 下不是插件的目录（shared 层、脚手架、测试、知识资产） */
const NON_PLUGIN_DIRS = new Set(['shared', 'scripts', 'tests', 'docs', 'node_modules'])

function resolveTargets(args) {
  const isPlugin = (dir) => existsSync(path.join(dir, 'package.json'))
  if (!args.length) {
    return readdirSync(repoRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !NON_PLUGIN_DIRS.has(d.name))
      .map((d) => path.join(repoRoot, d.name))
      .filter(isPlugin)
  }
  return args.map((arg) => {
    const asPath = path.isAbsolute(arg) ? arg : path.resolve(repoRoot, arg)
    if (isPlugin(asPath)) return asPath
    const inPresets = path.join(repoRoot, arg)
    if (isPlugin(inPresets)) return inPresets
    console.error(`找不到插件目录：${arg}`)
    process.exit(2)
  })
}

const targets = resolveTargets(process.argv.slice(2))
let failed = 0
let warned = 0

for (const dir of targets) {
  const report = createReport(path.basename(dir))
  checkManifest(dir, report)
  const pkg = (() => {
    try {
      return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8'))
    } catch {
      return null
    }
  })()
  checkCapabilities(dir, pkg, report)
  checkDataDir(dir, report)
  checkArtifacts(dir, pkg, report)

  const status = report.failures.length ? '✗' : '✓'
  console.log(`${status} ${report.name}`)
  for (const item of report.failures) console.log(`    ${item}`)
  for (const item of report.warnings) console.log(`    · ${item}`)
  failed += report.failures.length
  warned += report.warnings.length
}

console.log(`\n${targets.length} 个插件：${failed} 项不合规，${warned} 条提示`)
if (failed) {
  console.log('规范真源：docs/plugin-spec.md（改规范 → 再改代码）')
  process.exit(1)
}
