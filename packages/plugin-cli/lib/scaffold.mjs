/**
 * 插件脚手架：参数 → 文件清单 → 落盘（+ 需要时登记 Rust workspace member）。
 *
 * 生成器只做**轻校验**（id / 命令名形状、目录冲突、保留前缀）；清单的**终检**交给
 * `@launcher/plugin-manifest` 的真校验器 —— 守护用例把生成物喂给它跑一遍
 * （`test/scaffold.test.ts`），生成器不可能产出「装不上」的插件。
 *
 * 本 CLI 面向**本仓库**（`plugins/<id>/`）：模板里的相对引用（vite 配置 / Cargo.toml /
 * app.css）按实际位置算相对路径。`--out` 指向仓库外时可用，但那三处引用需要自己调整
 * （依赖也换成版本号），CLI 会打印提醒。
 */
import fs from 'node:fs'
import path from 'node:path'
import * as templates from './templates.mjs'

/** 与 packages/plugin-manifest/src/types.ts 的 PLUGIN_ID_RE / COMMAND_NAME_RE 一致（那侧是权威，这里只是提前报错） */
const ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const COMMAND_RE = /^[a-z0-9][a-z0-9-]{0,38}$/

export const MODES = ['view', 'script', 'full']

/** id 形状 + 保留前缀；合法返回 null，否则返回人话错误 */
export function checkId(id) {
  if (!ID_RE.test(String(id ?? ''))) {
    return `插件 id 必须是 kebab-case（小写字母 / 数字 / 连字符，3–40 位）：${JSON.stringify(id)}`
  }
  // `internal-` 是内置特权插件的保留命名（ctx.settings 只注入它，ADR-0003）
  if (id.startsWith('internal-')) return 'internal- 前缀保留给内置特权插件（ADR-0003），换个名字'
  return null
}

/**
 * 归一化 + 校验参数；`hasView` / `hasScript` 由 mode 推出。
 * `command` = 逻辑层命令名（= 产物文件名 dist/<command>）。
 */
export function resolveOptions(input) {
  const id = String(input.id ?? '').trim()
  const idError = checkId(id)
  if (idError) throw new Error(idError)

  const mode = input.mode ?? 'view'
  if (!MODES.includes(mode)) throw new Error(`--mode 只支持 ${MODES.join(' / ')}：${mode}`)

  const hasView = mode === 'view' || mode === 'full'
  const hasScript = mode === 'script' || mode === 'full'

  // 逻辑层命令名：script 模式默认 = id；full 模式 id 已被 view 命令占用，默认 <id>-run
  const command = String(input.command ?? (hasView && hasScript ? `${id}-run` : id)).trim()
  if (hasScript && !COMMAND_RE.test(command)) {
    throw new Error(`命令名必须是 kebab-case（小写字母 / 数字 / 连字符，≤39 位）：${JSON.stringify(command)}`)
  }
  if (hasView && hasScript && command === id) {
    throw new Error(`full 模式下逻辑层命令名不能与插件 id 相同（id 已作为 view 命令名）：--command 传别的名字`)
  }

  return {
    id,
    mode,
    hasView,
    hasScript,
    command,
    title: String(input.title ?? humanize(id)).trim(),
    author: String(input.author ?? 'triple3h').trim(),
    description: String(input.description ?? '').trim(),
    icon: String(input.icon ?? 'puzzle').trim(),
    capabilities: (input.capabilities ?? []).map((value) => String(value).trim()).filter(Boolean),
  }
}

