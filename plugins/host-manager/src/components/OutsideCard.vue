<script setup lang="ts">
import { computed } from 'vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import { matchesQuery } from '../core/blocks'
import { isProtectedEntry, type EntryLine } from '../core/hosts'

/**
 * 「外部条目」卡片：托管区之外、不是这个插件加的记录 ——
 * 系统自带的回环行、VPN 启动时自己写进去的行、用户直接拿编辑器加的行都算。
 *
 * 这些行**不归插件管**：插件既不改它们、也不会替它们做开关
 * （写了也会被下一个程序覆盖，只会让人以为生效了）。想管就「收进块」：
 * 那条记录会被挪进托管区，从此归某个块调度。
 */
const props = defineProps<{
  entries: EntryLine[]
  /** 区外读不出结构的行数 */
  raw: number
  query: string
  expanded: boolean
  conflicts: Set<string>
  /** 文档版本号（浅响应式对象的更新靠它推下来） */
  version: number
}>()

const emit = defineEmits<{
  (e: 'expand'): void
  (e: 'adopt', line: EntryLine): void
  (e: 'adopt-all'): void
}>()

const MAX_ROWS = 200

const matched = computed(() => props.entries.filter((l) => matchesQuery(l, props.query)))

const visible = computed(() => matched.value.slice(0, MAX_ROWS))
const hiddenCount = computed(() => Math.max(0, matched.value.length - visible.value.length))
const dimmed = computed(() => !!props.query.trim() && !matched.value.length)
/** 能收进托管区的（系统回环行不收：收进块再关掉会让本机解析出问题） */
const adoptable = computed(() => props.entries.filter((l) => !isProtectedEntry(l)))

const protectedIds = computed(() => {
  const ids = new Set<string>()
  for (const line of props.entries) if (isProtectedEntry(line)) ids.add(line.id)
  return ids
})
</script>

<template>
  <div class="hm-outside group" :class="{ 'opacity-45': dimmed }">
    <div class="flex cursor-pointer items-center gap-2 px-2.5 py-2" @click="emit('expand')">
      <span class="text-faint"><UiIcon name="lock" :size="13" /></span>
      <span class="min-w-0 flex-1 truncate text-[12.5px] font-semibold">外部条目</span>
      <span class="launcher-chip" title="不属于本插件托管区的内容，插件不会去改它们">非插件添加</span>
      <span class="text-[11px] text-faint">{{ entries.length }} 条</span>
      <UiIcon
        name="chevronDown"
        :size="13"
        class="shrink-0 text-faint transition-transform"
        :class="{ '-rotate-90': !expanded }"
      />
    </div>

    <div v-if="expanded" class="border-t border-line">
      <div class="px-3 pt-2 text-[11.5px] text-muted">
        {{ raw ? `另有 ${raw} 行读不出结构。` : '' }}系统与其它程序维护的行，收进块后才归本插件调度。
      </div>

      <div v-if="!matched.length" class="px-3 py-2 text-[12px] text-muted">
        {{ query ? '没有匹配的记录' : '托管区之外没有能识别的记录' }}
      </div>

      <!-- 条目多时自己在卡片里滚：不然二十来行就把下面的块卡片顶出视野 -->
      <div v-else class="launcher-scroll mt-1 max-h-[248px]">
        <div
          v-for="line in visible"
          :key="line.id"
          class="hm-out-row flex h-8 items-center gap-3 px-3 pr-12 hover:bg-hover"
        >
          <span class="launcher-mono w-[94px] shrink-0 truncate text-[11.5px] text-muted" :title="line.ip">
            {{ line.ip }}
          </span>
          <span class="min-w-0 flex-1 truncate text-[12.5px]" :title="line.names.join(' ')">
            <span class="text-accent">{{ line.names.join('  ') }}</span>
            <span v-if="line.comment" class="ml-2 text-[11px] text-muted"># {{ line.comment }}</span>
          </span>
          <span v-if="conflicts.has(line.id)" class="shrink-0 text-warn" title="这个域名在别处指向了另一个 IP">
            <UiIcon name="alert" :size="12" />
          </span>
          <span v-if="protectedIds.has(line.id)" class="shrink-0 text-faint" title="系统关键条目，不建议挪走">
            <UiIcon name="lock" :size="12" />
          </span>
          <button
            v-else
            class="hm-adopt launcher-btn"
            title="收进某个块，从此由本插件调度"
            @click.stop="emit('adopt', line)"
          >
            收进
          </button>
        </div>
        <div v-if="hiddenCount" class="px-3 py-1 text-[11.5px] text-faint">还有 {{ hiddenCount }} 条没显示</div>
      </div>

      <div class="flex h-9 items-center gap-2 border-t border-line px-2.5">
        <button class="launcher-btn" :disabled="!adoptable.length" @click="emit('adopt-all')">
          <UiIcon name="download" :size="12" /> 全部收进新块
        </button>
        <span class="min-w-0 flex-1 truncate text-[11px] text-faint">系统回环行留在外面</span>
      </div>
    </div>
  </div>
</template>
