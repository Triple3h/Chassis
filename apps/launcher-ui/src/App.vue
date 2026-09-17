<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import ActionsMenu from './components/ActionsMenu.vue'
import DetailPanel from './components/DetailPanel.vue'
import FooterBar from './components/FooterBar.vue'
import IconGlyph from './components/IconGlyph.vue'
import PluginView from './components/PluginView.vue'
import ResultGrid from './components/ResultGrid.vue'
import SearchBox from './components/SearchBox.vue'
import { api, subscribeEvents } from './lib/api'
import {
  FOOTER_HEIGHT,
  GRID_METRICS,
  MAX_WINDOW_HEIGHT,
  MIN_WINDOW_HEIGHT,
  SEARCH_BAR_HEIGHT,
  buildGridRows,
  buildSections,
  columnsFor,
  flattenItems,
  moveItem,
  moveVertical,
  rowHeightOf,
  type GridMetrics,
  type ResultGroup,
} from './lib/grid'
import { formatKeys, matchChord } from './lib/keys'
import { setWindowHeight } from './lib/windowMotion'
import { useDataStore } from './stores/data'
import { useUiStore, type FooterButtonView, type PluginViewState } from './stores/ui'
import type { ActionResult, ResultItem } from '@launcher/plugin-manifest'
import type { RankedResult } from './lib/types'

const data = useDataStore()
const ui = useUiStore()

const searchBox = ref<InstanceType<typeof SearchBox> | null>(null)
const pluginRef = ref<InstanceType<typeof PluginView> | null>(null)
const viewportHeight = ref(420)
/** 网格容器实测宽度 → 列数（窗口固定 720，通常恒为 7 列） */
const containerWidth = ref(720)
let disposeEvents: (() => void) | null = null

/**
 * 窗口是否已被壳藏起来 —— 整个「弹窗动效」的总开关。
 *
 * 初值取 `false`（当作可见）是刻意的：万一可见性事件因为任何原因没到，
 * 最坏结果只是少一次入场动画，而反过来（默认不可见）会让整个启动台变成一片透明。
 * 挂载时再问内核一次，把「用户提前按了热键」这种情况校正回来。
 */
const windowHidden = ref(false)
/** 是否已经收到过 shell/visibility；事件永远比启动时的查询新，收到过就不再采纳查询结果 */
let sawVisibilityEvent = false
/** 显隐相位的令牌：等待揭示的过程中又来了新的一次显隐，旧回调要自己作废 */
let visibilityToken = 0
/** 进入隐藏态的时刻（`performance.now()`）：用来识别「离场还没演完，用户又按了一次」 */
let hiddenAtMs = 0
/**
 * 在这个窗口内重新唤出 = 用户在撤销那次隐藏（热键连按），不该重播入场动画。
 *
 * 上限必须**小于**「离场演完 + 回执」的耗时（≈140+100ms）：再晚窗口就已经真的藏了，
 * 那时必须走「等窗口能画」的正常路径，否则入场动画会在没有画面的时候被吞掉。
 */
const REVEAL_FAST_MS = 180
/** 离场回执的定时器（同一时刻只有一个） */
let exitAckTimer = 0
/** 回执余量：离场时长之外再留给合成器两帧 + IPC 抖动 */
const EXIT_ACK_MARGIN_MS = 100

/**
 * 窗口显隐 → 界面相位。**隐藏立刻做，显示要等到「窗口真的能画」了再做。**
 *
 * 为什么显示不能立刻摘掉隐藏态：窗口一旦被壳藏起来，webview 的绘制会被系统挂起，
 * 而 CSS transition 的时钟照走 —— 立刻摘掉的话，等绘制恢复，动画早跑完了，
 * 用户看到的只是「啪」一下整块出现（也就是"动效好像没实现"）。
 *
 * 等待拆成两段：
 *   ① 页面还被系统标成 `hidden`（窗口还没上屏）就先等 `visibilitychange`，另有 400ms 兜底；
 *   ② 再等「webview 真的开始在画了」（`waitForPaint()`：页面可见后等两帧），
 *      动画才有一个已经被画出来的起点。
 */
