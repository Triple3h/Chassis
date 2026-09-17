<script setup lang="ts">
import { computed, ref } from 'vue'
import UiDialog from '@launcher/ui/UiDialog.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import UiSelect from '@launcher/ui/UiSelect.vue'
import { useToast } from '@launcher/ui/toast'
import { fileFromDataTransfer, pickFile, readClipboardText } from '@launcher/ui/clipboard'
import { clipboard as hostClipboard, host } from '@launcher/api'
import type { Snip, SnipKind } from '../core/types'
import type { SnipInput } from '../core/snips'
import { LANG_PRESETS, defaultTitle, guessLang, looksLikeCode } from '../core/snips'
import { blobToDataUrl, imageTooLarge, isImageDataUrl } from '../core/images'

const props = defineProps<{ snip: Snip | null; preset: SnipInput | null }>()
const emit = defineEmits<{ close: []; save: [input: SnipInput] }>()

const editing = props.snip
const preset = props.preset
const kind = ref<SnipKind>(editing?.kind ?? preset?.kind ?? 'text')
const title = ref(editing?.title ?? preset?.title ?? '')
const content = ref(editing?.content ?? preset?.content ?? '')
const lang = ref(editing?.lang ?? preset?.lang ?? 'text')
const toast = useToast()

const isImage = computed(() => kind.value === 'image')
const kindTabs: Array<{ value: SnipKind; label: string; icon: string }> = [
  { value: 'text', label: '文本', icon: 'file' },
  { value: 'code', label: '代码', icon: 'braces' },
  { value: 'image', label: '图片', icon: 'image' },
]
const langOptions = LANG_PRESETS.map((value) => ({ value, label: value }))
const preview = computed(() => (isImage.value ? content.value : ''))

function setKind(next: SnipKind): void {
  if (next === kind.value) return
  // 图片与文本是两种完全不同的载体，切过去就清空正文，避免留下半截看不懂的内容
  if ((next === 'image') !== (kind.value === 'image')) content.value = ''
  kind.value = next
  if (next === 'code' && lang.value === 'text') lang.value = guessLang(content.value) ?? 'bash'
}

async function fromClipboardText(): Promise<void> {
  let text = ''
  if (host.isLauncher()) text = await hostClipboard.readText().catch(() => '')
  if (!text) text = (await readClipboardText()) ?? ''
  if (!text) {
    toast.err('读不到剪贴板内容（未授权或为空）')
    return
  }
  content.value = text
  if (!title.value) title.value = defaultTitle(text, kind.value)
  if (kind.value === 'text' && looksLikeCode(text)) {
    kind.value = 'code'
    lang.value = guessLang(text) ?? 'bash'
  }
}

async function useBlob(blob: Blob, name?: string): Promise<void> {
  const dataUrl = await blobToDataUrl(blob).catch(() => '')
  if (!dataUrl) {
    toast.err('读取图片失败')
    return
  }
  if (imageTooLarge(dataUrl)) {
    toast.err('图片太大（约 1 MB 上限），请先压缩再存')
    return
  }
  kind.value = 'image'
  content.value = dataUrl
  if (!title.value) title.value = name ? name.replace(/\.[a-z0-9]+$/i, '') : '图片快贴'
}

async function pickImage(): Promise<void> {
  const file = await pickFile('image/*')
  if (file) await useBlob(file, file.name)
}

async function fromClipboardImage(): Promise<void> {
  // 浏览器剪贴板读图（iframe 已拿到 clipboard-read 授权），失败就引导走文件选择
  try {
    const items = (await navigator.clipboard?.read()) ?? []
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (type) {
        await useBlob(await item.getType(type))
        return
      }
    }
  } catch {
    /* 落到下面的提示 */
  }
  toast.info('剪贴板里没有图片，可直接拖入或选择文件')
}

async function onDrop(event: DragEvent): Promise<void> {
  const file = fileFromDataTransfer(event.dataTransfer, true)
  if (file instanceof File) await useBlob(file, file.name)
  else if (file) await useBlob(file)
}

async function onPaste(event: ClipboardEvent): Promise<void> {
  if (!isImage.value) return
  const file = fileFromDataTransfer(event.clipboardData, true)
  if (!file) return
  event.preventDefault()
  if (file instanceof File) await useBlob(file, file.name)
  else await useBlob(file)
}

function submit(): void {
  if (!content.value) {
    toast.err(isImage.value ? '还没有选择图片' : '内容不能为空')
    return
  }
  if (isImage.value && !isImageDataUrl(content.value)) {
    toast.err('图片内容无效，请重新选择')
    return
  }
  emit('save', {
    kind: kind.value,
    title: title.value.trim(),
    content: content.value,
    ...(kind.value === 'code' && lang.value ? { lang: lang.value } : {}),
  })
}
</script>

<template>
  <UiDialog :title="editing ? '编辑快贴' : '新建快贴'" :subtitle="editing ? editing.title : '收藏常用文本 / 代码 / 图片'" size="wide" @close="emit('close')">
    <div class="flex flex-col gap-2.5">
      <div class="flex items-center gap-1.5">
        <button
          v-for="tab in kindTabs"
          :key="tab.value"
          class="launcher-btn ghost"
          :class="kind === tab.value ? 'bg-active text-accent' : ''"
          @click="setKind(tab.value)"
        >
          <UiIcon :name="tab.icon" :size="13" />
          {{ tab.label }}
        </button>
        <div class="ml-auto flex items-center gap-1.5">
          <button v-if="!isImage" class="launcher-btn ghost" @click="fromClipboardText">
            <UiIcon name="clipboard" :size="13" />
            读剪贴板
          </button>
          <template v-else>
            <button class="launcher-btn ghost" @click="fromClipboardImage">
              <UiIcon name="clipboard" :size="13" />
              读剪贴板
            </button>
            <button class="launcher-btn ghost" @click="pickImage">
              <UiIcon name="upload" :size="13" />
              选择图片
            </button>
          </template>
        </div>
      </div>

      <input v-model="title" class="launcher-input" placeholder="标题（留空自动取首行）" />

      <div v-if="!isImage" class="flex flex-col gap-2.5">
        <textarea
          v-model="content"
          class="launcher-input snips-code h-[190px] resize-none"
          :placeholder="kind === 'code' ? '粘贴代码片段…' : '粘贴要收藏的文本…'"
        />
        <div v-if="kind === 'code'" class="flex items-center gap-2">
          <span class="text-[11.5px] text-muted">语言标签</span>
          <div class="w-[150px]">
            <UiSelect :model-value="lang" :options="langOptions" @update:model-value="(value) => (lang = String(value))" />
          </div>
          <span class="text-[11px] text-faint">仅用于展示与检索</span>
        </div>
      </div>

      <div
        v-else
        class="flex h-[190px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-linestrong bg-panel2"
        @dragover.prevent
        @drop.prevent="onDrop"
        @paste="onPaste"
      >
        <img v-if="preview" :src="preview" class="max-h-[140px] max-w-full rounded" alt="" />
        <template v-else>
          <UiIcon name="image" :size="26" class="text-faint" />
          <p class="text-[12px] text-faint">拖入图片 / 选择文件 / 剪贴板读图</p>
        </template>
        <p v-if="preview" class="text-[11px] text-faint">已就绪，约 {{ Math.round(preview.length / 1024) }} KB</p>
      </div>
    </div>

    <template #footer>
      <button class="launcher-btn ghost" @click="emit('close')">取消</button>
      <button class="launcher-btn primary" @click="submit">
        <UiIcon name="check" :size="13" />
        保存
      </button>
    </template>
  </UiDialog>
</template>
