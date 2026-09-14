<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import ActionsMenu from './components/ActionsMenu.vue'
import DetailPanel from './components/DetailPanel.vue'
import FooterBar from './components/FooterBar.vue'
import PluginView from './components/PluginView.vue'
import ResultList from './components/ResultList.vue'
import SearchBox from './components/SearchBox.vue'
import { api, subscribeEvents } from './lib/api'
import { formatKeys, matchChord } from './lib/keys'
import { useDataStore } from './stores/data'
import { useUiStore, type FooterButtonView, type PluginViewState } from './stores/ui'
import type { ActionResult, ResultItem } from '@launcher/plugin-manifest'
import type { RankedResult, Row } from './lib/types'

const data = useDataStore()
const ui = useUiStore()

const searchBox = ref<InstanceType<typeof SearchBox> | null>(null)
const pluginRef = ref<InstanceType<typeof PluginView> | null>(null)
const listRef = ref<InstanceType<typeof ResultList> | null>(null)
const viewportHeight = ref(420)
let disposeEvents: (() => void) | null = null

const rowHeight = computed(() => (data.config?.density === 'compact' ? 44 : 52))
const pinnedCollapseOver = 8
const recentCollapseOver = 6

/** 扁平行：pinned → best → recent（selected 跨分组连续，requirements §3.2） */
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const query = ui.query.trim()
  const pinned = data.pinnedResults
  const best = data.results
  const recent = data.recentResults

  const pushItems = (list: RankedResult[], group: Row['group']) => {
    for (const item of list) {
      out.push({ kind: 'item', key: `${group}:${item.itemKey}`, group, result: item, index: out.length })
    }
  }

  if (!query) {
    if (pinned.length > 0) {
      const collapsed = !ui.expandedPinned && pinned.length > pinnedCollapseOver
      out.push({
        kind: 'header',
        key: 'h:pinned',
        label: collapsed ? `已固定 (${pinned.length})` : '已固定',
        count: collapsed ? undefined : pinned.length,
        group: 'pinned',
        collapsed,
      })
      pushItems(collapsed ? pinned.slice(0, pinnedCollapseOver) : pinned, 'pinned')
    }
    if (recent.length > 0) {
      const collapsed = !ui.expandedRecent && recent.length > recentCollapseOver
      out.push({
        kind: 'header',
        key: 'h:recent',
        label: collapsed ? `最近使用 (${recent.length})` : '最近使用',
        count: collapsed ? undefined : recent.length,
        group: 'recent',
        collapsed,
      })
      pushItems(collapsed ? recent.slice(0, recentCollapseOver) : recent, 'recent')
    }
    if (out.length === 0) out.push({ kind: 'header', key: 'h:empty', label: '还没有任何记录' })
    return out
  }

  if (pinned.length > 0) {
    out.push({ kind: 'header', key: 'h:pinned', label: '已固定', count: pinned.length, group: 'pinned' })
    pushItems(pinned, 'pinned')
  }
  if (best.length > 0) {
    out.push({ kind: 'header', key: 'h:best', label: '最佳匹配', count: best.length, group: 'best' })
    pushItems(best, 'best')
  }
  if (recent.length > 0) {
    const collapsed = !ui.expandedRecent && recent.length > recentCollapseOver
    out.push({
      kind: 'header',
      key: 'h:recent',
      label: collapsed ? `最近使用 (${recent.length})` : '最近使用',
      count: collapsed ? undefined : recent.length,
      group: 'recent',
      collapsed,
    })
    pushItems(collapsed ? recent.slice(0, recentCollapseOver) : recent, 'recent')
  }
  if (best.length === 0 && pinned.length === 0 && recent.length === 0) {
    out.push({ kind: 'header', key: 'h:none', label: `没有匹配「${query}」的结果` })
  }
  return out
})

const itemRows = computed(() => rows.value.filter((r) => r.kind === 'item'))
const selectedRow = computed(() => rows.value[ui.selected])
const selectedResult = computed(() => selectedRow.value?.result ?? null)

const desiredHeight = computed(() => {
  if (ui.inPluginView) return 560
  const content = rows.value.reduce((sum, row) => sum + (row.kind === 'header' ? 30 : rowHeight.value), 0)
  const chrome = 54 + (itemRows.value.length > 0 ? 36 : 0) + 12
  return Math.min(640, Math.max(320, content + chrome))
})

