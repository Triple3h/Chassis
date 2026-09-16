<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import UiDialog from '@shared/ui/UiDialog.vue'
import UiIcon from '@shared/ui/UiIcon.vue'
import { useToast } from '@shared/lib/toast'
import { fileFromDataTransfer, pickFile, readClipboardImage, textFromDataTransfer } from '@shared/lib/clipboard'
import { exec, host, screenshot } from '@launcher/api'
import { decodeQrFromBlob, decodeQrFromVideo, warmupQr } from '../core/qr'
import { isMigrationUri, isOtpAuthUri, parseOtpAuthUri } from '../core/otpauth'
import { parseMigrationUri } from '../core/migration'
import { normalizeAccount, type Account } from '../core/types'

const props = defineProps<{
  existing: Account[]
  /** 从宿主搜索框带进来的 otpauth 链接 / 迁移链接 */
  seed?: string
}>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'import', accounts: Account[]): void }>()

const toast = useToast()
const stage = ref<'idle' | 'decoding' | 'done' | 'error'>('idle')
const hint = ref('')
const rawText = ref('')
const previewUrl = ref('')
const drafts = ref<Partial<Account>[]>([])
const checked = ref<Set<number>>(new Set())
const manual = ref('')
const elapsed = ref(0)
const cameraOn = ref(false)
const videoEl = ref<HTMLVideoElement | null>(null)
const batches = ref(0)

let stream: MediaStream | null = null
let scanTimer = 0
let cameraTimer = 0

const checkedCount = computed(() => checked.value.size)

/** 已存在的账户（按密钥+服务判重） */
function isDuplicate(d: Partial<Account>) {
  return props.existing.some(
    (a) => a.secret === (d.secret ?? '') && (a.issuer || '') === (d.issuer || '') && (a.name || '') === (d.name || ''),
  )
}

function addDrafts(list: Partial<Account>[]) {
  const merged = [...drafts.value]
  let added = 0
  for (const item of list) {
    const account = normalizeAccount(item)
    if (!account.secret) continue
    const dup = merged.some((d) => d.secret === account.secret && (d.issuer ?? '') === account.issuer && (d.name ?? '') === account.name)
    if (dup) continue
    merged.push(account)
    checked.value.add(merged.length - 1)
    added++
  }
  drafts.value = merged
  return added
}

function ingestText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (isMigrationUri(trimmed)) {
    const res = parseMigrationUri(trimmed)
    batches.value = res.batchSize
    const added = addDrafts(res.accounts)
    if (res.batchSize > 1) {
      hint.value = `这是第 ${res.batchIndex + 1}/${res.batchSize} 张二维码，请继续扫描其余图片`
    } else {
      hint.value = added ? `识别成功，共 ${added} 个账户` : '这些账户已经在列表里了'
    }
    return true
  }
  if (isOtpAuthUri(trimmed)) {
    const added = addDrafts([parseOtpAuthUri(trimmed)])
    hint.value = added ? '识别成功' : '该账户已在列表里'
    return true
  }
  if (/^https?:\/\//i.test(trimmed)) {
    hint.value = '这是一个普通网址二维码，不含验证码配置'
    return false
  }
  hint.value = '二维码内容不是 otpauth 配置'
  return false
}

async function handleBlob(blob: Blob) {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = URL.createObjectURL(blob)
  stage.value = 'decoding'
  hint.value = '正在识别二维码…'
  const t0 = performance.now()
  try {
    const outcome = await decodeQrFromBlob(blob)
    elapsed.value = Math.round(performance.now() - t0)
    if (!outcome.hits.length) {
      stage.value = 'error'
      hint.value = '没找到二维码。可以试试：把二维码放大后重新截图、确保没有裁剪边缘、或改用「粘贴链接 / 密钥」'
      return
    }
    let ok = false
    for (const hit of outcome.hits) {
      if (ingestText(hit.text)) ok = true
      else rawText.value = hit.text
    }
    stage.value = ok ? 'done' : 'error'
  } catch (err) {
    stage.value = 'error'
    hint.value = err instanceof Error ? err.message : '识别失败'
  }
}

async function hostScreenshot() {
  hint.value = '等待宿主截图…'
  await screenshot.start()
  // 宿主截图后一般会把图放进系统剪贴板，稍等一下再读
  await new Promise((r) => setTimeout(r, 700))
  const blob = await readClipboardImage()
  if (blob) {
    await handleBlob(blob)
    return
  }
  stage.value = 'idle'
  hint.value = '截图已就绪：按 ⌘V 把截图粘贴进来（或点「粘贴剪贴板」）'
}

