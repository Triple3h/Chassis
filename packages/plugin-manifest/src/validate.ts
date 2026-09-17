import { CAPABILITIES, isKnownCapability } from './capabilities'
import type { ManifestErrorCode } from './errors'
import {
  API_VERSIONS_SUPPORTED,
  ARCHS,
  COMMAND_NAME_RE,
  PLATFORMS,
  PLUGIN_ID_RE,
  scriptEntryCandidates,
  type Arch,
  type CommandDecl,
  type CommandMode,
  type Platform,
  type PluginManifest,
  type SettingDecl,
  type SettingOption,
} from './types'

export type ManifestValidation =
  | { ok: true; manifest: PluginManifest; warnings: string[] }
  | { ok: false; code: ManifestErrorCode; message: string }

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const MAX_COMMANDS = 32
const SETTING_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/
const MAX_SETTINGS = 16
const MAX_SETTING_OPTIONS = 32

function fail(code: ManifestErrorCode, message: string): ManifestValidation {
  return { ok: false, code, message }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validateCommand(
  raw: unknown,
  index: number,
): { ok: true; cmd: CommandDecl } | { ok: false; message: string; code?: ManifestErrorCode } {
  if (!isPlainObject(raw)) return { ok: false, message: `commands[${index}] 必须是对象` }

  const name = raw.name
  if (typeof name !== 'string' || !COMMAND_NAME_RE.test(name)) {
    return { ok: false, message: `commands[${index}].name 不符合 /^[a-z0-9][a-z0-9-]{0,38}$/（收到 ${JSON.stringify(name)}）` }
  }
  const title = raw.title
  if (typeof title !== 'string' || title.length < 1 || title.length > 40) {
    return { ok: false, message: `commands[${index}].title 必须是 1–40 字符` }
  }
  const mode = raw.mode
  if (mode !== 'view' && mode !== 'no-view' && mode !== 'script') {
    return { ok: false, message: `commands[${index}].mode 必须是 view | no-view | script` }
  }

  const cmd: CommandDecl = { name, title, mode: mode as CommandMode }

  if (raw.subtitle !== undefined) {
    if (typeof raw.subtitle !== 'string' || raw.subtitle.length > 60) {
      return { ok: false, message: `commands[${index}].subtitle 必须是 ≤60 字符的字符串` }
    }
    cmd.subtitle = raw.subtitle
  }
  if (raw.icon !== undefined) {
    if (typeof raw.icon !== 'string') return { ok: false, message: `commands[${index}].icon 必须是字符串` }
    cmd.icon = raw.icon
  }
  for (const boolField of ['searchable', 'contributes', 'hidden'] as const) {
    if (raw[boolField] !== undefined) {
      if (typeof raw[boolField] !== 'boolean') {
        return { ok: false, message: `commands[${index}].${boolField} 必须是布尔` }
      }
      cmd[boolField] = raw[boolField] as boolean
    }
  }
  if (raw.placeholder !== undefined) {
    if (typeof raw.placeholder !== 'string') return { ok: false, message: `commands[${index}].placeholder 必须是字符串` }
    cmd.placeholder = raw.placeholder
  }
  if (raw.keywords !== undefined) {
    if (!Array.isArray(raw.keywords) || raw.keywords.length > 10 || raw.keywords.some((k) => typeof k !== 'string')) {
      return { ok: false, message: `commands[${index}].keywords 必须是 ≤10 个字符串` }
    }
    cmd.keywords = raw.keywords as string[]
  }
  if (raw.capabilities !== undefined) {
    if (!Array.isArray(raw.capabilities) || raw.capabilities.some((c) => typeof c !== 'string')) {
      return { ok: false, message: `commands[${index}].capabilities 必须是字符串数组` }
    }
    for (const cap of raw.capabilities as string[]) {
      if (!isKnownCapability(cap)) {
        return {
          ok: false,
          code: 'CAPABILITY_UNKNOWN',
          message: `commands[${index}] 使用了未知能力：${cap}（已知：${CAPABILITIES.join(', ')}）`,
        }
      }
    }
    cmd.capabilities = raw.capabilities as string[]
  }
  return { ok: true, cmd }
}

function validateSetting(
  raw: unknown,
  index: number,
): { ok: true; decl: SettingDecl } | { ok: false; message: string } {
  if (!isPlainObject(raw)) return { ok: false, message: `settings[${index}] 必须是对象` }

  const key = raw.key
  if (typeof key !== 'string' || !SETTING_KEY_RE.test(key)) {
    return { ok: false, message: `settings[${index}].key 不符合 /^[a-z][a-z0-9-]{0,31}$/（收到 ${JSON.stringify(key)}）` }
  }
  const type = raw.type
  if (type !== 'select' && type !== 'switch' && type !== 'text') {
    return { ok: false, message: `settings[${index}].type 必须是 select | switch | text` }
  }
  const title = raw.title
  if (typeof title !== 'string' || title.length < 1 || title.length > 40) {
    return { ok: false, message: `settings[${index}].title 必须是 1–40 字符` }
  }

  const decl: SettingDecl = { key, type, title }

  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string' || raw.description.length > 120) {
      return { ok: false, message: `settings[${index}].description 必须是 ≤120 字符的字符串` }
    }
    decl.description = raw.description
  }
  if (raw.options !== undefined) {
    if (type !== 'select') return { ok: false, message: `settings[${index}]：只有 type=select 才能声明 options` }
    if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > MAX_SETTING_OPTIONS) {
      return { ok: false, message: `settings[${index}].options 必须是 2–${MAX_SETTING_OPTIONS} 项` }
    }
    const options: SettingOption[] = []
    const seen = new Set<string>()
    for (const [i, item] of raw.options.entries()) {
      if (!isPlainObject(item)) return { ok: false, message: `settings[${index}].options[${i}] 必须是对象` }
      const value = item.value
      const label = item.label
      if (typeof value !== 'string' || value.length === 0) {
        return { ok: false, message: `settings[${index}].options[${i}].value 必须是非空字符串` }
      }
      if (typeof label !== 'string' || label.length === 0 || label.length > 40) {
        return { ok: false, message: `settings[${index}].options[${i}].label 必须是 1–40 字符` }
      }
      if (seen.has(value)) return { ok: false, message: `settings[${index}].options 值重复：${value}` }
      seen.add(value)
      options.push({ value, label })
    }
    decl.options = options
  }
  if (type === 'select' && !decl.options) {
    return { ok: false, message: `settings[${index}]：type=select 必须提供 options` }
  }
  if (raw.default !== undefined) {
    if (type === 'switch') {
      if (typeof raw.default !== 'boolean') {
        return { ok: false, message: `settings[${index}].default 必须是布尔（type=switch）` }
      }
      decl.default = raw.default
    } else {
      if (typeof raw.default !== 'string') {
        return { ok: false, message: `settings[${index}].default 必须是字符串（type=${type}）` }
      }
      if (type === 'select' && !(decl.options ?? []).some((option) => option.value === raw.default)) {
        return { ok: false, message: `settings[${index}].default 不在 options 里：${raw.default}` }
      }
      decl.default = raw.default
    }
  }
  return { ok: true, decl }
}

