<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useVirtualList } from '@launcher/ui/virtual'
import { useToast } from '@launcher/ui/toast'
import { copyText } from '@launcher/ui/clipboard'
import { formatJson } from '../core/format'
import { addChild, canEditValue, editText, patchKey, patchValue, removeNode } from '../core/edit'
import {
  KIND,
  closeRowNode,
  indexInParent,
  isContainerKind,
  jsonPath,
  lastChildOf,
  nodeSource,
  projectRows,
  type FlatTree,
} from '../core/tree'

const props = defineProps<{
  tree: FlatTree | null
  /** 树对应的文本：树上的编辑以它为底稿做最小替换 */
  source: string
  /** 新成员的缩进单位（跟随格式化设置） */
  indent?: string
  /** 树字号（px） */
  fontSize?: number
  /** 新文档的序号（粘贴 / 载入示例 / 清空）：变一次就把展开与滚动复位 */
  docEpoch?: number
}>()

const emit = defineEmits<{ edit: [text: string]; reveal: [line: number] }>()

/** 每层缩进 / 起始留白（对齐 bejson：成员 20px 一级） */
const INDENT_PX = 20
const BASE_PAD = 8
/** 超过这个大小时复制节点不再重新缩进，直接给原文 */
const PRETTY_LIMIT = 200_000
const DEFAULT_FONT = 14

const scroller = ref<HTMLElement | null>(null)
const toast = useToast()

const expanded = new Set<number>()
const rev = ref(0)
const selected = ref(0)
const editing = ref<{ idx: number; field: Field } | null>(null)
const draft = ref('')
let commitTimer = 0
/** 新增成员之后要接着编辑它（等新的树回来再落座） */
let pending: { parent: number; field: Field } | null = null

type Field = 'key' | 'value'

const ROW = computed(() => Math.max(18, Math.round((props.fontSize ?? DEFAULT_FONT) * 1.6)))

const rows = computed<Int32Array>(() => {
  rev.value
  if (!props.tree) return new Int32Array(0)
  return projectRows(props.tree, expanded)
})

const { startIndex, endIndex, totalHeight, scrollToIndex } = useVirtualList(scroller, {
  count: computed(() => rows.value.length),
  rowHeight: ROW,
})

const visibleRows = computed(() => Array.from(rows.value.slice(startIndex.value, endIndex.value)))

/* ------------------------------------------------------------------ 行渲染 */

function depthOf(row: number): number {
  const t = props.tree
  if (!t) return 0
  const idx = row < 0 ? closeRowNode(row) : row
  return idx < 0 ? 0 : t.depth[idx]
}

function openChar(idx: number): string {
  return props.tree?.kind[idx] === KIND.array ? '[' : '{'
}

function closeChar(idx: number): string {
  return props.tree?.kind[idx] === KIND.array ? ']' : '}'
}

function isContainer(idx: number): boolean {
  const t = props.tree
  return !!t && idx >= 0 && isContainerKind(t.kind[idx])
}

/** 数组元素显示 `0:` 而不是键 */
function isArrayChild(idx: number): boolean {
  const t = props.tree
  return !!t && idx > 0 && t.parent[idx] >= 0 && t.kind[t.parent[idx]] === KIND.array
}

function arrayIndex(idx: number): number {
  const t = props.tree
  return t ? indexInParent(t, idx) : 0
}

function hasComma(idx: number): boolean {
  const t = props.tree
  return !!t && idx >= 0 && idx !== 0 && t.nextSibling[idx] !== -1
}

function valueClass(kind: number): string {
  switch (kind) {
    case KIND.string:
      return 'jv-str'
    case KIND.number:
      return 'jv-num'
    case KIND.boolean:
      return 'jv-bool'
    case KIND.null:
      return 'jv-null'
    default:
      return ''
  }
}

