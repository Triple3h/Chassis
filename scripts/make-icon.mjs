#!/usr/bin/env node
/**
 * 生成应用图标（矢量源 → 多尺寸 PNG → .icns / .ico）。
 *
 * 为什么要脚本而不是塞一张位图：图标要出现在 16px（Finder 列表）到 1024px（预览）之间，
 * 手工放一张位图在高分屏 / 小尺寸下都会糊。这里用 SVG 作为唯一源，任何尺寸都是重绘。
 *
 * 两个字形：
 *   应用图标 = 「输入框」（玻璃胶囊 + 文字光标 + 上箭头），即"输入即搜、回车即启"
 *   托盘     = 放大镜（18pt 下输入框的内里会糊，放大镜轮廓更清楚）
 *
 * 视觉语言：Liquid Glass —— 深色中性玻璃盘 + 边缘镜面高光 + 内部半透明胶囊。
 * 不依赖彩色光斑；蓝色只作为极淡的环境光，保证浅色 / 深色桌面下都读得清。
 *
 * 依赖：rsvg-convert（brew install librsvg）、iconutil（macOS 自带）
 * 用法：npm run icon
 * 产物：apps/shell/icons/{icon.svg, icon.png, icon.icns, icon.ico, tray.svg, tray.png, tray-win.svg, tray-win.png}
 *
 * `.ico`：手写封装（PNG-in-ICO，Vista+ 原生支持），不引第三方库 ——
 * 图标链路已经有一个 brew 依赖（rsvg-convert），再加一个 npm 依赖不划算。
 * **产物必须入库**：CI 上跑不了本脚本（macOS runner 没有 rsvg-convert / iconutil）。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const iconsDir = path.join(repoRoot, 'apps', 'shell', 'icons')

// ── 设计常量（改这里即可换配色 / 换比例）─────────────────────────
const CANVAS = 1024
const PLATE = 824 // macOS 图稿标准：1024 画布内 824 的圆角方
const PLATE_OFFSET = (CANVAS - PLATE) / 2
const PLATE_CENTER = PLATE_OFFSET + PLATE / 2
const SQUIRCLE_N = 5 // 超椭圆指数：4.5–5 最接近 Apple 的连续圆角

// 中性石板蓝：左上环境光、右下压暗；蓝色只做很淡的冷光，不做彩色渐变球
const PALETTE = {
  from: '#2A3850', // 左下：石板蓝
  mid: '#19222F', // 中段：深石墨
  to: '#0D121B', // 右上：近黑
  glow: '#6FA8FF', // 右上冷光（低透明度）
  shade: '#04070D', // 底部压暗
  trayFrom: '#5E97FF', // Windows 托盘：浅色任务栏也看得清
  trayTo: '#2B5CC4',
}

const MARK = { w: 540, h: 250 } // 玻璃胶囊（宽 53% / 高 24% 图稿）

/**
 * 菜单栏字形：放大镜 —— **刻意与应用图标不同**。
 * 应用图标那个「输入框」在 18pt 下内里的光标/箭头会糊掉，放大镜的轮廓干净得多。
 * 值是以环心为原点的绝对坐标（字形框边长 = to·u + r + stroke）。
 */
const MAGNIFIER = { r: 142, stroke: 80, from: 140, to: 262, fill: 0.88 }

// ── 超椭圆路径：比 SVG 的 rx 圆弧更接近 macOS 图标的连续圆角 ──────
function squirclePath(size, n, samples = 72) {
  const a = size / 2
  const pt = (t) => {
    const c = Math.cos(t)
    const s = Math.sin(t)
    return [a * Math.sign(c) * Math.abs(c) ** (2 / n), a * Math.sign(s) * Math.abs(s) ** (2 / n)]
  }
  const points = []
  const total = samples * 4
  for (let i = 0; i < total; i += 1) {
    const t = (i / total) * Math.PI * 2
    const [x, y] = pt(t)
    points.push([a + x, a + y])
  }
  return `M${points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join('L')}Z`
}

/** 字形框边长（含描边） */
function magnifierBox() {
  const { r, stroke, to } = MAGNIFIER
  return to * Math.SQRT1_2 + r + stroke
}

/** 放大镜：环 + 45° 手柄。以**字形框中心**为原点，所以绘制前要把环心挪回去。 */
function magnifierMarkup({ size, color }) {
  const u = Math.SQRT1_2
  const { r, stroke, from, to } = MAGNIFIER
  const scale = size / magnifierBox()
  const offset = (to * u - r) / 2 // 字形框中心相对环心的偏移
  const n = (v) => v.toFixed(1)
  return `<g transform="scale(${scale.toFixed(5)}) translate(${-offset.toFixed(2)} ${-offset.toFixed(2)})" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round">
    <circle cx="0" cy="0" r="${r}" />
    <line x1="${n(from * u)}" y1="${n(from * u)}" x2="${n(to * u)}" y2="${n(to * u)}" />
  </g>`
}