async function fromClipboard() {
  stage.value = 'decoding'
  hint.value = '正在读取剪贴板…'
  const blob = await readClipboardImage()
  if (blob) {
    await handleBlob(blob)
    return
  }
  stage.value = 'idle'
  hint.value = '剪贴板里没有图片。可以直接按 ⌘V 粘贴截图，或选择图片文件'
}

async function fromFile() {
  const file = await pickFile('image/*')
  if (file) await handleBlob(file)
}

function onPaste(e: ClipboardEvent) {
  const image = fileFromDataTransfer(e.clipboardData, true)
  if (image) {
    e.preventDefault()
    void handleBlob(image as File)
    return
  }
  const text = textFromDataTransfer(e.clipboardData)
  if (text && (isMigrationUri(text) || isOtpAuthUri(text))) {
    e.preventDefault()
    ingestText(text)
    stage.value = 'done'
  }
}

function onDrop(e: DragEvent) {
  const file = fileFromDataTransfer(e.dataTransfer, true)
  if (!file) return
  e.preventDefault()
  void handleBlob(file as File)
}

/* ------------------------------------------------------- 本地图片（Node 侧） */

/**
 * 浏览器沙箱读不了本地路径，但 `mode: "script"` 的 Node Worker 可以。
 * read-image 脚本负责扫描常见截图目录 / 读取指定路径，把图片转成 base64 交回来。
 */
interface LocalImageInfo {
  path: string
  name: string
  size: number
  mtime: number
  mime: string
}

interface ReadImageResult {
  ok: boolean
  files: Array<LocalImageInfo & { data?: string }>
  dirs: string[]
  error?: string
}

const showLocal = ref(false)
const localBusy = ref(false)
const localFiles = ref<LocalImageInfo[]>([])
const localNote = ref('')
const localPath = ref('')
const localDirs = ref<string[]>([])

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

function fmtTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(ms).toLocaleDateString()
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/** script 命令只在真宿主里跑得起来；浏览器调试时提前说清楚，别让用户白等超时 */
const SCRIPT_HINT = '浏览器调试模式读不了本地路径（需要启动台宿主）；请改用「选择图片」或 ⌘V 粘贴'

async function listLocalImages() {
  showLocal.value = true
  if (!host.isLauncher()) {
    localNote.value = SCRIPT_HINT
    return
  }
  localBusy.value = true
  localNote.value = '正在扫描桌面 / 图片 / 下载目录…'
  const res = (await exec
    .run({ command: 'read-image', args: { listOnly: true, withinMinutes: 120, limit: 8 }, timeoutMs: 12_000 })
    .catch(() => null)) as ReadImageResult | null
  localBusy.value = false
  if (!res) {
    localNote.value = SCRIPT_HINT
    return
  }
  localFiles.value = res.files ?? []
  localDirs.value = res.dirs ?? []
  localNote.value = localFiles.value.length
    ? `最近两小时找到 ${localFiles.value.length} 张图片，点一条即可识别`
    : `最近两小时没在这些目录找到图片：${localDirs.value.join('、') || '（无）'}`
}

async function readLocalPath(filePath: string) {
  const target = filePath.trim()
  if (!target || localBusy.value) return
  if (!host.isLauncher()) {
    localNote.value = SCRIPT_HINT
    return
  }
  localBusy.value = true
  localNote.value = `正在读取 ${target} …`
  const res = (await exec
    .run({ command: 'read-image', args: { path: target }, timeoutMs: 20_000 })
    .catch(() => null)) as ReadImageResult | null
  localBusy.value = false
  if (!res) {
    localNote.value = '读取失败：本地读取需要宿主支持 script 命令'
    return
  }
  if (!res.ok || !res.files?.length) {
    localNote.value = `读取失败：${res.error ?? '未知错误'}`
    return
  }
  const file = res.files[0]
  if (!file.data) {
    localNote.value = '读取失败：返回内容为空'
    return
  }
  localNote.value = `已读取 ${file.name}（${fmtSize(file.size)}）`
  await handleBlob(base64ToBlob(file.data, file.mime))
}

/* --------------------------------------------------------------- 摄像头 */

async function toggleCamera() {
  if (cameraOn.value) {
    stopCamera()
    return
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
  } catch {
    hint.value = '无法访问摄像头（宿主可能未授权）'
    return
  }
  cameraOn.value = true
  hint.value = '把二维码对准摄像头…'
  await warmupQr().catch(() => undefined)
  requestAnimationFrame(() => {
    if (videoEl.value) {
      videoEl.value.srcObject = stream
      void videoEl.value.play()
    }
  })
  cameraTimer = window.setInterval(async () => {
    if (!videoEl.value || stage.value === 'decoding') return
    const hits = await decodeQrFromVideo(videoEl.value).catch(() => [])
    if (!hits.length) return
    stopCamera()
    let ok = false
    for (const hit of hits) if (ingestText(hit.text)) ok = true
    stage.value = ok ? 'done' : 'error'
  }, 350)
}