// ── 初始化 ───────────────────────────────────────────────────
onMounted(async () => {
  applyTheme()
  try {
    await data.init()
    await data.runSearch('')
  } catch (err) {
    ui.showToast(err instanceof Error ? err.message : '内核未连接')
  }
  disposeEvents = subscribeAll()
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('resize', measure)
  measure()
  searchBox.value?.focus()
})

onUnmounted(() => {
  disposeEvents?.()
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('resize', measure)
})

function measure(): void {
  viewportHeight.value = Math.max(120, window.innerHeight - 54 - 36 - 16)
}

watch(desiredHeight, (height) => {
  void api.setWindowHeight(height).catch(() => undefined)
})

watch(
  () => data.config?.theme,
  () => applyTheme(),
)

watch(
  () => ui.query,
  (value) => {
    data.scheduleSearch(value)
  },
)

watch(
  () => rows.value.length,
  () => {
    ui.clampSelection(rows.value.length)
  },
)

function applyTheme(): void {
  const preference = data.config?.theme ?? 'system'
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const theme = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
  document.documentElement.dataset.theme = theme
  document.documentElement.dataset.density = data.config?.density ?? 'comfortable'
  if (data.config?.accent) document.documentElement.style.setProperty('--color-accent', data.config.accent)
  void api.reportTheme(theme).catch(() => undefined)
}

// ── 事件 ─────────────────────────────────────────────────────
function subscribeAll(): () => void {
  return subscribeEvents(
    (event, payload) => {
      data.handleEvent(event, payload)
      handleKernelEvent(event, payload)
    },
    (connected) => {
      data.connected = connected
    },
  )
}

function handleKernelEvent(event: string, payload: unknown): void {
  if (event === 'search/query') {
    const data = payload as { sid: string; query: string; token: number }
    if (ui.pluginView && data?.sid === ui.pluginView.sid) {
      pluginRef.value?.postEvent('search/query', data)
    }
    return
  }
  if (event === 'ui/footer') {
    const data = payload as { sid: string; buttons: FooterButtonView[] }
    if (ui.pluginView && data?.sid === ui.pluginView.sid) ui.footer = data.buttons ?? []
    return
  }
  if (event === 'ui/searchContent') {
    const value = (payload as { value?: string })?.value ?? ''
    ui.setQuery(value)
    return
  }
  if (event === 'ui/hide') {
    void api.hideWindow().catch(() => undefined)
  }
}

// ── 键盘 ─────────────────────────────────────────────────────
function onKeydown(event: KeyboardEvent): void {
  if (ui.inPluginView) {
    if (matchChord(event, 'Escape') || matchChord(event, 'Mod+W')) {
      event.preventDefault()
      event.stopPropagation()
      ui.closePluginView()
      searchBox.value?.focus()
      return
    }
    if (matchChord(event, 'Mod+,')) {
      event.preventDefault()
      void openSettings()
    }
    return
  }

  if (ui.actionsOpen) {
    if (matchChord(event, 'Escape') || matchChord(event, 'Mod+K')) {
      event.preventDefault()
      ui.actionsOpen = false
    }
    return
  }

  if (matchChord(event, 'ArrowDown')) {
    event.preventDefault()
    move(1)
    return
  }
  if (matchChord(event, 'ArrowUp')) {
    event.preventDefault()
    move(-1)
    return
  }
  if (matchChord(event, 'Enter')) {
    event.preventDefault()
    if (event.shiftKey) void runSecondary()
    else void activate(ui.selected)
    return
  }
  if (matchChord(event, 'Mod+K')) {
    event.preventDefault()
    openActionsFromKeyboard()
    return
  }
  if (matchChord(event, 'Mod+,')) {
    event.preventDefault()
    void openSettings()
    return
  }
  if (matchChord(event, 'ArrowRight')) {
    if (selectedResult.value?.item.detail) {
      event.preventDefault()
      ui.detailOpen = true
    }
    return
  }
  if (matchChord(event, 'ArrowLeft')) {
    if (ui.detailOpen) {
      event.preventDefault()
      ui.detailOpen = false
    }
    return
  }
  if (matchChord(event, 'Escape')) {
    event.preventDefault()
    if (ui.detailOpen) ui.detailOpen = false
    else void api.hideWindow().catch(() => undefined)
    return
  }
  if (matchChord(event, 'Tab')) {
    // v2：把选中项作为作用对象传给下一次搜索
    event.preventDefault()
  }
}

