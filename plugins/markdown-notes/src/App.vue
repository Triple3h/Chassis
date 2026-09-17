<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import AppShell from '@launcher/ui/AppShell.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import { useToast } from '@launcher/ui/toast'
import { isTypingTarget, matchKey, modLabel } from '@launcher/ui/keys'
import { useVirtualList } from '@launcher/ui/virtual'
import { copyText, downloadBlob, pickFile } from '@launcher/ui/clipboard'
import { clipboard, host, hostUi } from '@launcher/api'
import type { Note } from './core/notes'
import {
  applyContent,
  countChars,
  createNote,
  exportHtml,
  filterNotes,
  noteFileName,
  noteSummary,
  relativeTime,
  renameNote,
} from './core/notes'
import { renderMarkdown } from './core/markdown'
import { loadCurrentId, loadNotes, saveCurrentId, saveNotes } from './core/store'

type ViewMode = 'edit' | 'split' | 'preview'

const ROW_HEIGHT = 60
const SAVE_DELAY = 500

const notes = ref<Note[]>([])
const loaded = ref(false)
const currentId = ref('')
const query = ref('')
const mode = ref<ViewMode>('split')
const savedAt = ref(0)
const saving = ref(false)
const titleDraft = ref('')
const now = ref(Date.now())
const listEl = ref<HTMLElement | null>(null)
const editorEl = ref<HTMLTextAreaElement | null>(null)
const toast = useToast()

const filtered = computed(() => filterNotes(notes.value, query.value))
const current = computed<Note | null>(() => notes.value.find((note) => note.id === currentId.value) ?? null)
const content = computed({
  get: () => current.value?.content ?? '',
  set: (value: string) => {
    const note = current.value
    if (!note) return
    notes.value = notes.value.map((item) => (item.id === note.id ? { ...item, content: value } : item))
  },
})
const previewHtml = computed(() => renderMarkdown(content.value))
const stats = computed(() => countChars(content.value))

const { startIndex, endIndex, offsetY, totalHeight } = useVirtualList(listEl, {
  count: computed(() => filtered.value.length),
  rowHeight: ROW_HEIGHT,
})
const visibleNotes = computed(() =>
  filtered.value.slice(startIndex.value, endIndex.value).map((note) => ({ note })),
)

watch(
  filtered,
  (list) => {
    if (!currentId.value && list.length) currentId.value = list[0]?.id ?? ''
  },
  { immediate: true },
)

watch(current, (note) => {
  titleDraft.value = note?.title ?? ''
})

/* ------------------------------------------------------------- 自动保存 */

let saveTimer = 0

function scheduleSave(): void {
  saving.value = true
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void flushSave(), SAVE_DELAY)
}

async function flushSave(): Promise<void> {
  window.clearTimeout(saveTimer)
  const note = current.value
  if (!note) return
  const next = applyContent(note, note.content)
  notes.value = notes.value.map((item) => (item.id === next.id ? next : item))
  await saveNotes(notes.value)
  savedAt.value = Date.now()
  saving.value = false
}

watch(content, () => scheduleSave())

/* ------------------------------------------------------------- 读写 */

async function load(): Promise<void> {
  notes.value = await loadNotes()
  const stored = await loadCurrentId()
  if (stored && notes.value.some((note) => note.id === stored)) currentId.value = stored
  else currentId.value = notes.value[0]?.id ?? ''
  if (!notes.value.length) {
    const note = createNote()
    notes.value = [note]
    currentId.value = note.id
    await saveNotes(notes.value)
  }
  loaded.value = true
}

async function selectNote(id: string): Promise<void> {
  await flushSave()
  currentId.value = id
  await saveCurrentId(id)
}

async function newNote(seed = ''): Promise<void> {
  await flushSave()
  const note = createNote(Date.now(), seed)
  notes.value = [note, ...notes.value]
  currentId.value = note.id
  await saveNotes(notes.value)
  await saveCurrentId(note.id)
  if (!seed) mode.value = 'split'
  toast.ok(seed ? '已把搜索框内容存成新笔记' : '新建了一篇笔记')
  void nextTick(() => editorEl.value?.focus())
}

async function removeNote(note: Note): Promise<void> {
  notes.value = notes.value.filter((item) => item.id !== note.id)
  if (!notes.value.length) {
    const fresh = createNote()
    notes.value = [fresh]
    currentId.value = fresh.id
  } else if (currentId.value === note.id) {
    currentId.value = notes.value[0]?.id ?? ''
  }
  await saveNotes(notes.value)
  await saveCurrentId(currentId.value)
  toast.info('已删除笔记')
}

