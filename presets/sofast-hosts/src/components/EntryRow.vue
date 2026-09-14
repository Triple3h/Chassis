<script setup lang="ts">
import { computed } from 'vue'
import SofIcon from '@shared/ui/SofIcon.vue'
import { ipWarning, isProtectedEntry, type EntryLine } from '../core/hosts'

/**
 * 列表里的一行条目（定高 40px，配合虚拟滚动）。
 * 行高写死在模板里，useVirtualList 的 rowHeight 必须和它一致。
 */
const props = defineProps<{
  line: EntryLine
  /** 域名与其它启用条目重复 */
  conflict: boolean
  /**
   * 文档版本号。
   * 文档用的是 shallowRef（几万行不能深度代理），条目属性原地改动不会触发子组件更新，
   * 靠这个每次操作都自增的数字把更新推下来。
   */
  version: number
}>()

const emit = defineEmits<{
  (e: 'toggle'): void
  (e: 'edit'): void
  (e: 'remove'): void
}>()

const locked = computed(() => isProtectedEntry(props.line))
const ipBad = computed(() => ipWarning(props.line.ip) !== null)
const namesTitle = computed(() => props.line.names.join(' '))
</script>

<template>
  <div
    class="sof-row group flex h-10 cursor-pointer items-center gap-2.5 border-b border-line px-3 hover:bg-hover"
    :class="{ 'opacity-50': line.disabled }"
    @click="emit('edit')"
  >
    <button
      class="sof-switch"
      :data-on="!line.disabled"
      :title="line.disabled ? '启用这一条' : '禁用这一条'"
      @click.stop="emit('toggle')"
    />

    <span
      class="sof-mono w-[104px] shrink-0 truncate text-[12px]"
      :class="ipBad ? 'text-danger' : 'text-fg'"
      :title="line.ip"
    >
      {{ line.ip }}
    </span>

    <div class="min-w-0 flex-1 truncate text-[12.5px]" :title="namesTitle">
      <span class="text-accent">{{ line.names.join('  ') }}</span>
      <span v-if="line.comment" class="ml-2.5 text-[11.5px] text-muted"># {{ line.comment }}</span>
    </div>

    <span v-if="locked" class="shrink-0 text-faint" title="系统关键条目，删掉可能影响本机解析">
      <SofIcon name="lock" :size="12" />
    </span>
    <span v-if="conflict" class="shrink-0 text-warn" title="这个域名在别处指向了另一个 IP，hosts 只会以最后一条为准">
      <SofIcon name="alert" :size="12" />
    </span>

    <div class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
      <button class="sof-btn ghost" title="编辑" @click.stop="emit('edit')">
        <SofIcon name="pencil" :size="12" />
      </button>
      <button class="sof-btn ghost text-danger" title="删除" @click.stop="emit('remove')">
        <SofIcon name="trash" :size="12" />
      </button>
    </div>
  </div>
</template>
