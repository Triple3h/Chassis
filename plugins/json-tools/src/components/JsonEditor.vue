<script setup lang="ts">
/**
 * JSON 编辑器：行号 + 语法高亮 + 括号折叠 + 原生编辑体验（对齐 bejson 左栏那台 CodeMirror）。
 *
 * 分四层，每层只管一件事：
 *   ① 可见行层：虚拟滚动，只渲染视口内的行（含折叠截断与高亮）
 *   ② 行号 / 折叠沟槽：不参与横向滚动，只随纵向位移平移
 *   ③ 光标与选区层：用 Range 量出真实像素位置手绘 —— 等宽字体也扛得住中文、emoji、制表符
 *   ④ 跟随光标的透明 textarea：输入法、撤销栈、复制粘贴、选区语义全部交给浏览器原生实现
 *
 * 之所以不直接用 textarea 覆盖高亮层：那样折叠就没法隐藏行（textarea 的行位置改不了）。
 * 把「输入」和「渲染」拆开之后，Cmd+Z / 输入法 / 系统级复制粘贴仍是原生的，折叠却能按行自由隐藏。
 */
import { computed, onMounted, onUnmounted, onUpdated, ref, shallowRef, watch } from 'vue'
import { useVirtualList } from '@launcher/ui/virtual'
import { highlightJsonLine } from '../core/highlight'
import { indexLines, lineAt } from '../core/lineIndex'
import { computeFolds, EMPTY_FOLDS, foldLayout, type FoldInfo } from '../core/fold'
import {
  dedentBlock,
  enterBlock,
  indentBlock,
  lineEndOffset,
  lineOfOffset,
  type BlockEdit,
} from '../core/editorOps'

