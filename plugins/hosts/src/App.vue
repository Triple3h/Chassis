<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, triggerRef } from 'vue'
import AppShell from '@shared/ui/AppShell.vue'
import UiIcon from '@shared/ui/UiIcon.vue'
import { copyText } from '@shared/lib/clipboard'
import { isMod, isTypingTarget, modLabel } from '@shared/lib/keys'
import { exec, host, hostUi } from '@launcher/api'
import { useToast } from '@shared/lib/toast'
import { useVirtualList } from '@shared/lib/virtual'
import EntryDialog from './components/EntryDialog.vue'
import EntryRow from './components/EntryRow.vue'
import PasteDialog from './components/PasteDialog.vue'
import SaveDialog from './components/SaveDialog.vue'
import SnapshotDialog from './components/SnapshotDialog.vue'
import {
  appendEntries,
  findConflicts,
  isDirty as lineDirty,
  isProtectedEntry,
  parseImportText,
  removeEntry,
  restoreLine,
  statsOf,
  updateEntry,
  type EntryFields,
  type EntryLine,
  type HostsDoc,
  type RemovedLine,
} from './core/hosts'
import { runParseHosts, runSerializeHosts } from './core/runner'
import type { HostsReadResult, HostsWriteResult } from './core/script-types'
import { loadSnapshots, persistSnapshots, pushSnapshot, removeSnapshot, type Snapshot } from './core/snapshots'

/** 列表行高，必须与 EntryRow 里的 h-10 一致 */
const ROW_HEIGHT = 40
/** 提权对话框要等用户输密码，超时给足 */
const WRITE_TIMEOUT = 180_000

/** 没有宿主时（浏览器里 npm run dev）用的演示内容 */
const DEMO_TEXT = `##
# Host Database
#
# 演示模式：没检测到启动台宿主，所有改动不会写进系统文件
##
127.0.0.1\tlocalhost
255.255.255.255\tbroadcasthost
::1             localhost

# 开发环境
127.0.0.1  dev.example.com
# 10.0.0.5  api.example.com
`

const loading = ref(true)
const fileInfo = shallowRef<HostsReadResult | null>(null)
const doc = shallowRef<HostsDoc | null>(null)
const originalText = ref('')
const removed = shallowRef<RemovedLine[]>([])
const demoMode = ref(false)
/** shallowRef 的文档改动不会自动触发渲染，靠这个版本号把更新推下去 */
const version = ref(0)

const query = ref('')
const filter = ref<'all' | 'enabled' | 'disabled' | 'dirty'>('all')
const snapshots = ref<Snapshot[]>([])

const editing = shallowRef<{ line: EntryLine | null; preset: Partial<EntryFields> | null } | null>(null)
const showPaste = ref(false)
const showSnapshots = ref(false)
const showSave = ref(false)
const savePhase = ref<'preview' | 'writing' | 'manual' | 'done'>('preview')
const writeResult = shallowRef<HostsWriteResult | null>(null)
const nextText = ref('')

const searchRef = ref<HTMLInputElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const toast = useToast()

/* ------------------------------------------------------------ 派生数据 */

const entries = computed(() => doc.value?.lines.filter((l): l is EntryLine => l.kind === 'entry') ?? [])

const stats = computed(() =>
  doc.value ? statsOf(doc.value) : { total: 0, enabled: 0, disabled: 0, dirty: 0, added: 0 },
)

/** 改动数 = 改过的条目 + 删掉的条目 */
const changeCount = computed(() => stats.value.dirty + removed.value.length)
const isDirty = computed(() => changeCount.value > 0)

const conflicts = computed(() => (doc.value ? findConflicts(doc.value) : new Map<string, string[]>()))
const conflictedIds = computed(() => {
  const ids = new Set<string>()
  for (const list of conflicts.value.values()) for (const id of list) ids.add(id)
  return ids
})