function move(delta: number): void {
  const list = itemRows.value
  if (list.length === 0) return
  const currentRow = rows.value[ui.selected]
  const currentItemIndex = currentRow?.kind === 'item' ? itemRows.value.indexOf(currentRow) : -1
  const nextItemIndex = Math.min(list.length - 1, Math.max(0, currentItemIndex + delta))
  const target = list[nextItemIndex]
  const targetIndex = target ? rows.value.indexOf(target) : 0
  ui.selected = targetIndex
}

function openActionsFromKeyboard(): void {
  const el = document.querySelector<HTMLElement>('[data-selected="true"]')
  const rect = el?.getBoundingClientRect()
  ui.actionsAnchor = rect
    ? { x: rect.left + 24, y: rect.top + rect.height }
    : { x: window.innerWidth / 2 - 110, y: 120 }
  ui.actionsOpen = true
}

// ── 执行 ─────────────────────────────────────────────────────
async function activate(index: number): Promise<void> {
  const row = rows.value[index]
  if (!row || row.kind !== 'item' || !row.result) return
  const result = row.result
  if (result.stale) {
    ui.showToast('该插件已不可用')
    return
  }
  const item: ResultItem = result.item
  const payload: Parameters<typeof api.exec>[0] = { pluginId: result.pluginId, command: result.command, item }
  if (item.action.type === 'command' && item.action.args !== undefined) payload.args = item.action.args
  const res = await api.exec(payload)
  handleResult(res.result)
  await data.refreshLists()
}

async function runSecondary(): Promise<void> {
  const result = selectedResult.value
  if (!result) return
  const action = result.item.actions?.[0]
  if (!action) {
    ui.showToast('该项没有第二动作')
    return
  }
  const res = await api.exec({ pluginId: result.pluginId, command: result.command, action })
  handleResult(res.result)
}

function handleResult(result?: ActionResult): void {
  if (!result) return
  if (!result.ok) {
    ui.showToast(result.error?.message ?? '执行失败')
    return
  }
  if (result.kind === 'view' && result.data) {
    const view = result.data as PluginViewState
    ui.openPluginView(view)
  }
}

async function openSettings(): Promise<void> {
  try {
    const res = await api.invoke('internal-settings:settings')
    handleResult(res.result)
  } catch (err) {
    ui.showToast(err instanceof Error ? err.message : '无法打开设置')
  }
}

// ── 结果项操作 ───────────────────────────────────────────────
function onContext(index: number, event: MouseEvent): void {
  ui.selected = index
  ui.actionsAnchor = { x: event.clientX, y: event.clientY }
  ui.actionsOpen = true
}

async function togglePin(): Promise<void> {
  const result = selectedResult.value
  if (!result) return
  try {
    await api.togglePin(ui.pinPayload(result, result.itemKey))
    await data.refreshLists()
    await data.runSearch(ui.query)
  } catch (err) {
    ui.showToast(err instanceof Error ? err.message : '操作失败')
  }
}

async function copyTitle(): Promise<void> {
  const result = selectedResult.value
  if (!result) return
  try {
    await navigator.clipboard.writeText(result.item.title)
    ui.showToast('已复制标题')
  } catch {
    ui.showToast('复制失败')
  }
}

async function removeFromHistory(): Promise<void> {
  const result = selectedResult.value
  if (!result) return
  await api.removeHistory(result.itemKey)
  await data.refreshLists()
  await data.runSearch(ui.query)
}

async function revealPlugin(): Promise<void> {
  const result = selectedResult.value
  if (!result) return
  await api.pluginAction({ action: 'reveal', id: result.pluginId })
}

async function disablePlugin(): Promise<void> {
  const result = selectedResult.value
  if (!result) return
  await api.pluginAction({ action: 'disable', id: result.pluginId })
  await data.loadConfig()
}

async function uninstallPlugin(): Promise<void> {
  const result = selectedResult.value
  if (!result) return
  try {
    await api.pluginAction({ action: 'uninstall', id: result.pluginId })
    await data.loadConfig()
  } catch (err) {
    ui.showToast(err instanceof Error ? err.message : '卸载失败')
  }
}

