/**
 * 极简 plist 解析（binary + XML），替代 `simple-plist`。
 *
 * 为什么自研：`simple-plist` 内部用运行时 `require('bplist-creator' / 'bplist-parser')`，
 * 无法静态打包进 `<name>.mjs`，会破坏 plugin-spec N1「脚本产物自包含」。
 * 这里只需要读 string / int / array / dict，约 200 行即可覆盖 Info.plist 与 InfoPlist.strings。
 */
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'

export type PlistValue = string | number | boolean | Date | Buffer | PlistValue[] | { [key: string]: PlistValue }

const BINARY_MAGIC = 'bplist'

export function parsePlistBuffer(buf: Buffer): PlistValue | null {
  if (buf.byteLength >= 6 && buf.toString('latin1', 0, 6) === 'bplist') {
    try {
      return parseBinary(buf)
    } catch {
      return null
    }
  }
  try {
    return parseXml(buf.toString('utf8'))
  } catch {
    return null
  }
}

export function parsePlistFileSync(file: string): PlistValue | null {
  try {
    return parsePlistBuffer(fs.readFileSync(file))
  } catch {
    return null
  }
}

export async function parsePlistFile(file: string): Promise<PlistValue | null> {
  try {
    return parsePlistBuffer(await fsPromises.readFile(file))
  } catch {
    return null
  }
}

export function asRecord(value: PlistValue | null): Record<string, PlistValue> | null {
  if (value && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)) {
    return value as Record<string, PlistValue>
  }
  return null
}

export function asString(value: PlistValue | undefined): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  return undefined
}

// ── binary plist ────────────────────────────────────────────────
function parseBinary(buf: Buffer): PlistValue {
  const trailerStart = buf.byteLength - 32
  const offsetIntSize = buf[trailerStart + 6] ?? 1
  const objectRefSize = buf[trailerStart + 7] ?? 1
  const numObjects = Number(buf.readBigUInt64BE(trailerStart + 8))
  const topObject = Number(buf.readBigUInt64BE(trailerStart + 16))
  const offsetTableOffset = Number(buf.readBigUInt64BE(trailerStart + 24))

  const offsets = new Array<number>(numObjects)
  for (let i = 0; i < numObjects; i += 1) {
    offsets[i] = readUInt(buf, offsetTableOffset + i * offsetIntSize, offsetIntSize)
  }

  const readRef = (index: number): PlistValue => {
    const offset = offsets[index]
    if (offset === undefined) return null as unknown as PlistValue
    return readObject(offset)
  }

  const readLength = (offset: number, info: number): { length: number; start: number } => {
    if (info !== 0x0f) return { length: info, start: offset + 1 }
    const intMarker = buf[offset + 1] ?? 0
    const size = 1 << (intMarker & 0x0f)
    const length = readUInt(buf, offset + 2, size)
    return { length, start: offset + 2 + size }
  }

  function readObject(offset: number): PlistValue {
    const marker = buf[offset] ?? 0
    const type = marker >> 4
    const info = marker & 0x0f

    switch (type) {
      case 0x0:
        if (info === 0x08) return false
        if (info === 0x09) return true
        return null as unknown as PlistValue
      case 0x1:
        return readUInt(buf, offset + 1, 1 << info)
      case 0x2: {
        const size = 1 << info
        if (size === 4) return buf.readFloatBE(offset + 1)
        if (size === 8) return buf.readDoubleBE(offset + 1)
        return 0
      }
      case 0x3:
        return new Date((buf.readDoubleBE(offset + 1) + 978307200) * 1000)
      case 0x4: {
        const { length, start } = readLength(offset, info)
        return buf.subarray(start, start + length)
      }
      case 0x5: {
        const { length, start } = readLength(offset, info)
        return buf.toString('latin1', start, start + length)
      }
      case 0x6: {
        // binary plist 的字符串是 UTF-16 **大端**（换成小端再解码）
        const { length, start } = readLength(offset, info)
        const slice = Buffer.from(buf.subarray(start, start + length * 2))
        return slice.swap16().toString('utf16le')
      }
      case 0xa: {
        const { length, start } = readLength(offset, info)
        const out: PlistValue[] = []
        for (let i = 0; i < length; i += 1) {
          out.push(readRef(readUInt(buf, start + i * objectRefSize, objectRefSize)))
        }
        return out
      }
      case 0xd: {
        const { length, start } = readLength(offset, info)
        const out: Record<string, PlistValue> = {}
        for (let i = 0; i < length; i += 1) {
          const keyRef = readUInt(buf, start + i * objectRefSize, objectRefSize)
          const valueRef = readUInt(buf, start + (length + i) * objectRefSize, objectRefSize)
          const key = readRef(keyRef)
          out[typeof key === 'string' ? key : String(key)] = readRef(valueRef)
        }
        return out
      }
      default:
        return null as unknown as PlistValue
    }
  }

  return readRef(topObject)
}

function readUInt(buf: Buffer, offset: number, size: number): number {
  if (size === 0) return 0
  if (offset < 0 || offset + size > buf.byteLength) return 0
  let value = 0
  for (let i = 0; i < size; i += 1) {
    value = value * 256 + (buf[offset + i] ?? 0)
  }
  return value
}

// ── XML plist（够用即可：key/string/integer/real/true/false/array/dict/data/date）──
interface XmlNode {
  tag: string
  text: string
  children: XmlNode[]
}

function parseXml(text: string): PlistValue {
  const cleaned = text
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  const tagRe = /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g
  const root: XmlNode = { tag: '#root', text: '', children: [] }
  const stack: XmlNode[] = [root]
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = tagRe.exec(cleaned)) !== null) {
    const text_ = cleaned.slice(cursor, match.index)
    if (text_.trim()) {
      const top = stack[stack.length - 1]
      if (top) top.text += text_
    }
    cursor = tagRe.lastIndex
    const closing = match[1] === '/'
    const tag = match[2] ?? ''
    const selfClosing = match[4] === '/'
    if (closing) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const node: XmlNode = { tag, text: '', children: [] }
    const top = stack[stack.length - 1]
    if (top) top.children.push(node)
    if (!selfClosing) stack.push(node)
  }

  const plistNode = root.children.find((child) => child.tag === 'plist') ?? root
  return nodeToValue(plistNode)
}

function nodeToValue(node: XmlNode): PlistValue {
  switch (node.tag) {
    case 'string':
      return decodeEntities(node.text)
    case 'integer':
      return Number.parseInt(node.text.trim(), 10) || 0
    case 'real':
      return Number.parseFloat(node.text.trim()) || 0
    case 'true':
      return true
    case 'false':
      return false
    case 'data':
      return Buffer.from(node.text.replace(/\s+/g, ''), 'base64')
    case 'date':
      return new Date(node.text.trim())
    case 'array':
      return node.children.map(nodeToValue)
    case 'dict': {
      const out: Record<string, PlistValue> = {}
      let key = ''
      for (const child of node.children) {
        if (child.tag === 'key') key = decodeEntities(child.text)
        else out[key] = nodeToValue(child)
      }
      return out
    }
    default:
      return decodeEntities(node.text)
  }
}

function decodeEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_all, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}