/**
 * 清单校验（plugin-spec §3.3）。
 * 纯函数：不触碰文件系统；产物存在性校验用 `checkEntries`。
 */
export function validateManifest(raw: unknown): ManifestValidation {
  if (!isPlainObject(raw)) return fail('MANIFEST_INVALID', 'package.json 顶层必须是对象')

  const warnings: string[] = []

  const name = raw.name
  if (typeof name !== 'string' || !PLUGIN_ID_RE.test(name)) {
    return fail(
      'MANIFEST_INVALID',
      `name 不符合 /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/（收到 ${JSON.stringify(name)}）`,
    )
  }
  const title = raw.title
  if (typeof title !== 'string' || title.length < 1 || title.length > 40) {
    return fail('MANIFEST_INVALID', 'title 必须是 1–40 字符')
  }
  const version = raw.version
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    return fail('MANIFEST_INVALID', `version 必须是 semver（收到 ${JSON.stringify(version)}）`)
  }

  if (raw.type !== undefined && raw.type !== 'module') {
    return fail('MANIFEST_INVALID', 'type 必须是 "module"')
  }

  // apiVersion：必填
  let apiVersion: string
  if (raw.apiVersion === undefined) {
    return fail('MANIFEST_INVALID', 'apiVersion 必填（接受 "1" 与 "2"）')
  } else if (typeof raw.apiVersion !== 'string') {
    return fail('MANIFEST_INVALID', 'apiVersion 必须是字符串')
  } else {
    apiVersion = raw.apiVersion
  }
  if (!API_VERSIONS_SUPPORTED.includes(apiVersion)) {
    return fail(
      'API_VERSION_UNSUPPORTED',
      `插件声明需要 apiVersion ${apiVersion}，当前底座支持 ${API_VERSIONS_SUPPORTED.join(' / ')}`,
    )
  }

  // capabilities：必填（可以是空数组）
  let capabilities: string[]
  if (raw.capabilities === undefined) {
    return fail('MANIFEST_INVALID', 'capabilities 必填（可以是空数组）')
  } else {
    if (!Array.isArray(raw.capabilities) || raw.capabilities.some((c) => typeof c !== 'string')) {
      return fail('MANIFEST_INVALID', 'capabilities 必须是字符串数组')
    }
    capabilities = raw.capabilities as string[]
    for (const cap of capabilities) {
      if (!isKnownCapability(cap)) {
        return fail('CAPABILITY_UNKNOWN', `使用了未知能力：${cap}（已知：${CAPABILITIES.join(', ')}）`)
      }
    }
  }

  const commandsRaw = raw.commands
  if (!Array.isArray(commandsRaw) || commandsRaw.length === 0) {
    return fail('MANIFEST_INVALID', 'commands 必须是非空数组')
  }
  if (commandsRaw.length > MAX_COMMANDS) {
    return fail('MANIFEST_INVALID', `commands 不得超过 ${MAX_COMMANDS} 条`)
  }

  const commands: CommandDecl[] = []
  const seen = new Set<string>()
  for (const [index, item] of commandsRaw.entries()) {
    const result = validateCommand(item, index)
    if (!result.ok) return fail(result.code ?? 'MANIFEST_INVALID', result.message)
    if (seen.has(result.cmd.name)) {
      return fail('MANIFEST_INVALID', `命令名重复：${result.cmd.name}`)
    }
    seen.add(result.cmd.name)
    commands.push(result.cmd)
  }

  const manifest: PluginManifest = { name, title, version, apiVersion, capabilities, commands, type: 'module' }

  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string' || raw.description.length > 200) {
      return fail('MANIFEST_INVALID', 'description 必须是 ≤200 字符的字符串')
    }
    manifest.description = raw.description
  }
  if (raw.author !== undefined) {
    if (typeof raw.author !== 'string') return fail('MANIFEST_INVALID', 'author 必须是字符串')
    manifest.author = raw.author
  }
  if (raw.icon !== undefined) {
    if (typeof raw.icon !== 'string') return fail('MANIFEST_INVALID', 'icon 必须是字符串')
    manifest.icon = raw.icon
  }
  if (raw.keywords !== undefined) {
    if (!Array.isArray(raw.keywords) || raw.keywords.length > 10 || raw.keywords.some((k) => typeof k !== 'string')) {
      return fail('MANIFEST_INVALID', 'keywords 必须是 ≤10 个字符串')
    }
    manifest.keywords = raw.keywords as string[]
  }
  if (raw.categories !== undefined) {
    if (!Array.isArray(raw.categories) || raw.categories.some((c) => typeof c !== 'string')) {
      return fail('MANIFEST_INVALID', 'categories 必须是字符串数组')
    }
    manifest.categories = raw.categories as string[]
  }
  if (raw.essential !== undefined) {
    if (typeof raw.essential !== 'boolean') return fail('MANIFEST_INVALID', 'essential 必须是布尔值')
    manifest.essential = raw.essential
  }
  if (raw.history !== undefined) {
    if (typeof raw.history !== 'boolean') return fail('MANIFEST_INVALID', 'history 必须是布尔值')
    manifest.history = raw.history
  }
  if (raw.settings !== undefined) {
    if (!Array.isArray(raw.settings)) return fail('MANIFEST_INVALID', 'settings 必须是数组')
    if (raw.settings.length > MAX_SETTINGS) return fail('MANIFEST_INVALID', `settings 不得超过 ${MAX_SETTINGS} 条`)
    const settings: SettingDecl[] = []
    const seenKeys = new Set<string>()
    for (const [index, item] of raw.settings.entries()) {
      const result = validateSetting(item, index)
      if (!result.ok) return fail('MANIFEST_INVALID', result.message)
      if (seenKeys.has(result.decl.key)) return fail('MANIFEST_INVALID', `settings.key 重复：${result.decl.key}`)
      seenKeys.add(result.decl.key)
      settings.push(result.decl)
    }
    manifest.settings = settings
  }
  // 平台 / 架构声明（plugin-spec §3.5）：可选；给了就必须是已知值的非空数组
  const platforms = validateDimension(raw.platforms, 'platforms', PLATFORMS)
  if (typeof platforms === 'string') return fail('MANIFEST_INVALID', platforms)
  manifest.platforms = platforms
  const arch = validateDimension(raw.arch, 'arch', ARCHS)
  if (typeof arch === 'string') return fail('MANIFEST_INVALID', arch)
  manifest.arch = arch

  return { ok: true, manifest, warnings }
}