const props = withDefaults(
  defineProps<{
    modelValue: string
    fontSize?: number
    showLineNumbers?: boolean
    /** 从树视图定位过来的行（1 起，0 = 无） */
    hitLine?: number
    /** 解析失败的那一行（1 起，0 = 无） */
    errorLine?: number
    /** Enter / Tab 插入的缩进单位 */
    indentUnit?: string
  }>(),
  { fontSize: 14, showLineNumbers: true, hitLine: 0, errorLine: 0, indentUnit: '  ' },
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()

/** 行文字到画布左边缘的距离（与 .jed-row 的 padding-left 一致） */
const PAD = 12
/** 折叠箭头列宽（与 .jed-fold 一致） */
const FOLD_W = 14
/** 折叠区间重算的防抖（大文档每次按键都全量扫描太浪费） */
const FOLD_DEBOUNCE = 150
/** 「折叠全部」的上限，避免超大文档一次塞进几万个折叠 */
const MAX_FOLD_ALL = 3000

const wrapEl = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const taEl = ref<HTMLTextAreaElement | null>(null)

const rowH = computed(() => Math.round(props.fontSize * 1.6))
const index = computed(() => indexLines(props.modelValue))
const lineCount = computed(() => Math.max(1, index.value.count))
const digits = computed(() => Math.max(2, String(lineCount.value).length))
/** 行号列宽：11px 等宽字体下每位数约 7px */
const lnw = computed(() => (props.showLineNumbers ? digits.value * 7 + 10 : 0))
const gutterW = computed(() => lnw.value + FOLD_W)

const folds = shallowRef<Set<number>>(new Set())
const foldInfo = shallowRef<FoldInfo>(EMPTY_FOLDS)
const layout = computed(() => foldLayout(folds.value, foldInfo.value.ends, lineCount.value))

const selStart = ref(0)
const selEnd = ref(0)
const focused = ref(false)
/** 光标闪烁靠重建元素来重新计时 */
const caretKey = ref(0)
const scrollLeft = ref(0)

const count = computed(() => layout.value.count)
const { scrollTop, startIndex, endIndex, totalHeight, scrollToIndex } = useVirtualList(scroller, {
  count,
  rowHeight: rowH,
})

const widthCh = computed(() => Math.max(index.value.maxLen + 4, 40))

/* ------------------------------------------------------------------ 行视图 */

function lineStart(line: number): number {
  return index.value.starts[line] ?? 0
}

function lineEnd(line: number): number {
  return lineEndOffset(props.modelValue, index.value.starts, index.value.count, line)
}

/** 某一行的可见文本（折叠时截断成 `{…}`）；limit 是光标 / 选区能画到的最右列 */
interface LineView {
  text: string
  limit: number
}

function lineView(line: number): LineView {
  const raw = lineAt(props.modelValue, index.value, line)
  const info = foldInfo.value
  const end = line < info.ends.length ? info.ends[line] : -1
  if (end > line && folds.value.has(line)) {
    const at = Math.max(0, Math.min(info.cols[line], raw.length))
    return { text: `${raw.slice(0, at + 1)}…${String.fromCharCode(info.closers[line])}`, limit: at + 1 }
  }
  return { text: raw, limit: raw.length }
}

interface Row {
  row: number
  line: number
  html: string
  foldable: boolean
  folded: boolean
}

const rows = computed<Row[]>(() => {
  const lay = layout.value
  const info = foldInfo.value
  const out: Row[] = []
  for (let r = startIndex.value; r < endIndex.value; r++) {
    const line = lay.lineOf(r)
    if (line < 0) continue
    const end = line < info.ends.length ? info.ends[line] : -1
    const foldable = end > line
    const folded = foldable && folds.value.has(line)
    out.push({ row: r, line, html: highlightJsonLine(lineView(line).text), foldable, folded })
  }
  return out
})

const caretLine = computed(() => lineOfOffset(index.value.starts, index.value.count, selEnd.value))

/* ------------------------------------------------------------ 光标 / 选区几何 */

/** 一次测量出来的覆盖层几何（相对包裹层坐标） */
interface Geometry {
  /** offset = 光标距行文字起点的像素宽度，用来把输入框自己滚到光标处（输入法候选框要贴对位置） */
  caret: { x: number; y: number; h: number; offset: number } | null
  rects: { x: number; y: number; w: number; h: number }[]
}

const geometry = shallowRef<Geometry>({ caret: null, rects: [] })

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** 行内第 col 列在包裹层坐标系里的 x（用 Range 量，中文 / emoji / tab 都准） */
function pointOf(el: HTMLElement, col: number, baseLeft: number): number {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let remain = col
  let last: Text | null = null
  let node = walk.nextNode() as Text | null
  while (node) {
    const len = node.data.length
    if (remain <= len) {
      const range = document.createRange()
      range.setStart(node, remain)
      range.collapse(true)
      return range.getBoundingClientRect().left - baseLeft
    }
    remain -= len
    last = node
    node = walk.nextNode() as Text | null
  }
  if (last) {
    const range = document.createRange()
    range.setStart(last, last.data.length)
    range.collapse(true)
    return range.getBoundingClientRect().left - baseLeft
  }
  // 空行：贴在这一行的起始位置
  return el.getBoundingClientRect().left - baseLeft + PAD
}

function computeGeometry(): Geometry {
  const wrap = wrapEl.value
  const sc = scroller.value
  if (!wrap || !sc) return { caret: null, rects: [] }
  const base = wrap.getBoundingClientRect()
  const els = new Map<number, HTMLElement>()
  for (const el of sc.querySelectorAll<HTMLElement>('.jed-row')) els.set(Number(el.dataset.row), el)

  const lay = layout.value
  const rH = rowH.value
  const a = selStart.value
  const b = selEnd.value
  const rects: Geometry['rects'] = []

  if (a !== b) {
    for (let r = startIndex.value; r < endIndex.value; r++) {
      const el = els.get(r)
      const line = lay.lineOf(r)
      if (!el || line < 0) continue
      const ls = lineStart(line)
      const le = lineEnd(line)
      if (b < ls || a > le) continue
      const lv = lineView(line)
      const x1 = pointOf(el, clamp(a - ls, 0, lv.limit), base.left)
      const x2 = pointOf(el, clamp(b - ls, 0, lv.limit), base.left)
      rects.push({ x: x1, y: el.getBoundingClientRect().top - base.top, w: Math.max(x2 - x1, 2), h: rH })
    }
  }

  let caret: Geometry['caret'] = null
  const line = caretLine.value
  const el = els.get(lay.rowOf(line))
  if (el) {
    const lv = lineView(line)
    const box = el.getBoundingClientRect()
    const x = pointOf(el, clamp(selEnd.value - lineStart(line), 0, lv.limit), base.left)
    caret = { x, y: box.top - base.top, h: rH, offset: Math.max(0, x - (box.left - base.left + PAD)) }
  }
  return { caret, rects }
}

let rafId = 0
let timerId = 0
let pending = false

function flushGeometry() {
  pending = false
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
  if (timerId) {
    clearTimeout(timerId)
    timerId = 0
  }
  const next = computeGeometry()
  geometry.value = next
  // 输入框自己滚到光标处（它的内容与行同字体，宽度故意只有几像素）：
  // 这样系统输入法的候选框才贴着手绘光标，而不是被整行的前缀宽度推歪
  const ta = taEl.value
  if (ta && next.caret) ta.scrollLeft = next.caret.offset
  // 焦点态顺便以 DOM 为准兜一次：后台标签页 / 未激活窗口里 focus 事件根本不来，
  // 只靠事件的话回到前台后光标要等到下次点击才出现
  focused.value = document.activeElement === ta
}

/**
 * 统一在下一帧测量：此时 DOM 已按最新数据补丁过，滚动位置也落定。
 * 再兜一个超时 —— 隐藏的标签页 / 未激活的窗口里 rAF 根本不跑，
 * 而宿主（Tauri）的窗口恰恰常常是先隐藏、唤出时才可见。
 */
function scheduleGeometry() {
  if (pending) return
  pending = true
  rafId = requestAnimationFrame(flushGeometry)
  timerId = setTimeout(() => {
    if (pending) flushGeometry()
  }, 80) as unknown as number
}

/** 方向键 / 拖选改的是 textarea 自己的选区，靠它同步回来 */
function onSelectionChange() {
  if (taEl.value && document.activeElement === taEl.value) syncSel()
}

onUpdated(scheduleGeometry)
onMounted(() => {
  window.addEventListener('resize', scheduleGeometry)
  document.addEventListener('selectionchange', onSelectionChange)
  scheduleGeometry()
})
onUnmounted(() => {
  window.removeEventListener('resize', scheduleGeometry)
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
  document.removeEventListener('selectionchange', onSelectionChange)
  clearTimeout(foldTimer)
  if (rafId) cancelAnimationFrame(rafId)
  if (timerId) clearTimeout(timerId)
})

watch([selStart, selEnd, scrollTop, scrollLeft, rowH, layout, () => props.modelValue], scheduleGeometry)

/* -------------------------------------------------------------------- 折叠 */

let foldTimer = 0

function recomputeFolds() {
  const info = computeFolds(props.modelValue)
  foldInfo.value = info
  // 行号漂移后，起点已经不是可折叠行的折叠直接丢掉
  const next = new Set<number>()
  for (const l of folds.value) if (l < info.ends.length && info.ends[l] > l) next.add(l)
  if (next.size !== folds.value.size) folds.value = next
}

function scheduleFolds() {
  clearTimeout(foldTimer)
  foldTimer = setTimeout(recomputeFolds, FOLD_DEBOUNCE) as unknown as number
}

function toggleFold(line: number) {
  const next = new Set(folds.value)
  if (next.has(line)) {
    next.delete(line)
  } else {
    const end = line < foldInfo.value.ends.length ? foldInfo.value.ends[line] : -1
    if (end <= line) return
    next.add(line)
  }
  folds.value = next
}

function foldAll() {
  const next = new Set<number>()
  for (const l of foldInfo.value.lines) {
    if (next.size >= MAX_FOLD_ALL) break
    next.add(l)
  }
  folds.value = next
}

function unfoldAll() {
  if (folds.value.size) folds.value = new Set()
}

/** 光标落进被折叠隐藏的行时，把那一层折开（否则光标看不见） */
function unfoldAt(line: number) {
  const info = foldInfo.value
  for (const l of folds.value) {
    const end = l < info.ends.length ? info.ends[l] : -1
    if (line > l && line <= end) {
      const next = new Set(folds.value)
      next.delete(l)
      folds.value = next
      return
    }
  }
}

/* --------------------------------------------------------------------- 输入 */

function syncSel() {
  const ta = taEl.value
  if (!ta) return
  selStart.value = ta.selectionStart
  selEnd.value = ta.selectionEnd
  caretKey.value++
  unfoldAt(caretLine.value)
}

/** textarea 是文档的真源；只有外部改动（粘贴 / 打开文件 / 树里改）才需要写回 */
function syncTextarea() {
  const ta = taEl.value
  if (!ta || ta.value === props.modelValue) return
  ta.value = props.modelValue
  const at = props.modelValue.length
  ta.setSelectionRange(at, at)
  syncSel()
}

watch(
  () => props.modelValue,
  () => {
    syncTextarea()
    scheduleFolds()
  },
)

function onInput() {
  const ta = taEl.value
  if (!ta) return
  emit('update:modelValue', ta.value)
  syncSel()
  revealCaret()
}

/**
 * 用 execCommand 替换一段文本：浏览器会把它记成**一步可撤销**的编辑，
 * 并照常派发 input 事件（再大段也走同一条路）。
 */
function replaceRange(from: number, to: number, text: string) {
  const ta = taEl.value
  if (!ta) return
  ta.focus({ preventScroll: true })
  ta.setSelectionRange(from, to)
  try {
    if (document.execCommand('insertText', false, text)) return
  } catch {
    // 老 WebView 不支持 —— 落到下面的手工替换（会丢撤销栈，但至少正确）
  }
  const next = ta.value.slice(0, from) + text + ta.value.slice(to)
  ta.value = next
  ta.setSelectionRange(from + text.length, from + text.length)
  emit('update:modelValue', next)
  syncSel()
}

function applyEdit(edit: BlockEdit) {
  const ta = taEl.value
  if (!ta) return
  replaceRange(edit.from, edit.to, edit.text)
  ta.setSelectionRange(edit.selStart, edit.selEnd)
  syncSel()
  revealCaret()
}

function onKeydown(e: KeyboardEvent) {
  const ta = taEl.value
  if (!ta) return
  if (e.key === 'Tab') {
    e.preventDefault()
    const { starts, count: n } = index.value
    const edit = e.shiftKey
      ? dedentBlock(ta.value, starts, n, ta.selectionStart, ta.selectionEnd, props.indentUnit)
      : indentBlock(ta.value, starts, n, ta.selectionStart, ta.selectionEnd, props.indentUnit)
    if (edit) applyEdit(edit)
    return
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault()
    applyEdit(
      enterBlock(ta.value, index.value.starts, index.value.count, ta.selectionStart, ta.selectionEnd, props.indentUnit),
    )
    return
  }
  // Tab 被编辑器吃掉了，留一个键盘出口：Esc 交出焦点，再按 Tab 就能去别的控件
  if (e.key === 'Escape') ta.blur()
}

/** 光标移出可视区时把它滚回来（纵向；横向留给人自己拖） */
function revealCaret() {
  const el = scroller.value
  if (!el) return
  const row = layout.value.rowOf(caretLine.value)
  if (row < 0) return
  const top = row * rowH.value
  const bottom = top + rowH.value
  if (top < el.scrollTop) el.scrollTop = top
  else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
}

/* ------------------------------------------------------------ 鼠标 → 偏移 */

/** 屏幕坐标 → 文档偏移（优先用浏览器自己的命中测试，退化时用 Range 二分） */
function offsetFromPoint(clientX: number, clientY: number): number {
  const sc = scroller.value
  if (!sc) return 0
  // 折叠行只让光标落在露出来的前缀里，不然一点就把整块折开了
  const limitOf = (line: number) => Math.min(lineView(line).limit, lineEnd(line) - lineStart(line))
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  const hit = doc.caretRangeFromPoint?.(clientX, clientY)
  if (hit) {
    const node = hit.startContainer
    const host = (node.nodeType === 3 ? node.parentElement : (node as HTMLElement)) ?? null
    const el = host?.closest<HTMLElement>('.jed-row') ?? null
    if (el) {
      const line = Number(el.dataset.line)
      return lineStart(line) + clamp(textLength(el, node, hit.startOffset), 0, limitOf(line))
    }
  }
  const pos = doc.caretPositionFromPoint?.(clientX, clientY)
  if (pos) {
    const host = pos.offsetNode.nodeType === 3 ? pos.offsetNode.parentElement : (pos.offsetNode as HTMLElement)
    const el = host?.closest<HTMLElement>('.jed-row') ?? null
    if (el) {
      const line = Number(el.dataset.line)
      return lineStart(line) + clamp(textLength(el, pos.offsetNode, pos.offset), 0, limitOf(line))
    }
  }
  // 没有命中测试 API：退化成「按行高定位 + Range 二分找列」
  const rect = sc.getBoundingClientRect()
  const r = clamp(Math.floor((clientY - rect.top + sc.scrollTop) / rowH.value), 0, layout.value.count - 1)
  const line = layout.value.lineOf(r)
  if (line < 0) return 0
  const el = sc.querySelector<HTMLElement>(`.jed-row[data-row="${r}"]`)
  if (!el) return lineStart(line)
  const ls = lineStart(line)
  const max = lineEnd(line) - ls
  let lo = 0
  let hi = max
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (pointOf(el, mid, rect.left) <= clientX) lo = mid
    else hi = mid - 1
  }
  return ls + lo
}