function stopCamera() {
  cameraOn.value = false
  clearInterval(cameraTimer)
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
}

/* --------------------------------------------------------------- 手动解析 */

function ingestManual() {
  const lines = manual.value.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return
  let ok = 0
  for (const line of lines) {
    if (isMigrationUri(line) || isOtpAuthUri(line)) {
      // 多行时每行独立处理，忽略批次提示
      const before = hint.value
      if (ingestText(line)) ok++
      else hint.value = before
    } else if (/^[A-Za-z2-7][\sA-Za-z2-7-]{15,}$/.test(line)) {
      if (addDrafts([{ secret: line.replace(/[\s-]/g, '').toUpperCase() }])) ok++
    }
  }
  stage.value = ok ? 'done' : 'error'
  hint.value = ok ? `解析出 ${ok} 条配置` : '没能解析出任何配置，请检查链接或密钥'
}

function confirmImport() {
  const list = drafts.value.filter((_, i) => checked.value.has(i))
  if (!list.length) return
  emit('import', list.map((d) => normalizeAccount(d)))
  toast.ok(`已导入 ${list.length} 个账户`)
}

function toggleAll() {
  if (checked.value.size === drafts.value.length) checked.value = new Set()
  else checked.value = new Set(drafts.value.map((_, i) => i))
}

function mask(secret?: string) {
  if (!secret) return ''
  return secret.slice(0, 4) + '···' + secret.slice(-4)
}

onMounted(() => {
  window.addEventListener('paste', onPaste)
  void warmupQr().catch(() => undefined)
  if (props.seed) {
    // 宿主搜索框里粘进来的链接
    manual.value = props.seed
    if (ingestText(props.seed)) stage.value = 'done'
  }
  scanTimer = window.setTimeout(() => {
    if (stage.value === 'idle') hint.value = '推荐流程：宿主的截图（或系统截图）→ 直接 ⌘V 粘贴'
  }, 1200)
})

onUnmounted(() => {
  window.removeEventListener('paste', onPaste)
  clearTimeout(scanTimer)
  stopCamera()
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
})
</script>

