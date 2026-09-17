<script setup lang="ts">
import IconGlyph from './IconGlyph.vue'

/**
 * 「恢复默认大小」（requirements §3.1）：**只在当前模式的尺寸被用户改过时出现**
 * （宿主态 / 插件页各记一份，谁被改过就在谁那里露头）。
 *
 * 两个落点共用它：宿主搜索态在搜索栏右侧（`label=false`，那一行空间紧，靠 title 说明），
 * 插件页在宿主 footer 右侧（`label=true` —— footer 是插件自己的页面，光一个图标没人猜得到）。
 */
withDefaults(defineProps<{ label?: boolean }>(), { label: false })

const emit = defineEmits<{ (e: 'reset'): void }>()
</script>

<template>
  <button
    type="button"
    class="reset-size"
    :class="{ 'reset-size-labeled': label }"
    title="恢复默认大小（清掉记住的窗口尺寸）"
    @click="emit('reset')"
  >
    <IconGlyph name="maximize" :size="13" />
    <span v-if="label">恢复默认大小</span>
  </button>
</template>

<style scoped>
.reset-size {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 22px;
  padding: 0 6px;
  border-radius: 999px;
  color: var(--fg-muted);
  background: var(--hover);
  font-size: 11px;
  transition:
    color var(--motion-instant) var(--motion-ease-move),
    background-color var(--motion-instant) var(--motion-ease-move);
}

.reset-size-labeled {
  padding: 0 9px;
}

.reset-size:hover {
  color: var(--color-accent);
}

.reset-size:active {
  background: var(--sel);
}
</style>