/** 从行首数到 (container, offset) 的可见字符数 */
function textLength(root: HTMLElement, container: Node, offset: number): number {
  if (container.nodeType !== 3) return 0
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let n = 0
  let node = walk.nextNode() as Text | null
  while (node) {
    if (node === container) return n + offset
    n += node.data.length
    node = walk.nextNode() as Text | null
  }
  return n
}

function setSelection(from: number, to: number) {
  const ta = taEl.value
  if (!ta) return
  ta.focus({ preventScroll: true })
  ta.setSelectionRange(from, to)
  syncSel()
}

const WORD = /[\w$.-]/

/** 双击选词 / 三击选行 */
function selectUnitAt(offset: number, lineWide: boolean) {
  const ta = taEl.value
  if (!ta) return
  if (lineWide) {
    const line = lineOfOffset(index.value.starts, index.value.count, offset)
    setSelection(lineStart(line), lineEnd(line))
    return
  }
  const text = ta.value
  let a = offset
  let b = offset
  while (a > 0 && WORD.test(text[a - 1])) a--
  while (b < text.length && WORD.test(text[b])) b++
  setSelection(a === b ? offset : a, a === b ? offset : b)
}

let dragging = false
/** 拖选的锚点（按下时定住，之后只动另一端） */
let dragAnchor = 0

