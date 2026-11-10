<script setup lang="ts">
/**
 * 更新页的变更说明（notes）：分类标题 + 圆点条目 + 行内加粗 / 代码。
 *
 * 发布索引里的 notes 是 Keep a Changelog 片段（`### Changed` / `- …`），
 * 直接当纯文本塞进 `<p>` 会把换行压平、`###` / `**` 原样露出来。
 */
import { computed } from 'vue'
import { parseChangelog } from '../lib/changelog'

const props = defineProps<{ notes?: string | null }>()

const groups = computed(() => parseChangelog(props.notes))
</script>

<template>
  <div v-if="groups.length" class="mt-1.5 space-y-1.5 text-[11.5px] leading-[1.5] text-faint">
    <div v-for="(group, groupIndex) in groups" :key="groupIndex">
      <div v-if="group.title" class="mb-0.5 text-[10.5px] font-medium tracking-wide text-muted">
        {{ group.title }}
      </div>
      <ul class="space-y-0.5">
        <li v-for="(item, itemIndex) in group.items" :key="itemIndex" class="flex gap-1.5">
          <span class="mt-[7px] size-[3px] shrink-0 rounded-full bg-accent/60" />
          <span class="min-w-0 break-words">
            <template v-for="(segment, segmentIndex) in item" :key="segmentIndex">
              <strong v-if="segment.bold" class="font-medium text-muted">{{ segment.text }}</strong>
              <code v-else-if="segment.code" class="rounded bg-hover px-1 py-px font-mono text-[10.5px]">{{ segment.text }}</code>
              <template v-else>{{ segment.text }}</template>
            </template>
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>
