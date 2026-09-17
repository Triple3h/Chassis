<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import AppShell from '@launcher/ui/AppShell.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import UiDialog from '@launcher/ui/UiDialog.vue'
import { useToast } from '@launcher/ui/toast'
import { isTypingTarget, matchKey, modLabel } from '@launcher/ui/keys'
import { copyText } from '@launcher/ui/clipboard'
import { clipboard, host, hostUi } from '@launcher/api'
import type { Pad } from './core/pads'
import {
  appendRow,
  clearPad,
  createPad,
  padScope,
  padSummary,
  padText,
  removeRow,
  renamePad,
  setNote,
} from './core/pads'
import { evaluate, SYNTAX_HINT } from './core/expr'
import { formatNumber, formatPlain } from './core/format'
import { loadCurrentId, loadPads, saveCurrentId, savePads } from './core/store'

const pads = ref<Pad[]>([])
const loaded = ref(false)
const currentId = ref('')
const draft = ref('')
const selectedIndex = ref(-1)
const noteEdit = ref<{ rowId: string; value: string } | null>(null)
const titleDraft = ref('')
const carried = ref(false)
const inputEl = ref<HTMLInputElement | null>(null)
const rowsEl = ref<HTMLElement | null>(null)
const toast = useToast()

const current = computed<Pad | null>(() => pads.value.find((pad) => pad.id === currentId.value) ?? pads.value[0] ?? null)
const rows = computed(() => current.value?.rows ?? [])
const selectedRow = computed(() => rows.value[selectedIndex.value] ?? null)

/** 底部输入框的实时预览：当前输入的算式能不能算出来 */
const preview = computed(() => {
  const text = draft.value.trim()
  if (!text || !current.value) return { text: '', error: '' }
  const result = evaluate(text, padScope(current.value))
  return result.ok ? { text: formatNumber(result.value), error: '' } : { text: '', error: result.error }
})

watch(
  current,
  (pad) => {
    selectedIndex.value = pad && pad.rows.length ? pad.rows.length - 1 : -1
    titleDraft.value = pad?.title ?? ''
  },
  { immediate: true },
)

/* ------------------------------------------------------------- 读写 */

async function persist(): Promise<void> {
  await savePads(pads.value)
}

function replacePad(next: Pad): void {
  pads.value = pads.value.map((pad) => (pad.id === next.id ? next : pad))
}

async function load(): Promise<void> {
  pads.value = await loadPads()
  const stored = await loadCurrentId()
  if (stored && pads.value.some((pad) => pad.id === stored)) currentId.value = stored
  else currentId.value = pads.value[0]?.id ?? ''
  if (!pads.value.length) {
    const pad = createPad()
    pads.value = [pad]
    currentId.value = pad.id
    await persist()
  }
  loaded.value = true
}

async function selectPad(id: string): Promise<void> {
  currentId.value = id
  await saveCurrentId(id)
  await nextTick()
  scrollToBottom()
}

async function newPad(): Promise<void> {
  const pad = createPad()
  pads.value = [pad, ...pads.value]
  await selectPad(pad.id)
  await persist()
  toast.ok('新建了一张稿纸')
  focusInput()
}

function commitTitle(): void {
  if (!current.value) return
  const next = renamePad(current.value, titleDraft.value)
  replacePad(next)
  titleDraft.value = next.title
  void persist()
}

/* ------------------------------------------------------------- 稿纸操作 */

function focusInput(): void {
  void nextTick(() => inputEl.value?.focus())
}