function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return
  e.preventDefault()
  const at = offsetFromPoint(e.clientX, e.clientY)
  if (e.detail >= 3) selectUnitAt(at, true)
  else if (e.detail === 2) selectUnitAt(at, false)
  else setSelection(at, at)
  dragAnchor = taEl.value?.selectionStart ?? at
  dragging = true
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
}

function onDragMove(e: MouseEvent) {
  if (!dragging) return
  const ta = taEl.value
  if (!ta) return
  const at = offsetFromPoint(e.clientX, e.clientY)
  ta.setSelectionRange(Math.min(dragAnchor, at), Math.max(dragAnchor, at))
  syncSel()
  autoScroll(e.clientY)
}

function onDragEnd() {
  dragging = false
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
}

/** 拖到视口边缘时自动滚动 */
function autoScroll(clientY: number) {
  const el = scroller.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const edge = rowH.value * 2
  if (clientY < rect.top + edge) el.scrollTop -= rowH.value
  else if (clientY > rect.bottom - edge) el.scrollTop += rowH.value
}

function onScroll() {
  scrollLeft.value = scroller.value?.scrollLeft ?? 0
}

/* ---------------------------------------------------------------- 对外接口 */

function replaceAll(text: string) {
  const ta = taEl.value
  if (!ta || ta.value === text) return
  replaceRange(0, ta.value.length, text)
  const at = text.length
  ta.setSelectionRange(at, at)
  syncSel()
  revealCaret()
}