async function togglePin(note: Note): Promise<void> {
  notes.value = notes.value.map((item) => (item.id === note.id ? { ...item, pinned: !item.pinned } : item))
  await saveNotes(notes.value)
}

async function commitTitle(): Promise<void> {
  const note = current.value
  if (!note) return
  const next = renameNote(note, titleDraft.value)
  notes.value = notes.value.map((item) => (item.id === next.id ? next : item))
  titleDraft.value = next.title
  await saveNotes(notes.value)
}

/* ------------------------------------------------------------- 复制 / 导出 */

async function writeClipboard(text: string): Promise<boolean> {
  if (host.isLauncher()) {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      /* 落到浏览器剪贴板 */
    }
  }
  return copyText(text)
}

async function copyMarkdown(): Promise<void> {
  const ok = await writeClipboard(content.value)
  toast[ok ? 'ok' : 'err'](ok ? '已复制 Markdown 原文' : '复制失败')
}

async function copyHtml(): Promise<void> {
  const ok = await writeClipboard(previewHtml.value)
  toast[ok ? 'ok' : 'err'](ok ? '已复制渲染后的 HTML' : '复制失败')
}

function exportNote(kind: 'md' | 'html'): void {
  const note = current.value
  if (!note) return
  if (kind === 'md') downloadBlob(noteFileName(note, 'md'), note.content, 'text/markdown;charset=utf-8')
  else downloadBlob(noteFileName(note, 'html'), exportHtml(note), 'text/html;charset=utf-8')
  toast.ok(kind === 'md' ? '已导出 Markdown' : '已导出 HTML')
}

async function importFile(): Promise<void> {
  const file = await pickFile('.md,.markdown,.txt,text/*')
  if (!file) return
  const text = await file.text()
  await newNote(text)
}

/* ------------------------------------------------------------- 编辑命令 */

function wrapSelection(before: string, after = before, placeholder = ''): void {
  const el = editorEl.value
  if (!el) {
    toast.info('先把光标放进编辑区')
    return
  }
  const start = el.selectionStart
  const end = el.selectionEnd
  const text = content.value
  const selected = text.slice(start, end) || placeholder
  content.value = `${text.slice(0, start)}${before}${selected}${after}${text.slice(end)}`
  void nextTick(() => {
    el.focus()
    el.setSelectionRange(start + before.length, start + before.length + selected.length)
  })
}

function toggleMode(next: ViewMode): void {
  mode.value = next
  if (next !== 'preview') void nextTick(() => editorEl.value?.focus())
}

/* ------------------------------------------------------------- 快捷键 */

function onKeydown(event: KeyboardEvent): void {
  const typing = isTypingTarget(event.target)
  if (matchKey(event, 'Mod+n')) {
    event.preventDefault()
    void newNote()
    return
  }
  if (matchKey(event, 'Mod+s')) {
    event.preventDefault()
    void flushSave().then(() => toast.ok('已保存'))
    return
  }
  if (matchKey(event, 'Mod+b')) {
    event.preventDefault()
    wrapSelection('**', '**', '粗体')
    return
  }
  if (matchKey(event, 'Mod+i')) {
    event.preventDefault()
    wrapSelection('*', '*', '斜体')
    return
  }
  if (matchKey(event, 'Mod+k')) {
    event.preventDefault()
    wrapSelection('[', '](https://)', '链接文字')
    return
  }
  if (matchKey(event, 'Mod+1')) {
    event.preventDefault()
    toggleMode('edit')
    return
  }
  if (matchKey(event, 'Mod+2')) {
    event.preventDefault()
    toggleMode('split')
    return
  }
  if (matchKey(event, 'Mod+3')) {
    event.preventDefault()
    toggleMode('preview')
    return
  }
  if (event.key === 'Tab' && event.target === editorEl.value) {
    // 编辑区里的 Tab 用来缩进，别把焦点丢走
    event.preventDefault()
    wrapSelection('  ', '', '')
    return
  }
  if (event.key === 'Escape' && query.value && !typing) {
    event.preventDefault()
    query.value = ''
  }
}

/* ------------------------------------------------------------- 宿主 footer */

