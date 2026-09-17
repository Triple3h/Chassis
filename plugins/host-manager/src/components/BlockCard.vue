<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import EntryRow from './EntryRow.vue'
import { matchesQuery, type Block } from '../core/blocks'
import type { EntryLine } from '../core/hosts'

/**
 * 左栏的一个块：开关、名字、条目列表与块级操作。
 *
 * 块关闭 = 整块在文件里被注释掉（不是从文件里删掉），所以开关是「马上能看见」的，
 * 右栏同步把这一段的底色变灰。
 */
const props = defineProps<{
  block: Block
  /** 色号（与右栏同一套） */
  tint: number
  /** 过滤器：按域名 / IP / 备注筛条目，空串表示不过滤 */
  query: string
  expanded: boolean
  active: boolean
  /** 本卡片能上移 / 下移 */
  canUp: boolean
  canDown: boolean
  /** 冲突条目的 id 集合 */
  conflicts: Set<string>
  /** 文档版本号（浅响应式对象的更新靠它推下来） */
  version: number
}>()

const emit = defineEmits<{
  (e: 'expand'): void
  (e: 'toggle'): void
  (e: 'rename', name: string): void
  (e: 'remove'): void
  (e: 'move', delta: number): void
  (e: 'add-entry'): void
  (e: 'paste'): void
  (e: 'edit', line: EntryLine): void
  (e: 'toggle-entry', line: EntryLine): void
  (e: 'remove-entry', line: EntryLine): void
}>()

/** 卡片里最多渲染多少条（几万行的屏蔽列表就别一次铺出来了，用搜索缩小范围） */
const MAX_ROWS = 300

const nameInput = ref<HTMLInputElement | null>(null)
const editingName = ref(false)
const draftName = ref('')

const entries = computed(() => props.block.body.lines.filter((l): l is EntryLine => l.kind === 'entry'))

const matched = computed(() => entries.value.filter((l) => matchesQuery(l, props.query)))

const visible = computed(() => matched.value.slice(0, MAX_ROWS))
const hiddenCount = computed(() => Math.max(0, matched.value.length - visible.value.length))
/** 被过滤掉的块整个压暗：还能看见它在，只是不在结果里 */
const dimmed = computed(() => !!props.query.trim() && !matched.value.length)

async function startRename() {
  draftName.value = props.block.name
  editingName.value = true
  await nextTick()
  nameInput.value?.focus()
  nameInput.value?.select()
}

function commitRename() {
  if (!editingName.value) return
  editingName.value = false
  emit('rename', draftName.value)
}
</script>

<template>
  <div
    class="hm-card"
    :class="[`hm-edge-${tint}`, { 'hm-card-active': active, 'opacity-45': dimmed, 'hm-card-off': !block.enabled }]"
  >
    <div class="hm-head" @click="emit('expand')">
      <button
        class="launcher-switch"
        :data-on="block.enabled"
        :title="block.enabled ? '关闭这个块（整块注释掉）' : '启用这个块'"
        @click.stop="emit('toggle')"
      />

      <span class="hm-dot" :class="`hm-dot-${tint}`" />

      <input
        v-if="editingName"
        ref="nameInput"
        v-model="draftName"
        class="launcher-input hm-name-input"
        @click.stop
        @keydown.enter="commitRename"
        @keydown.esc.stop="editingName = false"
        @blur="commitRename"
      />
      <template v-else>
        <span class="min-w-0 flex-1 truncate text-[12.5px] font-semibold" :title="block.name">{{ block.name }}</span>
        <span v-if="!block.enabled" class="launcher-chip text-warn">已关闭</span>
        <span class="shrink-0 text-[11px] text-faint">{{ entries.length }} 条</span>
      </template>

      <UiIcon
        name="chevronDown"
        :size="13"
        class="shrink-0 text-faint transition-transform"
        :class="{ '-rotate-90': !expanded }"
      />

      <!-- 悬停才出现：绝对定位，不占块名的宽度（300px 的栏里挤不下第四列） -->
      <div class="hm-head-actions">
        <button class="launcher-btn ghost" :disabled="!canUp" title="上移" @click.stop="emit('move', -1)">
          <UiIcon name="chevronDown" :size="12" class="rotate-180" />
        </button>
        <button class="launcher-btn ghost" :disabled="!canDown" title="下移" @click.stop="emit('move', 1)">
          <UiIcon name="chevronDown" :size="12" />
        </button>
        <button class="launcher-btn ghost" title="改块名" @click.stop="startRename">
          <UiIcon name="pencil" :size="12" />
        </button>
        <button class="launcher-btn ghost text-danger" title="删除这个块" @click.stop="emit('remove')">
          <UiIcon name="trash" :size="12" />
        </button>
      </div>
    </div>

    <div v-if="expanded" class="border-t border-line">
      <div v-if="!entries.length" class="px-3 py-2.5 text-[12px] text-muted">
        这个块还是空的，下面加两条试试。
      </div>
      <div v-else-if="!matched.length" class="px-3 py-2.5 text-[12px] text-muted">没有匹配的记录</div>

      <div v-else :class="{ 'opacity-55': !block.enabled }">
        <EntryRow
          v-for="line in visible"
          :key="line.id"
          :line="line"
          :version="version"
          :conflict="conflicts.has(line.id)"
          @toggle="emit('toggle-entry', line)"
          @edit="emit('edit', line)"
          @remove="emit('remove-entry', line)"
        />
        <div v-if="hiddenCount" class="px-3 py-2 text-[11.5px] text-faint">
          还有 {{ hiddenCount }} 条没显示 —— 在搜索框里筛一下
        </div>
      </div>

      <div class="flex items-center gap-1.5 px-2.5 py-1.5">
        <button class="launcher-btn" @click="emit('add-entry')">
          <UiIcon name="plus" :size="12" /> 新增条目
        </button>
        <button class="launcher-btn" @click="emit('paste')">
          <UiIcon name="clipboard" :size="12" /> 粘贴导入
        </button>
      </div>
    </div>
  </div>
</template>
