<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import ActionsMenu from './components/ActionsMenu.vue'
import DetailPanel from './components/DetailPanel.vue'
import FooterBar from './components/FooterBar.vue'
import IconGlyph from './components/IconGlyph.vue'
import PluginView from './components/PluginView.vue'
import ResetSizeButton from './components/ResetSizeButton.vue'
import ResultGrid from './components/ResultGrid.vue'
import SearchBox from './components/SearchBox.vue'
import SystemStats from './components/SystemStats.vue'
import WindowResizeHandles from './components/WindowResizeHandles.vue'
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
/** 网格容器实测宽度 → 列数（默认 720 ⇒ 7 列；窗口被拉宽后自动跟随） */
const containerWidth = ref(720)
let disposeEvents: (() => void) | null = null

/**
 * 窗口几何（位置 + 尺寸）由用户说了算（requirements §3.1「窗口几何记忆」）。
 *
 * 拖过缩放把手 / 挪过窗口就置位：内容高度不再改窗口（否则下一次搜索会立刻把手动调的尺寸顶回去）。
 * 几何**按窗口态分别记**进 config（`windowBounds`）：`host` = 搜索态、`plugin:<插件id>` = 各插件页
 * （设置页也是插件页）、`plugin` = 所有插件页的兜底（≤0.1.5 的旧数据）。
 * 关闭（隐藏）前 / 切换窗口态时落盘，唤出 / 进入插件页时还原；只有「恢复默认大小」会清掉尺寸记忆。
 */
const manualResized = ref(false)
/** 几何记忆的键：宿主搜索态与每个插件页各记一份，互不影响 */
const geometryKey = computed(() => {
  const view = ui.pluginView
  return view ? `plugin:${view.pluginId}` : 'host'
})
/** 当前窗口态的几何（专属记忆优先；插件页没记过专属的用 `plugin` 兜底） */
const savedGeometry = computed(() => lookupGeometry(geometryKey.value))
/** 尺寸那一半；位置那一半由壳在唤出时裁决，UI 只在切换窗口态时应用 */
const savedSize = computed(() => {
  const geometry = savedGeometry.value
  return geometry?.width && geometry?.height ? { width: geometry.width, height: geometry.height } : null
})
/** 「恢复默认大小」只在当前窗口态的尺寸确实被改过时露出（刚拖完还没落盘的那一瞬也算） */
const canResetSize = computed(() => manualResized.value || savedSize.value !== null)
/** 几何落盘的防抖定时器：拖动过程中 resize 事件是连续的，松手后 400ms 才认为定稿 */
let sizeSaveTimer = 0
/** 切换窗口态的令牌：快速往返时只让最后一次的「先落盘旧态、再应用新态」跑完 */
let geometryToken = 0

type BoundsEntry = { x?: number; y?: number; width?: number; height?: number }

function lookupGeometry(key: string): BoundsEntry | null {
  const map = data.config?.windowBounds
  const own = map?.[key]
  if (own) return own
  // 插件页没记过专属几何时回落到 `plugin` 兜底（旧模型「所有插件页共用一份」的沿用）
  return key.startsWith('plugin:') ? (map?.plugin ?? null) : null
}

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
    // 离场前把"用户刚拖出来的几何"立刻落盘：防抖窗口里的那次保存不该随着窗口隐藏被推迟 ——
    // 而窗口藏起来之后再读 innerWidth/innerHeight 未必准（下一次唤出会按错的尺寸还原）。
    void flushGeometry(geometryKey.value)
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
      if (token !== visibilityToken) return
      windowHidden.value = false
      // 唤出 = 回到"这个窗口态该有的尺寸"：有记忆就用记忆，没有就内容自适应。
      // 位置不在这里应用 —— 壳已经裁决过了（窗口中心还在鼠标所在屏就保持原位、换屏了才居中）
      applyGeometry(geometryKey.value, false)
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
    plugins: data.pluginResults,
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
  window.addEventListener('resize', onWindowResize)
  window.addEventListener('focus', clearHiddenByFocus)
  measure()
  // 挂载时也应用一次：UI 可能刚重载（内核重启 / 手动刷新），而窗口尺寸还停在上一次的模式上
  // （`inPluginView` 此刻必然是空的，所以这里应用的就是宿主态该有的尺寸）。
  // 位置不应用 —— 窗口已经显示着（或由壳放在用户上次的位置），别把它挪走
  applyGeometry(geometryKey.value, false)
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
  window.clearTimeout(sizeSaveTimer)
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('focus', clearHiddenByFocus)
})

function measure(): void {
  viewportHeight.value = Math.max(120, window.innerHeight - SEARCH_BAR_HEIGHT - FOOTER_HEIGHT - 18)
}

/** 窗口几何变了：重算可视区，并把用户接管过的尺寸记下来（位置由离场 / 切换窗口态时的 flush 兜） */
function onWindowResize(): void {
  measure()
  scheduleGeometrySave()
}