const filtered = computed(() => {
  let list = entries.value
  if (filter.value === 'enabled') list = list.filter((l) => !l.disabled)
  else if (filter.value === 'disabled') list = list.filter((l) => l.disabled)
  else if (filter.value === 'dirty') list = list.filter((l) => lineDirty(l))

  const q = query.value.trim().toLowerCase()
  if (!q) return list
  return list.filter(
    (l) =>
      l.ip.toLowerCase().includes(q) ||
      l.comment.toLowerCase().includes(q) ||
      l.names.some((n) => n.toLowerCase().includes(q)),
  )
})

const filterChips = computed(() => [
  { v: 'all' as const, t: '全部', n: stats.value.total },
  { v: 'enabled' as const, t: '启用', n: stats.value.enabled },
  { v: 'disabled' as const, t: '禁用', n: stats.value.disabled },
  { v: 'dirty' as const, t: '已改动', n: stats.value.dirty },
])

const listCount = computed(() => filtered.value.length)
const { startIndex, endIndex, offsetY, totalHeight, scrollToIndex } = useVirtualList(scroller, {
  count: listCount,
  rowHeight: ROW_HEIGHT,
})
const windowRows = computed(() => filtered.value.slice(startIndex.value, endIndex.value))

const path = computed(() => fileInfo.value?.path ?? '/etc/hosts')
const platform = computed(() => fileInfo.value?.platform ?? 'darwin')
const placeholder = computed(() => (demoMode.value ? '搜索域名 / IP / 备注（演示模式）' : '搜索域名 / IP / 备注'))
const unparsed = computed(() => doc.value?.unparsed ?? 0)

/* -------------------------------------------------------------- 生命周期 */

let stopSearchWatch: (() => void) | null = null

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  snapshots.value = await loadSnapshots()
  await reload()
  loading.value = false

  void registerFooter()
  void syncSearchContent()
  stopSearchWatch = hostUi.watchSearchContent((value) => {
    query.value = value
  })
})

onUnmounted(() => {
  stopSearchWatch?.()
  window.removeEventListener('keydown', onKeydown)
})

/** 宿主搜索框的内容：当作过滤词；如果本身是一条 host 记录就直接进新建流程 */
async function syncSearchContent() {
  const initial = (await hostUi.getSearchContent()).trim()
  if (!initial) return
  query.value = initial
  const parsed = parseImportText(initial)
  if (parsed.entries.length === 1 && !parsed.skipped.length) {
    query.value = ''
    editing.value = { line: null, preset: parsed.entries[0] }
    void hostUi.clearSearchContent()
  }
}

function onKeydown(e: KeyboardEvent) {
  if (isMod(e) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void openSave()
    return
  }
  if (isMod(e) && e.key.toLowerCase() === 'n') {
    e.preventDefault()
    onCreate()
    return
  }
  if (isMod(e) && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    searchRef.value?.focus()
    return
  }
  if (isMod(e) && e.key.toLowerCase() === 'z' && !isTypingTarget(e.target)) {
    e.preventDefault()
    undoRemove()
  }
}

async function registerFooter() {
  await hostUi.setFooter([
    { type: 'button', label: '新增记录', icon: 'plus', keys: ['Mod+N'], onClick: () => onCreate() },
    { type: 'button', label: '保存到系统', icon: 'save', keys: ['Mod+S'], onClick: () => void openSave() },
  ])
}

/* ------------------------------------------------------------------ 载入 */

async function applyText(text: string) {
  doc.value = await runParseHosts(text)
  originalText.value = text
  removed.value = []
  version.value++
}

/**
 * 宿主会用 `?sid=` 加载 iframe，没带就一定是本地浏览器直接打开的，
 * 这种情况不必去等 script 的长超时，直接亮演示内容。
 */
async function isHosted(): Promise<boolean> {
  return host.isLauncher()
}

