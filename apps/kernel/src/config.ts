import os from 'node:os'
import path from 'node:path'
import type { Config } from '@launcher/plugin-manifest'
import { readJson, writeJsonAtomic, ensureDir } from './util/fsx'

export type { Config }

export const CONFIG_VERSION = 1

export const DEFAULT_CONFIG: Config = {
  version: CONFIG_VERSION,
  hotkey: { accelerator: 'Alt+Space' },
  autostart: false,
  hideOnBlur: true,
  keepQuery: false,
  language: 'zh-CN',
  theme: 'system',
  accent: '#4f8cff',
  density: 'comfortable',
  historyLimit: 500,
  historyInSearch: true,
  disabled: [],
  denied: {},
  devPlugins: {},
  // 尺寸记忆从空开始：没拖过把手就走内容自适应 / 默认高度
  windowSizes: {},
}

/** 窗口尺寸记忆的允许区间（与壳侧的钳制同源；`MIN_*` 也与 requirements §6.2 的最小尺寸一致） */
export const MIN_WINDOW_WIDTH = 480
export const MIN_WINDOW_HEIGHT = 240
export const MAX_WINDOW_WIDTH = 2000
export const MAX_WINDOW_HEIGHT = 1400

/**
 * 内核自己算数据目录时的默认位置（standalone / 没传 `--data-root`）。
 * 目录名必须与壳一致（`apps/shell/src/sidecar.rs` 的 `APP_DATA_DIR_NAME`）——
 * 两边不一致就会出现两个数据目录，表现为「换个启动方式，历史全没了」。
 */
export function defaultDataRoot(appName = 'Chassis'): string {
  const override = process.env.LAUNCHER_DATA_ROOT
  if (override) return path.resolve(override)
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName)
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName)
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), appName)
}

/**
 * 出厂 bundle 目录（只读、可禁用不可卸载）。
 *
 * 开发态默认就是仓库根的 `plugins/`（全部出厂插件都在这里，工具链分两套、产物形态一致）；
 * 打包后由 `scripts/lib/resources.mjs` 拷进 `Resources/builtin-plugins/`，壳用
 * `--builtin-plugins` 指给内核。
 * 覆盖方式：`LAUNCHER_BUILTIN_PLUGINS=/a,/b`（逗号分隔，仍支持多目录）。
 */
export function defaultBuiltinPluginsRoots(): string[] {
  const override = process.env.LAUNCHER_BUILTIN_PLUGINS
  if (override) {
    return override
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => path.resolve(item))
  }
  return [path.resolve(process.cwd(), 'plugins')]
}

export class ConfigStore {
  readonly file: string
  private cache: Config = { ...DEFAULT_CONFIG }
  private queue: Promise<void> = Promise.resolve()

  constructor(readonly dataRoot: string) {
    this.file = path.join(dataRoot, 'config.json')
  }

  async load(): Promise<Config> {
    const raw = await readJson<Partial<Config>>(this.file, {})
    this.cache = migrateConfig(raw)
    return this.cache
  }

  get(): Config {
    return this.cache
  }

  async patch(patch: Partial<Config>): Promise<Config> {
    this.cache = sanitizeConfig({ ...this.cache, ...patch })
    const snapshot = this.cache
    this.queue = this.queue.then(
      () => writeJsonAtomic(this.file, snapshot),
      () => writeJsonAtomic(this.file, snapshot),
    )
    await this.queue
    return this.cache
  }

  async init(): Promise<void> {
    await ensureDir(this.dataRoot)
  }
}

export function migrateConfig(raw: Partial<Config>): Config {
  const merged = { ...DEFAULT_CONFIG, ...raw } as Config
  merged.version = CONFIG_VERSION
  merged.hotkey = { accelerator: raw.hotkey?.accelerator || DEFAULT_CONFIG.hotkey.accelerator }
  merged.disabled = Array.isArray(raw.disabled) ? [...new Set(raw.disabled.filter((x) => typeof x === 'string'))] : []
  merged.denied = raw.denied && typeof raw.denied === 'object' ? { ...raw.denied } : {}
  merged.devPlugins = raw.devPlugins && typeof raw.devPlugins === 'object' ? { ...raw.devPlugins } : {}
  return sanitizeConfig(merged)
}

export function sanitizeConfig(cfg: Config): Config {
  const out: Config = { ...cfg }
  out.historyLimit = clamp(Math.round(Number(cfg.historyLimit) || DEFAULT_CONFIG.historyLimit), 100, 2000)
  out.theme = cfg.theme === 'light' || cfg.theme === 'dark' ? cfg.theme : 'system'
  out.density = cfg.density === 'compact' ? 'compact' : 'comfortable'
  out.hideOnBlur = Boolean(cfg.hideOnBlur)
  out.keepQuery = Boolean(cfg.keepQuery)
  out.autostart = Boolean(cfg.autostart)
  out.historyInSearch = cfg.historyInSearch !== false
  if (!/^#[0-9a-fA-F]{3,8}$/.test(String(cfg.accent))) out.accent = DEFAULT_CONFIG.accent
  if (!cfg.hotkey?.accelerator) out.hotkey = { accelerator: DEFAULT_CONFIG.hotkey.accelerator }
  out.windowSizes = sanitizeWindowSizes(cfg.windowSizes)
  return out
}

/**
 * 尺寸记忆的清洗：只认「两个模式之一 + 一对落在允许区间里的完整数字」。
 *
 * 这里是**唯一**决定什么算合法记忆的地方（UI 提交、落盘、广播都过它）——
 * 半个尺寸（只有宽没有高）、负数、越界值一律丢掉那一项，让窗口回落默认形态，
 * 而不是拿着一个脏数字去 `setSize`（表现会是"窗口拉到一个诡异的尺寸"）。
 */
export function sanitizeWindowSizes(raw: unknown): Config['windowSizes'] {
  const out: Config['windowSizes'] = {}
  if (!raw || typeof raw !== 'object') return out
  for (const mode of ['host', 'plugin'] as const) {
    const entry = (raw as Record<string, unknown>)[mode] as { width?: unknown; height?: unknown } | undefined
    if (!entry || typeof entry !== 'object') continue
    const width = Math.round(Number(entry.width))
    const height = Math.round(Number(entry.height))
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue
    if (width < MIN_WINDOW_WIDTH || height < MIN_WINDOW_HEIGHT) continue
    out[mode] = {
      width: clamp(width, MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH),
      height: clamp(height, MIN_WINDOW_HEIGHT, MAX_WINDOW_HEIGHT),
    }
  }
  return out
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
