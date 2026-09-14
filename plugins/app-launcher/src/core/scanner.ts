/**
 * macOS 应用扫描。
 *
 * 扫描与本地化名称解析逻辑移植自 ZTools `src/main/core/commandScanner/macScanner.ts`
 * （MIT License, Copyright (c) ZToolsCenter），按本底座的「零 Electron」约束做了改造：
 *  - `app.getPreferredSystemLanguages()` → `defaults read -g AppleLanguages`
 *  - 图标改为输出 `.icns` 路径，由 icons.ts 用系统 `sips` 转 PNG
 *  详见 docs/THIRD-PARTY.md。
 */
import { execFileSync } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { asRecord, asString, parsePlistFile, type PlistValue } from './plist'

export interface AppEntry {
  name: string
  path: string
  aliases: string[]
  /** .icns 文件路径（可能缺省） */
  iconFile?: string
  acronym?: string
}

interface LocalizedAppMetadata {
  name: string
  aliases?: string[]
}

export function getMacApplicationPaths(): string[] {
  const home = process.env.HOME ?? ''
  return [
    '/Applications',
    '/System/Applications',
    '/System/Applications/Utilities',
    // Finder / Dock 等系统常驻应用在这里
    '/System/Library/CoreServices',
    `${home}/Applications`,
  ]
}

function uniqueNonEmpty(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])]
}

let _lprojNames: string[] | null = null
let _loctableKeys: string[] | null = null

/** BCP 47 → macOS lproj 目录名候选（移植） */
export function bcp47ToLprojNames(tag: string): string[] {
  const candidates: string[] = []
  const parts = tag.split('-')
  const lang = parts[0] ?? ''
  let script: string | undefined
  let region: string | undefined

  for (let i = 1; i < parts.length; i += 1) {
    const p = parts[i] ?? ''
    if (p.length === 4 && p[0] === p[0]?.toUpperCase()) script = p
    else if (p.length === 2 && p === p.toUpperCase()) region = p
  }

  if (lang === 'zh' && script) {
    candidates.push(`zh-${script}`)
    if (region) {
      candidates.push(`zh-${script}_${region}`)
      candidates.push(`zh_${region}`)
    } else if (script === 'Hans') {
      candidates.push('zh_CN', 'zh_SG')
    } else if (script === 'Hant') {
      candidates.push('zh_TW', 'zh_HK')
    }
  }

  const legacyNames: Record<string, string> = {
    ja: 'Japanese',
    ko: 'Korean',
    fr: 'French',
    de: 'German',
    es: 'Spanish',
    it: 'Italian',
    pt: 'Portuguese',
    nl: 'Dutch',
    sv: 'Swedish',
    da: 'Danish',
    fi: 'Finnish',
    nb: 'Norwegian',
    pl: 'Polish',
    ru: 'Russian',
    en: 'English',
  }

  if (region) candidates.push(`${lang}_${region}`)
  candidates.push(lang)
  if (legacyNames[lang]) candidates.push(legacyNames[lang])
  return candidates
}

export function bcp47ToLoctableKeys(tag: string): string[] {
  const candidates: string[] = []
  const parts = tag.split('-')
  const lang = parts[0] ?? ''
  let script: string | undefined
  let region: string | undefined

  for (let i = 1; i < parts.length; i += 1) {
    const p = parts[i] ?? ''
    if (p.length === 4 && p[0] === p[0]?.toUpperCase()) script = p
    else if (p.length === 2 && p === p.toUpperCase()) region = p
  }

  if (lang === 'zh' && script) {
    if (region) candidates.push(`zh_${region}`)
    if (script === 'Hans') candidates.push('zh_CN', 'zh_SG')
    else if (script === 'Hant') candidates.push('zh_TW', 'zh_HK')
  } else if (region) {
    candidates.push(`${lang}_${region}`)
  }

  candidates.push(lang)
  return [...new Set(candidates)]
}