async function runExtraAction(action: Parameters<typeof api.exec>[0]['action']): Promise<void> {
  const result = selectedResult.value
  if (!result || !action) return
  const res = await api.exec({ pluginId: result.pluginId, command: result.command, action })
  handleResult(res.result)
}

async function onFooterAction(button: FooterButtonView): Promise<void> {
  pluginRef.value?.postEvent('footer/click', { id: button.id })
}

const extraActions = computed(() => {
  const result = selectedResult.value
  if (!result?.item.actions?.length) return []
  return result.item.actions.map((action, index) => ({
    label: actionLabel(action, index),
    action,
    icon: action.type === 'copy' ? 'copy' : action.type === 'open' ? 'globe' : 'chevron-right',
  }))
})

function actionLabel(action: { type: string }, index: number): string {
  switch (action.type) {
    case 'copy':
      return '复制'
    case 'open':
      return '打开'
    case 'command':
      return '执行命令'
    case 'invoke':
      return '调用其它插件命令'
    default:
      return `动作 ${index + 1}`
  }
}

const defaultHints = computed(() => {
  if (ui.inPluginView) {
    return [
      { keys: ['Esc'], label: '返回' },
      { keys: formatKeys(['Mod+W']), label: '关闭' },
    ]
  }
  const hints = [
    { keys: ['↑', '↓'], label: '选择' },
    { keys: ['↵'], label: '执行' },
  ]
  if (selectedResult.value?.item.detail) hints.push({ keys: ['→'], label: '详情' })
  if (selectedResult.value?.item.actions?.length) hints.push({ keys: formatKeys(['Mod+Shift+Enter']), label: '次动作' })
  hints.push({ keys: formatKeys(['Mod+K']), label: '更多' })
  return hints
})
</script>

<template>
  <div class="shell">
    <!-- 插件视图 -->
    <template v-if="ui.inPluginView && ui.pluginView">
      <PluginView
        ref="pluginRef"
        :state="ui.pluginView"
        @loaded="ui.pluginLoading = false"
        @crash="(reason) => ui.showToast(reason)"
      />
      <FooterBar :buttons="ui.footer" :default-hints="defaultHints" @action="onFooterAction" />
    </template>

    <!-- 启动台 -->
    <template v-else>
      <SearchBox
        ref="searchBox"
        :model-value="ui.query"
        :busy="data.searching"
        @update:model-value="ui.setQuery"
      />
      <div class="flex flex-1 min-h-0">
        <ResultList
          ref="listRef"
          :rows="rows"
          :selected-index="ui.selected"
          :row-height="rowHeight"
          :viewport-height="viewportHeight"
          @hover="(index) => (ui.selected = index)"
          @activate="activate"
          @context="onContext"
          @toggle-group="
            (group) => {
              if (group === 'pinned') ui.expandedPinned = !ui.expandedPinned
              if (group === 'recent') ui.expandedRecent = !ui.expandedRecent
            }
          "
        />
        <DetailPanel
          v-if="ui.detailOpen && selectedResult?.item.detail"
          :title="selectedResult.item.title"
          :text="selectedResult.item.detail"
          @close="ui.detailOpen = false"
        />
      </div>
      <FooterBar :buttons="ui.footer" :default-hints="defaultHints" @action="onFooterAction" />
    </template>

    <ActionsMenu
      v-if="ui.actionsOpen && selectedResult"
      :x="ui.actionsAnchor.x"
      :y="ui.actionsAnchor.y"
      :pinned="Boolean(selectedResult.pinned)"
      :from-history="Boolean(selectedResult.fromHistory)"
      :can-reveal="!selectedResult.stale"
      :can-disable="!selectedResult.stale"
      :plugin-id="selectedResult.pluginId"
      :plugin-title="selectedResult.pluginTitle"
      :extra="extraActions"
      @close="ui.actionsOpen = false"
      @toggle-pin="togglePin"
      @copy-title="copyTitle"
      @remove-history="removeFromHistory"
      @reveal="revealPlugin"
      @disable="disablePlugin"
      @uninstall="uninstallPlugin"
      @run-extra="runExtraAction"
    />

    <div
      v-if="ui.toast"
      class="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[12px] shadow-lg"
    >
      {{ ui.toast }}
    </div>
  </div>
</template>
