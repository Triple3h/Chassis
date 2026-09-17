<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { api, type SystemStats } from '../lib/api'

/**
 * 搜索栏右侧的状态条：**启动台自身**占了多少（requirements §3.1「状态显示」）。
 *
 * 它回答的是一个具体问题 ——"这东西轻不轻"：CPU / 内存都取壳 + 内核两个进程之和，
 * 而不是整机负载（整机数字只在 tooltip 里作对照）。口径与算法见
 * `apps/kernel/src/services/systemStats.ts`。
 *
 * 刷新节奏是自己定的（3s，且**窗口隐藏时不拉**）：这类数字的唯一作用是"一眼看到涨没涨"，
 * 秒级刷新只是白白唤醒 CPU。
 */
const props = defineProps<{ active: boolean }>()

const REFRESH_MS = 3000
const stats = ref<SystemStats | null>(null)
let timer = 0

async function refresh(): Promise<void> {
  if (!props.active) return
  try {
    stats.value = (await api.systemStats()).stats
  } catch {
    // 内核未连接（standalone / 浏览器开发）时静默：状态条消失，不影响其它部分
  }
}

function start(): void {
  stop()
  if (!props.active) return
  void refresh()
  timer = window.setInterval(() => void refresh(), REFRESH_MS)
}

function stop(): void {
  if (timer) window.clearInterval(timer)
  timer = 0
}

watch(() => props.active, start, { immediate: true })
onUnmounted(stop)

/** 自身 CPU 百分比：没有差分基线时显示占位符（绝不拿一半的差值冒充整体） */
const cpuText = computed(() => {
  const value = stats.value?.app.cpu
  return value === null || value === undefined ? '—' : `${value.toFixed(1)}%`
})

const memText = computed(() => {
  const value = stats.value
  return value ? formatBytes(value.app.rss) : '—'
})

const title = computed(() => {
  const value = stats.value
  if (!value) return '正在读取启动台占用…'
  const [l1, l5, l15] = value.loadAvg
  return [
    `启动台自身：CPU ${cpuText.value} · 内存 ${memText.value}（壳 + 内核两进程之和）`,
    `　壳（launcher-shell）${formatBytes(value.app.rssShell)}`,
    `　内核（Node，含插件 worker）${formatBytes(value.app.rssKernel)}`,
    `CPU 百分比 = 两进程累计 CPU 时间差分 ÷ 墙钟 ÷ ${value.app.cores} 核（占整机；单核满载 = ${(100 / value.app.cores).toFixed(1)}%）`,
    `整机对照：CPU ${value.cpu}% · 内存 ${formatBytes(value.memUsed)} / ${formatBytes(value.memTotal)} · 负载 ${l1.toFixed(2)} / ${l5.toFixed(2)} / ${l15.toFixed(2)}`,
    '不含系统托管的 WebKit 渲染进程（界面绘制走系统共享进程）',
  ].join('\n')
})

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}
</script>

<template>
  <div v-if="stats" class="stats-chip" :title="title">
    <span class="stats-item">CPU {{ cpuText }}</span>
    <span class="stats-sep" />
    <span class="stats-item">内存 {{ memText }}</span>
  </div>
</template>

<style scoped>
/* 状态条刻意做得"安静"：它是背景信息，不该和搜索框 / 结果抢注意力 */
.stats-chip {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  color: var(--fg-muted);
  background: var(--hover);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  user-select: none;
  -webkit-user-select: none;
  cursor: default;
  transition: color var(--motion-instant) var(--motion-ease-move);
}

.stats-chip:hover {
  color: var(--fg);
}

.stats-sep {
  width: 1px;
  height: 10px;
  background: var(--border);
}
</style>
