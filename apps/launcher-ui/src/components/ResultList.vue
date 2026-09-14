<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import GroupHeader from './GroupHeader.vue'
import ResultRow from './ResultRow.vue'
import { useVirtualRows } from '../lib/virtual'
import type { Row } from '../lib/types'

const props = defineProps<{
  rows: Row[]
  selectedIndex: number
  rowHeight: number
  viewportHeight: number
}>()

const emit = defineEmits<{
  (e: 'hover', index: number): void
  (e: 'activate', index: number): void
  (e: 'context', index: number, event: MouseEvent): void
  (e: 'toggleGroup', group: string): void
}>()

const container = ref<HTMLElement | null>(null)
const rowsRef = computed(() => props.rows)
const rowHeightRef = computed(() => props.rowHeight)
const viewportRef = computed(() => props.viewportHeight)

const { enabled, visible, totalHeight, offsetTop, onScroll, scrollIndexIntoView } = useVirtualRows(
  rowsRef,
  rowHeightRef as never,
  viewportRef as never,
)

watch(
  () => props.selectedIndex,
  (index) => scrollIndexIntoView(index, container.value),
)

onMounted(() => {
  scrollIndexIntoView(props.selectedIndex, container.value)
})

defineExpose({ container })
</script>

<template>
  <div
    ref="container"
    class="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain py-1"
    @scroll="onScroll"
  >
    <div v-if="enabled" :style="{ height: `${totalHeight}px`, position: 'relative' }">
      <div :style="{ transform: `translateY(${offsetTop}px)` }">
        <template v-for="item in visible" :key="item.row.key">
          <GroupHeader
            v-if="item.row.kind === 'header'"
            :label="item.row.label ?? ''"
            :count="item.row.count"
            :collapsed="item.row.collapsed"
            :collapsible="Boolean(item.row.group === 'pinned' || item.row.group === 'recent')"
            @toggle="emit('toggleGroup', item.row.group ?? '')"
          />
          <ResultRow
            v-else-if="item.row.result"
            :result="item.row.result"
            :selected="item.row.index === selectedIndex"
            :index="item.row.index ?? 0"
            @hover="emit('hover', $event)"
            @activate="emit('activate', $event)"
            @context="(i, ev) => emit('context', i, ev)"
          />
        </template>
      </div>
    </div>

    <template v-else>
      <template v-for="item in visible" :key="item.row.key">
        <GroupHeader
          v-if="item.row.kind === 'header'"
          :label="item.row.label ?? ''"
          :count="item.row.count"
          :collapsed="item.row.collapsed"
          :collapsible="Boolean(item.row.group === 'pinned' || item.row.group === 'recent')"
          @toggle="emit('toggleGroup', item.row.group ?? '')"
        />
        <ResultRow
          v-else-if="item.row.result"
          :result="item.row.result"
          :selected="item.row.index === selectedIndex"
          :index="item.row.index ?? 0"
          @hover="emit('hover', $event)"
          @activate="emit('activate', $event)"
          @context="(i, ev) => emit('context', i, ev)"
        />
      </template>
    </template>
  </div>
</template>