/** 内容高度 → 窗口高度；尺寸被用户接管（拖过 or 当前窗口态有记忆）时不动窗口 */
watch(desiredHeight, (height) => {
  if (manualResized.value || savedSize.value) return
  setWindowHeight(height)
})

/** 切窗口态（宿主 ⇄ 插件页）：旧态先落盘（此刻读到的还是切换前的几何），新态再应用（含位置） */
watch(geometryKey, (now, previous) => {
  const token = ++geometryToken
  void (async () => {
    await flushGeometry(previous || 'host')
    if (token !== geometryToken) return
    applyGeometry(now, true)
  })()
})

/** 缩放把手按下：从这一刻起窗口尺寸由用户说了算 */
function onResizeStart(): void {
  manualResized.value = true
}

/** 拖完尺寸后落盘（防抖 400ms：拖动过程中 resize 事件是连续的，松手才算定稿） */
function scheduleGeometrySave(): void {
  if (!manualResized.value) return
  window.clearTimeout(sizeSaveTimer)
  sizeSaveTimer = window.setTimeout(() => void flushGeometry(geometryKey.value), 400)
}

/**
 * 立即把 `key` 这个窗口态的几何记进 config（防抖到点 / 离场前 / 切换窗口态前调用；值没变就不写）。
 *
 * 位置总是记（壳报什么记什么）；尺寸只在**用户接管过**时记 —— 否则会把「内容自适应」
 * 的当前高度误记成用户尺寸，从此这个窗口再也不会自适应。
 */
async function flushGeometry(key: string): Promise<void> {
  window.clearTimeout(sizeSaveTimer)
  sizeSaveTimer = 0
  let position: { x: number; y: number } | null = null
  try {
    const res = await api.windowBounds()
    // bounds 为 null = 问不到壳（standalone / 未连接）：静默 —— 下次还会再试一次
    if (res.bounds) position = { x: Math.round(res.bounds.x), y: Math.round(res.bounds.y) }
  } catch {
    return
  }
  if (!position) return
  const known = data.config?.windowBounds ?? {}
  const previous = known[key] ?? {}
  const next: BoundsEntry = { ...position }
  if (manualResized.value) {
    next.width = Math.round(window.innerWidth)
    next.height = Math.round(window.innerHeight)
  } else if (previous.width && previous.height) {
    // 尺寸不归这次 flush 管：原样保留（别把自适应的当前高度写成用户尺寸）
    next.width = previous.width
    next.height = previous.height
  }
  if (
    previous.x === next.x &&
    previous.y === next.y &&
    previous.width === next.width &&
    previous.height === next.height
  ) {
    return
  }
  try {
    // 整个 `windowBounds` 一起写回：patchConfig 是浅合并，只给一个键会把别的窗口态抹掉
    await api.patchConfig({ windowBounds: { ...known, [key]: next } })
  } catch {
    // 内核没连上（standalone / 退出中）：静默
  }
}

/**
 * 应用某个窗口态该有的几何。
 *  - 有尺寸记忆 ⇒ 用 `setWindowBounds`（宽高一起）并保持"用户接管"状态；
 *  - 没尺寸记忆 ⇒ 清掉接管状态、用 `setHeight` 回到内容自适应。
 *
 * `includePosition` 只在**切换窗口态**时为 true：唤出时位置由壳裁决（窗口中心还在鼠标所在屏
 * 就保持原位、换屏了才居中）—— UI 此刻再设一次位置会把壳的裁决覆盖掉（跨屏唤出又跳回旧位置）。
 */
function applyGeometry(key: string, includePosition: boolean): void {
  const geometry = lookupGeometry(key)
  const position =
    includePosition && geometry?.x != null && geometry?.y != null ? { x: geometry.x, y: geometry.y } : null
  if (geometry?.width && geometry?.height) {
    manualResized.value = true
    void api
      .setWindowBounds({ ...(position ?? {}), width: geometry.width, height: geometry.height })
      .catch(() => undefined)
    return
  }
  if (position) void api.setWindowBounds(position).catch(() => undefined)
  // 本来就在自适应轨道上（没记忆、也没人手动改过）：交给 `desiredHeight` 的 watch 就好，
  // 这里再 force 一次只会让窗口在唤出那一刻被无谓地设两遍尺寸
  if (!manualResized.value) return
  manualResized.value = false
  setWindowHeight(desiredHeight.value, { immediate: true, force: true })
}

/** 当前窗口态**自己的**尺寸记忆（不含 `plugin` 兜底）——「恢复默认大小」要清的那一份 */
function ownSizeKey(): string | null {
  const map = data.config?.windowBounds
  const key = geometryKey.value
  const own = map?.[key]
  if (own?.width || own?.height) return key
  // 插件页只有兜底那份：清兜底 = 所有插件页一起回默认（旧数据下这是唯一能清的目标）
  if (key.startsWith('plugin:') && (map?.plugin?.width || map.plugin?.height)) return 'plugin'
  return null
}