function scrollToBottom(): void {
  void nextTick(() => {
    const el = rowsEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

/** 提交底部输入：追加一行，并把结果带进输入框（可直接接着写 + 5） */
async function commit(): Promise<void> {
  const text = draft.value.trim()
  if (!text || !current.value) return
  const next = appendRow(current.value, text)
  replacePad(next)
  selectedIndex.value = next.rows.length - 1
  await persist()
  const row = next.rows[next.rows.length - 1]
  if (row?.value !== undefined) {
    draft.value = formatPlain(row.value)
    carried.value = true
    void nextTick(() => {
      const input = inputEl.value
      if (!input) return
      input.setSelectionRange(input.value.length, input.value.length)
    })
  } else {
    draft.value = ''
    carried.value = false
  }
  scrollToBottom()
}

async function copyResult(text: string, tip = '已复制结果'): Promise<void> {
  if (!text) return
  let ok = false
  if (host.isLauncher()) ok = await clipboard.writeText(text).then(() => true).catch(() => false)
  if (!ok) ok = await copyText(text)
  toast[ok ? 'ok' : 'err'](ok ? tip : '复制失败')
}

async function copyRow(row: { text: string; error?: string }): Promise<void> {
  if (row.error) {
    toast.err('这一行还没算出来')
    return
  }
  await copyResult(row.text.replace(/,/g, ''))
}

function moveSelection(delta: number): void {
  const list = rows.value
  if (!list.length) return
  const next = Math.min(list.length - 1, Math.max(0, selectedIndex.value + delta))
  selectedIndex.value = next
  // 输入框是空的：顺带把选中行的结果带进来（快速切换到某一行的结果继续算）
  const row = list[next]
  if (row && !draft.value.trim() && row.value !== undefined) {
    draft.value = formatPlain(row.value)
    carried.value = true
  }
}

function selectRow(index: number): void {
  selectedIndex.value = index
}

async function removeRowById(rowId: string): Promise<void> {
  if (!current.value) return
  const index = rows.value.findIndex((row) => row.id === rowId)
  replacePad(removeRow(current.value, rowId))
  selectedIndex.value = index >= 0 ? Math.min(index, rows.value.length - 1) : Math.min(selectedIndex.value, rows.value.length - 1)
  await persist()
}

async function removeSelectedRow(): Promise<void> {
  const row = selectedRow.value
  if (!row) return
  await removeRowById(row.id)
}

async function clearCurrent(): Promise<void> {
  if (!current.value) return
  replacePad(clearPad(current.value))
  selectedIndex.value = -1
  draft.value = ''
  carried.value = false
  await persist()
  toast.info('已清空这张稿纸')
}

async function removeCurrentPad(): Promise<void> {
  const pad = current.value
  if (!pad) return
  pads.value = pads.value.filter((item) => item.id !== pad.id)
  if (!pads.value.length) pads.value = [createPad()]
  currentId.value = pads.value[0]?.id ?? ''
  await persist()
  await saveCurrentId(currentId.value)
  toast.info('已删除稿纸')
}

function startNote(): void {
  const row = selectedRow.value
  if (!row) {
    toast.info('先用 ↑↓ 选中一行')
    return
  }
  noteEdit.value = { rowId: row.id, value: row.note ?? '' }
}

function submitNote(): void {
  const edit = noteEdit.value
  if (!edit || !current.value) return
  replacePad(setNote(current.value, edit.rowId, edit.value))
  noteEdit.value = null
  void persist()
}

/* ------------------------------------------------------------- 快捷键 */

function onKeydown(event: KeyboardEvent): void {
  const typing = isTypingTarget(event.target)
  if (matchKey(event, 'Mod+n')) {
    event.preventDefault()
    void newPad()
    return
  }
  if (matchKey(event, 'Mod+r')) {
    event.preventDefault()
    void clearCurrent()
    return
  }
  if (matchKey(event, 'Mod+b')) {
    event.preventDefault()
    startNote()
    return
  }
  if (matchKey(event, 'Mod+Backspace') && !typing) {
    event.preventDefault()
    void removeSelectedRow()
    return
  }
  if (matchKey(event, 'Mod+c') && !typing) {
    event.preventDefault()
    const text = preview.value.text || selectedRow.value?.text || ''
    void copyResult(text.replace(/,/g, ''))
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    moveSelection(1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveSelection(-1)
    return
  }
  if (event.key === 'Escape' && draft.value) {
    event.preventDefault()
    draft.value = ''
    carried.value = false
  }
}

/* ------------------------------------------------------------- 宿主 footer */

async function syncFooter(): Promise<void> {
  await hostUi
    .setFooter([
      {
        type: 'button',
        id: 'copy',
        label: '复制结果',
        icon: 'Copy',
        keys: [`${modLabel}+C`],
        onClick: () => {
          const text = preview.value.text || selectedRow.value?.text || ''
          void copyResult(text.replace(/,/g, ''))
        },
      },
      { type: 'button', id: 'new', label: '新建稿纸', icon: 'Plus', keys: [`${modLabel}+N`], onClick: () => void newPad() },
      {
        type: 'action-panel',
        id: 'more',
        label: '更多',
        icon: 'Sliders',
        keys: [`${modLabel}+K`],
        title: '稿纸操作',
        items: [
          {
            id: 'copy-all',
            name: '复制整张稿纸',
            icon: 'Clipboard',
            onSelect: () => current.value && void copyResult(padText(current.value), '已复制整张稿纸'),
          },
          { id: 'note', name: '给选中行加备注', icon: 'FileText', onSelect: () => startNote() },
          { id: 'remove-row', name: '删除选中行', icon: 'Trash', onSelect: () => void removeSelectedRow() },
          { id: 'clear', name: '清空当前稿纸', icon: 'Refresh', onSelect: () => void clearCurrent() },
          { id: 'remove-pad', name: '删除这张稿纸', icon: 'Trash', onSelect: () => void removeCurrentPad() },
        ],
      },
    ])
    .catch(() => undefined)
}

/* ------------------------------------------------------------- 生命周期 */

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  await load()
  void syncFooter()
  // 搜索框里如果已经敲了算式，直接接过来当草稿（插件页打开时搜索框已卸载，只能读一次初值）
  const seed = await hostUi.getSearchContent().catch(() => '')
  const text = seed.trim()
  if (text && /[0-9]/.test(text) && !/^[\u4e00-\u9fff]+$/.test(text)) draft.value = text
  focusInput()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <AppShell>
    <header class="flex items-center gap-2 border-b border-line px-3 py-2">
      <UiIcon name="calculator" :size="16" class="text-accent" />
      <span class="text-[13px] font-semibold">计算稿纸</span>
      <span class="launcher-chip">{{ pads.length }} 张 · {{ rows.length }} 行</span>
      <div class="ml-auto flex items-center gap-1.5">
        <button class="launcher-btn ghost" @click="copyResult(current ? padText(current) : '', '已复制整张稿纸')">
          <UiIcon name="copy" :size="13" />
          复制整张
        </button>
        <button class="launcher-btn primary" @click="newPad()">
          <UiIcon name="plus" :size="13" />
          新建稿纸
        </button>
      </div>
    </header>

    <div class="flex min-h-0 flex-1">
      <!-- 稿纸列表 -->
      <aside class="launcher-scroll w-[168px] shrink-0 max-[620px]:w-[120px] border-r border-line">
        <button
          v-for="pad in pads"
          :key="pad.id"
          class="flex w-full flex-col gap-0.5 border-b border-line px-3 py-2 text-left"
          :class="current?.id === pad.id ? 'bg-active' : 'hover:bg-hover'"
          @click="selectPad(pad.id)"
        >
          <span class="truncate text-[12px] font-medium" :class="current?.id === pad.id ? 'text-accent' : ''">{{ pad.title }}</span>
          <span class="truncate text-[10.5px] text-faint">{{ pad.rows.length }} 行 · {{ padSummary(pad) }}</span>
        </button>
        <div v-if="!pads.length && !loaded" class="px-3 py-4 text-[11.5px] text-faint">正在读取…</div>
      </aside>

      <!-- 稿纸正文 -->
      <section class="flex min-w-0 flex-1 flex-col">
        <div class="flex items-center gap-2 border-b border-line px-3 py-2">
          <input
            v-model="titleDraft"
            class="launcher-input h-7 min-w-0 flex-1 border-transparent bg-transparent px-1 text-[12.5px] font-medium"
            placeholder="稿纸名称"
            @change="commitTitle"
            @blur="commitTitle"
          />
          <span class="shrink-0 text-[11px] text-faint">改完自动保存</span>
        </div>

        <div ref="rowsEl" class="launcher-scroll min-h-0 flex-1 px-3 py-2">
          <div
            v-for="(row, index) in rows"
            :key="row.id"
            class="group flex items-baseline gap-2 rounded-md px-2 py-1"
            :class="selectedIndex === index ? 'bg-active' : 'hover:bg-hover'"
            @click="selectRow(index)"
          >
            <span class="pad-mono min-w-0 flex-1 truncate text-fg" :title="row.expr">{{ row.expr }}</span>
            <span v-if="row.note" class="pad-mono shrink-0 truncate text-[11px] text-faint" :title="row.note">// {{ row.note }}</span>
            <span class="pad-mono shrink-0 text-faint">=</span>
            <span
              class="pad-result shrink-0"
              :class="row.error ? 'max-w-[45%] truncate text-danger' : 'text-accent'"
              :title="row.error ?? row.text"
            >
              {{ row.error ?? row.text }}
            </span>
            <button class="launcher-btn ghost shrink-0 opacity-0 group-hover:opacity-100" title="复制结果" @click.stop="copyRow(row)">
              <UiIcon name="copy" :size="12" />
            </button>
            <button
              class="launcher-btn ghost shrink-0 text-danger opacity-0 group-hover:opacity-100"
              title="删除这一行"
              @click.stop="removeRowById(row.id)"
            >
              <UiIcon name="trash" :size="12" />
            </button>
          </div>

          <div v-if="!rows.length" class="flex flex-col items-center gap-2 px-6 py-10 text-center text-faint">
            <UiIcon name="calculator" :size="24" />
            <p class="text-[12.5px]">在下面输入算式，回车就记到稿纸上</p>
            <p class="text-[11px]">{{ SYNTAX_HINT }}</p>
          </div>
        </div>

        <div class="border-t border-line px-3 py-2">
          <div class="flex items-center gap-2">
            <input
              ref="inputEl"
              v-model="draft"
              class="launcher-input pad-mono min-w-0 flex-1"
              :placeholder="carried ? '接上一行结果继续算，回车记到稿纸' : '输入算式，回车记到稿纸上'"
              @keydown.enter.prevent="commit"
              @input="carried = false"
            />
            <span v-if="preview.text" class="pad-result shrink-0 text-accent">= {{ preview.text }}</span>
            <span v-else-if="preview.error" class="shrink-0 text-[11.5px] text-danger">{{ preview.error }}</span>
          </div>
          <div class="mt-1 flex items-center gap-3 text-[11px] text-faint">
            <span>{{ SYNTAX_HINT }}</span>
          </div>
        </div>
      </section>
    </div>

    <footer class="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[11.5px] text-faint">
      <span><span class="launcher-kbd">Enter</span> 记到稿纸</span>
      <span><span class="launcher-kbd">↑↓</span> 切换行</span>
      <span><span class="launcher-kbd">{{ modLabel }}C</span> 复制结果</span>
      <span><span class="launcher-kbd">{{ modLabel }}B</span> 备注</span>
      <span class="ml-auto">自动保存</span>
    </footer>

    <UiDialog v-if="noteEdit" title="给这一行加个备注" subtitle="备注只作说明，不参与计算" size="sm" @close="noteEdit = null">
      <input v-model="noteEdit.value" class="launcher-input" placeholder="例如：房租分摊" @keydown.enter.prevent="submitNote" />
      <template #footer>
        <button class="launcher-btn ghost" @click="noteEdit = null">取消</button>
        <button class="launcher-btn primary" @click="submitNote">保存</button>
      </template>
    </UiDialog>
  </AppShell>
</template>
