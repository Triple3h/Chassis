/// <reference types="node" />
import { execFileSync } from 'node:child_process'
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BackupInfo, HostsReadResult, HostsWriteResult, WriteMode } from '../core/script-types'

/**
 * hosts 文件的读写（只在 Node Worker / script 命令里用）。
 *
 * 为什么必须走 script：View 跑在 iframe 里，浏览器沙箱读不了 `/etc/hosts`；
 * 而 `mode: "script"` 的命令跑在 Node Worker 中，可以正常访问文件系统。
 *
 * 安全边界（这一层能改系统文件，必须自己收紧）：
 *   1. **目标路径不可由调用方指定** —— 只认 SOFAST_HOSTS_PATH（测试用）与平台默认值。
 *      否则「支持提权写文件」的脚本就成了任意文件写入的跳板。
 *   2. 写入前先备份，写入后回读校验，内容为空直接拒绝。
 *   3. 提权一律走系统自带对话框（osascript / UAC），不自己存密码。
 *   4. 备份、待生效文件只落 `dataPath`（N2）：安装目录在新底座里是只读的，
 *      升级/重装会覆盖它 —— 用户的备份绝不能放在那儿。
 */

const BOM = Buffer.from([0xef, 0xbb, 0xbf])
/** 提权对话框可能等用户输密码，给足时间（也会传给 UI 侧的 runScript 超时） */
export const ELEVATE_TIMEOUT_MS = 120_000
const MAX_HOSTS_BYTES = 4 * 1024 * 1024
const KEEP_BACKUPS = 30

/** 展开开头的 `~`（用户写 SOFAST_HOSTS_PATH 时习惯这么写） */
function expandHome(input: string): string {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2))
  return input
}

/** 系统 hosts 路径（可用环境变量覆盖，测试与自定义安装场景用） */
export function resolveHostsPath(): string {
  const override = process.env.SOFAST_HOSTS_PATH?.trim()
  if (override) return path.resolve(expandHome(override))
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows'
    return path.join(root, 'System32', 'drivers', 'etc', 'hosts')
  }
  return '/etc/hosts'
}

/**
 * 备份目录 = `<数据目录>/backups`。
 * dataPath 由 `shared/lib/host-node.ts` 给出：新底座是 `<dataRoot>/plugins/sofast-hosts`，
 * 如快兜底成 `<插件目录>/data` —— 后者正是历史版本的位置，所以如快侧不迁移也不丢备份。
 */
export function backupDirOf(dataPath: string): string {
  return path.join(dataPath, 'backups')
}

function decode(buf: Buffer): { text: string; bom: boolean; encoding: 'utf8' | 'binary' } {
  let body = buf
  let bom = false
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    bom = true
    body = buf.subarray(3)
  }
  const text = body.toString('utf8')
  // 往返比对：合法 UTF-8 才按 utf8 处理，否则用 latin1 逐字节映射。
  // latin1 的往返是无损的，中文会显示成乱码，但绝不会把文件写坏。
  if (Buffer.compare(Buffer.from(text, 'utf8'), body) === 0) {
    return { text, bom, encoding: 'utf8' }
  }
  return { text: body.toString('latin1'), bom, encoding: 'binary' }
}

function encode(text: string, bom: boolean, encoding: 'utf8' | 'binary'): Buffer {
  const body = Buffer.from(text, encoding === 'binary' ? 'latin1' : 'utf8')
  return bom ? Buffer.concat([BOM, body]) : body
}

