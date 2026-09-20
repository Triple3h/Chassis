<script setup lang="ts">
/** 历史记录面板：列最近 20 份 JSON，点一条载入、可以删单条或全清。 */
import UiDialog from '@launcher/ui/UiDialog.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import { previewOf, type HistoryEntry } from '../core/history'

defineProps<{ entries: HistoryEntry[] }>()
const emit = defineEmits<{
  pick: [entry: HistoryEntry]
  remove: [id: string]
  clear: []
  close: []
}>()

function fmtTime(at: number): string {
  if (!at) return ''
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<template>
  <UiDialog title="历史记录" subtitle="最近 20 份 JSON，自动保存并跨重启保留" size="wide" @close="emit('close')">
    <p v-if="entries.length === 0" class="py-6 text-center text-[12.5px] text-muted">
      还没有记录 —— 导入或改写一份 JSON 之后会自动出现在这里
    </p>

    <div v-else class="flex flex-col gap-0.5">
      <div
        v-for="entry in entries"
        :key="entry.id"
        class="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-[var(--launcher-active)]"
      >
        <button type="button" class="min-w-0 flex-1 text-left" title="载入这份 JSON" @click="emit('pick', entry)">
          <div class="truncate font-mono text-[12px]">{{ previewOf(entry.text) }}</div>
          <div class="text-[11px] text-faint">
            {{ entry.text.length.toLocaleString() }} 字符<template v-if="fmtTime(entry.at)"> · {{ fmtTime(entry.at) }}</template>
          </div>
        </button>
        <button class="launcher-btn ghost !px-1.5" title="删除这一条" @click="emit('remove', entry.id)">
          <UiIcon name="trash" :size="12" />
        </button>
      </div>
    </div>

    <template #footer>
      <span class="text-[11.5px] text-faint">共 {{ entries.length }} / 20 条</span>
      <button class="launcher-btn ghost ml-auto" :disabled="entries.length === 0" @click="emit('clear')">
        <UiIcon name="trash" :size="12" />清空全部
      </button>
    </template>
  </UiDialog>
</template>
