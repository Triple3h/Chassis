<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import AppShell from '@launcher/ui/AppShell.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import UiDialog from '@launcher/ui/UiDialog.vue'
import { useToast } from '@launcher/ui/toast'
import { copyText } from '@launcher/ui/clipboard'
import { isTypingTarget, matchKey, modLabel } from '@launcher/ui/keys'
import { useVirtualList } from '@launcher/ui/virtual'
import { host, hostUi } from '@launcher/api'
import * as api from './core/api'
import type { HistoryEntry, KindFilter } from './core/types'
import { KIND_TABS, detailOf, formatDateTime, formatTime, kindIcon, pauseLabel } from './core/format'

const ROW_HEIGHT = 52

const inHost = host.isLauncher()
const entries = ref<HistoryEntry[]>([])
const total = ref(0)
const pausedUntil = ref(0)
const loaded = ref(false)
const error = ref('')
const query = ref('')
const kind = ref<KindFilter>('all')
const selectedId = ref('')
const listEl = ref<HTMLElement | null>(null)
const searchEl = ref<HTMLInputElement | null>(null)
const preview = ref<{ entry: HistoryEntry; data: string } | null>(null)
const toast = useToast()

const selected = computed(() => entries.value.find((entry) => entry.id === selectedId.value) ?? null)
const selectedIndex = computed(() => entries.value.findIndex((entry) => entry.id === selectedId.value))
const pausedText = computed(() => pauseLabel(pausedUntil.value, Date.now()))

const { startIndex, endIndex, offsetY, totalHeight, scrollToIndex } = useVirtualList(listEl, {
  count: computed(() => entries.value.length),
  rowHeight: ROW_HEIGHT,
})
const rows = computed(() => entries.value.slice(startIndex.value, endIndex.value))

let timer = 0
let clock = 0

/* ------------------------------------------------------------- 读写 */

async function load(): Promise<void> {
  if (!inHost) {
    loaded.value = true
    return
  }
  const res = await api.list(query.value, kind.value)
  if (!res) {
    error.value = '读不到剪贴板历史（宿主不可用或脚本失败）'
    loaded.value = true
    return
  }
  if (!res.ok) {
    error.value = res.error ?? '读取失败'
    loaded.value = true
    return
  }
  entries.value = res.entries
  total.value = res.total
  pausedUntil.value = res.pausedUntil
  error.value = ''
  loaded.value = true
  if (entries.value.length && !entries.value.some((entry) => entry.id === selectedId.value)) {
    selectedId.value = entries.value[0].id
  }
}

/** 打字期间别每次按键都 spawn 一个子进程 */
function scheduleLoad(): void {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => void load(), 150)
}

/* ------------------------------------------------------------- 操作 */

async function paste(entry?: HistoryEntry | null): Promise<void> {
  const target = entry ?? selected.value
  if (!target) return
  const res = await api.paste(target.id)
  if (!res?.ok) {
    // 逻辑层写不了（多半是非 Windows）就退回浏览器剪贴板，至少文本还能带走
    if (target.text && (await copyText(target.text))) {
      toast.ok('已复制到剪贴板（文本）')
      return
    }
    toast.err(res?.error ?? '贴回失败')
    return
  }
  toast.ok(target.kind === 'text' ? '已贴回剪贴板' : target.kind === 'image' ? '图片已放回剪贴板' : '文件已放回剪贴板')
  void load()
}

async function togglePin(entry?: HistoryEntry | null): Promise<void> {
  const target = entry ?? selected.value
  if (!target) return
  const res = await api.pin(target.id, !target.pinned)
  if (!res?.ok) {
    toast.err(res?.error ?? '固定失败')
    return
  }
  toast.info(target.pinned ? '已取消固定' : '已固定')
  void load()
}

async function remove(entry?: HistoryEntry | null): Promise<void> {
  const target = entry ?? selected.value
  if (!target) return
  const res = await api.remove(target.id)
  if (!res?.ok) {
    toast.err(res?.error ?? '删除失败')
    return
  }
  if (selectedId.value === target.id) selectedId.value = ''
  preview.value = null
  await load()
}

async function clearAll(): Promise<void> {
  const pinnedCount = entries.value.filter((entry) => entry.pinned).length
  // 有固定项时先只清未固定的（固定项就是「不想丢」的那几条）
  const res = await api.clear(false)
  if (!res?.ok) {
    toast.err(res?.error ?? '清空失败')
    return
  }
  const kept = res.total ?? 0
  toast.ok(pinnedCount ? `已清空 ${total.value - kept} 条（保留 ${kept} 条固定项）` : '已清空')
  void load()
}

async function setPause(minutes: number): Promise<void> {
  const res = await api.pause(minutes)
  if (!res?.ok) {
    toast.err(res?.error ?? '操作失败')
    return
  }
  pausedUntil.value = res.pausedUntil ?? 0
  toast.info(minutes === 0 ? '已恢复记录' : minutes < 0 ? '已暂停记录（记得手动恢复）' : `已暂停 ${minutes} 分钟`)
}

