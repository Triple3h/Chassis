<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef, watch } from 'vue'
import UiDialog from '@launcher/ui/UiDialog.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import { copyText } from '@launcher/ui/clipboard'
import { useToast } from '@launcher/ui/toast'
import { useVirtualList } from '@launcher/ui/virtual'
import type { DiffResult } from '../core/hosts'
import { runDiffLines } from '../core/runner'
import type { HostsWriteResult } from '../core/script-types'

/**
 * 写入预览。
 * 确认前先让用户看清「哪些行会进去、哪些行会没」，写入失败（提权不可用）时
 * 同一个弹窗切成手工指引，给出可复制的命令与待生效文件路径。
 */
const props = defineProps<{
  prevText: string
  nextText: string
  path: string
  writable: boolean
  platform: string
  phase: 'preview' | 'writing' | 'manual' | 'done'
  result: HostsWriteResult | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'confirm', payload: { remember: boolean }): void
}>()

const diff = shallowRef<DiffResult | null>(null)
const scroller = ref<HTMLElement | null>(null)
const toast = useToast()

/**
 * 「以后不再询问」：这次授权的同时把 hosts 的写权限授给当前账户（ACL），
 * 之后保存直接写入、不再弹授权框。仅在当前不可写时才有意义，默认勾上 ——
 * 用户来做这一步就是嫌每次弹窗（要的就是「一次授权、长期免授权」）；
 * 不想开就取消勾选，行为与以前完全一致。
 */
const remember = ref(true)

const rows = computed(() => diff.value?.rows ?? [])
const count = computed(() => rows.value.length)

const { startIndex, endIndex, offsetY, totalHeight, scrollToIndex } = useVirtualList(scroller, {
  count,
  rowHeight: 20,
})

const window$ = computed(() => rows.value.slice(startIndex.value, endIndex.value))

function mark(kind: string): string {
  if (kind === 'add') return '+'
  if (kind === 'del') return '−'
  return ' '
}

async function computeDiff(text: string) {
  const res = await runDiffLines(props.prevText, text)
  diff.value = res
  await nextTick()
  const first = res.rows.findIndex((r) => r.kind !== 'same')
  if (first > 0) scrollToIndex(first, 'center')
}

onMounted(() => void computeDiff(props.nextText))
watch(() => props.nextText, (text) => void computeDiff(text))

async function copyAll() {
  if (await copyText(props.nextText)) toast.ok('已复制完整内容，可自行粘贴到编辑器')
  else toast.err('复制失败，请手动选择')
}

async function copyCommand() {
  const command = props.result?.command ?? ''
  if (!command) return
  if (await copyText(command)) toast.ok('命令已复制，粘到终端执行即可')
  else toast.err('复制失败，请手动选择')
}
</script>

