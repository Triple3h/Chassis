<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import AppShell from '@launcher/ui/AppShell.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import { useToast } from '@launcher/ui/toast'
import { isTypingTarget, matchKey, modLabel } from '@launcher/ui/keys'
import { useVirtualList } from '@launcher/ui/virtual'
import { copyText, downloadBlob } from '@launcher/ui/clipboard'
import { clipboard, host, hostUi } from '@launcher/api'
import type { Snip, SnipKind } from './core/types'
import type { SnipInput } from './core/snips'
import { KIND_ICON, KIND_LABEL, applyEdit, createSnip, filterSnips, relativeTime, summarize, touch } from './core/snips'
import { dataUrlToBlob, imageFileName } from './core/images'
import { loadSnips, saveSnips } from './core/store'
import SnipDialog from './components/SnipDialog.vue'

const ROW_HEIGHT = 64

const items = ref<Snip[]>([])
const loaded = ref(false)
const query = ref('')
const kind = ref<SnipKind | 'all'>('all')
const selectedId = ref('')
const editing = ref<{ snip: Snip | null; preset: SnipInput | null } | null>(null)
/** 启动台搜索框里的内容：非命中的「真内容」才提示存成快贴 */
const searchSeed = ref('')
const now = ref(Date.now())
const searchEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const toast = useToast()

const kindTabs: Array<{ value: SnipKind | 'all'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'text', label: '文本' },
  { value: 'code', label: '代码' },
  { value: 'image', label: '图片' },
]

const filtered = computed(() => filterSnips(items.value, query.value, kind.value))
const selected = computed(() => filtered.value.find((item) => item.id === selectedId.value) ?? filtered.value[0] ?? null)
const totalUses = computed(() => items.value.reduce((sum, item) => sum + item.uses, 0))

const { startIndex, endIndex, offsetY, totalHeight, scrollToIndex } = useVirtualList(listEl, {
  count: computed(() => filtered.value.length),
  rowHeight: ROW_HEIGHT,
})
const visibleRows = computed(() =>
  filtered.value.slice(startIndex.value, endIndex.value).map((item, offset) => ({ item, index: startIndex.value + offset })),
)

watch(
  filtered,
  (list) => {
    if (!list.length) {
      selectedId.value = ''
      return
    }
    if (!list.some((item) => item.id === selectedId.value)) selectedId.value = list[0]?.id ?? ''
  },
  { immediate: true },
)

/* ------------------------------------------------------------- 读写 */

async function load(): Promise<void> {
  items.value = await loadSnips()
  loaded.value = true
}

async function persist(): Promise<void> {
  await saveSnips(items.value)
}

function select(snip: Snip): void {
  selectedId.value = snip.id
}

/* ------------------------------------------------------------- 复制 / 粘贴 */

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

async function copyImageToClipboard(snip: Snip): Promise<boolean> {
  const blob = dataUrlToBlob(snip.content)
  if (!blob) return false
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })])
      return true
    }
  } catch {
    /* 复制图片失败 → 另存为 */
  }
  downloadBlob(imageFileName(snip.title, snip.content, String(Date.now())), blob, blob.type || 'image/png')
  toast.info('系统剪贴板不接受图片，已改为另存为文件')
  return false
}

async function markUsed(snip: Snip): Promise<void> {
  items.value = items.value.map((item) => (item.id === snip.id ? touch(item) : item))
  await persist()
}

/** 一键快速粘贴：写剪贴板 → 收起启动台 → 用户直接 ⌘V 到前台应用 */
async function quickPaste(snip: Snip): Promise<void> {
  const ok = snip.kind === 'image' ? await copyImageToClipboard(snip) : await writeClipboard(snip.content)
  if (!ok) {
    toast.err('复制失败，请手动选择内容')
    return
  }
  await markUsed(snip)
  toast.ok('已复制，粘贴到前台应用即可')
  window.setTimeout(() => void hostUi.hide().catch(() => undefined), 140)
}