/**
 * 平台 / 架构维度校验：省略（`undefined`）= 不限制；给了就必须是**非空**的已知值数组
 * （空数组语义歧义 —— 是"全平台"还是"全不支持"？一律拒绝）。
 * 返回错误文案字符串表示失败。
 */
function validateDimension<T extends string>(value: unknown, field: string, known: readonly T[]): T[] | undefined | string {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return `${field} 必须是非空数组（省略 = 不限制）`
  if (value.length === 0) return `${field} 必须是非空数组（省略 = 不限制）`
  if (value.length > 8) return `${field} 不得超过 8 项`
  const pool: readonly string[] = known
  for (const item of value) {
    if (typeof item !== 'string') return `${field} 必须是字符串数组`
    if (!pool.includes(item)) return `${field} 含未知取值：${item}（已知：${pool.join(', ')}）`
  }
  return value as T[]
}

/**
 * 清单是否匹配给定运行环境（未声明的维度不限制）。
 *
 * 纯函数、不读 `process` —— 本包是**环境无关**的契约包（没有 `@types/node`），
 * 真正的运行时探测在内核 `manifest.rs`（`current_platform()` / `current_arch()`）里。
 * 调用方（Node 侧）自行传：`{ platform: process.platform === 'darwin' ? 'macos' : … , arch: process.arch }`。
 */