<template>
  <UiDialog
    :title="phase === 'manual' ? '需要手动执行一次' : '写入预览'"
    :subtitle="path"
    size="wide"
    @close="emit('close')"
  >
    <!-- 提权不可用：给出可复制的命令 -->
    <div v-if="phase === 'manual'" class="flex flex-col gap-3">
      <div class="rounded-lg border border-line bg-panel2 p-3 text-[12.5px] leading-relaxed">
        <div class="flex items-center gap-2 text-warn">
          <UiIcon name="alert" :size="14" />
          <span>{{ result?.error || '自动提权没能完成' }}</span>
        </div>
        <div class="mt-2 text-muted">
          内容已经写好放在插件数据目录里了，执行下面这条命令即可生效（会要求输入密码）：
        </div>
      </div>

      <div class="launcher-mono launcher-scroll max-h-24 rounded-lg border border-line bg-bg p-2.5 text-[11.5px] break-all">
        {{ result?.command }}
      </div>

      <div class="text-[11.5px] text-muted">
        待生效文件：<span class="launcher-mono">{{ result?.pendingPath }}</span>
      </div>

      <div class="rounded-lg border border-line bg-panel2 p-3 text-[12px] leading-relaxed text-muted">
        Windows 上请用「以管理员身份运行」打开 PowerShell 再执行；
        macOS / Linux 直接粘到终端即可。<br />
        也可以点下面的「复制完整内容」，自己打开 hosts 文件全选粘贴。
      </div>
    </div>

    <!-- 正常预览 -->
    <div v-else class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-2 text-[12px]">
        <span v-if="diff" class="launcher-chip text-addfg">+{{ diff.added }}</span>
        <span v-if="diff" class="launcher-chip text-delfg">−{{ diff.removed }}</span>
        <span class="text-muted">{{ rows.length }} 行</span>
        <div class="flex-1" />
        <span v-if="!writable" class="launcher-chip">
          <UiIcon name="lock" :size="11" />
          需要管理员授权
        </span>
      </div>

      <div ref="scroller" class="launcher-scroll h-72 rounded-lg border border-line bg-bg">
        <div class="relative" :style="{ height: `${totalHeight}px` }">
          <div class="absolute inset-x-0" :style="{ transform: `translateY(${offsetY}px)` }">
            <div
              v-for="row in window$"
              :key="`${row.no}-${row.kind}`"
              class="launcher-mono flex h-5 items-center gap-2 px-2 text-[11.5px] leading-5"
              :class="{ 'launcher-diff-add': row.kind === 'add', 'launcher-diff-del': row.kind === 'del' }"
            >
              <span class="w-9 shrink-0 text-right text-faint">{{ row.no }}</span>
              <span class="w-2 shrink-0">{{ mark(row.kind) }}</span>
              <span class="truncate whitespace-pre">{{ row.text || ' ' }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="phase === 'writing'" class="flex items-center gap-2 rounded-lg border border-line bg-panel2 p-3 text-[12.5px]">
        <span class="launcher-pulse"><UiIcon name="alert" :size="14" /></span>
        <span>正在写入…… 如果系统弹出授权窗口，请先完成验证。</span>
      </div>

      <div v-if="!writable && phase === 'preview'" class="flex flex-col gap-2 rounded-lg border border-line bg-panel2 p-2.5 text-[11.5px] text-muted">
        <div>
          当前进程没有 {{ path }} 的写权限，
          {{ platform === 'darwin' ? 'macOS 会弹出系统授权窗口' : platform === 'win32' ? 'Windows 会弹出 UAC 确认' : '会尝试用 pkexec 提权' }}，
          写入前会自动备份现有内容。
        </div>
        <label
          v-if="platform === 'darwin' || platform === 'linux'"
          class="flex items-start gap-2 leading-relaxed"
          title="一次授权后不再弹出授权窗口；随时可在顶栏的权限面板里撤销"
        >
          <input v-model="remember" type="checkbox" class="mt-0.5 shrink-0" />
          <span>
            开启<span class="text-fg">免授权写入</span>：这次授权的同时，把
            <span class="launcher-mono">{{ path }}</span> 的写权限授给当前账户，
            <span class="text-fg">以后保存不再弹窗</span>（随时可撤销）。
          </span>
        </label>
      </div>
    </div>

    <template #footer>
      <button class="launcher-btn" @click="copyAll">
        <UiIcon name="copy" :size="12" /> 复制完整内容
      </button>
      <button v-if="phase === 'manual'" class="launcher-btn primary" @click="copyCommand">
        <UiIcon name="copy" :size="12" /> 复制命令
      </button>
      <div class="flex-1" />
      <button class="launcher-btn" @click="emit('close')">{{ phase === 'manual' ? '关闭' : '取消' }}</button>
      <button
        v-if="phase !== 'manual'"
        class="launcher-btn primary"
        :disabled="phase === 'writing'"
        @click="emit('confirm', { remember })"
      >
        {{ phase === 'writing' ? '写入中…' : writable ? '确认写入' : remember ? '授权并写入（以后不再询问）' : '授权并写入' }}
      </button>
    </template>
  </UiDialog>
</template>