<template>
  <UiDialog
    title="导入账户"
    subtitle="支持 Google Authenticator 迁移二维码、otpauth 链接与纯密钥"
    size="wide"
    @close="emit('close')"
  >
    <div class="space-y-3" @drop="onDrop" @dragover.prevent>
      <div class="flex flex-wrap items-center gap-2">
        <button class="launcher-btn primary" @click="hostScreenshot">
          <UiIcon name="camera" :size="13" />宿主截图
        </button>
        <button class="launcher-btn" @click="fromClipboard">
          <UiIcon name="clipboard" :size="13" />粘贴剪贴板
        </button>
        <button class="launcher-btn" @click="fromFile">
          <UiIcon name="folder" :size="13" />选择图片
        </button>
        <button class="launcher-btn" :class="{ primary: showLocal }" @click="listLocalImages">
          <UiIcon name="file" :size="13" />本地图片
        </button>
        <button class="launcher-btn" :class="{ primary: cameraOn }" @click="toggleCamera">
          <UiIcon name="qr" :size="13" />{{ cameraOn ? '停止摄像头' : '摄像头' }}
        </button>
        <span class="ml-auto text-[11.5px] text-faint">
          也可以直接把截图拖进这个窗口，或按 ⌘V 粘贴
        </span>
      </div>

      <!-- 本地文件路径读取：走 script 命令在 Node 侧读盘 -->
      <div v-if="showLocal" class="rounded-lg border border-line">
        <div class="flex items-center gap-2 border-b border-line px-3 py-2 text-[12px]">
          <UiIcon name="file" :size="13" class="text-muted" />
          <span class="font-medium">本地已保存的截图</span>
          <button class="launcher-btn ghost ml-auto !text-[11.5px]" :disabled="localBusy" @click="listLocalImages">
            <UiIcon name="refresh" :size="12" />重新扫描
          </button>
        </div>

        <div v-if="localNote" class="px-3 py-1.5 text-[11.5px]" :class="stage === 'error' ? 'text-danger' : 'text-muted'">
          {{ localNote }}
        </div>

        <div v-if="localFiles.length" class="launcher-scroll max-h-40">
          <button
            v-for="f in localFiles"
            :key="f.path"
            class="flex w-full items-center gap-2 border-b border-line px-3 py-1.5 text-left text-[12px] last:border-0 hover:bg-hover disabled:opacity-50"
            :disabled="localBusy"
            @click="readLocalPath(f.path)"
          >
            <UiIcon name="file" :size="12" class="text-faint" />
            <span class="min-w-0 flex-1 truncate">{{ f.name }}</span>
            <span class="text-faint">{{ fmtTime(f.mtime) }}</span>
            <span class="launcher-chip">{{ fmtSize(f.size) }}</span>
          </button>
        </div>

        <div class="flex items-center gap-2 border-t border-line px-3 py-2">
          <input
            v-model="localPath"
            class="launcher-input flex-1 font-mono !text-[11.5px]"
            placeholder="或直接填绝对路径，如 /Users/你/Desktop/截图.png"
            spellcheck="false"
            @keydown.enter="readLocalPath(localPath)"
          />
          <button class="launcher-btn" :disabled="localBusy || !localPath.trim()" @click="readLocalPath(localPath)">
            <UiIcon name="download" :size="13" />读取
          </button>
        </div>
      </div>

      <p v-if="hint" class="text-[12px]" :class="stage === 'error' ? 'text-danger' : 'text-muted'">
        {{ hint }}
        <span v-if="elapsed && stage === 'done'" class="text-faint">· 识别耗时 {{ elapsed }}ms</span>
      </p>

      <video
        v-if="cameraOn"
        ref="videoEl"
        class="launcher-scan-box h-44 w-full object-cover"
        playsinline
        muted
      />
      <div v-else-if="previewUrl" class="launcher-scan-box flex max-h-44 items-center justify-center overflow-hidden">
        <img :src="previewUrl" alt="待识别图片" class="max-h-44 object-contain" />
      </div>
      <div v-else class="launcher-scan-box launcher-pulse grid h-24 place-items-center text-[12px] text-faint">
        截图 / 图片会显示在这里
      </div>

      <!-- 解析结果 -->
      <div v-if="drafts.length" class="rounded-lg border border-line">
        <div class="flex items-center gap-2 border-b border-line px-3 py-2 text-[12px]">
          <span class="font-medium">待导入 {{ drafts.length }} 个账户</span>
          <span v-if="batches > 1" class="launcher-chip">迁移二维码共 {{ batches }} 张</span>
          <button class="launcher-btn ghost ml-auto !text-[11.5px]" @click="toggleAll">
            {{ checked.size === drafts.length ? '全不选' : '全选' }}
          </button>
        </div>
        <div class="launcher-scroll max-h-52">
          <label
            v-for="(d, i) in drafts"
            :key="i"
            class="launcher-row flex cursor-pointer items-center gap-2 border-b border-line px-3 py-2 last:border-0 hover:bg-hover"
          >
            <input
              type="checkbox"
              :checked="checked.has(i)"
              @change="checked.has(i) ? checked.delete(i) : checked.add(i)"
            />
            <span class="min-w-0 flex-1 truncate">
              <span class="text-[13px] font-medium">{{ d.issuer || '未命名服务' }}</span>
              <span v-if="d.name" class="ml-2 text-[12px] text-muted">{{ d.name }}</span>
            </span>
            <span class="launcher-chip">{{ d.type === 'hotp' ? 'HOTP' : 'TOTP' }}</span>
            <span class="launcher-chip">{{ d.digits !== 8 ? 6 : 8 }} 位</span>
            <span class="launcher-code text-[11.5px] text-faint">{{ mask(d.secret) }}</span>
            <span v-if="isDuplicate(d)" class="launcher-chip !text-warn">已存在</span>
          </label>
        </div>
      </div>

      <!-- 兜底：手动粘贴 -->
      <details class="rounded-lg border border-line px-3 py-2">
        <summary class="cursor-pointer text-[12px] text-muted">识别不到？粘贴链接或密钥</summary>
        <textarea
          v-model="manual"
          class="launcher-input launcher-scroll mt-2 h-20 resize-none font-mono"
          spellcheck="false"
          placeholder="otpauth://totp/... 或 otpauth-migration://offline?data=... 或 JBSWY3DPEHPK3PXP（可多行）"
        />
        <button class="launcher-btn mt-2" @click="ingestManual">解析</button>
        <span v-if="rawText" class="mt-2 block truncate font-mono text-[11px] text-faint">上一次识别到：{{ rawText }}</span>
      </details>
    </div>

    <template #footer>
      <span class="text-[11.5px] text-faint">
        密钥仅保存在本机插件数据目录（<code class="font-mono">storage.json</code>）
      </span>
      <div class="ml-auto flex items-center gap-2">
        <button class="launcher-btn" @click="emit('close')">取消</button>
        <button class="launcher-btn primary" :disabled="!checkedCount" @click="confirmImport">
          <UiIcon name="check" :size="13" />导入 {{ checkedCount }} 个
        </button>
      </div>
    </template>
  </UiDialog>
</template>
