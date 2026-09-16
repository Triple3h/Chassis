import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

/**
 * 二维码识别（zxing-cpp 编译成 wasm）。
 *
 * 为什么不是 jsQR：Google Authenticator 的迁移二维码装了整张账户表，
 * 版本通常在 20 以上、码点密集，jsQR 这类纯 JS 实现在这种码上翻车率明显偏高；
 * zxing-wasm 是 C++ 实现，同一张图通常 50~150ms 出结果。
 *
 * 离线要求：zxing-wasm 默认会去 jsDelivr 拉 wasm，插件必须自带，
 * 因此这里用 `?url` 让 Vite 把 zxing_reader.wasm 作为资源打进 dist，
 * 再以 ArrayBuffer 形式喂给 Emscripten（顺带绕开 instantiateStreaming 的 MIME 坑）。
 */

type ZXingOverrides = NonNullable<Parameters<typeof prepareZXingModule>[0]>['overrides']

let initPromise: Promise<void> | null = null

/** 预热解码引擎（进页面就可以调，等真正截图时已经热好） */
export function warmupQr(): Promise<void> {
  initPromise ??= (async () => {
    const res = await fetch(wasmUrl)
    if (!res.ok) throw new Error(`解码引擎资源缺失：HTTP ${res.status}`)
    const wasmBinary = await res.arrayBuffer()
    await prepareZXingModule({
      overrides: { wasmBinary, locateFile: () => wasmUrl } as ZXingOverrides,
      fireImmediately: true,
    })
  })().catch((err) => {
    initPromise = null
    throw err
  })
  return initPromise
}

export interface QrHit {
  text: string
  /** 码在图片中的大致位置，多码时用来排序 */
  x: number
  y: number
}

const READ_OPTIONS = {
  formats: ['QRCode'] as const,
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  maxNumberOfSymbols: 8,
}

async function readAll(input: Blob | ImageData): Promise<QrHit[]> {
  const results = await readBarcodes(input as Blob, READ_OPTIONS as never)
  const hits: QrHit[] = []
  for (const r of results) {
    if (!r.text) continue
    if ('isValid' in r && r.isValid === false) continue
    const pos = (r as { position?: { topLeft?: { x: number; y: number } } }).position
    hits.push({ text: r.text, x: pos?.topLeft?.x ?? 0, y: pos?.topLeft?.y ?? 0 })
  }
  hits.sort((a, b) => a.y - b.y || a.x - b.x)
  return hits
}

function canvasToImageData(canvas: HTMLCanvasElement): ImageData {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建绘图上下文')
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

/** 把图片按最长边缩放后绘制到 canvas，返回 ImageData */
export async function blobToImageData(blob: Blob, maxSide = 2400): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建绘图上下文')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()
  return canvasToImageData(canvas)
}

/** 放大一版：小截图里的二维码放大后再识别，命中率更高 */
export async function blobToImageDataScaled(blob: Blob, side: number): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob)
  const scale = side / Math.max(bitmap.width, bitmap.height)
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建绘图上下文')
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()
  return canvasToImageData(canvas)
}

export interface DecodeOutcome {
  hits: QrHit[]
  /** 尝试次数，用于 UI 反馈 */
  attempts: number
  /** 图片尺寸，用于提示 */
  size: string
}

/**
 * 多轮识别：先用缩放版快速试一次，不中再上原图与放大图。
 * 绝大多数截图第一轮就出结果，整体耗时仍在 100ms 量级。
 */
export async function decodeQrFromBlob(blob: Blob): Promise<DecodeOutcome> {
  await warmupQr()
  let attempts = 0
  let size = ''
  const tryOnce = async (input: Blob | ImageData) => {
    attempts++
    return readAll(input)
  }

  // 第一轮：原始文件直接交给 zxing（它内部自带降采样/旋转/反色尝试）
  let hits = await tryOnce(blob)
  if (hits.length) return { hits, attempts, size }

  // 第二轮：统一缩放到 2000px，避免超大截图拖慢局部二值化
  const imageData = await blobToImageData(blob, 2000)
  size = `${imageData.width}×${imageData.height}`
  hits = await tryOnce(imageData)
  if (hits.length) return { hits, attempts, size }

  // 第三轮：放大到 1600px，救小图
  const scaled = await blobToImageDataScaled(blob, 1600)
  hits = await tryOnce(scaled)
  return { hits, attempts, size }
}

/** 摄像头取帧识别 */
export async function decodeQrFromVideo(video: HTMLVideoElement): Promise<QrHit[]> {
  await warmupQr()
  const w = video.videoWidth
  const h = video.videoHeight
  if (!w || !h) return []
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return []
  ctx.drawImage(video, 0, 0, w, h)
  return readAll(canvasToImageData(canvas))
}
