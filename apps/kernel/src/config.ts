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
}

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
  return out
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