/** `my-cool-plugin` → `My Cool Plugin`（--title 缺省时用） */
export function humanize(id) {
  return id
    .split('-')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

/** 从 startDir 向上找仓库根（同时有 packages/plugin-sdk-rs 与 Cargo.toml 的目录）；找不到返回 null */
export function findRepoRoot(startDir) {
  let dir = path.resolve(startDir)
  for (;;) {
    if (fs.existsSync(path.join(dir, 'packages', 'plugin-sdk-rs', 'Cargo.toml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** 仓库内目标 → 相对引用（模板用；统一 / 分隔，跨平台）。注意基准目录各文件不同：
 *  vite.config.ts / Cargo.toml 在插件根；app.css 在 `src/styles/` 下（差两层）。 */
export function computeRel(pluginDir, repoRoot) {
  const stylesDir = path.join(pluginDir, 'src', 'styles')
  const to = (from, target) => path.relative(from, target).split(path.sep).join('/')
  return {
    scriptsLib: to(pluginDir, path.join(repoRoot, 'scripts', 'lib')),
    themeCss: to(stylesDir, path.join(repoRoot, 'packages', 'ui', 'styles', 'theme.css')),
    uiDir: to(stylesDir, path.join(repoRoot, 'packages', 'ui')),
    sdkPath: to(pluginDir, path.join(repoRoot, 'packages', 'plugin-sdk-rs')),
  }
}

/**
 * 文件清单（path 相对插件目录）。
 * rel 缺省时按「本仓库 plugins/<id>」的常见形态兜底（仓库外生成的可用形态，引用需手调）。
 */
export function buildFiles(opts, rel) {
  const { id, title, author, description, icon, capabilities, command, hasView, hasScript } = opts
  const refs = rel ?? {
    scriptsLib: '../../scripts/lib',
    themeCss: '../../../../packages/ui/styles/theme.css',
    uiDir: '../../../../packages/ui',
    sdkPath: '../../packages/plugin-sdk-rs',
  }

  const commands = []
  if (hasView) {
    commands.push({ name: id, title, mode: 'view', searchable: true, placeholder: `搜索 ${title}…`, icon })
  }
  if (hasScript) commands.push({ name: command, title: `${title}（脚本）`, mode: 'script' })

  const files = [
    {
      path: 'package.json',
      content: templates.manifest({ id, title, author, description, icon, capabilities, commands, hasView, hasScript }),
    },
  ]

  if (hasView) {
    files.push(
      { path: 'vite.config.ts', content: templates.viteConfig({ rel: refs }) },
      { path: 'tsconfig.json', content: templates.tsconfig() },
      { path: 'index.html', content: templates.indexHtml(title) },
      { path: 'src/main.ts', content: templates.mainTs() },
      { path: 'src/App.vue', content: templates.appVue({ title, scriptCommand: hasScript ? command : '' }) },
      { path: 'src/styles/app.css', content: templates.appCss({ rel: refs }) },
    )
  }

  if (hasScript) {
    files.push(
      { path: 'Cargo.toml', content: templates.cargoToml({ id, title, sdkPath: refs.sdkPath }).replaceAll('%%BIN_NAME%%', command) },
      { path: 'src/lib.rs', content: templates.libRs({ title }) },
      { path: `src/bin/${command}.rs`, content: templates.binRs({ id, command }) },
    )
  }

  return files
}

/** 落盘（目录已存在且非空 ⇒ 除非 force 一律拒绝）；返回写入的相对路径列表 */
export function writeFiles(pluginDir, files, { force = false } = {}) {
  if (fs.existsSync(pluginDir) && !force) {
    const entries = fs.readdirSync(pluginDir).filter((name) => name !== '.DS_Store')
    if (entries.length > 0) {
      throw new Error(`目录已存在且非空：${pluginDir}（要覆盖用 --force）`)
    }
  }
  for (const file of files) {
    const target = path.join(pluginDir, file.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.content, 'utf-8')
  }
  return files.map((file) => file.path)
}

/**
 * 把成员路径（相对仓库根，如 `plugins/<id>`）登记进根 Cargo.toml 的 members
 * （缺这一步 = `cargo build -p` 找不到包，逻辑层产物静默缺失 —— 见 plugin-dev-guide §5.4）。
 * 幂等：已在列表里就不动。
 */
export function addWorkspaceMember(tomlText, memberPath) {
  const entry = `"${memberPath}"`
  if (tomlText.includes(entry)) return { text: tomlText, changed: false }

  const match = /members\s*=\s*\[([\s\S]*?)\]/.exec(tomlText)
  if (!match) return { text: tomlText, changed: false, reason: 'Cargo.toml 里没有 members 数组' }

  const inner = match[1]
  const inserted = `\n    ${entry},`
  // 插在最后一个插件成员之后（保持「插件区」聚在一起）；没有就追加到数组末尾
  const pluginLines = [...inner.matchAll(/^[ \t]*"[^"]*\/[^"]*",[ \t]*$/gm)].filter((line) => line[0].includes('plugins/'))
  let nextInner
  if (pluginLines.length > 0) {
    const last = pluginLines.at(-1)
    const at = last.index + last[0].length
    nextInner = `${inner.slice(0, at)}${inserted}${inner.slice(at)}`
  } else {
    nextInner = `${inner.replace(/\s*$/, '')}${inserted}\n`
  }
  const next = tomlText.slice(0, match.index) + `members = [${nextInner}]` + tomlText.slice(match.index + match[0].length)
  return { text: next, changed: true }
}

/** 仓库内生成且含逻辑层时：登记 members（按插件相对仓库根的真实路径）。返回 `{ memberPath, path, changed }`。 */
export function registerWorkspaceMember(pluginDir, repoRoot) {
  if (!repoRoot) return null
  const cargoPath = path.join(repoRoot, 'Cargo.toml')
  if (!fs.existsSync(cargoPath)) return null
  const memberPath = path.relative(repoRoot, pluginDir).split(path.sep).join('/')
  const before = fs.readFileSync(cargoPath, 'utf-8')
  const { text, changed } = addWorkspaceMember(before, memberPath)
  if (changed) fs.writeFileSync(cargoPath, text, 'utf-8')
  return { memberPath, path: cargoPath, changed }
}