/** 读取系统语言偏好（替代 Electron 的 getPreferredSystemLanguages） */
export function preferredSystemLanguages(): string[] {
  try {
    const raw = execFileSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 2000 })
    const matches = raw.match(/"([^"]+)"/g)
    if (matches && matches.length > 0) return matches.map((m) => m.replace(/"/g, ''))
  } catch {
    /* 回退到环境变量 */
  }
  const env = [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG].filter(Boolean) as string[]
  const fromEnv = env
    .map((value) => value.split('.')[0]?.replace('_', '-'))
    .filter((value): value is string => Boolean(value))
  return fromEnv.length > 0 ? fromEnv : ['en-US']
}

function localeLprojNames(): string[] {
  if (_lprojNames) return _lprojNames
  const candidates: string[] = []
  for (const lang of preferredSystemLanguages()) candidates.push(...bcp47ToLprojNames(lang))
  _lprojNames = [...new Set(candidates)]
  return _lprojNames
}

function localeLoctableKeys(): string[] {
  if (_loctableKeys) return _loctableKeys
  const candidates: string[] = []
  for (const tag of preferredSystemLanguages()) candidates.push(...bcp47ToLoctableKeys(tag))
  _loctableKeys = [...new Set(candidates)]
  return _loctableKeys
}

function extractLocalizedAliases(data: Record<string, string> | null | undefined, name?: string): string[] {
  if (!data) return []
  const aliases = Object.entries(data)
    .filter(([key, value]) => key.startsWith('APP_NAME_SYNONYM_') && typeof value === 'string')
    .map(([, value]) => value.trim())
    .filter(Boolean)
  return [...new Set(aliases.filter((alias) => alias !== name))]
}

function parseStringsContent(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  const regex = /(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_]\w*))\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    const key = match[1] ?? match[2]
    if (key) result[key] = match[3] ?? ''
  }
  return result
}

async function readPlist(file: string): Promise<Record<string, PlistValue> | null> {
  return asRecord(await parsePlistFile(file))
}

function toStringMap(record: Record<string, PlistValue> | null): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record ?? {})) {
    const text = asString(value)
    if (text) out[key] = text
  }
  return out
}

async function readStringsFile(filePath: string): Promise<Record<string, string> | null> {
  const viaPlist = await readPlist(filePath)
  if (viaPlist) return toStringMap(viaPlist)
  // 回退：UTF-16 / UTF-8 文本格式的 .strings
  try {
    const buf = await fs.readFile(filePath)
    let content: string
    if (buf[0] === 0xff && buf[1] === 0xfe) content = buf.toString('utf16le')
    else if (buf[0] === 0xfe && buf[1] === 0xff) content = Buffer.from(buf).swap16().toString('utf16le')
    else content = buf.toString('utf8')
    return parseStringsContent(content)
  } catch {
    return null
  }
}

async function getLocalizedMetadataFromLproj(appPath: string): Promise<LocalizedAppMetadata | null> {
  for (const lprojName of localeLprojNames()) {
    const stringsPath = path.join(appPath, 'Contents', 'Resources', `${lprojName}.lproj`, 'InfoPlist.strings')
    if (!fsSync.existsSync(stringsPath)) continue
    const data = await readStringsFile(stringsPath)
    const name = data?.CFBundleDisplayName || data?.CFBundleName
    if (name) return { name, aliases: extractLocalizedAliases(data, name) }
  }
  return null
}

async function getLocalizedMetadataFromLoctable(appPath: string): Promise<LocalizedAppMetadata | null> {
  const loctablePath = path.join(appPath, 'Contents', 'Resources', 'InfoPlist.loctable')
  if (!fsSync.existsSync(loctablePath)) return null
  const data = await readPlist(loctablePath)
  if (!data) return null
  for (const key of localeLoctableKeys()) {
    const entry = toStringMap(asRecord(data[key] ?? null))
    const name = entry.CFBundleDisplayName || entry.CFBundleName
    if (name) return { name, aliases: extractLocalizedAliases(entry, name) }
  }
  return null
}