function defs(platePath) {
  return `<defs>
    <linearGradient id="plate" x1="0.08" y1="0.95" x2="0.82" y2="0.02">
      <stop offset="0" stop-color="${PALETTE.from}" />
      <stop offset="0.52" stop-color="${PALETTE.mid}" />
      <stop offset="1" stop-color="${PALETTE.to}" />
    </linearGradient>
    <radialGradient id="glow" cx="0.82" cy="0.12" r="0.7">
      <stop offset="0" stop-color="${PALETTE.glow}" stop-opacity="0.34" />
      <stop offset="1" stop-color="${PALETTE.glow}" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="specular" x1="0.08" y1="0" x2="0.82" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.26" />
      <stop offset="0.42" stop-color="#ffffff" stop-opacity="0.04" />
      <stop offset="0.44" stop-color="#ffffff" stop-opacity="0" />
    </linearGradient>
    <radialGradient id="sheen" cx="0.16" cy="0.02" r="0.7">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.2" />
      <stop offset="1" stop-color="#ffffff" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="shade" x1="0.5" y1="1" x2="0.5" y2="0.5">
      <stop offset="0" stop-color="${PALETTE.shade}" stop-opacity="0.46" />
      <stop offset="1" stop-color="${PALETTE.shade}" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="plateRim" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.5" />
      <stop offset="0.45" stop-color="#ffffff" stop-opacity="0.08" />
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.26" />
    </linearGradient>
    <linearGradient id="glassFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.42" />
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.16" />
    </linearGradient>
    <linearGradient id="glassStroke" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="1" />
      <stop offset="0.52" stop-color="#ffffff" stop-opacity="0.5" />
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.8" />
    </linearGradient>
    <filter id="capsuleShadow" x="-30%" y="-45%" width="160%" height="200%">
      <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#04070D" flood-opacity="0.55" />
    </filter>
    <clipPath id="plateClip"><path d="${platePath}" transform="translate(${PLATE_OFFSET} ${PLATE_OFFSET})" /></clipPath>
  </defs>`
}

function iconSvg() {
  const d = squirclePath(PLATE, SQUIRCLE_N)
  const plateRect = `<path d="${d}" transform="translate(${PLATE_OFFSET} ${PLATE_OFFSET})"`
  const washRect = `<rect x="${PLATE_OFFSET}" y="${PLATE_OFFSET}" width="${PLATE}" height="${PLATE}"`
  const halfW = MARK.w / 2
  const halfH = MARK.h / 2
  const r = halfH
  const stroke = 18
  const n = (v) => Number(v).toFixed(1)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
${defs(d)}
  <g clip-path="url(#plateClip)">
    ${plateRect} fill="url(#plate)" />
    ${washRect} fill="url(#glow)" />
    ${washRect} fill="url(#sheen)" />
    ${washRect} fill="url(#specular)" />
    ${washRect} fill="url(#shade)" />
    <path d="${d}" transform="translate(${PLATE_OFFSET} ${PLATE_OFFSET})" fill="none" stroke="url(#plateRim)" stroke-width="7" opacity="0.6" />
  </g>
  <g transform="translate(${PLATE_CENTER} ${PLATE_CENTER})" filter="url(#capsuleShadow)">
    <rect x="${n(-halfW)}" y="${n(-halfH)}" width="${MARK.w}" height="${MARK.h}" rx="${n(r)}" fill="url(#glassFill)" stroke="url(#glassStroke)" stroke-width="${stroke}" />
    <rect x="${n(-halfW + 22)}" y="${n(-halfH + 22)}" width="${MARK.w - 44}" height="${MARK.h - 44}" rx="${n(r - 22)}" fill="none" stroke="#ffffff" stroke-opacity="0.16" stroke-width="3" />
    <path d="M ${n(-halfW + 92)} ${n(-halfH + 12)} H ${n(halfW - 156)}" fill="none" stroke="#ffffff" stroke-opacity="0.4" stroke-width="8" stroke-linecap="round" />
    <line x1="-180" y1="-46" x2="-180" y2="46" stroke="#ffffff" stroke-width="22" stroke-linecap="round" />
    <polyline points="110,30 152,-12 194,30" fill="none" stroke="#ffffff" stroke-width="22" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M -142 74 H 96" fill="none" stroke="#ffffff" stroke-opacity="0.1" stroke-width="10" stroke-linecap="round" />
  </g>
</svg>
`
}

/**
 * 菜单栏图标：macOS 用模板图（只取 alpha 通道，系统按明暗自动反色），
 * 所以这里只要一个纯色字形 + 透明底，颜色本身不参与显示。
 *
 * 尺寸语义：`tray-icon` 会把整图**高度钳到 18pt**、宽度按比例算。
 * 放大镜是方形，所以成品正好 18×18pt（标准菜单栏尺寸）。
 */
function traySvg() {
  const box = magnifierBox()
  const canvas = box / MAGNIFIER.fill // 字形留 10% 余量
  const side = 36 // @2x 下的 18pt
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="${(-canvas / 2).toFixed(1)} ${(-canvas / 2).toFixed(1)} ${canvas.toFixed(1)} ${canvas.toFixed(1)}">${magnifierMarkup(
    { size: box, color: '#000000' },
  )}
</svg>
`
  return { svg, width: side, height: side }
}