async function openPreview(entry: HistoryEntry): Promise<void> {
  if (entry.kind !== 'image') return
  const res = await api.image(entry.id)
  if (!res?.ok || !res.data) {
    toast.err(res?.error ?? '读不到缩略图')
    return
  }
  preview.value = { entry, data: res.data }
}

function moveSelection(delta: number): void {
  const list = entries.value
  if (!list.length) return
  const current = selectedIndex.value
  const next = Math.min(list.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta))
  selectedId.value = list[next].id
  scrollToIndex(next)
}

/* ------------------------------------------------------------- 键盘 */

function onKeydown(event: KeyboardEvent): void {
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
  if (isTypingTarget(event.target)) return
  if (event.key === 'Enter') {
    event.preventDefault()
    void paste()
    return
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    void remove()
    return
  }
  if (matchKey(event, 'Mod+p')) {
    event.preventDefault()
    void togglePin()
    return
  }
  if (matchKey(event, 'Mod+shift+c')) {
    event.preventDefault()
    void paste()
  }
}

/** 搜索框里按 Esc：先清搜索词（消费掉这次按键），没有搜索词再交还宿主 */
function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !query.value) return
  event.preventDefault()
  event.stopPropagation()
  query.value = ''
  void load()
}

/* ------------------------------------------------------------- footer */

async function syncFooter(): Promise<void> {
  if (!inHost) return
  await hostUi
    .setFooter([
      {
        type: 'button',
        id: 'paste',
        label: '贴回',
        icon: 'copy',
        keys: ['Enter'],
        onClick: () => void paste(),
      },
      {
        type: 'button',
        id: 'pin',
        label: selected.value?.pinned ? '取消固定' : '固定',
        icon: 'pin',
        keys: [`${modLabel}+P`],
        onClick: () => void togglePin(),
      },
      {
        type: 'action-panel',
        id: 'more',
        label: '更多',
        icon: 'sliders',
        keys: [`${modLabel}+K`],
        title: '历史操作',
        items: [
          {
            id: 'preview',
            name: '预览选中条目',
            icon: 'eye',
            onSelect: () => selected.value && void openPreview(selected.value),
          },
          { id: 'delete', name: '删除选中条目', icon: 'trash', onSelect: () => void remove() },
          { id: 'clear', name: '清空（保留固定项）', icon: 'trash', onSelect: () => void clearAll() },
          {
            id: 'pause5',
            name: '暂停记录 5 分钟',
            icon: 'timer',
            onSelect: () => void setPause(5),
          },
          {
            id: 'pause30',
            name: '暂停记录 30 分钟',
            icon: 'timer',
            onSelect: () => void setPause(30),
          },
          { id: 'resume', name: '恢复记录', icon: 'play', onSelect: () => void setPause(0) },
        ],
      },
    ])
    .catch(() => undefined)
}

watch([selected, pausedUntil], () => void syncFooter())
watch(kind, () => void load())

/* ------------------------------------------------------------- 生命周期 */

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  // 「暂停到某个时刻」是倒计时：过点了要自己把提示去掉（1 秒一次足够）
  clock = window.setInterval(() => {
    if (pausedUntil.value && pausedUntil.value <= Date.now()) pausedUntil.value = 0
  }, 1000)
  if (inHost) {
    const seed = (await hostUi.getSearchContent().catch(() => '')).trim()
    if (seed && !seed.startsWith('剪贴板')) query.value = seed
  }
  await load()
  void syncFooter()
  void nextTick(() => searchEl.value?.focus())
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.clearTimeout(timer)
  window.clearInterval(clock)
})
</script>