async function syncFooter(): Promise<void> {
  await hostUi
    .setFooter([
      { type: 'button', id: 'save', label: '保存', icon: 'Save', keys: [`${modLabel}+S`], onClick: () => void flushSave() },
      {
        type: 'button',
        id: 'mode',
        label: mode.value === 'preview' ? '回到编辑' : '预览',
        icon: 'Eye',
        keys: [`${modLabel}+3`],
        onClick: () => toggleMode(mode.value === 'preview' ? 'split' : 'preview'),
      },
      { type: 'button', id: 'new', label: '新建', icon: 'Plus', keys: [`${modLabel}+N`], onClick: () => void newNote() },
      {
        type: 'action-panel',
        id: 'more',
        label: '更多',
        icon: 'Sliders',
        keys: [`${modLabel}+K`],
        title: '笔记操作',
        items: [
          { id: 'md', name: '导出 Markdown', icon: 'Download', onSelect: () => exportNote('md') },
          { id: 'html', name: '导出 HTML', icon: 'Download', onSelect: () => exportNote('html') },
          { id: 'copy-md', name: '复制 Markdown', icon: 'Copy', onSelect: () => void copyMarkdown() },
          { id: 'copy-html', name: '复制 HTML', icon: 'Copy', onSelect: () => void copyHtml() },
          { id: 'import', name: '从文件导入', icon: 'Upload', onSelect: () => void importFile() },
          {
            id: 'pin',
            name: current.value?.pinned ? '取消置顶' : '置顶这篇笔记',
            icon: 'Pin',
            onSelect: () => current.value && void togglePin(current.value),
          },
        ],
      },
    ])
    .catch(() => undefined)
}

watch(mode, () => void syncFooter())
watch(current, () => void syncFooter())

/* ------------------------------------------------------------- 生命周期 */

let clock = 0
/** 搜索框里带进来的「像内容」的初值：给一次「存成新笔记」的机会，不自动落库 */
const seed = ref('')

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  clock = window.setInterval(() => (now.value = Date.now()), 30_000)
  await load()
  void syncFooter()
  // 插件页打开时宿主已经卸载了搜索框，只能读一次初值
  const search = (await hostUi.getSearchContent().catch(() => '')).trim()
  if (looksLikeContent(search) && !notes.value.some((note) => note.content.trim() === search)) seed.value = search
  void nextTick(() => editorEl.value?.focus())
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.clearInterval(clock)
  window.clearTimeout(saveTimer)
  void flushSave()
})

const MODE_TABS: Array<{ value: ViewMode; label: string; icon: string }> = [
  { value: 'edit', label: '编辑', icon: 'pencil' },
  { value: 'split', label: '分栏', icon: 'columns' },
  { value: 'preview', label: '预览', icon: 'eye' },
]
/** 命中本插件的关键词（用户是来「找插件」而不是「带内容进来」），不要拿它当新笔记 */
const TRIGGERS = ['markdown', 'md', '笔记', 'note', 'notes', '写作', '编辑器']
function looksLikeContent(text: string): boolean {
  if (!text || text.length > 60) return false
  return !TRIGGERS.includes(text.toLowerCase())
}

const seedHint = computed(() => (loaded.value ? seed.value : ''))
function useSeed(): void {
  const text = seedHint.value
  seed.value = ''
  if (text) void newNote(text)
}
</script>