/** 「恢复默认大小」：忘掉当前窗口态的尺寸记忆（位置保留），回到默认形态 */
async function resetWindowSize(): Promise<void> {
  manualResized.value = false
  window.clearTimeout(sizeSaveTimer)
  sizeSaveTimer = 0
  const key = ownSizeKey()
  if (key) {
    const known = { ...(data.config?.windowBounds ?? {}) }
    const entry: BoundsEntry = { ...(known[key] ?? {}) }
    delete entry.width
    delete entry.height
    // 位置也空 ⇒ 整项没有存在意义，删掉（内核清洗也不会收空对象）
    if (entry.x == null && entry.y == null) delete known[key]
    else known[key] = entry
    await api.patchConfig({ windowBounds: known }).catch(() => undefined)
  }
  setWindowHeight(desiredHeight.value, { immediate: true, force: true })
}

/**
 * 按住面板拖动窗口（无边框窗口没有系统标题栏）。
 *
 * 触发面由 `data-drag-region` 收口：搜索栏那一行（搜索框 / 按钮除外）与顶缘热区；
 * 结果网格、详情面板、菜单都**不**参与 —— 那里每一次 mousedown 都有正经用途
 * （选中、拖拽固定项、点空白回搜索框），把整块面板变成拖拽区会毁掉它们。
 */
function onPanelMouseDown(event: MouseEvent): void {
  if (event.button !== 0) return
  const target = event.target as HTMLElement | null
  if (!target || !target.closest('[data-drag-region]')) return
  if (target.closest('input, textarea, button, a, select, [contenteditable="true"]')) return
  event.preventDefault()
  void api.startWindowDrag().catch(() => undefined)
}

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
    const visible = (payload as { visible?: boolean })?.visible !== false
    setWindowVisible(visible)
    // 每次唤出都让首页（空查询）重查一次。
    // 否则会卡在「query 已清空、response 还是上一次带查询的结果」这种不一致里：
    // 带查询的响应没有 `groups.plugins`（内核只在空输入给「已安装插件」分组），
    // 渲染出来就是空态「还没有安装任何插件」，而且没有任何事件会把它救回来。
    if (visible && !ui.query) void data.runSearch('').catch(() => undefined)
    return
  }
  if (event === 'ui/hide') {
    void api.hideWindow().catch(() => undefined)
  }
  // 内核主动让 UI 打开插件页（托盘「设置…」「插件管理…」）：载荷 = invoke 的 ActionResult，
  // 复用同一条处理 —— 打开 iframe，失败时 toast
  if (event === 'ui/openView') {
    handleResult(payload as ActionResult)
    return
  }
  // 插件页会话被内核关掉：停用 / 卸载 ⇒ 直接卸载 iframe；重载 ⇒ 等 plugin/reloaded 后重开
  if (event === 'session/closed') {
    const info = payload as { sid?: string; reason?: string }
    const view = ui.pluginView
    if (!view || info?.sid !== view.sid) return
    if (info.reason === 'reload') return
    // `ui` 是插件页自己关自己（SDK 交还的 Esc / 插件调 commands.close）：
    // 走「返回」那条收尾（含焦点交还搜索框）—— 从插件页出来，用户下一句一定是打字。
    if (info.reason === 'ui') {
      void leavePluginView()
      return
    }
    ui.closePluginView()
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

  // 方向键按「格子」移动：↑↓ 同列换行，←→ 逐格
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

/** Esc 分步退出：收起二级面板 → 清空输入 → 隐藏窗口 */
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

/** 固定项拖拽重排 */
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
  <div class="shell" :class="{ 'is-window-hidden': windowHidden }" @mousedown="onPanelMouseDown">
    <!-- 顶缘拖拽热区：搜索栏上方那几像素空白，专门用来"按住搬窗口"（无边框窗口没有标题栏） -->
    <div class="drag-strip" data-drag-region />

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
        :can-reset-size="canResetSize"
        @action="onFooterAction"
        @back="leavePluginView"
        @reset-size="resetWindowSize"
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
      >
        <template #trailing>
          <!-- 尺寸被改过才露出：一键忘掉记忆、回到内容自适应的默认形态 -->
          <ResetSizeButton v-if="canResetSize" @reset="resetWindowSize" />
          <!-- 窗口隐藏时不轮询：状态条只在"看得见"的时候才有意义 -->
          <SystemStats :active="!windowHidden" />
        </template>
      </SearchBox>
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
            ui.query ? `没有匹配「${ui.query}」的结果` : '还没有安装任何插件'
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

    <!-- 四边 / 四角的缩放把手（无边框窗口没有系统边框可抓） -->
    <WindowResizeHandles @resize-start="onResizeStart" />
  </div>
</template>