function setWindowVisible(visible: boolean): void {
  const token = ++visibilityToken
  if (!visible) {
    windowHidden.value = true
    hiddenAtMs = performance.now()
    armExitAck(token)
    return
  }
  if (!windowHidden.value) return
  // 离场还在演（多半是热键连按，壳那边也刚撤掉排队中的隐藏）：立刻恢复可见。
  // transition 会从当前值自然反向，视觉上就是「淡出到一半又淡回来」；
  // 再走一遍「等窗口能画」的流程反而会让用户看到「闪一下又回来」。
  if (performance.now() - hiddenAtMs < REVEAL_FAST_MS) {
    windowHidden.value = false
    return
  }
  const reveal = (): void => {
    if (token !== visibilityToken) return
    void waitForPaint().then(() => {
      if (token === visibilityToken) windowHidden.value = false
    })
  }
  if (document.visibilityState === 'hidden') {
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      document.removeEventListener('visibilitychange', onVisible)
      reveal()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.setTimeout(() => {
      document.removeEventListener('visibilitychange', onVisible)
      reveal()
    }, 400)
    return
  }
  reveal()
}

/**
 * 离场回执：等「离场动画的最后一帧已经画出来了」再让内核真正把窗口藏起来。
 *
 * 为什么必须是回执而不是固定时长：隐藏广播要穿过 内核 → SSE → webview 才会变成
 * CSS 的起点，这段延迟不可控（几毫秒到几十毫秒都有）。固定时长一旦砍在淡出中途，
 * webview 就会把「半透明面板」留成最后一帧 —— 下次唤出时合成器先亮它：
 * 用户看到的是「闪一下，像打开了两次」。
 *
 * 等待 = 离场时长（`--motion-fast`，含减弱动态效果的降级值）+ 两帧余量，
 * 让合成器有时间把最后那帧（opacity 0）提交上去；回执里带 `opacity` 只是留证据。
 */
function armExitAck(token: number): void {
  const startedAt = performance.now()
  window.clearTimeout(exitAckTimer)
  exitAckTimer = window.setTimeout(() => {
    exitAckTimer = 0
    // 等待期间又被唤出（或又隐了一次）：这次的回执作废，别把窗口藏了
    if (token !== visibilityToken) return
    const shell = document.querySelector<HTMLElement>('.shell')
    const opacity = shell ? Number(getComputedStyle(shell).opacity) : 0
    void api
      .confirmWindowHidden({ opacity, elapsedMs: Math.round(performance.now() - startedAt) })
      .catch(() => undefined)
  }, exitAckDelayMs())
}

/** 离场时长 + 余量：从 CSS 令牌 `--motion-fast` 读，避免和样式表两处维护 */
function exitAckDelayMs(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--motion-fast').trim()
  const value = Number.parseFloat(raw)
  const duration = Number.isFinite(value) ? (raw.endsWith('ms') ? value : value * 1000) : 140
  return Math.round(duration + EXIT_ACK_MARGIN_MS)
}

/**
 * 等「webview 真的在画了」：页面可见之后再等两帧就够。
 *
 * 窗口被藏起来时 WebKit 会停渲染、rAF 跟着停；页面上屏后 rAF 重新跑起来这件事本身
 * 就是「帧循环已经转起来了」的信号 —— 再等一帧，隐藏态（opacity 0）已经被画出来，
 * 入场动画就有了一个真实的起点。
 *
 * 为什么不再等「恢复后的那个长帧」（实测录屏）：从旧画面被擦掉到动画开始是一段**空窗**，
 * 用户盯着空窗口等 200ms —— 比入场动画本身还长。上限 `maxMs` 只防 rAF 因为任何原因不来；
 * 最后还有一道 setTimeout 保险 —— 无论 rAF 走不走，界面都必须被显出来：
 * **白屏比没有动画严重得多**。
 */