async function reload(notify = false) {
  if (!(await isHosted())) {
    // 没有宿主：进演示模式，界面功能全部可用，只是写不进系统文件
    demoMode.value = true
    fileInfo.value = null
    await applyText(DEMO_TEXT)
    return
  }

  const res = (await exec
    .run({ command: 'hosts-read', args: {}, timeoutMs: 15_000 })
    .catch(() => null)) as HostsReadResult | null

  if (!res) {
    // 宿主在但不认这个脚本（版本太旧）：同样退到演示模式，别让界面空着
    demoMode.value = true
    fileInfo.value = null
    await applyText(DEMO_TEXT)
    return
  }

  if (!res.ok) {
    fileInfo.value = res
    demoMode.value = false
    await applyText('')
    toast.err(res.error ?? '读取 hosts 失败')
    return
  }

  demoMode.value = false
  fileInfo.value = res
  await applyText(res.content)
  if (notify) toast.ok('已重新读取')
}

/* ------------------------------------------------------------ 条目操作 */

function touch() {
  version.value++
  if (doc.value) triggerRef(doc)
}

function onCreate() {
  editing.value = { line: null, preset: null }
}

function onEdit(line: EntryLine) {
  editing.value = { line, preset: null }
}

function onToggle(line: EntryLine) {
  if (!doc.value) return
  updateEntry(doc.value, line.id, { disabled: !line.disabled })
  touch()
}

function onRemove(line: EntryLine): boolean {
  if (!doc.value) return false
  if (isProtectedEntry(line) && !window.confirm(`「${line.names.join(' ')}」是本机解析要用的系统记录，确定删除？`)) {
    return false
  }
  const taken = removeEntry(doc.value, line.id)
  if (!taken) return false
  removed.value = [...removed.value, taken]
  touch()
  toast.info(`已删除，可用 ${modLabel}Z 撤销`)
  return true
}

function undoRemove() {
  const last = removed.value[removed.value.length - 1]
  if (!doc.value || !last) return
  restoreLine(doc.value, last)
  removed.value = removed.value.slice(0, -1)
  touch()
}

async function submitEntry(fields: EntryFields) {
  if (!doc.value || !editing.value) return
  const target = editing.value.line
  const isNew = !target
  if (target) {
    updateEntry(doc.value, target.id, fields)
  } else {
    appendEntries(doc.value, [fields])
  }
  touch()
  editing.value = null
  if (isNew) {
    // 新记录追加在列表末尾，滚过去让用户看见
    await nextTick()
    scrollToIndex(Math.max(0, filtered.value.length - 1), 'center')
  }
}

function removeEditing() {
  const line = editing.value?.line
  if (!line) {
    editing.value = null
    return
  }
  // 用户在确认框里点了取消就保持弹窗打开，别把编辑到一半的内容一起关掉
  if (onRemove(line)) editing.value = null
}

async function submitPaste(payload: { entries: EntryFields[]; replace: boolean }) {
  if (!doc.value) return
  showPaste.value = false

  if (payload.replace) {
    const text = `${payload.entries.map((e) => `${e.disabled ? '# ' : ''}${e.ip}\t${e.names.join(' ')}`).join('\n')}\n`
    const before = originalText.value
    await applyText(text)
    // 「替换全文」是一次改动，不能把原文也顶成新内容，否则保存按钮一直不亮
    originalText.value = before
  } else {
    appendEntries(doc.value, payload.entries)
    touch()
    await nextTick()
    scrollToIndex(Math.max(0, filtered.value.length - 1), 'center')
  }

  toast.ok(`已导入 ${payload.entries.length} 条，别忘了点保存`)
}

/* ------------------------------------------------------------------ 保存 */

async function openSave() {
  if (!doc.value || !isDirty.value) {
    if (!isDirty.value) toast.info('没有需要保存的改动')
    return
  }
  nextText.value = await runSerializeHosts(doc.value)
  writeResult.value = null
  savePhase.value = 'preview'
  showSave.value = true
}

