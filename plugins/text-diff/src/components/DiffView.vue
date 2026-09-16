<script setup lang="ts">
import { computed, ref } from 'vue'
import { useVirtualList } from '@shared/lib/virtual'
import type { Row, Seg } from '../core/diff'

const props = defineProps<{
  rows: Row[]
  mode: 'split' | 'unified'
}>()

const ROW = 20
const scroller = ref<HTMLElement | null>(null)

/** 统一视图下「修改行」要拆成删除行 + 新增行两行渲染 */
interface DisplayRow {
  key: string
  kind: Row['kind']
  leftNo: number
  rightNo: number
  sign: string
  skipped: number
  source: Row | null
  /** 该行是否取右侧内容（统一视图的新增行） */
  useRight: boolean
}

const display = computed<DisplayRow[]>(() => {
  const out: DisplayRow[] = []
  const rows = props.rows
  if (props.mode === 'split') {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      out.push({
        key: `s${i}`,
        kind: row.kind,
        leftNo: row.leftNo,
        rightNo: row.rightNo,
        sign: '',
        skipped: row.skipped ?? 0,
        source: row,
        useRight: false,
      })
    }
    return out
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.kind === 'mod') {
      out.push({ key: `m${i}d`, kind: 'del', leftNo: row.leftNo, rightNo: 0, sign: '-', skipped: 0, source: row, useRight: false })
      out.push({ key: `m${i}i`, kind: 'ins', leftNo: 0, rightNo: row.rightNo, sign: '+', skipped: 0, source: row, useRight: true })
    } else {
      out.push({
        key: `u${i}`,
        kind: row.kind,
        leftNo: row.leftNo,
        rightNo: row.rightNo,
        sign: row.kind === 'del' ? '-' : row.kind === 'ins' ? '+' : ' ',
        skipped: row.skipped ?? 0,
        source: row,
        useRight: row.kind === 'ins',
      })
    }
  }
  return out
})

const { startIndex, endIndex, totalHeight, scrollToIndex } = useVirtualList(scroller, {
  count: computed(() => display.value.length),
  rowHeight: ROW,
})

const visible = computed(() =>
  display.value.slice(startIndex.value, endIndex.value).map((row, k) => ({ row, index: startIndex.value + k })),
)

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
function esc(text: string): string {
  return text.replace(/[&<>]/g, (c) => ESC[c] as string)
}

function segsToHtml(segs: Seg[] | undefined, text: string, hlClass: string): string {
  if (!segs) return esc(text)
  let out = ''
  for (const seg of segs) {
    out += seg.hl ? `<span class="${hlClass}">${esc(seg.t)}</span>` : esc(seg.t)
  }
  return out
}

function leftHtml(item: DisplayRow): string {
  const row = item.source
  if (!row || row.kind === 'skip') return ''
  return segsToHtml(row.leftSegs, row.left, 'launcher-seg-del')
}

function rightHtml(item: DisplayRow): string {
  const row = item.source
  if (!row || row.kind === 'skip') return ''
  return segsToHtml(row.rightSegs, row.right, 'launcher-seg-add')
}

type VisibleItem = { row: DisplayRow; index: number }

/** 并排视图的左半边：删除行 / 修改行的旧值 */
function leftBg(item: VisibleItem): string {
  const kind = item.row.kind
  if (kind === 'del') return 'launcher-row-del'
  if (kind === 'mod') return 'launcher-mod-del'
  if (kind === 'skip') return 'launcher-row-skip'
  return ''
}

/** 并排视图的右半边：新增行 / 修改行的新值 */
function rightBg(item: VisibleItem): string {
  const kind = item.row.kind
  if (kind === 'ins') return 'launcher-row-add'
  if (kind === 'mod') return 'launcher-mod-add'
  if (kind === 'skip') return 'launcher-row-skip'
  return ''
}

/** 统一视图里由修改行拆出来的两行，用弱一点的底色 */
function unifiedBg(item: VisibleItem): string {
  const isMod = item.row.source?.kind === 'mod'
  if (item.row.kind === 'del') return isMod ? 'launcher-mod-del' : 'launcher-row-del'
  if (item.row.kind === 'ins') return isMod ? 'launcher-mod-add' : 'launcher-row-add'
  if (item.row.kind === 'skip') return 'launcher-row-skip'
  return ''
}

const widthCh = computed(() => {
  let max = 40
  for (const row of props.rows) {
    if (row.left.length > max) max = row.left.length
    if (row.right.length > max) max = row.right.length
  }
  return Math.min(max + 6, 800)
})

defineExpose({ scrollToIndex })
</script>

<template>
  <div ref="scroller" class="launcher-scroll relative h-full w-full bg-panel">
    <div class="relative" :style="{ height: totalHeight + 'px', width: widthCh + 'ch', minWidth: '100%' }">
      <!-- 并排：左删右改 -->
      <template v-if="mode === 'split'">
        <div
          v-for="item in visible"
          :key="item.row.key"
          class="launcher-diff-row absolute inset-x-0 flex"
          :style="{ top: item.index * ROW + 'px' }"
        >
          <span class="launcher-diff-no sticky left-0 bg-panel">{{ item.row.leftNo || '' }}</span>
          <span class="launcher-diff-line w-1/2" :class="leftBg(item)" v-html="leftHtml(item.row)" />
          <span class="launcher-diff-no sticky left-0 border-l border-line bg-panel">{{ item.row.rightNo || '' }}</span>
          <span class="launcher-diff-line flex-1" :class="rightBg(item)" v-html="rightHtml(item.row)" />
        </div>
      </template>

      <!-- 统一 -->
      <template v-else>
        <div
          v-for="item in visible"
          :key="item.row.key"
          class="launcher-diff-row absolute inset-x-0 flex"
          :style="{ top: item.index * ROW + 'px' }"
        >
          <span class="launcher-diff-no sticky left-0 bg-panel">{{ item.row.leftNo || item.row.rightNo || '' }}</span>
          <span class="launcher-diff-line flex-1" :class="unifiedBg(item)">
            <template v-if="item.row.kind === 'skip'">
              <span class="text-faint">⋯ 折叠 {{ item.row.skipped }} 行相同内容 ⋯</span>
            </template>
            <template v-else>
              <span class="text-faint">{{ item.row.sign }} </span>
              <span v-if="item.row.useRight" v-html="rightHtml(item.row)" />
              <span v-else v-html="leftHtml(item.row)" />
            </template>
          </span>
        </div>
      </template>
    </div>
  </div>
</template>
