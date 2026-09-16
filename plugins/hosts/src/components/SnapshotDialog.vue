<script setup lang="ts">
import { ref } from 'vue'
import UiDialog from '@shared/ui/UiDialog.vue'
import UiIcon from '@shared/ui/UiIcon.vue'
import type { Snapshot } from '../core/snapshots'

/**
 * 快照：写入前自动留一份，用户也可以手动命名存档。
 * 载入快照只改编辑器里的内容，仍然要再点一次保存才会写进系统文件。
 */
defineProps<{
  snapshots: Snapshot[]
  /** 当前编辑器里的条目数，手动存档时记进去 */
  currentEntries: number
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'save', name: string): void
  (e: 'load', snap: Snapshot): void
  (e: 'remove', id: string): void
}>()

const name = ref('')

function submit() {
  emit('save', name.value.trim() || `快照 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`)
  name.value = ''
}

function when(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <UiDialog title="快照" subtitle="每次写入前会自动存一份；载入后仍需点保存才会生效" @close="emit('close')">
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-2">
        <input
          v-model="name"
          class="launcher-input"
          placeholder="给当前配置起个名字（留空自动命名）"
          @keydown.enter="submit"
        />
        <button class="launcher-btn primary shrink-0" @click="submit">
          <UiIcon name="save" :size="12" /> 存档
        </button>
      </div>

      <div v-if="!snapshots.length" class="rounded-lg border border-line bg-panel2 p-4 text-center text-[12.5px] text-muted">
        还没有快照。改完第一次写入系统文件时，这里会自动出现一份。
      </div>

      <div v-else class="launcher-scroll flex max-h-[46vh] flex-col gap-1.5">
        <div
          v-for="snap in snapshots"
          :key="snap.id"
          class="group flex items-center gap-2.5 rounded-lg border border-line bg-panel2 px-2.5 py-2"
        >
          <span :class="snap.kind === 'auto' ? 'text-faint' : 'text-accent'">
            <UiIcon :name="snap.kind === 'auto' ? 'history' : 'save'" :size="13" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="truncate text-[12.5px]">{{ snap.name }}</div>
            <div class="text-[11px] text-muted">
              {{ when(snap.createdAt) }} · {{ snap.entries }} 条
              <span v-if="snap.kind === 'auto'"> · 自动</span>
            </div>
          </div>
          <button class="launcher-btn" @click="emit('load', snap)">载入</button>
          <button class="launcher-btn ghost text-danger" title="删除" @click="emit('remove', snap.id)">
            <UiIcon name="trash" :size="12" />
          </button>
        </div>
      </div>

      <div class="text-[11.5px] text-muted">
        当前编辑器里有 {{ currentEntries }} 条记录。存档会把「现在编辑的内容」存起来，含尚未写入系统的改动。
      </div>
    </div>

    <template #footer>
      <div class="flex-1" />
      <button class="launcher-btn" @click="emit('close')">关闭</button>
    </template>
  </UiDialog>
</template>
