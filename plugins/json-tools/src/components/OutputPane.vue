<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useVirtualList } from '@shared/lib/virtual'
import { highlightJsonLine } from '../core/highlight'
import { indexLines, lineAt } from '../core/lineIndex'

const props = defineProps<{
  text: string
  /** 压缩模式下是超长单行，跳过着色直接纯文本渲染 */
  plain?: boolean
}>()

const ROW = 20
const GUTTER = 46
const scroller = ref<HTMLElement | null>(null)

const index = computed(() => indexLines(props.text))
const { scrollTop, startIndex, endIndex, totalHeight, scrollToIndex } = useVirtualList(scroller, {
  count: computed(() => index.value.count),
  rowHeight: ROW,
})

interface Row {
  no: number
  /** 高亮后的 HTML（已转义） */
  html: string
  /** 纯文本，压缩模式下直接显示 */
  line: string
}

const rows = computed<Row[]>(() => {
  const idx = index.value
  const out: Row[] = []
  for (let i = startIndex.value; i < endIndex.value; i++) {
    const line = lineAt(props.text, idx, i)
    out.push({ no: i, line, html: props.plain ? '' : highlightJsonLine(line) })
  }
  return out
})

/** 用最长行的字符数撑开横向宽度，避免滚动条随可视行抖动 */
const widthCh = computed(() => Math.max(index.value.maxLen + 4, 40))

watch(
  () => props.text,
  () => {
    if (scroller.value) scroller.value.scrollTop = 0
  },
)

defineExpose({ scrollToIndex })
</script>

<template>
  <div class="relative h-full w-full bg-panel">
    <!-- 代码区：双向滚动，左侧留出行号宽度 -->
    <div ref="scroller" class="launcher-scroll absolute inset-0" :style="{ paddingLeft: GUTTER + 'px' }">
      <div class="relative" :style="{ height: totalHeight + 'px', width: widthCh + 'ch', minWidth: '100%' }">
        <div
          v-for="row in rows"
          :key="row.no"
          class="launcher-code-row"
          :style="{ top: row.no * ROW + 'px' }"
        >
          <template v-if="plain">{{ row.line }}</template>
          <span v-else v-html="row.html" />
        </div>
      </div>
    </div>

    <!-- 行号层：不参与横向滚动，只跟随纵向位移 -->
    <div
      class="pointer-events-none absolute inset-y-0 left-0 overflow-hidden border-r border-line bg-panel"
      :style="{ width: GUTTER + 'px' }"
    >
      <div class="relative" :style="{ height: totalHeight + 'px', transform: `translateY(${-scrollTop}px)` }">
        <div
          v-for="row in rows"
          :key="row.no"
          class="launcher-gutter"
          :style="{ top: row.no * ROW + 'px' }"
        >
          {{ row.no + 1 }}
        </div>
      </div>
    </div>
  </div>
</template>
