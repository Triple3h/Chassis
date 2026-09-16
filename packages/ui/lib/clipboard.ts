/**
 * 剪贴板读写。
 *
 * 插件运行在 iframe 里（宿主用本地 HTTP 服务托管，属于 secure context），
 * Chromium / WebKit 下 `navigator.clipboard` 基本可用；仍旧实现三级兜底：
 *   1. navigator.clipboard（异步，需要用户手势）
 *   2. document.execCommand('copy')（同步，兼容老 WebView）
 *   3. 手动选中隐藏 textarea，让用户自己按 Cmd+C
 */

/** 复制纯文本，返回是否成功 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 继续兜底 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** 读取剪贴板文本（可能因权限被拒） */
export async function readClipboardText(): Promise<string | null> {
  try {
    return (await navigator.clipboard?.readText()) ?? null
  } catch {
    return null
  }
}

/** 读取剪贴板中的图片（可能因权限被拒） */
export async function readClipboardImage(): Promise<Blob | null> {
  try {
    const items = (await navigator.clipboard?.read()) ?? []
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (type) return await item.getType(type)
    }
  } catch {
    /* 权限被拒或宿主未授权 */
  }
  return null
}

/** 弹出系统文件选择器 */
export function pickFile(accept = '*/*'): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    input.onchange = () => {
      resolve(input.files?.[0] ?? null)
      input.remove()
    }
    // 用户取消时不会触发 change，这里不阻塞流程
    document.body.appendChild(input)
    input.click()
  })
}

/** 从拖拽事件里取出第一个文件；imageOnly 时只接受图片 */
export function fileFromDataTransfer(dt: DataTransfer | null, imageOnly = false): File | Blob | null {
  if (!dt) return null
  const ok = (type: string) => !imageOnly || type.startsWith('image/')
  for (const file of Array.from(dt.files ?? [])) {
    if (ok(file.type)) return file
  }
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file' && ok(item.type)) {
      const f = item.getAsFile()
      if (f) return f
    }
  }
  return null
}

/** 从粘贴事件里取出纯文本 */
export function textFromDataTransfer(dt: DataTransfer | null): string {
  if (!dt) return ''
  return dt.getData('text/plain') || dt.getData('text') || ''
}

/** 触发浏览器下载 */
export function downloadBlob(filename: string, content: string | Blob, mime = 'text/plain;charset=utf-8') {
  const blob = typeof content === 'string' ? new Blob([content], { type: mime }) : content
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(url)
    a.remove()
  }, 1000)
}
