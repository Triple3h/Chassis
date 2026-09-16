<script setup lang="ts">
import { computed, ref } from 'vue'
import UiDialog from '@shared/ui/UiDialog.vue'
import UiIcon from '@shared/ui/UiIcon.vue'
import { copyText, readClipboardText } from '@shared/lib/clipboard'
import { useToast } from '@shared/lib/toast'
import { parseImportText, type EntryFields } from '../core/hosts'

/**
 * 批量粘贴：从文档、工单、同事聊天记录里直接拖一段 hosts 进来。
 * 边打边解析，认不出来的行原样列出来让用户自己看着办。
 */
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'submit', payload: { entries: EntryFields[]; replace: boolean }): void
}>()

const text = ref('')
const replace = ref(false)
const toast = useToast()

const parsed = computed(() => parseImportText(text.value))
const preview = computed(() => parsed.value.entries.slice(0, 200))

async function pullFromClipboard() {
  const fromClipboard = await readClipboardText()
  if (!fromClipboard?.trim()) {
    toast.err('剪贴板里没有文本（宿主可能未授权读取）')
    return
  }
  text.value = fromClipboard
  toast.ok('已读取剪贴板')
}

function submit() {
  if (!parsed.value.entries.length) return
  emit('submit', { entries: parsed.value.entries, replace: replace.value })
}

async function copyInput() {
  if (await copyText(text.value)) toast.ok('已复制')
  else toast.err('复制失败，请手动选择')
}
</script>

<template>
  <UiDialog
    title="批量粘贴"
    subtitle="支持「IP 域名 # 备注」一行一条，被 # 注释掉的会当成禁用条目导入"
    size="wide"
    @close="emit('close')"
  >
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-2">
        <textarea
          v-model="text"
          class="launcher-input launcher-mono h-40 resize-none leading-[18px]"
          placeholder="10.0.0.1	dev.example.com	# 开发环境
10.0.0.2	api.example.com
# 10.0.0.3	old.example.com"
          spellcheck="false"
        />
      </div>

      <div class="flex flex-wrap items-center gap-2 text-[12px]">
        <button class="launcher-btn" @click="pullFromClipboard">
          <UiIcon name="clipboard" :size="12" /> 从剪贴板读取
        </button>
        <span class="launcher-chip">识别 {{ parsed.entries.length }} 条</span>
        <span v-if="parsed.skipped.length" class="launcher-chip text-warn">
          跳过 {{ parsed.skipped.length }} 行
        </span>
        <div class="flex-1" />
        <label class="flex cursor-pointer items-center gap-1.5 text-muted">
          <input v-model="replace" type="checkbox" />
          替换全文（默认追加到末尾）
        </label>
      </div>

      <div v-if="preview.length" class="launcher-scroll max-h-40 rounded-lg border border-line bg-panel2 p-2">
        <div v-for="(entry, i) in preview" :key="i" class="launcher-mono truncate py-0.5 text-[11.5px]">
          <span :class="entry.disabled ? 'text-faint' : 'text-fg'">{{ entry.disabled ? '# ' : '' }}{{ entry.ip }}</span>
          <span class="text-accent"> {{ entry.names.join(' ') }}</span>
          <span v-if="entry.comment" class="text-muted"> # {{ entry.comment }}</span>
        </div>
        <div v-if="parsed.entries.length > preview.length" class="pt-1 text-[11.5px] text-faint">
          …还有 {{ parsed.entries.length - preview.length }} 条
        </div>
      </div>

      <div v-if="parsed.skipped.length" class="rounded-lg border border-line bg-panel2 p-2">
        <div class="mb-1 text-[11.5px] text-warn">下面这些行读不出 IP 和域名，不会被导入：</div>
        <div v-for="(line, i) in parsed.skipped.slice(0, 6)" :key="i" class="launcher-mono truncate text-[11.5px] text-muted">
          {{ line }}
        </div>
      </div>

      <div v-if="replace" class="rounded-lg border border-line bg-panel2 p-2 text-[11.5px] text-warn">
        替换全文会丢掉当前列表里所有条目（包括 localhost 那些系统行），请谨慎使用。
      </div>
    </div>

    <template #footer>
      <button class="launcher-btn" @click="copyInput">复制输入内容</button>
      <div class="flex-1" />
      <button class="launcher-btn" @click="emit('close')">取消</button>
      <button class="launcher-btn primary" :disabled="!parsed.entries.length" @click="submit">
        {{ replace ? '替换全文' : `追加 ${parsed.entries.length} 条` }}
      </button>
    </template>
  </UiDialog>
</template>