async function addAutoSnapshot(content: string, entryCount: number) {
  const now = new Date()
  snapshots.value = pushSnapshot(snapshots.value, {
    name: `写入前 · ${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
    kind: 'auto',
    content,
    entries: entryCount,
  })
  await persistSnapshots(snapshots.value)
}

async function confirmWrite() {
  if (!doc.value) return
  const before = originalText.value
  const entryCount = stats.value.total
  savePhase.value = 'writing'

  const res = (await exec
    .run({ command: 'hosts-write', args: { content: nextText.value }, timeoutMs: WRITE_TIMEOUT })
    .catch(() => null)) as HostsWriteResult | null

  if (!res) {
    // 演示模式：留个快照，让用户至少能带走内容
    await addAutoSnapshot(before, entryCount)
    showSave.value = false
    savePhase.value = 'done'
    toast.info('演示模式：内容未写入系统文件')
    return
  }

  writeResult.value = res

  if (res.ok) {
    await addAutoSnapshot(before, entryCount)
    showSave.value = false
    savePhase.value = 'done'
    toast.ok(res.method === 'privileged' ? '已通过管理员授权写入' : '已写入系统')
    await reload()
    return
  }

  if (res.method === 'manual') {
    // 内容已落盘，只差用户执行一条命令
    await addAutoSnapshot(before, entryCount)
    savePhase.value = 'manual'
    return
  }

  showSave.value = false
  savePhase.value = 'done'
  toast.err(res.error ?? '写入失败')
}

/* ------------------------------------------------------------------ 快照 */

async function saveSnapshot(name: string) {
  if (!doc.value) return
  const text = await runSerializeHosts(doc.value)
  snapshots.value = pushSnapshot(snapshots.value, {
    name,
    kind: 'manual',
    content: text,
    entries: stats.value.total,
  })
  await persistSnapshots(snapshots.value)
  toast.ok('已存档')
}

async function loadSnapshot(snap: Snapshot) {
  const before = originalText.value
  await applyText(snap.content)
  // originalText 记的是「系统文件里现在是什么」，载入快照不该动它，
  // 否则载入完就变成「无改动」，用户没法把快照写回系统
  originalText.value = before
  showSnapshots.value = false
  toast.info('已载入到编辑器，点保存才会写入系统')
}

async function dropSnapshot(id: string) {
  snapshots.value = removeSnapshot(snapshots.value, id)
  await persistSnapshots(snapshots.value)
}

/* ------------------------------------------------------------------ 其它 */

async function copyPath() {
  if (await copyText(path.value)) toast.ok('路径已复制')
}
</script>

<template>
  <AppShell>
    <!-- 顶栏 -->
    <header class="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
      <span class="text-accent"><UiIcon name="sliders" :size="15" /></span>
      <span class="shrink-0 text-[13px] font-semibold">Hosts 管家</span>

      <button class="launcher-chip max-w-[190px] truncate" :title="path" @click="copyPath">
        <UiIcon name="file" :size="11" />
        {{ path }}
      </button>

      <span v-if="demoMode" class="launcher-chip text-warn" title="没检测到启动台宿主，改动不会写进系统文件">
        <UiIcon name="alert" :size="11" /> 演示模式
      </span>
      <span
        v-else-if="fileInfo && !fileInfo.writable"
        class="launcher-chip text-warn"
        title="当前进程没有写权限，保存时会请求管理员授权"
      >
        <UiIcon name="lock" :size="11" /> 需授权
      </span>

      <div class="relative min-w-0 flex-1">
        <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint">
          <UiIcon name="search" :size="13" />
        </span>
        <input ref="searchRef" v-model="query" class="launcher-input pl-7" :placeholder="placeholder" />
      </div>

      <button class="launcher-btn" title="新增记录（⌘N）" @click="onCreate">
        <UiIcon name="plus" :size="12" /> 新建
      </button>
      <button class="launcher-btn" title="批量粘贴" @click="showPaste = true">
        <UiIcon name="clipboard" :size="13" />
      </button>
      <button class="launcher-btn" title="快照与回滚" @click="showSnapshots = true">
        <UiIcon name="history" :size="13" />
      </button>
      <button class="launcher-btn" title="重新读取系统文件" @click="reload(true)">
        <UiIcon name="refresh" :size="13" />
      </button>
    </header>

    <!-- 工具条 -->
    <div class="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-3">
      <button
        v-for="chip in filterChips"
        :key="chip.v"
        class="launcher-btn"
        :class="{ primary: filter === chip.v }"
        @click="filter = chip.v"
      >
        {{ chip.t }} <span class="opacity-60">{{ chip.n }}</span>
      </button>

      <div class="flex-1" />

      <span v-if="unparsed" class="text-[11.5px] text-faint" :title="`${unparsed} 行读不出 IP 和域名，会原样保留`">
        {{ unparsed }} 行原样保留
      </span>
      <button v-if="removed.length" class="launcher-btn" @click="undoRemove">
        <UiIcon name="history" :size="12" /> 撤销删除 ({{ removed.length }})
      </button>
      <span v-if="changeCount" class="text-[11.5px] text-muted">{{ changeCount }} 处改动</span>
      <button class="launcher-btn primary" :disabled="!isDirty" @click="openSave">
        <UiIcon name="save" :size="12" /> 保存
      </button>
    </div>

    <!-- 列表 -->
    <div ref="scroller" class="launcher-scroll min-h-0 flex-1">
      <div v-if="loading" class="flex h-full items-center justify-center text-[12.5px] text-muted">正在读取…</div>

      <div v-else-if="!filtered.length" class="flex h-full flex-col items-center justify-center gap-2.5 text-muted">
        <UiIcon name="file" :size="22" class="text-faint" />
        <div class="text-[12.5px]">
          {{ query || filter !== 'all' ? '没有匹配的记录' : '这个 hosts 文件是空的' }}
        </div>
        <button v-if="!query && filter === 'all'" class="launcher-btn" @click="onCreate">
          <UiIcon name="plus" :size="12" /> 添加第一条
        </button>
      </div>

      <div v-else class="relative" :style="{ height: `${totalHeight}px` }">
        <div class="absolute inset-x-0" :style="{ transform: `translateY(${offsetY}px)` }">
          <EntryRow
            v-for="line in windowRows"
            :key="line.id"
            :line="line"
            :version="version"
            :conflict="conflictedIds.has(line.id)"
            @toggle="onToggle(line)"
            @edit="onEdit(line)"
            @remove="onRemove(line)"
          />
        </div>
      </div>
    </div>

    <!-- 底栏 -->
    <div class="flex h-8 shrink-0 items-center gap-3 border-t border-line px-3 text-[11.5px] text-muted">
      <span>共 {{ stats.total }} 条 · 启用 {{ stats.enabled }} · 禁用 {{ stats.disabled }}</span>
      <span v-if="conflicts.size" class="text-warn" title="同一个域名被分配了多个 IP，hosts 只会以最后一条为准">
        <UiIcon name="alert" :size="11" class="mr-1 inline" />
        {{ conflicts.size }} 个域名指向了多个 IP
      </span>
      <div class="flex-1" />
      <span v-if="fileInfo && fileInfo.encoding === 'binary'" class="text-warn">文件不是 UTF-8，中文可能显示异常</span>
      <span class="text-faint">{{ modLabel }}N 新建 · {{ modLabel }}S 保存 · {{ modLabel }}F 搜索</span>
    </div>

    <EntryDialog
      v-if="editing"
      :line="editing.line"
      :preset="editing.preset"
      @close="editing = null"
      @submit="submitEntry"
      @remove="removeEditing"
    />

    <PasteDialog v-if="showPaste" @close="showPaste = false" @submit="submitPaste" />

    <SnapshotDialog
      v-if="showSnapshots"
      :snapshots="snapshots"
      :current-entries="stats.total"
      @close="showSnapshots = false"
      @save="saveSnapshot"
      @load="loadSnapshot"
      @remove="dropSnapshot"
    />

    <SaveDialog
      v-if="showSave"
      :prev-text="originalText"
      :next-text="nextText"
      :path="path"
      :writable="!!fileInfo?.writable || demoMode"
      :platform="platform"
      :phase="savePhase"
      :result="writeResult"
      @close="showSave = false"
      @confirm="confirmWrite"
    />
  </AppShell>
</template>