function displayValue(idx: number): string {
  const t = props.tree
  if (!t || isContainerKind(t.kind[idx])) return ''
  return t.truncated && t.kind[idx] === KIND.string && t.value[idx].length >= 300
    ? `${t.value[idx]}…`
    : t.value[idx]
}

/* -------------------------------------------------------------- 展开与选中 */

function toggle(idx: number) {
  if (!isContainer(idx)) return
  if (expanded.has(idx)) expanded.delete(idx)
  else expanded.add(idx)
  rev.value++
}

function expandAll() {
  const t = props.tree
  if (!t) return
  for (let i = 0; i < t.nodeCount; i++) if (isContainerKind(t.kind[i])) expanded.add(i)
  rev.value++
}

function collapseAll() {
  expanded.clear()
  rev.value++
}

function selectNode(idx: number) {
  selected.value = idx
  const at = rows.value.indexOf(idx)
  if (at >= 0) scrollToIndex(at)
}

/* ------------------------------------------------------------------ 编辑 */

function isEditing(idx: number, field: Field): boolean {
  return editing.value?.idx === idx && editing.value.field === field
}

/** 输入框宽度：近似「中文 2 格、其余 1 格」，随内容增长 */
const draftWidth = computed(() => {
  let units = 0
  for (const ch of draft.value) units += ch.charCodeAt(0) > 0x2e80 ? 2 : 1
  return `${Math.max(2, units + 1)}ch`
})

function beginEdit(idx: number, field: Field) {
  const t = props.tree
  if (!t) return
  if (field === 'key' && idx === 0) return
  if (field === 'value' && !canEditValue(t, idx)) {
    toast.info('字符串过长（已截断），请切到文本视图编辑')
    return
  }
  // 换到另一处编辑时，先把上一处没落盘的输入写完（防抖可能还没到点）
  clearTimeout(commitTimer)
  if (editing.value) flush()
  selected.value = idx
  editing.value = { idx, field }
  draft.value = field === 'key' ? t.key[idx] : editText(t, idx)
  void nextTick(() => focusEditor())
}

/** 同一时刻只有一个编辑框，直接查 DOM（模板 ref 在 v-for 里拿不到元素） */
function focusEditor(retry = true) {
  const el = scroller.value?.querySelector('.jedit') as HTMLInputElement | null
  if (!el) {
    // 新加的成员可能在虚拟窗口外，滚动落定后再试一次
    if (retry) setTimeout(() => focusEditor(false), 80)
    return
  }
  el.focus()
  el.select()
}

/** 把当前草稿写回文档；非法输入返回 false（调用方决定提示与还原） */
function flush(): boolean {
  const st = editing.value
  const t = props.tree
  if (!st || !t) return false
  const next =
    st.field === 'key'
      ? patchKey(props.source, t, st.idx, draft.value)
      : patchValue(props.source, t, st.idx, draft.value)
  if (next === null) return false
  if (next !== props.source) emit('edit', next)
  return true
}

/** 输入即写（防抖）—— 与 bejson 的行内编辑一样是「改完立刻生效」 */
function onInput() {
  clearTimeout(commitTimer)
  commitTimer = setTimeout(flush, 240) as unknown as number
}

function endEdit() {
  clearTimeout(commitTimer)
  const st = editing.value
  if (!st) return
  if (!flush()) {
    const t = props.tree
    if (t) draft.value = st.field === 'key' ? t.key[st.idx] : editText(t, st.idx)
    toast.err(st.field === 'key' ? '键名没变' : '值不合法，已还原')
  }
  editing.value = null
}

function cancelEdit() {
  clearTimeout(commitTimer)
  editing.value = null
}

function addTo(idx: number) {
  const t = props.tree
  if (!t || !isContainer(idx)) return
  const next = addChild(props.source, t, idx, { indent: props.indent ?? '  ' })
  if (next === null) return
  pending = { parent: idx, field: t.kind[idx] === KIND.object ? 'key' : 'value' }
  expanded.add(idx)
  rev.value++
  emit('edit', next)
}

