import { IMAGE_MAX_CHARS } from './types'

/** data URL → Blob（复制到剪贴板 / 另存为都要它）；形状不对返回 null */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl)
  if (!match) return null
  const mime = match[1] || 'image/png'
  const payload = match[3] ?? ''
  if (match[2] !== ';base64') {
    try {
      return new Blob([decodeURIComponent(payload)], { type: mime })
    } catch {
      return null
    }
  }
  try {
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return new Blob([bytes], { type: mime })
  } catch {
    return null
  }
}

export function isImageDataUrl(value: string): boolean {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value)
}

export function imageTooLarge(dataUrl: string): boolean {
  return dataUrl.length > IMAGE_MAX_CHARS
}

/** 把图片快贴按 data URL 的扩展名另存为文件（复制图片失败时的兜底路径） */
export function imageFileName(title: string, dataUrl: string, stamp?: string): string {
  const ext = /^data:image\/([a-z0-9.+-]+)/i.exec(dataUrl)?.[1]?.replace('jpeg', 'jpg') ?? 'png'
  const safe = title.replace(/[\\/:*?"<>|]/g, '_').trim() || '快贴图片'
  return stamp ? `${safe}-${stamp}.${ext}` : `${safe}.${ext}`
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(blob)
  })
}
