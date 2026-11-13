<script setup lang="ts">
/**
 * 插件页顶栏：**全族只有这一种几何**。
 *
 * 以前 14 个插件各自手抄 `<header class="flex items-center gap-2 border-b ...px-3 py-2">`，
 * 结果高度 40 / 44 / 48 / 54、左右内距 12 / 14 / 16 各有几份 —— 在同一个窗口里换页，
 * 标题栏会上下跳。这里钉死：40px 高、12px 内距、8px 间距、一条底部发丝线。
 *
 * 内容是 slot：`<UiIcon name="..."/> <span class="text-[13px] font-semibold">标题</span>`
 * 后面跟状态 chip，右端动作按钮用 `<span class="ml-auto" />` 推开。
 */
</script>

<template>
  <header class="flex min-h-10 shrink-0 items-center gap-2 border-b border-line px-3">
    <slot />
  </header>
</template>