function removeAt(idx: number) {
  const t = props.tree
  if (!t || idx === 0) return
  const next = removeNode(props.source, t, idx)
  if (next === null) return
  if (editing.value?.idx === idx) editing.value = null
  selected.value = t.parent[idx] >= 0 ? t.parent[idx] : 0
  emit('edit', next)
}

/** 新的树回来之后，把光标落到刚添加的成员上 */
watch(
  () => props.tree,
  (t) => {
    if (!t || !pending) return
    const { parent, field } = pending
    pending = null
    const idx = lastChildOf(t, parent)
    if (idx < 0) return
    selectNode(idx)
    beginEdit(idx, field)
  },
)

/* -------------------------------------------------------------- 复制 / 定位 */

function prettify(raw: string): string {
  if (!raw || raw.length > PRETTY_LIMIT) return raw
  const res = formatJson(raw, { indent: 2 })
  return res.ok ? res.output : raw
}

async function copyValue() {
  const t = props.tree
  if (!t) return
  const idx = selected.value
  const raw = nodeSource(t, props.source, idx)
  const text = isContainerKind(t.kind[idx]) ? prettify(raw) : raw
  if (await copyText(text)) toast.ok(isContainerKind(t.kind[idx]) ? '已复制该节点的 JSON' : '已复制该节点的值')
}

async function copyPath() {
  const t = props.tree
  if (!t) return
  if (await copyText(jsonPath(t, selected.value))) toast.ok('已复制路径')
}

function revealSelected() {
  const t = props.tree
  if (!t) return
  emit('reveal', t.line[selected.value])
}

defineExpose({ expandAll, collapseAll, copyValue, copyPath, revealSelected, selectNode })

/* ---------------------------------------------------------------- 键盘 */

function onKeydown(e: KeyboardEvent) {
  if (editing.value) return
  // 行内编辑框里的按键（Enter 提交 / Esc 取消）不该再被树当成导航键
  const el = e.target as HTMLElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
  const t = props.tree
  if (!t || !rows.value.length) return
  const pos = rows.value.indexOf(selected.value)
  const at = pos < 0 ? 0 : pos
  const move = (delta: number) => {
    e.preventDefault()
    const next = Math.max(0, Math.min(rows.value.length - 1, at + delta))
    const row = rows.value[next]
    selected.value = closeRowNode(row) >= 0 ? closeRowNode(row) : row
    scrollToIndex(next)
  }
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key.toLowerCase() === 'c') {
    e.preventDefault()
    if (e.shiftKey) void copyPath()
    else void copyValue()
    return
  }
  switch (e.key) {
    case 'ArrowDown':
      move(1)
      break
    case 'ArrowUp':
      move(-1)
      break
    case 'PageDown':
      move(20)
      break
    case 'PageUp':
      move(-20)
      break
    case 'Home':
      move(-rows.value.length)
      break
    case 'End':
      move(rows.value.length)
      break
    case 'Enter':
      e.preventDefault()
      beginEdit(selected.value, isArrayChild(selected.value) || selected.value === 0 ? 'value' : 'key')
      break
    default:
      break
  }
}

/* ------------------------------------------------------------ 初始展开 */

/** 默认展开两层（避免一进来只看到一根线）；只在「新文档」时复位 */
function initExpansion(t: FlatTree) {
  expanded.clear()
  for (let i = 0; i < t.nodeCount; i++) {
    if (isContainerKind(t.kind[i]) && t.depth[i] < 2) expanded.add(i)
  }
  selected.value = 0
  if (scroller.value) scroller.value.scrollTop = 0
}

let inited = false
let needsInit = false

watch(
  () => props.docEpoch,
  () => {
    needsInit = true
  },
)

