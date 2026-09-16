<script setup lang="ts">
import IconGlyph from './IconGlyph.vue'
import { formatKeys } from '../lib/keys'
import type { FooterButtonView } from '../stores/ui'

/**
 * `back` 是宿主自有的退出入口，只看插件视图用得到。
 *
 * 为什么非得有一个真按钮：插件页占满整个窗口，而它是**插件自己的**顶栏（各插件都画了），
 * 宿主不能再叠一条标题栏上去。于是窗口上没有任何"关闭"的视觉线索，
 * 只能靠 `Esc` / `⌘W` —— 对不知道这两个键的人来说，插件页就是一间隔绝的屋子。
 * 放在 footer 而不是浮在右上角：右上角会被插件自己的顶栏内容压住。
 */
defineProps<{
  buttons: FooterButtonView[]
  defaultHints: Array<{ keys: string[]; label: string }>
  back?: boolean
}>()

/** 两个等价的退出键（App.vue 的键盘处理里它们走同一条分支）：Esc 与 ⌘W */
const backKeys = formatKeys(['Escape', 'Mod+W'])

const emit = defineEmits<{
  (e: 'action', button: FooterButtonView, itemId?: string): void
  (e: 'back'): void
}>()
</script>

<template>
  <div class="hairline flex items-center gap-3 px-4 h-[36px] text-[11px] text-[var(--fg-muted)]">
    <!-- 退出入口：与插件自己的按钮之间留一道竖线，别让「返回」混进主要动作里被误点 -->
    <template v-if="back">
      <div class="flex items-center gap-1.5">
        <button type="button" class="footer-back" title="返回启动台" @click="emit('back')">
          <IconGlyph name="chevron-left" :size="13" />
          <span>返回</span>
        </button>
        <span v-for="key in backKeys" :key="key" class="kbd">{{ key }}</span>
      </div>
      <span v-if="buttons.length > 0" class="footer-sep" />
    </template>

    <div v-for="button in buttons" :key="button.id" class="flex items-center gap-1.5">
      <template v-if="button.type === 'button'">
        <button type="button" class="footer-btn" @click="emit('action', button)">
          <IconGlyph v-if="button.icon" :name="button.icon" :size="12" />
          <span>{{ button.label }}</span>
        </button>
      </template>
      <template v-else>
        <button type="button" class="footer-btn" @click="emit('action', button)">
          <IconGlyph v-if="button.icon" :name="button.icon" :size="12" />
          <span>{{ button.label }}</span>
        </button>
        <span v-for="item in button.items ?? []" :key="item.id" class="hidden" />
      </template>
      <span v-for="key in formatKeys(button.keys)" :key="key" class="kbd">{{ key }}</span>
    </div>

    <div class="ml-auto flex items-center gap-3">
      <span v-for="hint in defaultHints" :key="hint.label" class="flex items-center gap-1">
        <span v-for="key in hint.keys" :key="key" class="kbd">{{ key }}</span>
        <span>{{ hint.label }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.footer-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: 6px;
  padding: 2px 6px;
  transition: background-color var(--motion-instant) var(--motion-ease-move);
}

.footer-btn:hover {
  background: var(--hover);
}

.footer-btn:active {
  background: var(--sel);
}

/* 退出入口刻意比同排的按钮重一档：描边 + 实底 + 更亮的文字，
   它必须一眼看出"能点"，而不是又一条提示文字 */
.footer-back {
  flex: none;
  display: flex;
  align-items: center;
  gap: 5px;
  border-radius: 6px;
  padding: 2px 8px;
  color: var(--fg);
  background: var(--hover);
  border: 1px solid var(--border);
  transition:
    background-color var(--motion-instant) var(--motion-ease-move),
    border-color var(--motion-instant) var(--motion-ease-move),
    color var(--motion-instant) var(--motion-ease-move);
}

.footer-back:hover {
  color: var(--color-accent);
  background: var(--sel);
  border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
}

.footer-back:active {
  background: color-mix(in srgb, var(--color-accent) 24%, transparent);
}

.footer-sep {
  flex: none;
  width: 1px;
  height: 14px;
  background: var(--border);
}
</style>