async function copyOnly(snip: Snip): Promise<void> {
  const ok = snip.kind === 'image' ? await copyImageToClipboard(snip) : await writeClipboard(snip.content)
  if (!ok) {
    toast.err('复制失败，请手动选择内容')
    return
  }
  await markUsed(snip)
  toast.ok('已复制')
}

async function saveAsFile(snip: Snip): Promise<void> {
  if (snip.kind !== 'image') {
    downloadBlob(`${snip.title}.txt`, snip.content)
    return
  }
  const blob = dataUrlToBlob(snip.content)
  if (!blob) {
    toast.err('图片内容损坏')
    return
  }
  downloadBlob(imageFileName(snip.title, snip.content, String(Date.now())), blob, blob.type || 'image/png')
}

/* ------------------------------------------------------------- 增删改 */

function openCreate(seed = ''): void {
  // seed = 启动台搜索框里的原文：当成「新建」的预填内容，别走编辑路径
  editing.value = { snip: null, preset: seed ? { kind: 'text', title: '', content: seed } : null }
  if (seed) searchSeed.value = ''
}

async function onSave(input: SnipInput): Promise<void> {
  const target = editing.value?.snip ?? null
  if (target) {
    items.value = items.value.map((item) => (item.id === target.id ? applyEdit(item, input) : item))
  } else {
    const snip = createSnip(input)
    items.value = [snip, ...items.value]
    selectedId.value = snip.id
  }
  editing.value = null
  await persist()
  toast.ok(target ? '已保存' : '已加入快贴')
}

async function removeSnip(snip: Snip): Promise<void> {
  items.value = items.value.filter((item) => item.id !== snip.id)
  await persist()
  toast.info('已删除')
}

async function togglePin(snip: Snip): Promise<void> {
  items.value = items.value.map((item) => (item.id === snip.id ? { ...item, pinned: !item.pinned } : item))
  await persist()
}

/* ------------------------------------------------------------- 快捷键 */

function moveSelection(delta: number): void {
  const list = filtered.value
  if (!list.length) return
  const current = list.findIndex((item) => item.id === selected.value?.id)
  const next = Math.min(list.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta))
  const target = list[next]
  if (!target) return
  selectedId.value = target.id
  scrollToIndex(next)
}

function onKeydown(event: KeyboardEvent): void {
  const typing = isTypingTarget(event.target)
  const inTextarea = (event.target as HTMLElement | null)?.tagName === 'TEXTAREA'
  if (matchKey(event, 'Mod+n')) {
    event.preventDefault()
    openCreate()
    return
  }
  if (matchKey(event, 'Mod+e')) {
    event.preventDefault()
    if (selected.value) editing.value = { snip: selected.value, preset: null }
    return
  }
  if (matchKey(event, 'Mod+c') && !typing) {
    event.preventDefault()
    if (selected.value) void copyOnly(selected.value)
    return
  }
  if (matchKey(event, 'Mod+Backspace') && !typing) {
    event.preventDefault()
    if (selected.value) void removeSnip(selected.value)
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
  if (event.key === 'Enter' && !event.shiftKey && !inTextarea) {
    event.preventDefault()
    if (selected.value) void quickPaste(selected.value)
    return
  }
  if (event.key === 'Escape' && query.value) {
    event.preventDefault()
    query.value = ''
  }
}

/* ------------------------------------------------------------- 宿主 footer */

async function syncFooter(): Promise<void> {
  const current = selected.value
  await hostUi
    .setFooter([
      {
        type: 'button',
        id: 'paste',
        label: '复制并粘贴',
        icon: 'Clipboard',
        keys: ['Enter'],
        onClick: () => current && void quickPaste(current),
      },
      { type: 'button', id: 'new', label: '新建', icon: 'Plus', keys: [`${modLabel}+N`], onClick: () => openCreate() },
      {
        type: 'action-panel',
        id: 'more',
        label: '更多',
        icon: 'Sliders',
        keys: [`${modLabel}+K`],
        title: '快贴操作',
        items: [
          { id: 'copy', name: '仅复制', icon: 'Copy', onSelect: () => current && void copyOnly(current) },
          { id: 'edit', name: '编辑', icon: 'FileText', onSelect: () => current && (editing.value = { snip: current, preset: null }) },
          { id: 'pin', name: current?.pinned ? '取消置顶' : '置顶', icon: 'Pin', onSelect: () => current && void togglePin(current) },
          { id: 'save', name: '另存为文件', icon: 'Save', onSelect: () => current && void saveAsFile(current) },
          { id: 'remove', name: '删除', icon: 'Trash', onSelect: () => current && void removeSnip(current) },
        ],
      },
    ])
    .catch(() => undefined)
}

watch(selected, () => void syncFooter())

/* ------------------------------------------------------------- 生命周期 */

let seedWatch: (() => void) | null = null
let clock = 0

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  clock = window.setInterval(() => (now.value = Date.now()), 30_000)
  void syncFooter()
  await load()
  const content = await hostUi.getSearchContent().catch(() => '')
  if (isContentLike(content)) searchSeed.value = content.trim()
  seedWatch = hostUi.watchSearchContent((value) => {
    searchSeed.value = isContentLike(value) ? value.trim() : ''
  })
  await nextTick()
  searchEl.value?.focus()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.clearInterval(clock)
  seedWatch?.()
})

