import { storage } from '@launcher/api'
import { DEFAULT_SETTINGS, normalizeAccount, type Account, type Settings } from './types'
import { isVaultBlob, type VaultBlob } from './vault'

/**
 * 账户持久化。
 *  - 未开启口令：账户直接存 `accounts`
 *  - 已开启口令：账户存进 `vault` 密文，`accounts` 键被清掉，列表在内存里解密后使用
 * 存储位置由宿主决定：`<dataRoot>/plugins/totp/storage.json`；
 * 一律走 storage API，不要自己拼路径。
 */

const KEY_ACCOUNTS = 'accounts'
const KEY_SETTINGS = 'settings'
const KEY_VAULT = 'vault'

export interface LoadedState {
  accounts: Account[]
  settings: Settings
  vault: VaultBlob | null
}

export async function loadState(): Promise<LoadedState> {
  const [rawAccounts, rawSettings, rawVault] = await Promise.all([
    storage.get<Account[]>(KEY_ACCOUNTS),
    storage.get<Partial<Settings>>(KEY_SETTINGS),
    storage.get<unknown>(KEY_VAULT),
  ])
  return {
    accounts: Array.isArray(rawAccounts) ? rawAccounts.map(normalizeAccount) : [],
    settings: { ...DEFAULT_SETTINGS, ...(rawSettings ?? {}) },
    vault: isVaultBlob(rawVault) ? rawVault : null,
  }
}

export async function saveAccounts(accounts: Account[]): Promise<void> {
  await storage.set(KEY_ACCOUNTS, accounts)
}

export async function saveVault(blob: VaultBlob): Promise<void> {
  await storage.set(KEY_VAULT, blob)
  // 明文副本必须清掉，否则加密形同虚设
  await storage.remove(KEY_ACCOUNTS)
}

export async function clearVault(): Promise<void> {
  await storage.remove(KEY_VAULT)
}

export async function saveSettings(settings: Settings): Promise<void> {
  await storage.set(KEY_SETTINGS, settings)
}

/** 导出为通用 JSON（可选带口令加密） */
export interface ExportFile {
  format: 'totp'
  version: 1
  exportedAt: number
  encrypted?: boolean
  accounts?: Account[]
  vault?: VaultBlob
}