watch(
  () => props.tree,
  (t) => {
    if (!t) return
    if (!inited || needsInit) {
      inited = true
      needsInit = false
      initExpansion(t)
    }
    // 新增成员之后把光标落到它身上
    if (!pending) return
    const { parent, field } = pending
    pending = null
    const idx = lastChildOf(t, parent)
    if (idx < 0) return
    selectNode(idx)
    beginEdit(idx, field)
  },
  { immediate: true },
)

onMounted(() => scroller.value?.addEventListener('keydown', onKeydown))
onUnmounted(() => {
  scroller.value?.removeEventListener('keydown', onKeydown)
  clearTimeout(commitTimer)
})
</script>

<template>
  <div
    ref="scroller"
    class="jtree launcher-scroll relative h-full w-full outline-none"
    tabindex="0"
    :style="{ fontSize: (fontSize ?? DEFAULT_FONT) + 'px' }"
  >
    <div class="relative" :style="{ height: totalHeight + 'px', minWidth: '100%' }">
      <div
        v-for="(row, i) in visibleRows"
        :key="row"
        class="jrow"
        :class="{ 'is-sel': row >= 0 && row === selected }"
        :style="{
          top: (startIndex + i) * ROW + 'px',
          height: ROW + 'px',
          paddingLeft: BASE_PAD + depthOf(row) * INDENT_PX + 'px',
        }"
        @click="row >= 0 && (selected = row)"
      >
        <!-- 收尾括号行 -->
        <template v-if="row < 0">
          <span class="jpunc jbrack">{{ closeChar(closeRowNode(row)) }}</span>
          <span v-if="hasComma(closeRowNode(row))" class="jpunc">,</span>
        </template>

        <template v-else>
          <button v-if="isContainer(row)" class="jchev" @click.stop="toggle(row)">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path :d="expanded.has(row) ? 'M2 4l6 6 6-6H2z' : 'M4 2l6 6-6 6V2z'" fill="currentColor" />
            </svg>
          </button>
          <span v-else class="jchev" />

          <!-- 下标（数组元素） -->
          <span v-if="isArrayChild(row)" class="jidx">{{ arrayIndex(row) }}:</span>
          <!-- 键（对象成员）；根节点没有键 -->
          <template v-else-if="row > 0">
            <input
              v-if="isEditing(row, 'key')"
              v-model="draft"
              class="jedit jkey"
              :style="{ width: draftWidth }"
              spellcheck="false"
              @click.stop
              @input="onInput"
              @keydown.enter.prevent="endEdit()"
              @keydown.esc.prevent="cancelEdit()"
              @blur="endEdit()"
            />
            <span v-else class="jkey" @click.stop="beginEdit(row, 'key')">{{ tree?.key[row] }}</span>
            <span class="jpunc">:</span>
          </template>

          <!-- 值 -->
          <template v-if="isContainer(row)">
            <span class="jpunc jbrack">{{ openChar(row) }}</span>
            <span class="jlen">{{ tree?.count[row] }}</span>
            <button class="jadd" title="添加成员" @click.stop="addTo(row)">+</button>
            <span v-if="!expanded.has(row)" class="jpunc jbrack">{{ closeChar(row) }}</span>
          </template>
          <template v-else>
            <input
              v-if="isEditing(row, 'value')"
              v-model="draft"
              class="jedit jval"
              :class="valueClass(tree?.kind[row] ?? 0)"
              :style="{ width: draftWidth }"
              spellcheck="false"
              @click.stop
              @input="onInput"
              @keydown.enter.prevent="endEdit()"
              @keydown.esc.prevent="cancelEdit()"
              @blur="endEdit()"
            />
            <span
              v-else
              class="jval"
              :class="valueClass(tree?.kind[row] ?? 0)"
              @click.stop="beginEdit(row, 'value')"
            >
              {{ displayValue(row) }}
            </span>
            <span v-if="hasComma(row)" class="jpunc">,</span>
          </template>
        </template>

        <button v-if="row > 0" class="jdel" title="删除这个成员" @click.stop="removeAt(row)">删除</button>
      </div>
    </div>
  </div>
</template>
