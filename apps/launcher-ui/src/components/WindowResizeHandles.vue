<script setup lang="ts">
import { api, type ResizeDirection } from '../lib/api'

/**
 * 无边框窗口的缩放把手（requirements §3.1「缩放」）。
 *
 * 窗口没有系统边框可抓，所以四边 / 四角由这层透明把手补上：
 * mousedown 时把方向递给壳（`window.startResizeDragging`），之后的缩放由系统接管。
 * 因此这里是**一次请求**，不是跟随鼠标的每帧请求。
 *
 * 顶边中段刻意不放手柄 —— 那一条留给"按住面板拖动窗口"（见 App.vue 的拖拽区），
 * 两个手势压在同一个像素上会互相抢。四个角是例外：角上优先缩放，因为那里拖窗口没有意义。
 */
const emit = defineEmits<{ (e: 'resize-start'): void }>()

const HANDLES: Array<{ direction: ResizeDirection; cls: string }> = [
  { direction: 'north', cls: 'handle-n' },
  { direction: 'south', cls: 'handle-s' },
  { direction: 'east', cls: 'handle-e' },
  { direction: 'west', cls: 'handle-w' },
  { direction: 'northEast', cls: 'handle-ne' },
  { direction: 'northWest', cls: 'handle-nw' },
  { direction: 'southEast', cls: 'handle-se' },
  { direction: 'southWest', cls: 'handle-sw' },
]

function onDown(event: MouseEvent, direction: ResizeDirection): void {
  if (event.button !== 0) return
  event.preventDefault()
  emit('resize-start')
  void api.startWindowResize(direction).catch(() => undefined)
}
</script>

<template>
  <div class="resize-layer" aria-hidden="true">
    <div
      v-for="handle in HANDLES"
      :key="handle.direction"
      class="resize-handle"
      :class="handle.cls"
      @mousedown="onDown($event, handle.direction)"
    />
  </div>
</template>

<style scoped>
.resize-layer {
  position: absolute;
  inset: 0;
  z-index: 60; /* 压在拖拽条（40）之上：角上的缩放优先于拖动 */
  pointer-events: none;
}

.resize-handle {
  position: absolute;
  pointer-events: auto;
}

/* 边长 6px：再宽会盖到内容，再窄不好抓 */
.handle-n,
.handle-s {
  left: 12px;
  right: 12px;
  height: 6px;
  cursor: ns-resize;
}
.handle-n {
  top: 0;
}
.handle-s {
  bottom: 0;
}

.handle-w,
.handle-e {
  top: 12px;
  bottom: 12px;
  width: 6px;
  cursor: ew-resize;
}
.handle-w {
  left: 0;
}
.handle-e {
  right: 0;
}

/* 四个角 16×16：对角线方向，范围比边稍大一点才好抓 */
.handle-nw,
.handle-ne,
.handle-sw,
.handle-se {
  width: 16px;
  height: 16px;
}
.handle-nw {
  top: 0;
  left: 0;
  cursor: nwse-resize;
}
.handle-ne {
  top: 0;
  right: 0;
  cursor: nesw-resize;
}
.handle-sw {
  bottom: 0;
  left: 0;
  cursor: nesw-resize;
}
.handle-se {
  bottom: 0;
  right: 0;
  cursor: nwse-resize;
}
</style>