<template>
  <AppShell>
    <header class="flex items-center gap-2 border-b border-line px-3 py-2">
      <UiIcon name="clipboard" :size="16" class="text-accent" />
      <span class="text-[13px] font-semibold">剪贴板历史</span>
      <span class="launcher-chip">{{ entries.length }} / {{ total }}</span>
      <span v-if="pausedText" class="launcher-chip text-accent">{{ pausedText }}</span>
      <div class="ml-auto flex items-center gap-1.5">
        <button class="launcher-btn ghost" :title="pausedText ? '恢复记录' : '暂停记录 30 分钟'" @click="setPause(pausedUntil ? 0 : 30)">
          <UiIcon :name="pausedUntil ? 'play' : 'stop'" :size="13" />
          {{ pausedUntil ? '恢复记录' : '暂停记录' }}
        </button>
        <button class="launcher-btn ghost" @click="clearAll">
          <UiIcon name="trash" :size="13" />
          清空
        </button>
      </div>
    </header>

    <!-- 搜索与筛选 -->
    <div class="flex items-center gap-1.5 border-b border-line px-3 py-2">
      <UiIcon name="search" :size="14" class="text-faint" />
      <input
        ref="searchEl"
        v-model="query"
        class="launcher-input min-w-0 flex-1"
        placeholder="搜索历史（回车贴回选中项）"
        @input="scheduleLoad"
        @keydown="onSearchKeydown"
      />
      <button
        v-for="tab in KIND_TABS"
        :key="tab.value"
        class="launcher-btn ghost shrink-0"
        :class="kind === tab.value ? 'bg-active text-accent' : ''"
        @click="kind = tab.value"
      >
        {{ tab.label }}
      </button>
    </div>

    <p v-if="!inHost" class="border-b border-line px-3 py-2 text-[11.5px] text-accent">
      这个插件要在启动台里运行：剪贴板的读取与写回由 Windows 上的逻辑层命令完成，浏览器里只能看界面。
    </p>
    <p v-else-if="error" class="border-b border-line px-3 py-2 text-[11.5px] text-danger">{{ error }}</p>

    <!-- 列表（虚拟滚动） -->
    <div ref="listEl" class="launcher-scroll min-h-0 flex-1">
      <div :style="{ height: `${totalHeight}px`, position: 'relative' }">
        <div :style="{ transform: `translateY(${offsetY}px)` }">
          <div
            v-for="entry in rows"
            :key="entry.id"
            class="group flex items-center gap-2.5 border-b border-line px-3"
            :style="{ height: `${ROW_HEIGHT}px` }"
            :class="selectedId === entry.id ? 'bg-active' : 'hover:bg-hover'"
            @click="selectedId = entry.id"
            @dblclick="paste(entry)"
          >
            <UiIcon :name="kindIcon(entry.kind)" :size="15" class="shrink-0 text-muted" />

            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="truncate text-[12.5px]">{{ entry.title }}</span>
                <span v-if="entry.pinned" class="launcher-chip shrink-0 text-accent">固定</span>
                <span v-if="entry.uses > 1" class="launcher-chip shrink-0">用过 {{ entry.uses }} 次</span>
              </div>
              <div class="truncate text-[10.5px] text-faint">
                <span class="text-muted">{{ detailOf(entry) || entry.subtitle }}</span>
                <span class="ml-1.5">{{ formatDateTime(entry.createdAt) }}</span>
              </div>
            </div>

            <button
              v-if="entry.kind === 'image'"
              class="launcher-btn ghost shrink-0 opacity-0 group-hover:opacity-100"
              title="预览"
              @click.stop="openPreview(entry)"
            >
              <UiIcon name="eye" :size="12" />
            </button>
            <button class="launcher-btn ghost shrink-0 opacity-0 group-hover:opacity-100" title="贴回剪贴板" @click.stop="paste(entry)">
              <UiIcon name="copy" :size="12" />
            </button>
            <button
              class="launcher-btn ghost shrink-0 opacity-0 group-hover:opacity-100"
              :class="entry.pinned ? 'text-accent' : ''"
              :title="entry.pinned ? '取消固定' : '固定'"
              @click.stop="togglePin(entry)"
            >
              <UiIcon name="pin" :size="12" />
            </button>
            <button class="launcher-btn ghost shrink-0 text-danger opacity-0 group-hover:opacity-100" title="删除" @click.stop="remove(entry)">
              <UiIcon name="trash" :size="12" />
            </button>
          </div>
        </div>
      </div>

      <div v-if="!entries.length" class="flex flex-col items-center gap-2 px-6 py-10 text-center text-faint">
        <UiIcon name="clipboard" :size="24" />
        <p class="text-[12.5px]">
          {{
            !loaded
              ? '正在读取…'
              : !inHost
                ? '请在启动台里打开这个插件'
                : query || kind !== 'all'
                  ? '没有匹配的历史'
                  : '还没有记录：随便复制点什么，它就会出现在这里'
          }}
        </p>
        <p v-if="loaded && inHost && !query" class="text-[11px]">记录由启动台在后台完成，不需要你手动保存</p>
      </div>
    </div>

    <footer class="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[11.5px] text-faint">
      <span><span class="launcher-kbd">Enter</span> 贴回</span>
      <span><span class="launcher-kbd">↑↓</span> 选择</span>
      <span><span class="launcher-kbd">{{ modLabel }}P</span> 固定</span>
      <span><span class="launcher-kbd">Del</span> 删除</span>
      <span class="ml-auto">双击一行也能贴回</span>
    </footer>

    <UiDialog
      v-if="preview"
      :title="preview.entry.title"
      :subtitle="`${preview.entry.subtitle} · ${formatTime(preview.entry.createdAt)}`"
      size="wide"
      @close="preview = null"
    >
      <div class="flex flex-col items-center gap-3">
        <img
          :src="`data:image/png;base64,${preview.data}`"
          :alt="preview.entry.title"
          class="max-h-[52vh] max-w-full rounded-lg border border-line object-contain"
        />
        <p class="text-[11px] text-faint">历史里存的是缩略图（长边 1024），原图不落盘</p>
      </div>
      <template #footer>
        <button class="launcher-btn primary" @click="paste(preview?.entry)">
          <UiIcon name="copy" :size="12" />
          贴回剪贴板
        </button>
        <button class="launcher-btn ghost" @click="preview = null">关闭</button>
      </template>
    </UiDialog>
  </AppShell>
</template>