function waitForPaint(maxMs = 120): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    window.setTimeout(finish, maxMs + 200)
    const start = performance.now()
    let frames = 0
    const tick = (): void => {
      if (settled) return
      frames += 1
      if (frames >= 2 || performance.now() - start >= maxMs) {
        finish()
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

/**
 * 兜底：窗口自己拿到焦点 ⇒ 它不可能是隐藏的。
 *
 * 兜的是「事件丢了」这一类意外（SSE 还没连上 / 断线重连期间刚好唤出）。
 * 一旦漏掉那次广播，界面会停在 opacity 0 —— 窗口是出来了，但用户看到的是一片透明，
 * 比少一次动画严重得多。焦点事件在宿主、webview、UI 三处都不需要额外协议，代价为零。
 * 它和广播走同一条揭示路径（一样等绘制恢复），所以不会把入场动画抢跑掉。
 */
function clearHiddenByFocus(): void {
  if (windowHidden.value) setWindowVisible(true)
}

const metrics = computed<GridMetrics>(() => GRID_METRICS[data.config?.density === 'compact' ? 'compact' : 'comfortable'])
const columns = computed(() => columnsFor(containerWidth.value))

const sections = computed(() =>
  buildSections({
    query: ui.query.trim(),
    pinned: data.pinnedResults,
    best: data.results,
    recent: data.recentResults,
    columns: columns.value,
    expanded: ui.expandedGroups,
  }),
)
const rows = computed(() => buildGridRows(sections.value, columns.value))
const items = computed(() => flattenItems(rows.value))
const selectedResult = computed<RankedResult | null>(() => items.value[ui.selected] ?? null)
const pinnedSection = computed(() => sections.value.find((section) => section.group === 'pinned'))
/** 固定项拖拽重排：只在「空输入 + 已展开 + 不止一条」时开放 */
const pinDraggable = computed(
  () => !ui.query.trim() && pinnedSection.value?.expanded === true && data.pinnedResults.length > 1,
)

const desiredHeight = computed(() => {
  if (ui.inPluginView) return 560
  const content = rows.value.reduce((sum, row) => sum + rowHeightOf(row, metrics.value), 0)
  const chrome = SEARCH_BAR_HEIGHT + (items.value.length > 0 ? FOOTER_HEIGHT : 0) + 18
  return Math.min(MAX_WINDOW_HEIGHT, Math.max(MIN_WINDOW_HEIGHT, content + chrome))
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
  window.addEventListener('focus', clearHiddenByFocus)
  measure()
  searchBox.value?.focus()
  // 触发点可能是「壳在 UI 加载完之前就显示过窗口」：只有问内核才知道当前该不该播入场动画。
  // 只在**明确**回答 false 时收起界面 —— null 表示内核问不到壳（standalone / `pnpm dev`），
  // 那种情况下根本没有"窗口隐藏"这回事，当成隐藏就是把自己藏没了。
  void api
    .windowVisible()
    .then((res) => {
      if (!sawVisibilityEvent && res.visible === false) windowHidden.value = true
    })
    .catch(() => undefined)
})

onUnmounted(() => {
  disposeEvents?.()
  // 作废还在等「窗口能画」的那次揭示、还在等回执的那次离场：组件都卸载了，别再动相位
  visibilityToken += 1
  window.clearTimeout(exitAckTimer)
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('resize', measure)
  window.removeEventListener('focus', clearHiddenByFocus)
})

function measure(): void {
  viewportHeight.value = Math.max(120, window.innerHeight - SEARCH_BAR_HEIGHT - FOOTER_HEIGHT - 18)
}

watch(desiredHeight, (height) => setWindowHeight(height))

// 外观三项都要盯住：设置页改主题色 / 密度后内核会广播 `config/changed`，
// 只监听 theme 的话另外两项要等下次重载才生效（用户看到的就是「改了没反应」）。
watch(
  () => [data.config?.theme, data.config?.accent, data.config?.density],
  () => applyTheme(),
)

watch(
  () => ui.query,
  (value) => {
    data.scheduleSearch(value)
  },
)

watch(
  () => items.value.length,
  (count) => {
    ui.clampSelection(count)
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
  if (event === 'shell/visibility') {
    sawVisibilityEvent = true
    setWindowVisible((payload as { visible?: boolean })?.visible !== false)
    return
  }
  if (event === 'ui/hide') {
    void api.hideWindow().catch(() => undefined)
  }
  // 插件页会话被内核关掉：停用 / 卸载 ⇒ 直接卸载 iframe；重载 ⇒ 等 plugin/reloaded 后重开
  if (event === 'session/closed') {
    const info = payload as { sid?: string; reason?: string }
    const view = ui.pluginView
    if (!view || info?.sid !== view.sid) return
    if (info.reason === 'reload') return
    ui.closePluginView()
    // `ui` 是插件页自己关自己（commands.close），安静卸载就行
    const notice = info.reason === 'uninstall' ? '插件已卸载，页面已关闭' : info.reason === 'disable' ? '插件已停用，页面已关闭' : ''
    if (notice) ui.showToast(notice)
    return
  }
  // 插件重载完成：旧会话与旧端口都失效了，用同一命令换一个新会话重开
  if (event === 'plugin/reloaded') {
    const info = payload as { pluginId?: string; commands?: string[]; ok?: boolean }
    const view = ui.pluginView
    if (!view || !info?.pluginId || info.pluginId !== view.pluginId) return
    if (info.ok === false) {
      ui.closePluginView()
      ui.showToast('插件重载失败，页面已关闭')
      return
    }
    if (Array.isArray(info.commands) && !info.commands.includes(view.command)) {
      ui.closePluginView()
      ui.showToast('插件已重载，但该页面命令已不存在')
      return
    }
    void reopenPluginView(view)
  }
}

// ── 键盘 ─────────────────────────────────────────────────────
function onKeydown(event: KeyboardEvent): void {
  if (ui.inPluginView) {
    if (matchChord(event, 'Escape') || matchChord(event, 'Mod+W')) {
      event.preventDefault()
      event.stopPropagation()
      void leavePluginView()
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

  // 方向键按「格子」移动（ZTools 的聚合视图同款）：↑↓ 同列换行，←→ 逐格
  if (matchChord(event, 'ArrowDown')) {
    event.preventDefault()
    ui.selected = moveVertical(rows.value, ui.selected, 1)
    return
  }
  if (matchChord(event, 'ArrowUp')) {
    event.preventDefault()
    ui.selected = moveVertical(rows.value, ui.selected, -1)
    return
  }
  if (matchChord(event, 'ArrowRight')) {
    event.preventDefault()
    ui.selected = moveItem(rows.value, ui.selected, 1)
    return
  }
  if (matchChord(event, 'ArrowLeft')) {
    event.preventDefault()
    ui.selected = moveItem(rows.value, ui.selected, -1)
    return
  }
  if (matchChord(event, 'Tab')) {
    event.preventDefault()
    ui.selected = moveItem(rows.value, ui.selected, event.shiftKey ? -1 : 1)
    return
  }
  if (event.key === 'Enter') {
    // 这里不用 matchChord：⇧/⌘ + Enter 要能命中同一分支
    event.preventDefault()
    if (event.shiftKey || event.metaKey || event.ctrlKey) void runSecondary()
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
  if (matchChord(event, 'Mod+I')) {
    if (selectedResult.value?.item.detail) {
      event.preventDefault()
      ui.detailOpen = !ui.detailOpen
    }
    return
  }
  if (matchChord(event, 'Escape')) {
    event.preventDefault()
    stepwiseEscape()
  }
}

/** Esc 分步退出（ZTools 同款）：收起二级面板 → 清空输入 → 隐藏窗口 */
function stepwiseEscape(): void {
  if (ui.detailOpen) {
    ui.detailOpen = false
    return
  }
  if (ui.query) {
    ui.setQuery('')
    searchBox.value?.focus()
    return
  }
  void api.hideWindow().catch(() => undefined)
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
  const result = items.value[index]
  if (!result) return
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

/**
 * 插件重载后自动重开当前插件页（例如在插件管理页点「重载」重载了它自己 / 全部重载）。
 * 旧会话已被内核关闭、旧端口也停了，只有换新会话 + 新 URL 才能继续用。
 */
async function reopenPluginView(view: PluginViewState): Promise<void> {
  let result: ActionResult | undefined
  try {
    result = (await api.invoke(`${view.pluginId}:${view.command}`)).result
  } catch (err) {
    ui.showToast(err instanceof Error ? err.message : '插件页重开失败')
    ui.closePluginView()
    return
  }
  if (ui.pluginView?.sid !== view.sid) {
    // 等待期间用户已经离开这个页面：把刚建的会话关掉，别留孤儿
    const fresh = result?.data as PluginViewState | undefined
    if (fresh?.sid) void api.closeSession(fresh.sid).catch(() => undefined)
    return
  }
  if (result?.ok && result.kind === 'view' && result.data) {
    ui.openPluginView(result.data as PluginViewState)
    return
  }
  ui.showToast(result?.error?.message ?? '插件页重开失败')
  ui.closePluginView()
}

/**
 * 离开插件页回到搜索态（footer 的「返回」按钮、`Esc`、`⌘W` 都走这一条）。
 *
 * 必须 `await nextTick()` 再聚焦：插件页开着的时候 SearchBox 是卸载状态，
 * 它的模板 ref 是 null，同步调用 `.focus()` 只会静默失败 ——
 * 表现就是"回来了但键盘打不进字，还得用鼠标点一下"。
 */
async function leavePluginView(): Promise<void> {
  ui.closePluginView()
  await nextTick()
  searchBox.value?.focus()
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

function onToggleGroup(group: string): void {
  ui.toggleGroup(group as ResultGroup)
  ui.clampSelection(items.value.length)
}

function focusSearch(): void {
  searchBox.value?.focus()
}

function onMeasure(width: number): void {
  if (width > 0) containerWidth.value = width
}

/** 固定项拖拽重排（ZTools 的已固定网格支持拖动排序） */
async function onReorder(payload: { from: RankedResult; to: RankedResult }): Promise<void> {
  const keys = data.pinnedResults.map((result) => result.itemKey)
  const from = keys.indexOf(payload.from.itemKey)
  const to = keys.indexOf(payload.to.itemKey)
  if (from < 0 || to < 0 || from === to) return
  keys.splice(to, 0, ...keys.splice(from, 1))
  try {
    await api.reorderPinned(keys)
    await data.refreshLists()
    await data.runSearch(ui.query)
    ui.selected = to
  } catch (err) {
    ui.showToast(err instanceof Error ? err.message : '排序失败')
  }
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
    // 插件视图里宿主只有一个动作（返回），它和它的两个快捷键都在左下角那个按钮上，
    // 这一侧再写一遍就是同一个词在一行里出现两次
    return []
  }
  const hints = [
    { keys: ['↑', '↓', '←', '→'], label: '选择' },
    { keys: ['↵'], label: '执行' },
  ]
  if (selectedResult.value?.item.detail) hints.push({ keys: formatKeys(['Mod+I']), label: '详情' })
  if (selectedResult.value?.item.actions?.length) hints.push({ keys: formatKeys(['Shift+Enter']), label: '次动作' })
  hints.push({ keys: formatKeys(['Mod+K']), label: '更多' })
  return hints
})
</script>

<template>
  <div class="shell" :class="{ 'is-window-hidden': windowHidden }">
    <!-- 插件视图 -->
    <template v-if="ui.inPluginView && ui.pluginView">
      <PluginView
        ref="pluginRef"
        :state="ui.pluginView"
        @loaded="ui.pluginLoading = false"
        @crash="(reason) => ui.showToast(reason)"
      />
      <FooterBar
        :buttons="ui.footer"
        :default-hints="defaultHints"
        back
        @action="onFooterAction"
        @back="leavePluginView"
      />
    </template>

    <!-- 启动台 -->
    <template v-else>
      <SearchBox
        ref="searchBox"
        :model-value="ui.query"
        :busy="data.searching"
        @update:model-value="ui.setQuery"
        @settings="openSettings"
      />
      <div class="relative flex-1 min-h-0 flex">
        <ResultGrid
          v-if="items.length > 0"
          :rows="rows"
          :selected-index="ui.selected"
          :metrics="metrics"
          :columns="columns"
          :viewport-height="viewportHeight"
          :pin-draggable="pinDraggable"
          @hover="(index) => (ui.selected = index)"
          @activate="activate"
          @context="onContext"
          @toggle="onToggleGroup"
          @reorder="onReorder"
          @measure="onMeasure"
          @background="focusSearch"
        />
        <div v-else class="flex-1 flex flex-col items-center justify-center gap-1.5 text-[var(--fg-muted)]">
          <IconGlyph name="search" :size="22" />
          <span class="text-[12.5px]">{{
            ui.query ? `没有匹配「${ui.query}」的结果` : '还没有任何记录'
          }}</span>
        </div>

        <Transition name="motion-slide-right" :duration="{ enter: 200, leave: 140 }">
          <DetailPanel
            v-if="ui.detailOpen && selectedResult?.item.detail"
            :title="selectedResult.item.title"
            :text="selectedResult.item.detail"
            @close="ui.detailOpen = false"
          />
        </Transition>
      </div>
      <FooterBar v-if="items.length > 0" :buttons="ui.footer" :default-hints="defaultHints" @action="onFooterAction" />
    </template>

    <Transition name="motion-menu" :duration="{ enter: 140, leave: 90 }">
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
    </Transition>

    <Transition name="motion-toast" :duration="{ enter: 200, leave: 140 }">
      <div
        v-if="ui.toast"
        class="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[12px] shadow-lg"
      >
        {{ ui.toast }}
      </div>
    </Transition>
  </div>
</template>
