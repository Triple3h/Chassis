<script setup lang="ts">
/**
 * 插件页页脚：**全族只有这一种几何**。
 *
 * 一行按键提示 + 右侧状态字。文字用 muted 而不是 faint —— 页脚这排字是「怎么用」
 * 的信息，浅色主题下 faint 只有 3.6:1，读不动。
 *
 * 内容写法：`<span><span class="launcher-kbd">Enter</span> 添加</span>`，
 * 右端状态用 `<span class="ml-auto" />` 推开。
 */
</script>

<template>
  <footer class="flex shrink-0 items-center gap-3 border-t border-line px-3 py-1.5 text-[11.5px] text-muted">
    <slot />
  </footer>
</template>
