#!/usr/bin/env node
/**
 * 生成壳的占位图标（icons/icon.png + icon.icns）。
 * 真实发布前请替换为自己的品牌图标（§6.3 打包要求）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const iconDir = path.join(repoRoot, 'apps', 'shell', 'icons')
fs.mkdirSync(iconDir, { recursive: true })

const SIZE = 512
const png = createPng(SIZE, SIZE)
const pngPath = path.join(iconDir, 'icon.png')
fs.writeFileSync(pngPath, png)
console.log(`✓ ${path.relative(repoRoot, pngPath)}`)

if (process.platform === 'darwin') {
  const icnsPath = path.join(iconDir, 'icon.icns')
  try {
    execFileSync('sips', ['-s', 'format', 'icns', pngPath, '--out', icnsPath], { stdio: 'ignore' })
    console.log(`✓ ${path.relative(repoRoot, icnsPath)}`)
  } catch (err) {
    console.warn(`· 生成 icns 失败（可忽略，打包时再补）：${err.message}`)
  }
}

/** 写一张圆角渐变底 + 白色方块的 PNG（不引第三方库） */
function createPng(width, height) {
  const raw = Buffer.alloc(height * (width * 4 + 1))
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0
    offset += 1
    for (let x = 0; x < width; x += 1) {
      const t = (x / width + y / height) / 2
      const r = Math.round(79 + t * 40)
      const g = Math.round(140 - t * 40)
      const b = Math.round(255 - t * 60)
      const inCenter = Math.abs(x - width / 2) < width * 0.16 && Math.abs(y - height / 2) < height * 0.16
      raw[offset] = inCenter ? 255 : r
      raw[offset + 1] = inCenter ? 255 : g
      raw[offset + 2] = inCenter ? 255 : b
      raw[offset + 3] = 255
      offset += 4
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  const chunks = [
    chunk('IHDR', ihdr(width, height)),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks])
}

function ihdr(width, height) {
  const buffer = Buffer.alloc(13)
  buffer.writeUInt32BE(width, 0)
  buffer.writeUInt32BE(height, 4)
  buffer[8] = 8 // bit depth
  buffer[9] = 6 // RGBA
  return buffer
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

// 用 var：模块顶层会先执行 createPng，声明提升后这里只是 undefined（避免 TDZ）
var CRC_TABLE = null

function crc32(buffer) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