export function readHostsFile(target = resolveHostsPath()): HostsReadResult {
  const base: HostsReadResult = {
    ok: false,
    path: target,
    content: '',
    size: 0,
    mtime: 0,
    bom: false,
    encoding: 'utf8',
    writable: false,
    platform: process.platform,
  }

  try {
    if (!existsSync(target)) {
      return { ...base, error: `文件不存在：${target}` }
    }
    const stat = statSync(target)
    if (stat.size > MAX_HOSTS_BYTES) {
      return { ...base, size: stat.size, error: `文件异常大（${(stat.size / 1048576).toFixed(1)}MB），已拒绝读取` }
    }
    const buf = readFileSync(target)
    const { text, bom, encoding } = decode(buf)

    let writable = false
    try {
      accessSync(target, constants.W_OK)
      writable = true
    } catch {
      writable = false
    }

    return {
      ok: true,
      path: target,
      content: text,
      size: buf.length,
      mtime: stat.mtimeMs,
      bom,
      encoding,
      writable,
      platform: process.platform,
    }
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  }
}

/* ------------------------------------------------------------------ 备份 */

export function listBackups(dataPath: string): BackupInfo[] {
  const dir = backupDirOf(dataPath)
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: BackupInfo[] = []
  for (const name of names) {
    if (!/^hosts-[\w.-]+\.txt$/.test(name)) continue
    try {
      const stat = statSync(path.join(dir, name))
      out.push({ name, size: stat.size, mtime: stat.mtimeMs })
    } catch {
      continue
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

export function readBackup(dataPath: string, name: string): string {
  // 备份名来自 UI，必须挡掉路径穿越
  if (!/^hosts-[\w.-]+\.txt$/.test(name)) throw new Error('备份文件名不合法')
  return readFileSync(path.join(backupDirOf(dataPath), name), 'utf8')
}

/** 备份当前文件，返回备份名；原文件不存在则返回 null */
export function backupHosts(dataPath: string, target: string): { name: string; path: string } | null {
  if (!existsSync(target)) return null
  const dir = backupDirOf(dataPath)
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let name = `hosts-${stamp}.txt`
  // 同一毫秒内连写两次时，时间戳文件名会撞车 —— 撞了就加序号，别互相覆盖
  for (let seq = 2; existsSync(path.join(dir, name)); seq++) {
    name = `hosts-${stamp}-${seq}.txt`
  }
  const dest = path.join(dir, name)
  copyFileSync(target, dest)

  const all = listBackups(dataPath)
  for (const old of all.slice(KEEP_BACKUPS)) {
    try {
      rmSync(path.join(dir, old.name), { force: true })
    } catch {
      /* 清理失败无所谓 */
    }
  }
  return { name, path: dest }
}

/* ------------------------------------------------------------------ 提权 */

const SQ = "'\\''"

/** shell 单引号转义：路径里有空格、引号都安全 */
function shq(value: string): string {
  return `'${value.replace(/'/g, SQ)}'`
}

function psq(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function stderrOf(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string }
  const raw = e?.stderr instanceof Buffer ? e.stderr.toString('utf8') : (e?.stderr ?? '')
  return String(raw || e?.message || err).trim()
}

function isPermissionError(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'EEXIST'
}

function elevateDarwin(pending: string, target: string): void {
  const shell = `/bin/cp ${shq(pending)} ${shq(target)} && /bin/chmod 644 ${shq(target)}`
  // JSON.stringify 的结果恰好是合法的 AppleScript 字符串字面量（转义规则一致）
  const script = `do shell script ${JSON.stringify(shell)} with administrator privileges`
  execFileSync('/usr/bin/osascript', ['-e', script], { timeout: ELEVATE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] })
}

function elevateLinux(pending: string, target: string): void {
  execFileSync('/usr/bin/pkexec', ['/bin/cp', pending, target], {
    timeout: ELEVATE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function elevateWindows(pending: string, target: string): void {
  // 内层命令转成 UTF-16LE base64，绕开 Start-Process 参数重新拼接的引号地狱
  const inner = `Copy-Item -LiteralPath ${psq(pending)} -Destination ${psq(target)} -Force`
  const encoded = Buffer.from(inner, 'utf16le').toString('base64')
  const outer = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', outer], {
    timeout: ELEVATE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function elevate(pending: string, target: string): void {
  if (process.platform === 'darwin') return elevateDarwin(pending, target)
  if (process.platform === 'win32') return elevateWindows(pending, target)
  return elevateLinux(pending, target)
}

function manualCommand(pending: string, target: string): string {
  if (process.platform === 'win32') {
    return `Copy-Item -Force ${psq(pending)} ${psq(target)}`
  }
  return `sudo cp ${shq(pending)} ${shq(target)} && sudo chmod 644 ${shq(target)}`
}

/* ------------------------------------------------------------------ 写入 */

export interface WriteOptions {
  content: string
  /** 插件数据目录（备份与待生效文件都写这里，N2） */
  dataPath: string
  /** 仅供测试注入；正常运行永远用 resolveHostsPath() */
  target?: string
  mode?: WriteMode
  backup?: boolean
}

function verify(target: string, expected: Buffer): boolean {
  try {
    return Buffer.compare(readFileSync(target), expected) === 0
  } catch {
    return false
  }
}

export function writeHostsFile(opts: WriteOptions): HostsWriteResult {
  const target = opts.target ?? resolveHostsPath()
  const mode: WriteMode = opts.mode ?? 'auto'
  const result: HostsWriteResult = { ok: false, method: 'none', path: target }

  if (!opts.content.trim()) {
    return { ...result, error: '内容为空，已阻止写入（空 hosts 会让本机解析全部失效）' }
  }

  // 保留原文件的编码与 BOM：先探一次，拿不到就按 UTF-8 处理
  let bom = false
  let encoding: 'utf8' | 'binary' = 'utf8'
  const before = readHostsFile(target)
  if (before.ok) {
    bom = before.bom
    encoding = before.encoding
  } else if (existsSync(target)) {
    // 文件在、但读不出来（超大 / 权限异常）：不冒险覆盖它
    return { ...result, error: before.error ?? '无法读取目标文件，已中止写入' }
  }
  const data = encode(opts.content, bom, encoding)

  if (opts.backup !== false) {
    try {
      const saved = backupHosts(opts.dataPath, target)
      if (saved) {
        result.backup = saved.name
        result.backupPath = saved.path
      }
    } catch (err) {
      return { ...result, error: `备份失败，已中止写入：${err instanceof Error ? err.message : String(err)}` }
    }
  }

  if (mode !== 'privileged') {
    try {
      writeFileSync(target, data)
      return { ...result, ok: true, method: 'direct', verified: verify(target, data) }
    } catch (err) {
      if (!isPermissionError(err)) {
        return { ...result, error: err instanceof Error ? err.message : String(err) }
      }
      if (mode === 'direct') {
        return { ...result, error: '当前进程没有写权限，可改用「管理员写入」重试' }
      }
    }
  }

  // 提权路径：先把内容落到数据目录，再让系统对话框以管理员身份拷过去
  const dataDir = opts.dataPath
  const pending = path.join(dataDir, 'pending-hosts.txt')
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(pending, data)
  } catch (err) {
    return { ...result, error: `无法写入待生效文件：${err instanceof Error ? err.message : String(err)}` }
  }

  try {
    elevate(pending, target)
  } catch (err) {
    const detail = stderrOf(err)
    const canceled = /user canceled|User cancelled|-128/i.test(detail)
    return {
      ...result,
      method: 'manual',
      pendingPath: pending,
      command: manualCommand(pending, target),
      error: canceled ? '已取消管理员授权' : `提权失败：${detail || '未知原因'}`,
    }
  }

  const verified = verify(target, data)
  return {
    ...result,
    ok: verified,
    method: 'privileged',
    verified,
    error: verified ? undefined : '提权命令执行完了，但回读内容与预期不一致，请到备份里确认',
  }
}

/** 供 UI 提示用的平台描述 */
export function platformLabel(): string {
  if (process.platform === 'darwin') return 'macOS'
  if (process.platform === 'win32') return 'Windows'
  return os.platform()
}
