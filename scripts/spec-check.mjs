#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { MANIFEST_KEYS } from './lib/manifest-keys.mjs'

/**
 * 规范自检（plugin-spec v1 的可执行化）—— 面向 `plugins/` 下的全部出厂插件。
 *
 * 为什么必须有：`docs/plugin-spec.md` §13 的检查清单一靠人肉就必然腐化 ——
 * 漏声明一个 capability、把备份写进安装目录、多入口构建把共用模块拆出去，
 * 这三类事故都不会在 dev 时暴露，只有在宿主里才炸。
 *
 * 用法（仓库根）：
 *   node scripts/spec-check.mjs              # 检查 plugins/ 下全部插件
 *   node scripts/spec-check.mjs totp  # 只检查某个插件（目录名或路径）
 *
 * 对应关系（docs/plugin-spec.md §13 检查清单）：
 *   G1 清单字段完整性 / N1 产物名一致 / N2 数据目录 / N3 能力声明 / 产物齐备 / 远程资源
 *
 * 注：插件一律直连 `@launcher/api`，静态推不出精确能力集 ——
 * 声明了 capabilities 的插件只给一句「发布前人工核对」提示，不判失败。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginsRoot = path.join(repoRoot, 'plugins')

/* ------------------------------------------------------------------ 规则表 */

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
// 1 = 逻辑层是自包含 .mjs（Node worker）；2 = 逻辑层是可执行文件（Rust，plugin-spec §4.4）
const API_VERSIONS = ['1', '2']
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
/**
 * dist/package.json 允许出现的字段（§2.2 / §3.1）。
 * 与构建侧的裁剪白名单**共用一份**（`scripts/lib/manifest-keys.mjs`），外加产物固定带的 `type` ——
 * 三处各写一份的代价就是加字段必漏（`essential` 就是这么被抓出来的）。
 */
const DIST_MANIFEST_FIELDS = [...MANIFEST_KEYS, 'type']

/** 底座 SDK：插件页（`@launcher/api`）；逻辑层侧是 Rust 的 `launcher-plugin-sdk`，不再有 JS SDK */
const LAUNCHER_SDK_RE = /^@launcher\/api(\/.*)?$/
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

/**
 * 能力声明检查（N3）。
 *
 * 插件直连底座 SDK 后，「调用了哪些 API」与「声明了哪些 capability」在源码层面并不同构
 * （能力由内核在装配期按清单挂载，SDK 调用点推不出精确集合），所以这里只做提示；
 * 判定交给发布前的人工核对（`docs/plugin-spec.md` §13 检查清单）。
 */
function checkCapabilities(pluginDir, pkg, report) {
  if (!pkg || !Array.isArray(pkg.capabilities) || !pkg.capabilities.length) return
  const srcFiles = walk(path.join(pluginDir, 'src'), (f) => /\.(ts|vue|js)$/.test(f))
  const importRe = /import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
  let usesSdk = false

  for (const file of srcFiles) {
    const source = stripComments(readFileSync(file, 'utf-8'))
    for (const match of source.matchAll(importRe)) {
      if (LAUNCHER_SDK_RE.test(match[3])) usesSdk = true
    }
  }

  if (usesSdk) {
    report.warn('N3', `声明了 ${pkg.capabilities.join(' / ')} —— 直连 SDK 无法静态比对，发布前请人工核对`)
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

  // N1：产物名 = 命令名
  //  - apiVersion 1：自包含 `.mjs`（只 import node: 内置模块）
  //  - apiVersion 2：**可执行文件** `dist/<name>`（无扩展名；Windows 是 `<name>.exe`），
  //    必须带可执行位 + 二进制魔数（ELF / Mach-O / PE）—— 脚本改名冒充不算。
  const isV2 = String(pkg.apiVersion) === '2'
  for (const cmd of commands) {
    if (!cmd || cmd.mode === 'view') continue
    if (isV2) {
      const name = process.platform === 'win32' ? `${cmd.name}.exe` : cmd.name
      const found = path.join(dist, name)
      if (!existsSync(found)) {
        report.fail('N1', `命令 ${cmd.name} 缺少同名可执行产物（${name}）`)
        continue
      }
      if (process.platform !== 'win32' && !(statSync(found).mode & 0o111)) {
        report.fail('N1', `${rel(found)} 没有可执行权限（chmod 0755）`)
      }
      const hex = readFileSync(found).subarray(0, 4).toString('hex')
      const isBinary =
        hex.startsWith('7f454c46') || // ELF
        ['feedface', 'feedfacf', 'cffaedfe', 'cefaedfe'].some((magic) => hex.startsWith(magic)) || // Mach-O
        hex.startsWith('4d5a') // PE
      if (!isBinary) report.fail('N1', `${rel(found)} 不是可执行文件（二进制魔数校验失败）`)
      continue
    }
    // v1 的逻辑层（自包含 `.mjs` / Node worker）**不再支持**（plugin-spec §4.4 / ADR-0005）：
    // 这里直接判失败，而不是去校验它 —— 「明确不支持」好过「半支持」。
    report.fail(
      'N1',
      `命令 ${cmd.name} 的插件 apiVersion=${pkg.apiVersion}：v1 逻辑层（.mjs）已不支持，请升级为可执行产物（apiVersion 2）`,
    )
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

/** plugins/ 下不是插件的目录（发布产物、依赖） */
const NON_PLUGIN_DIRS = new Set(['release', 'node_modules'])

function resolveTargets(args) {
  const isPlugin = (dir) => existsSync(path.join(dir, 'package.json'))
  if (!args.length) {
    return readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !NON_PLUGIN_DIRS.has(d.name))
      .map((d) => path.join(pluginsRoot, d.name))
      .filter(isPlugin)
  }
  return args.map((arg) => {
    const asPath = path.isAbsolute(arg) ? arg : path.resolve(repoRoot, arg)
    if (isPlugin(asPath)) return asPath
    const inPlugins = path.join(pluginsRoot, arg)
    if (isPlugin(inPlugins)) return inPlugins
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