function scrollToLine(line: number) {
  const at = line - 1
  if (at < 0 || at >= lineCount.value) return
  unfoldAt(at)
  const row = layout.value.rowOf(at)
  if (row < 0) return
  scrollToIndex(row, 'center')
  scheduleGeometry()
}

function focus() {
  taEl.value?.focus({ preventScroll: true })
}

onMounted(() => {
  recomputeFolds()
  syncTextarea()
  taEl.value?.setSelectionRange(0, 0)
  syncSel()
})

defineExpose({ replaceAll, scrollToLine, foldAll, unfoldAll, focus })
</script>

<template>
  <div
    ref="wrapEl"
    class="jed-root"
    title="Tab 缩进 · Shift+Tab 反缩进 · Esc 退出编辑"
    :style="{ fontSize: fontSize + 'px', lineHeight: rowH + 'px' }"
    @mousedown="onMouseDown"
  >
    <!-- ① 可见行（横向滚动由这一层承担）。纯装饰：读屏只该读下面那个 textarea -->
    <div
      ref="scroller"
      class="jed-scroll launcher-scroll"
      aria-hidden="true"
      :style="{ paddingLeft: gutterW + 'px' }"
      @scroll="onScroll"
    >
      <div
        class="jed-canvas"
        :style="{ height: totalHeight + 'px', width: widthCh + 'ch', minWidth: '100%' }"
      >
        <div
          v-for="row in rows"
          :key="row.row"
          class="jed-row"
          :class="{ 'is-hit': row.line + 1 === hitLine, 'is-err': row.line + 1 === errorLine }"
          :data-row="row.row"
          :data-line="row.line"
          :style="{ top: row.row * rowH + 'px' }"
        >
          <span v-html="row.html" />
        </div>
      </div>
    </div>

    <!-- ② 行号与折叠箭头（固定列，只随纵向位移平移） -->
    <div class="jed-gutter" :style="{ width: gutterW + 'px' }">
      <div class="jed-gutter-inner" :style="{ height: totalHeight + 'px', transform: `translateY(${-scrollTop}px)` }">
        <template v-for="row in rows" :key="row.row">
          <div
            v-if="showLineNumbers"
            class="jed-ln"
            aria-hidden="true"
            :class="{ 'is-err': row.line + 1 === errorLine, 'is-hit': row.line + 1 === hitLine }"
            :style="{ top: row.row * rowH + 'px', width: lnw + 'px', height: rowH + 'px' }"
          >
            {{ row.line + 1 }}
          </div>
          <button
            v-if="row.foldable"
            type="button"
            class="jed-fold"
            :class="{ 'is-folded': row.folded }"
            :style="{ top: row.row * rowH + 'px', left: lnw + 'px', width: FOLD_W + 'px', height: rowH + 'px' }"
            :title="row.folded ? '展开' : '折叠'"
            :aria-label="`${row.folded ? '展开' : '折叠'}第 ${row.line + 1} 行`"
            :aria-expanded="!row.folded"
            @mousedown.stop
            @click.stop="toggleFold(row.line)"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path :d="row.folded ? 'M4 2l6 6-6 6V2z' : 'M2 4l6 6 6-6H2z'" fill="currentColor" />
            </svg>
          </button>
        </template>
      </div>
    </div>

    <!-- ③ 选区 / 光标 + ④ 跟随光标的透明输入框 -->
    <div class="jed-overlay">
      <div
        v-for="(rect, i) in geometry.rects"
        :key="`s${i}`"
        class="jed-sel"
        :style="{ left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' }"
      />
      <div
        v-if="focused && geometry.caret"
        :key="caretKey"
        class="jed-caret"
        :style="{
          left: geometry.caret.x + 'px',
          top: geometry.caret.y + 'px',
          height: geometry.caret.h + 'px',
        }"
      />
      <textarea
        ref="taEl"
        class="jed-input"
        :style="{ left: (geometry.caret?.x ?? 0) + 'px', top: (geometry.caret?.y ?? 0) + 'px', height: rowH + 'px' }"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        wrap="off"
        aria-label="JSON 文本"
        @input="onInput"
        @keydown="onKeydown"
        @select="syncSel"
        @focus="focused = true"
        @blur="focused = false"
      />
    </div>

    <div v-if="!modelValue" class="jed-ph" :style="{ left: gutterW + PAD + 'px' }">
      粘贴 JSON，或把 .json 文件拖进来…
    </div>
  </div>
</template>
