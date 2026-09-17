<script setup lang="ts">
import { ref } from 'vue'
import UiDialog from '@launcher/ui/UiDialog.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import UiSelect from '@launcher/ui/UiSelect.vue'
import { useToast } from '@launcher/ui/toast'
import type { Priority, Task } from '../core/tasks'
import { dueInputValue, parseDue } from '../core/tasks'

const props = defineProps<{ task: Task }>()
const emit = defineEmits<{
  close: []
  save: [patch: { title: string; note: string; priority: Priority; dueAt?: number }]
  remove: []
}>()

const title = ref(props.task.title)
const note = ref(props.task.note)
const priority = ref<Priority>(props.task.priority)
const dueText = ref(dueInputValue(props.task.dueAt))
const toast = useToast()

const priorityOptions = [
  { value: 0, label: '普通' },
  { value: 1, label: '重要' },
  { value: 2, label: '紧急' },
]

function submit(): void {
  const raw = dueText.value.trim()
  let dueAt: number | undefined
  if (raw) {
    dueAt = parseDue(raw)
    if (dueAt === undefined) {
      toast.err('截止日期看不懂：试试 明天 / 周五 / 3天后 / 2026-09-20')
      return
    }
  }
  emit('save', { title: title.value.trim() || props.task.title, note: note.value, priority: priority.value, dueAt })
}

function clearDue(): void {
  dueText.value = ''
}
</script>

<template>
  <UiDialog title="编辑待办" :subtitle="task.title" size="md" @close="emit('close')">
    <div class="flex flex-col gap-2.5">
      <input v-model="title" class="launcher-input" placeholder="要做什么" @keydown.enter.prevent="submit" />

      <textarea v-model="note" class="launcher-input h-[92px] resize-none" placeholder="备注（可选）" />

      <div class="flex items-center gap-2">
        <span class="w-[52px] shrink-0 text-[11.5px] text-muted">优先级</span>
        <div class="w-[120px]">
          <UiSelect :model-value="priority" :options="priorityOptions" @update:model-value="(value) => (priority = Number(value) as Priority)" />
        </div>
        <span class="ml-auto text-[11px] text-faint">已完成 {{ task.pomodoros }} 个番茄</span>
      </div>

      <div class="flex items-center gap-2">
        <span class="w-[52px] shrink-0 text-[11.5px] text-muted">截止</span>
        <input v-model="dueText" class="launcher-input flex-1" placeholder="明天 / 周五 / 3天后 / 2026-09-20" />
        <button class="launcher-btn ghost" @click="clearDue">
          <UiIcon name="close" :size="12" />
          清除
        </button>
      </div>
    </div>

    <template #footer>
      <button class="launcher-btn danger" @click="emit('remove')">
        <UiIcon name="trash" :size="13" />
        删除
      </button>
      <button class="launcher-btn ghost" @click="emit('close')">取消</button>
      <button class="launcher-btn primary" @click="submit">保存</button>
    </template>
  </UiDialog>
</template>
