#!/usr/bin/env node
/**
 * 生成应用图标（矢量源 → 多尺寸 PNG → .icns）。
 *
 * 为什么要脚本而不是塞一张位图：图标要出现在 16px（Finder 列表）到 1024px（预览）之间，
 * 手工放一张位图在高分屏 / 小尺寸下都会糊。这里用 SVG 作为唯一源，任何尺寸都是重绘。
 *
 * 两个字形：
 *   应用图标 = 「输入框」（胶囊外框 + 文字光标 + 上箭头），即"输入即搜、回车即启"
 *   菜单栏   = 放大镜（18pt 下输入框的内里会糊，放大镜轮廓更清楚）
 *
 * 依赖：rsvg-convert（brew install librsvg）、iconutil（macOS 自带）
 * 用法：npm run icon
 * 产物：apps/shell/icons/{icon.svg, icon.png, icon.icns, tray.svg, tray.png}
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

// 蓝 → 靛 → 亮紫，方向为左下 → 右上（与 launcher-ui 的强调色同一族，但更深）
const PALETTE = {
  from: '#1C5CF5', // 左下：蓝
  mid: '#5B34E8', // 中段：靛
  to: '#A32BEE', // 右上：亮紫
  glow: '#C558FF', // 右上角高光
  shade: '#0C1250', // 底部压暗
}

const MARK = { w: 420, h: 175 } // 应用图标字形（宽 51% / 高 21% 图稿）

/**
 * 菜单栏字形：放大镜 —— **刻意与应用图标不同**。
 * 应用图标那个「输入框」在 18pt 下内里的光标/箭头会糊掉，放大镜的轮廓干净得多。
 * 值是以环心为原点的绝对坐标（字形框边长 = to·u + r + stroke）。
 */
const MAGNIFIER = { r: 148, stroke: 78, from: 140, to: 262, fill: 0.9 }

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

/**
 * 字形几何。全部尺寸由胶囊高度 `h` 推导，所以整组缩放时比例不变。
 * 坐标以胶囊中心为原点，调用方负责 translate。
 *
 * 关键：光标与箭头按**内孔**（扣掉描边后的可用区域）定位，不能按外框宽度 ——
 * 否则胶囊一变窄（菜单栏那版），光标就贴到边框上，视觉上和边框糊成一体。
 */
function markGeometry(w, h, lineScale = 0.14) {
  const stroke = h * 0.195
  const frameW = w - stroke // 描边中线框：外扩 stroke/2 后正好是 w × h
  const frameH = h - stroke
  return {
    stroke,
    line: h * lineScale,
    capsule: { w: frameW, h: frameH, r: frameH / 2 },
    caret: { x: -frameW / 2 + frameH * 0.47, half: frameH * 0.3 },
    chevron: {
      apex: [frameW / 2 - frameH * 0.72, -frameH * 0.13],
      arm: [frameH * 0.26, frameH * 0.24],
    },
  }
}

function markMarkup({ w, h, color, shadow, lineScale }) {
  const g = markGeometry(w, h, lineScale)
  const [ax, ay] = g.chevron.apex
  const [dx, dy] = g.chevron.arm
  const n = (v) => v.toFixed(1)
  return `
  <g${shadow ? ' filter="url(#markShadow)"' : ''} fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round">
    <rect x="${n(-g.capsule.w / 2)}" y="${n(-g.capsule.h / 2)}" width="${n(g.capsule.w)}" height="${n(g.capsule.h)}" rx="${n(g.capsule.r)}" stroke-width="${n(g.stroke)}" />
    <line x1="${n(g.caret.x)}" y1="${n(-g.caret.half)}" x2="${n(g.caret.x)}" y2="${n(g.caret.half)}" stroke-width="${n(g.line)}" />
    <polyline points="${n(ax - dx)},${n(ay + dy)} ${n(ax)},${n(ay)} ${n(ax + dx)},${n(ay + dy)}" stroke-width="${n(g.line)}" />
  </g>`
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
    <linearGradient id="plate" x1="0.1" y1="0.95" x2="0.78" y2="0.02">
      <stop offset="0" stop-color="${PALETTE.from}" />
      <stop offset="0.5" stop-color="${PALETTE.mid}" />
      <stop offset="1" stop-color="${PALETTE.to}" />
    </linearGradient>
    <radialGradient id="glow" cx="0.88" cy="0.1" r="0.72">
      <stop offset="0" stop-color="${PALETTE.glow}" stop-opacity="0.6" />
      <stop offset="1" stop-color="${PALETTE.glow}" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="sheen" cx="0.18" cy="0.04" r="0.8">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22" />
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.05" />
      <stop offset="1" stop-color="#ffffff" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="shade" x1="0.5" y1="1" x2="0.5" y2="0.45">
      <stop offset="0" stop-color="${PALETTE.shade}" stop-opacity="0.34" />
      <stop offset="1" stop-color="${PALETTE.shade}" stop-opacity="0" />
    </linearGradient>
    <filter id="markShadow" x="-30%" y="-50%" width="160%" height="200%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#1B0B63" flood-opacity="0.42" />
    </filter>
    <clipPath id="plateClip"><path d="${platePath}" transform="translate(${PLATE_OFFSET} ${PLATE_OFFSET})" /></clipPath>
  </defs>`
}

function iconSvg() {
  const d = squirclePath(PLATE, SQUIRCLE_N)
  const plateRect = `<path d="${d}" transform="translate(${PLATE_OFFSET} ${PLATE_OFFSET})"`
  const washRect = `<rect x="${PLATE_OFFSET}" y="${PLATE_OFFSET}" width="${PLATE}" height="${PLATE}"`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
${defs(d)}
  <g clip-path="url(#plateClip)">
    ${plateRect} fill="url(#plate)" />
    ${washRect} fill="url(#glow)" />
    ${washRect} fill="url(#sheen)" />
    ${washRect} fill="url(#shade)" />
  </g>
  <g transform="translate(${PLATE_CENTER} ${PLATE_CENTER})">${markMarkup({
    w: MARK.w,
    h: MARK.h,
    color: '#ffffff',
    shadow: true,
  })}
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
const tray = traySvg()
fs.writeFileSync(iconSvgPath, iconSvg())
fs.writeFileSync(traySvgPath, tray.svg)
line(`✓ 矢量源：${path.relative(repoRoot, iconSvgPath)} / tray.svg`)

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

// 3) 壳运行时用的 PNG（tauri.conf 的 icon 列表 + 菜单栏）
raster(iconSvgPath, path.join(iconsDir, 'icon.png'), 512)
raster(traySvgPath, path.join(iconsDir, 'tray.png'), tray.width, tray.height)
line(`✓ icon.png (512) / tray.png (${tray.width}×${tray.height})`)
line('\n完成。重新打包：npm run app:local')