export function supportsRuntime(
  manifest: Pick<PluginManifest, 'platforms' | 'arch'>,
  current: { platform: Platform; arch: Arch },
): boolean {
  const platformOk = !manifest.platforms || manifest.platforms.includes(current.platform)
  const archOk = !manifest.arch || manifest.arch.includes(current.arch)
  return platformOk && archOk
}

export interface EntryCheckResult {
  /** 命令名 → 缺失原因 */
  missing: Record<string, string>
}

/**
 * 产物存在性校验（plugin-spec N1 / §3.3 `ENTRY_MISSING`）。
 * `files` 是插件目录下的相对路径列表（由调用方读盘后传入，保持本函数可单测）。
 */
export function checkEntries(manifest: PluginManifest, files: Iterable<string>): EntryCheckResult {
  const set = new Set<string>()
  for (const f of files) set.add(f.replace(/\\/g, '/').replace(/^\.\//, ''))

  const missing: Record<string, string> = {}
  const hasView = manifest.commands.some((c) => c.mode === 'view')
  if (hasView && !set.has('index.html')) {
    for (const decl of manifest.commands) {
      if (decl.mode === 'view') missing[decl.name] = '缺少 index.html'
    }
  }
  for (const decl of manifest.commands) {
    if (decl.mode === 'view') continue
    const found = scriptEntryCandidates(decl.name).some((c) => set.has(c))
    if (!found) missing[decl.name] = `缺少 ${decl.name}（可执行产物）`
  }
  return { missing }
}
