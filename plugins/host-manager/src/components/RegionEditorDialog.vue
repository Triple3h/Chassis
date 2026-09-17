<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import UiDialog from '@launcher/ui/UiDialog.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import { copyText, readClipboardText } from '@launcher/ui/clipboard'
import { useToast } from '@launcher/ui/toast'
import type { Block } from '../core/blocks'
import { runParseRegion } from '../core/runner'

/**
 * 批量编辑：把**整个托管区**当一段文本改。
 *
 * 块列表视图适合日常增删条目；要一次动很多块（改块名、调顺序、整块开关、
 * 把文档里的一整套配置粘进来）就该用文本：这里所见即托管区的全部内容，
 * 提交后整体替换；区外的行（系统行 / VPN 自己加的）不参与、也不会被碰到。
 *
 * 语法与文件里的一模一样（`core/blocks.ts` 的行模型），边打边解析：
 *   `# @block 名字` … `# @/block` 一个块；块名后加 `| off` 关掉整块；
 *   行首 `#` 注释掉单条（导入时按「禁用条目」认）。
 */
const props = defineProps<{
  /** 当前托管区文本（含首尾标记），打开时预填 */
  region: string
  eol: '\n' | '\r\n'
  sep: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'submit', payload: { blocks: Block[] }): void
}>()

const text = ref(props.region)
const blocks = shallowRef<Block[]>([])
const parsing = ref(false)
const toast = useToast()

let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null

/** 解析结果只认最后一次：边打边解析时，早发出的请求可能后回来 */
async function reparse() {
  const token = ++seq
  parsing.value = true
  const parsed = await runParseRegion(text.value, props.eol, props.sep)
  if (token !== seq) return
  blocks.value = parsed
  parsing.value = false
}

function schedule() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void reparse(), 250)
}

watch(text, schedule)
onMounted(() => void reparse())

const stats = computed(() => {
  let entries = 0
  let off = 0
  for (const block of blocks.value) {
    entries += entryCount(block)
    if (!block.enabled) off++
  }
  return { blocks: blocks.value.length, entries, off }
})

/** 文本里有没有块标记 —— 没有的话所有记录会收进一个「未分组」块，得先提醒 */
const hasMarker = computed(() => /^\s*#\s*@block\s+\S/m.test(text.value))
const preview = computed(() => blocks.value.slice(0, 8))

function entryCount(block: Block): number {
  return block.body.lines.filter((line) => line.kind === 'entry').length
}

function reset() {
  text.value = props.region
}

async function pullFromClipboard() {
  const fromClipboard = await readClipboardText()
  if (!fromClipboard?.trim()) {
    toast.err('剪贴板里没有文本（宿主可能未授权读取）')
    return
  }
  text.value = fromClipboard
  toast.ok('已读取剪贴板')
}

async function copyInput() {
  if (await copyText(text.value)) toast.ok('已复制')
  else toast.err('复制失败，请手动选择')
}

function submit() {
  if (!blocks.value.length) return
  emit('submit', { blocks: blocks.value })
}
</script>

<template>
  <UiDialog
    title="批量编辑托管区"
    subtitle="整个托管区一次改完；保存后才写进系统文件，区外的行不参与"
    size="wide"
    @close="emit('close')"
  >
    <div class="flex flex-col gap-3">
      <textarea
        v-model="text"
        class="launcher-input launcher-mono h-64 resize-none leading-[18px]"
        placeholder="# @block 开发环境
10.0.0.1	dev.example.com	# 主站
10.0.0.2	api.example.com
# @/block
# @block 备用线路 | off
# 10.0.0.9	backup.example.com
# @/block"
        spellcheck="false"
      />

      <div class="flex flex-wrap items-center gap-2 text-[12px]">
        <button class="launcher-btn" @click="reset">
          <UiIcon name="refresh" :size="12" /> 还原为当前内容
        </button>
        <button class="launcher-btn" @click="pullFromClipboard">
          <UiIcon name="clipboard" :size="12" /> 从剪贴板读取
        </button>
        <div class="flex-1" />
        <span class="launcher-chip" :class="{ 'text-warn': parsing }">
          {{ parsing ? '解析中…' : `${stats.blocks} 个块 · ${stats.entries} 条` }}
        </span>
        <span v-if="stats.off" class="launcher-chip text-faint">{{ stats.off }} 个块已关闭</span>
      </div>

      <div v-if="preview.length" class="launcher-scroll max-h-32 rounded-lg border border-line bg-panel2 p-2">
        <div v-for="block in preview" :key="block.id" class="flex items-center gap-2 py-0.5 text-[11.5px]">
          <UiIcon :name="block.enabled ? 'check' : 'minus'" :size="11" :class="block.enabled ? 'text-accent' : 'text-faint'" />
          <span class="min-w-0 flex-1 truncate" :class="block.enabled ? '' : 'text-faint'">{{ block.name }}</span>
          <span class="shrink-0 text-faint">{{ entryCount(block) }} 条</span>
        </div>
        <div v-if="blocks.length > preview.length" class="pt-1 text-[11.5px] text-faint">
          …还有 {{ blocks.length - preview.length }} 个块
        </div>
      </div>

      <div v-if="!blocks.length" class="rounded-lg border border-line bg-panel2 p-2.5 text-[11.5px] text-warn">
        这里至少要有一个块才能提交；想清空托管区请用左侧的「删除块」。
      </div>
      <div
        v-else-if="!hasMarker && text.trim()"
        class="rounded-lg border border-line bg-panel2 p-2.5 text-[11.5px] text-muted"
      >
        没有 <span class="launcher-mono"># @block 名字</span> 标记，所有记录会收进一个「未分组」块。
      </div>

      <div class="text-[11.5px] leading-relaxed text-muted">
        <span class="launcher-mono"># @block 名字</span> … <span class="launcher-mono"># @/block</span> 包住一个块；
        块名后加 <span class="launcher-mono">| off</span> 关掉整块；行首 <span class="launcher-mono">#</span> 注释掉单条，
        导入时按「禁用条目」认。
      </div>
    </div>

    <template #footer>
      <button class="launcher-btn" @click="copyInput">
        <UiIcon name="copy" :size="12" /> 复制内容
      </button>
      <div class="flex-1" />
      <button class="launcher-btn" @click="emit('close')">取消</button>
      <button class="launcher-btn primary" :disabled="!blocks.length" @click="submit">
        替换为 {{ stats.blocks }} 个块
      </button>
    </template>
  </UiDialog>
</template>
