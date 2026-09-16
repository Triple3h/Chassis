<script setup lang="ts">
import { computed, ref } from 'vue'
import UiDialog from '@launcher/ui/UiDialog.vue'
import { ipWarning, isValidHostname, type EntryFields, type EntryLine } from '../core/hosts'

/** 新建 / 编辑单条 host 记录 */
const props = defineProps<{
  /** 编辑现有条目时传入；null 表示新建 */
  line: EntryLine | null
  /** 新建时的预填（从搜索框或剪贴板带过来） */
  preset?: Partial<EntryFields> | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'submit', fields: EntryFields): void
  (e: 'remove'): void
}>()

const source: Partial<EntryFields> = props.line ?? props.preset ?? {}

const ip = ref(source.ip ?? '')
const namesText = ref((source.names ?? []).join(' '))
const comment = ref(source.comment ?? '')
const enabled = ref(!source.disabled)

const names = computed(() =>
  namesText.value
    .split(/[\s,，]+/)
    .map((n) => n.trim())
    .filter(Boolean),
)

const ipIssue = computed(() => (ip.value.trim() ? ipWarning(ip.value.trim()) : '请填写 IP'))
const nameIssues = computed(() =>
  names.value.filter((n) => !isValidHostname(n)).map((n) => `「${n}」不是合法域名`),
)
const blocked = computed(() => !!ipIssue.value || !names.value.length || nameIssues.value.length > 0)

function submit() {
  if (blocked.value) return
  emit('submit', {
    ip: ip.value.trim(),
    names: names.value,
    comment: comment.value.trim(),
    disabled: !enabled.value,
  })
}
</script>

<template>
  <UiDialog :title="line ? '编辑记录' : '新增记录'" subtitle="改完点保存，才会真正写进系统文件" @close="emit('close')">
    <div class="flex flex-col gap-3.5">
      <label class="flex flex-col gap-1.5">
        <span class="text-[12px] text-muted">IP 地址</span>
        <input
          v-model="ip"
          class="launcher-input launcher-mono"
          placeholder="10.0.0.1"
          autofocus
          @keydown.enter="submit"
        />
        <span v-if="ipIssue" class="text-[11.5px] text-danger">{{ ipIssue }}</span>
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="text-[12px] text-muted">域名（多个用空格或逗号分隔）</span>
        <input
          v-model="namesText"
          class="launcher-input launcher-mono"
          placeholder="dev.example.com api.dev.example.com"
          @keydown.enter="submit"
        />
        <span v-for="issue in nameIssues" :key="issue" class="text-[11.5px] text-danger">{{ issue }}</span>
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="text-[12px] text-muted">备注（可选）</span>
        <input v-model="comment" class="launcher-input" placeholder="写给自己看的说明" @keydown.enter="submit" />
      </label>

      <div class="flex items-center gap-2">
        <button class="launcher-switch" :data-on="enabled" @click="enabled = !enabled" />
        <span class="text-[12.5px]">{{ enabled ? '启用（写入后立即生效）' : '禁用（写入时保持注释状态）' }}</span>
      </div>
    </div>

    <template #footer>
      <button v-if="line" class="launcher-btn danger" @click="emit('remove')">删除</button>
      <div class="flex-1" />
      <button class="launcher-btn" @click="emit('close')">取消</button>
      <button class="launcher-btn primary" :disabled="blocked" @click="submit">确定</button>
    </template>
  </UiDialog>
</template>