/**
 * Windows 托盘图标：同一个放大镜字形，**彩色**。
 *
 * 不能直接用 `tray.png`：那是 macOS 的模板图（只取 alpha，系统按明暗自动反色），
 * Windows 托盘不反色 —— 纯黑字形在深色任务栏上糊成一团，纯白反过来在浅色主题下消失。
 * 用与应用图标同族的蓝→紫渐变，浅色 / 深色任务栏都看得清，字形也与 macOS 菜单栏一致。
 */
function winTraySvg() {
  const box = magnifierBox()
  const canvas = box / MAGNIFIER.fill
  const side = 64 // Windows 托盘最高用到 32px（200% 缩放），留一档余量
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="${(-canvas / 2).toFixed(1)} ${(-canvas / 2).toFixed(1)} ${canvas.toFixed(1)} ${canvas.toFixed(1)}">
<defs>
  <linearGradient id="winTray" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${PALETTE.trayFrom}" />
    <stop offset="1" stop-color="${PALETTE.trayTo}" />
  </linearGradient>
</defs>${magnifierMarkup({ size: box, color: 'url(#winTray)' })}
</svg>
`
  return { svg, width: side, height: side }
}

// ── 光栅化 ───────────────────────────────────────────────────────
function raster(svgPath, outPath, width, height = width) {
  const result = spawnSync(
    'rsvg-convert',
    ['-w', String(width), '-h', String(height), '-o', outPath, svgPath],
    { encoding: 'utf8' },
  )
  if (result.error?.code === 'ENOENT') {
    fail('找不到 rsvg-convert，请先安装：brew install librsvg')
  }
  if (result.status !== 0) fail(`rsvg-convert 失败：${result.stderr || result.status}`)
}

function fail(message) {
  process.stdout.write(`✗ ${message}\n`)
  process.exit(1)
}

function line(text) {
  process.stdout.write(`${text}\n`)
}

// ── 主流程 ───────────────────────────────────────────────────────
fs.mkdirSync(iconsDir, { recursive: true })

const iconSvgPath = path.join(iconsDir, 'icon.svg')
const traySvgPath = path.join(iconsDir, 'tray.svg')
const winTraySvgPath = path.join(iconsDir, 'tray-win.svg')
const tray = traySvg()
const winTray = winTraySvg()
fs.writeFileSync(iconSvgPath, iconSvg())
fs.writeFileSync(traySvgPath, tray.svg)
fs.writeFileSync(winTraySvgPath, winTray.svg)
line(`✓ 矢量源：${path.relative(repoRoot, iconSvgPath)} / tray.svg / tray-win.svg`)

// 1) iconset（iconutil 要求的固定命名）
const iconset = path.join(iconsDir, 'icon.iconset')
fs.rmSync(iconset, { recursive: true, force: true })
fs.mkdirSync(iconset, { recursive: true })
const entries = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]
for (const [name, size] of entries) raster(iconSvgPath, path.join(iconset, name), size)
line(`✓ 光栅化 ${entries.length} 个尺寸`)

// 2) .icns
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(iconsDir, 'icon.icns')])
fs.rmSync(iconset, { recursive: true, force: true })
line('✓ icon.icns')

// 3) 壳运行时用的 PNG（tauri.conf 的 icon 列表 + 托盘：macOS 模板图 / Windows 彩色）
raster(iconSvgPath, path.join(iconsDir, 'icon.png'), 512)
raster(traySvgPath, path.join(iconsDir, 'tray.png'), tray.width, tray.height)
raster(winTraySvgPath, path.join(iconsDir, 'tray-win.png'), winTray.width, winTray.height)
line(`✓ icon.png (512) / tray.png (${tray.width}×${tray.height}) / tray-win.png (${winTray.width}×${winTray.height})`)

// 4) .ico（Windows：窗口图标 / 资源管理器 / NSIS 安装器）
const icoPath = path.join(iconsDir, 'icon.ico')
const icoSizes = [16, 32, 48, 64, 128, 256]
const icoBuffer = packIco(
  icoSizes.map((size) => {
    const file = path.join(iconsDir, `.ico-${size}.png`)
    raster(iconSvgPath, file, size)
    const bytes = fs.readFileSync(file)
    fs.rmSync(file, { force: true })
    return { size, bytes }
  }),
)
fs.writeFileSync(icoPath, icoBuffer)
line(`✓ icon.ico (${icoSizes.join('/')}，PNG-in-ICO)`)
line('\n完成。重新打包：npm run app:local')

/**
 * PNG-in-ICO 封装（ICONDIR + ICONDIRENTRY + 各尺寸 PNG 数据）。
 * 宽/高字段 0 表示 256（1 字节装不下）。
 */
function packIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(images.length, 4)

  const entries = []
  let offset = 6 + images.length * 16
  for (const { size, bytes } of images) {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size
    entry[1] = size >= 256 ? 0 : size
    entry[2] = 0 // 调色板数（真彩为 0）
    entry[3] = 0 // reserved
    entry.writeUInt16LE(1, 4) // planes
    entry.writeUInt16LE(32, 6) // bit count
    entry.writeUInt32LE(bytes.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += bytes.length
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.bytes)])
}
