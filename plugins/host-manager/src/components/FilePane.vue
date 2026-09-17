<script setup lang="ts">
import { computed, ref } from 'vue'
import { useVirtualList } from '@launcher/ui/virtual'
import type { PreviewLine } from '../core/blocks'

/**
 * 右栏：最终 hosts 文件。
 *
 * 显示的不是磁盘上那份，而是「按当前块配置算出来、点保存就会写进去的那份」——
 * 于是关掉一个块，能当场看见那个块整段变成注释，而不是等写完才发现。
 *
 * 行底色按所属块区分（块内连续一段同色 + 左侧色条），与左栏卡片同一套色号，
 * 一眼能对上是哪个块在写这些行。
 */
const props = defineProps<{
  lines: PreviewLine[]
  /** 与磁盘相比新增 / 变化的行号（1 基） */
  marks: Set<number>
  /** 悬停或选中的块：整段提亮 */
  activeBlockId: string | null
}>()

const emit = defineEmits<{ (e: 'pick-block', blockId: string | null): void }>()

/** 行高必须与样式里 .hm-line 的高度一致 */
const ROW_HEIGHT = 19
const scroller = ref<HTMLElement | null>(null)

const { startIndex, endIndex, offsetY, totalHeight, scrollToIndex } = useVirtualList(scroller, {
  count: computed(() => props.lines.length),
  rowHeight: ROW_HEIGHT,
})

const windowRows = computed(() =>
  props.lines.slice(startIndex.value, endIndex.value).map((line, i) => ({
    line,
    no: startIndex.value + i + 1,
  })),
)

/** 色号按块出现的顺序分配（6 色循环），与左栏卡片用的是同一套 */
const tints = computed(() => {
  const map = new Map<string, number>()
  for (const line of props.lines) {
    if (line.blockId && !map.has(line.blockId)) map.set(line.blockId, map.size % 6)
  }
  return map
})

defineExpose({
  /** 滚到某一行（左栏点块头时用） */
  scrollTo(lineNo: number) {
    scrollToIndex(Math.max(0, lineNo - 1), 'start')
  },
})
</script>

<template>
  <div ref="scroller" class="launcher-scroll min-h-0 flex-1">
    <div class="relative" :style="{ height: `${totalHeight}px` }">
      <div class="absolute left-0 top-0 w-max min-w-full" :style="{ transform: `translateY(${offsetY}px)` }">
        <div
          v-for="row in windowRows"
          :key="row.no"
          class="hm-line"
          :class="[
            `k-${row.line.kind}`,
            row.line.blockId ? `hm-tint-${tints.get(row.line.blockId) ?? 0}` : '',
            {
              'hm-line-dim': row.line.disabled,
              'hm-line-mark': marks.has(row.no),
              'hm-line-active': !!row.line.blockId && row.line.blockId === activeBlockId,
              'hm-line-block': row.line.kind === 'block-head',
              'hm-line-marker': row.line.kind === 'marker',
              'cursor-pointer': !!row.line.blockId,
            },
          ]"
          :style="{ height: `${ROW_HEIGHT}px` }"
          @click="emit('pick-block', row.line.blockId)"
        >
          <span class="hm-no">{{ row.no }}</span>
          <span class="hm-mark">{{ marks.has(row.no) ? '+' : '' }}</span>
          <span class="hm-text">{{ row.line.text || ' ' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