async function getLocalizedMetadata(appPath: string): Promise<LocalizedAppMetadata | null> {
  return (await getLocalizedMetadataFromLproj(appPath)) ?? (await getLocalizedMetadataFromLoctable(appPath))
}

function resolveIconFile(appPath: string, info: Record<string, PlistValue> | null): string | undefined {
  const resources = path.join(appPath, 'Contents', 'Resources')
  const declared = asString(info?.CFBundleIconFile) ?? ''
  if (declared) {
    const candidates = [declared, `${declared}.icns`].map((name) => path.join(resources, name))
    for (const candidate of candidates) {
      if (fsSync.existsSync(candidate)) return candidate
    }
  }
  const fallbacks = ['AppIcon.icns', 'app.icns', 'Icon.icns'].map((name) => path.join(resources, name))
  for (const candidate of fallbacks) {
    if (fsSync.existsSync(candidate)) return candidate
  }
  return undefined
}

async function getBundleNames(appPath: string, info: Record<string, PlistValue> | null): Promise<string[]> {
  const fileName = path.basename(appPath, '.app')
  if (!info) return uniqueNonEmpty([fileName])
  return uniqueNonEmpty([asString(info.CFBundleDisplayName), asString(info.CFBundleName), fileName])
}

async function getAppDisplayInfo(appPath: string): Promise<{ entry: AppEntry }> {
  const info = await readPlist(path.join(appPath, 'Contents', 'Info.plist'))
  const bundleNames = await getBundleNames(appPath, info)
  const iconFile = resolveIconFile(appPath, info)
  const localized = await getLocalizedMetadata(appPath)

  if (localized?.name) {
    const aliases = uniqueNonEmpty([...bundleNames, ...(localized.aliases ?? [])]).filter(
      (alias) => alias !== localized.name,
    )
    return { entry: { name: localized.name, path: appPath, aliases, ...(iconFile ? { iconFile } : {}) } }
  }
  const [name = path.basename(appPath, '.app'), ...aliases] = bundleNames
  return { entry: { name, path: appPath, aliases, ...(iconFile ? { iconFile } : {}) } }
}

/**
 * 递归收集 .app：
 *  - 命中 .app 即收集并停止下钻（避免 helper 子 app）
 *  - 普通目录下钻一层（覆盖浏览器 PWA、Office 子目录）
 *  - 符号链接用 stat 解析真实类型（否则 /Applications/Safari.app 这类链接会被漏扫）
 */
async function collectAppBundles(dir: string, depth: number, out: string[]): Promise<void> {
  let entries: fsSync.Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    let isDirectory = entry.isDirectory()
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = (await fs.stat(fullPath)).isDirectory()
      } catch {
        continue
      }
    }
    if (!isDirectory) continue
    if (entry.name.endsWith('.app')) {
      out.push(fullPath)
      continue
    }
    if (depth > 0) await collectAppBundles(fullPath, depth - 1, out)
  }
}

/** 并发映射（保序） */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor++
      const item = items[index]
      if (item === undefined) continue
      out[index] = await fn(item)
    }
  })
  await Promise.all(workers)
  return out
}

export interface ScanResult {
  apps: AppEntry[]
  scannedDirs: string[]
  durationMs: number
}

export async function scanApplications(): Promise<ScanResult> {
  const started = Date.now()
  const searchPaths = getMacApplicationPaths().filter((dir) => fsSync.existsSync(dir))
  const collected: string[] = []
  for (const searchPath of searchPaths) {
    await collectAppBundles(searchPath, 1, collected)
  }
  const allPaths = [...new Set(collected)]

  const entries = await mapLimit(allPaths, 50, async (appPath) => {
    try {
      const { entry } = await getAppDisplayInfo(appPath)
      return entry
    } catch {
      const name = path.basename(appPath, '.app')
      return { name, path: appPath, aliases: [] } satisfies AppEntry
    }
  })

  return {
    apps: entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
    scannedDirs: searchPaths,
    durationMs: Date.now() - started,
  }
}