/** 搜索框里是「真内容」而不是我们的命中词时，才值得提示存下来 */
const TRIGGERS = ['快贴', '备忘', '剪贴板', '片段', 'snippet', 'snips', 'clipboard', '常用文本']
function isContentLike(text: string): boolean {
  const value = text.trim()
  if (value.length < 2) return false
  return !TRIGGERS.includes(value.toLowerCase())
}

/** 相对时间那列不跟着输入变，但用一个显式依赖让它随分钟走 */
const tick = computed(() => now.value)
</script>

<template>
  <AppShell>
    <header class="flex items-center gap-2 border-b border-line px-3 py-2">
      <UiIcon name="clipboard" :size="16" class="text-accent" />
      <span class="text-[13px] font-semibold">备忘快贴</span>
      <span class="launcher-chip">{{ items.length }} 条 · 用过 {{ totalUses }} 次</span>
      <div class="ml-auto flex items-center gap-1.5">
        <div class="relative">
          <UiIcon name="search" :size="13" class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
          <input ref="searchEl" v-model="query" class="launcher-input w-[190px] pl-7" placeholder="搜索快贴" />
        </div>
        <button class="launcher-btn primary" @click="openCreate()">
          <UiIcon name="plus" :size="13" />
          新建
        </button>
      </div>
    </header>

    <div class="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5">
      <button
        v-for="tab in kindTabs"
        :key="tab.value"
        class="launcher-btn ghost"
        :class="kind === tab.value ? 'bg-active text-accent' : ''"
        @click="kind = tab.value"
      >
        {{ tab.label }}
      </button>
      <span class="text-[11.5px] text-faint">{{ filtered.length }} 条匹配</span>
      <button v-if="searchSeed" class="launcher-btn ghost ml-auto text-accent" @click="openCreate(searchSeed)">
        <UiIcon name="save" :size="13" />
        存搜索框内容
      </button>
    </div>

    <div class="flex min-h-0 flex-1">
      <!-- 列表：定高虚拟滚动，几百条也不卡 -->
      <div ref="listEl" class="launcher-scroll w-[272px] shrink-0 max-[620px]:w-[200px] border-r border-line">
        <div :style="{ height: `${totalHeight}px`, position: 'relative' }">
          <div :style="{ transform: `translateY(${offsetY}px)` }">
            <button
              v-for="row in visibleRows"
              :key="row.item.id"
              class="flex w-full items-center gap-2 border-b border-line px-3 text-left"
              :style="{ height: `${ROW_HEIGHT}px` }"
              :class="selected?.id === row.item.id ? 'bg-active' : 'hover:bg-hover'"
              @click="select(row.item)"
              @dblclick="quickPaste(row.item)"
            >
              <UiIcon
                :name="KIND_ICON[row.item.kind]"
                :size="14"
                class="shrink-0"
                :class="row.item.pinned ? 'text-accent' : 'text-faint'"
              />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1">
                  <span class="truncate text-[12.5px] font-medium">{{ row.item.title }}</span>
                  <UiIcon v-if="row.item.pinned" name="pin" :size="11" class="shrink-0 text-accent" />
                </div>
                <div class="truncate text-[11px] text-faint">
                  {{ row.item.kind === 'image' ? '图片快贴' : summarize(row.item.content, 42) }}
                </div>
              </div>
              <span class="shrink-0 text-[10.5px] text-faint">{{ relativeTime(row.item.updatedAt, tick) }}</span>
            </button>
          </div>
        </div>
        <div v-if="!filtered.length" class="flex flex-col items-center gap-2 px-4 py-10 text-center text-faint">
          <UiIcon name="clipboard" :size="22" />
          <p class="text-[12px]">
            {{ !loaded ? '正在读取…' : items.length ? '没有匹配的快贴' : '还没有快贴，按 ⌘N 存一条' }}
          </p>
        </div>
      </div>

      <!-- 详情 -->
      <section class="flex min-w-0 flex-1 flex-col">
        <template v-if="selected">
          <div class="flex items-center gap-2 border-b border-line px-3 py-2">
            <UiIcon :name="KIND_ICON[selected.kind]" :size="15" class="text-accent" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-[13px] font-semibold">{{ selected.title }}</div>
              <div class="text-[11px] text-faint">
                {{ KIND_LABEL[selected.kind] }}
                <template v-if="selected.lang"> · {{ selected.lang }}</template>
                · 更新于 {{ relativeTime(selected.updatedAt, tick) }} · 用过 {{ selected.uses }} 次
              </div>
            </div>
            <button class="launcher-btn primary" @click="quickPaste(selected)">
              <UiIcon name="clipboard" :size="13" />
              快速粘贴
            </button>
            <button class="launcher-btn ghost" title="仅复制" @click="copyOnly(selected)">
              <UiIcon name="copy" :size="13" />
            </button>
            <button class="launcher-btn ghost" :title="selected.pinned ? '取消置顶' : '置顶'" @click="togglePin(selected)">
              <UiIcon name="pin" :size="13" :class="selected.pinned ? 'text-accent' : ''" />
            </button>
            <button class="launcher-btn ghost" title="编辑" @click="editing = { snip: selected, preset: null }">
              <UiIcon name="pencil" :size="13" />
            </button>
            <button class="launcher-btn ghost text-danger" title="删除" @click="removeSnip(selected)">
              <UiIcon name="trash" :size="13" />
            </button>
          </div>
          <div class="launcher-scroll min-h-0 flex-1 p-3">
            <img
              v-if="selected.kind === 'image'"
              :src="selected.content"
              class="max-h-full max-w-full rounded-lg border border-line"
              alt=""
            />
            <pre v-else-if="selected.kind === 'code'" class="snips-code text-fg">{{ selected.content }}</pre>
            <pre v-else class="whitespace-pre-wrap break-words text-[13px] leading-6 text-fg">{{ selected.content }}</pre>
          </div>
        </template>
        <div v-else class="flex flex-1 flex-col items-center justify-center gap-2 text-faint">
          <UiIcon name="clipboard" :size="28" />
          <p class="text-[12.5px]">{{ loaded ? `还没有快贴，按 ${modLabel}+N 新建一条` : '正在读取…' }}</p>
          <button v-if="loaded" class="launcher-btn primary" @click="openCreate()">
            <UiIcon name="plus" :size="13" />
            新建快贴
          </button>
        </div>
      </section>
    </div>

    <footer class="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[11.5px] text-faint">
      <span><span class="launcher-kbd">Enter</span> 复制并粘贴</span>
      <span><span class="launcher-kbd">{{ modLabel }}N</span> 新建</span>
      <span><span class="launcher-kbd">{{ modLabel }}E</span> 编辑</span>
      <span class="ml-auto">↑↓ 选择 · 双击条目直接粘贴</span>
    </footer>

    <SnipDialog v-if="editing" :snip="editing.snip" :preset="editing.preset" @close="editing = null" @save="onSave" />
  </AppShell>
</template>