<template>
  <AppShell>
    <header class="flex items-center gap-2 border-b border-line px-3 py-2">
      <UiIcon name="file" :size="16" class="text-accent" />
      <span class="text-[13px] font-semibold">Markdown 笔记</span>
      <span class="launcher-chip">{{ notes.length }} 篇</span>
      <div class="ml-auto flex items-center gap-1.5">
        <div class="relative">
          <UiIcon name="search" :size="13" class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
          <input v-model="query" class="launcher-input w-[190px] pl-7" placeholder="搜索笔记" />
        </div>
        <button class="launcher-btn primary" @click="newNote()">
          <UiIcon name="plus" :size="13" />
          新建
        </button>
      </div>
    </header>

    <div v-if="seedHint" class="flex items-center gap-2 border-b border-line bg-panel2 px-3 py-1.5 text-[11.5px] text-muted">
      <UiIcon name="wand" :size="13" class="text-accent" />
      <span class="truncate">把搜索框里的内容「{{ seedHint }}」存成新笔记？</span>
      <button class="launcher-btn ghost ml-auto text-accent" @click="useSeed">存成笔记</button>
    </div>

    <div class="flex min-h-0 flex-1">
      <!-- 笔记列表 -->
      <aside ref="listEl" class="launcher-scroll w-[236px] shrink-0 max-[620px]:w-[168px] border-r border-line">
        <div :style="{ height: `${totalHeight}px`, position: 'relative' }">
          <div :style="{ transform: `translateY(${offsetY}px)` }">
            <button
              v-for="row in visibleNotes"
              :key="row.note.id"
              class="flex w-full flex-col gap-0.5 border-b border-line px-3 py-2 text-left"
              :style="{ height: `${ROW_HEIGHT}px` }"
              :class="currentId === row.note.id ? 'bg-active' : 'hover:bg-hover'"
              @click="selectNote(row.note.id)"
            >
              <div class="flex items-center gap-1">
                <UiIcon v-if="row.note.pinned" name="pin" :size="11" class="shrink-0 text-accent" />
                <span class="truncate text-[12.5px] font-medium" :class="currentId === row.note.id ? 'text-accent' : ''">
                  {{ row.note.title }}
                </span>
              </div>
              <span class="truncate text-[10.5px] text-faint">
                {{ relativeTime(row.note.updatedAt, now) }} · {{ noteSummary(row.note.content, 46) || '空白笔记' }}
              </span>
            </button>
          </div>
        </div>
        <div v-if="!filtered.length" class="px-3 py-6 text-[11.5px] text-faint">
          {{ loaded ? '没有匹配的笔记' : '正在读取…' }}
        </div>
      </aside>

      <!-- 编辑 / 预览 -->
      <section class="flex min-w-0 flex-1 flex-col">
        <div class="flex items-center gap-1.5 border-b border-line px-3 py-2">
          <input
            v-model="titleDraft"
            class="launcher-input h-7 min-w-0 flex-1 border-transparent bg-transparent px-1 text-[12.5px] font-medium"
            placeholder="笔记标题"
            @change="commitTitle"
            @blur="commitTitle"
          />
          <div class="flex shrink-0 items-center gap-1">
            <button
              v-for="tab in MODE_TABS"
              :key="tab.value"
              class="launcher-btn ghost"
              :class="mode === tab.value ? 'bg-active text-accent' : ''"
              :title="`${tab.label}（${modLabel}+${tab.value === 'edit' ? 1 : tab.value === 'split' ? 2 : 3}）`"
              @click="toggleMode(tab.value)"
            >
              <UiIcon :name="tab.icon" :size="13" />
            </button>
            <button class="launcher-btn ghost" title="置顶" @click="current && togglePin(current)">
              <UiIcon name="pin" :size="13" :class="current?.pinned ? 'text-accent' : ''" />
            </button>
            <button class="launcher-btn ghost text-danger" title="删除这篇笔记" @click="current && removeNote(current)">
              <UiIcon name="trash" :size="13" />
            </button>
          </div>
        </div>

        <div class="flex min-h-0 flex-1">
          <textarea
            v-if="mode !== 'preview'"
            ref="editorEl"
            v-model="content"
            class="md-editor launcher-scroll min-h-0 flex-1 resize-none border-0 bg-transparent px-3 py-2 text-fg outline-none"
            :class="mode === 'split' ? 'w-1/2 border-r border-line' : 'w-full'"
            placeholder="支持 Markdown：标题 #、**粗体**、`代码`、列表、表格、任务清单…"
            spellcheck="false"
          />
          <!-- 渲染器已把源码整体转义，这里输出的是自己拼的标签 -->
          <div
            v-if="mode !== 'edit'"
            class="launcher-scroll md-body min-h-0 flex-1 px-3 py-2"
            :class="mode === 'split' ? 'w-1/2' : 'w-full'"
            v-html="previewHtml"
          />
        </div>

        <div class="flex items-center gap-3 border-t border-line px-3 py-1 text-[11px] text-faint">
          <span>{{ stats.words }} 字 / {{ stats.lines }} 行</span>
          <span>{{ saving ? '保存中…' : savedAt ? `已保存 ${relativeTime(savedAt, now)}` : '尚未改动' }}</span>
          <span class="ml-auto">{{ modLabel }}B 粗体 · {{ modLabel }}I 斜体 · {{ modLabel }}K 链接 · Tab 缩进</span>
        </div>
      </section>
    </div>

    <footer class="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[11.5px] text-faint">
      <span><span class="launcher-kbd">{{ modLabel }}S</span> 保存</span>
      <span><span class="launcher-kbd">{{ modLabel }}1/2/3</span> 编辑 / 分栏 / 预览</span>
      <span><span class="launcher-kbd">{{ modLabel }}N</span> 新建</span>
      <span class="ml-auto">自动保存（停笔 0.5 秒）</span>
    </footer>
  </AppShell>
</template>
