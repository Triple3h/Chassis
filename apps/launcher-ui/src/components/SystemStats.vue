<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { api, type SystemStats } from '../lib/api'

/**
 * 搜索栏右侧的状态条：**启动台自身**占了多少（requirements §3.1「状态显示」）。
 *
 * 它回答的是一个具体问题 ——"这东西轻不轻"：CPU / 内存都取壳 + 内核两个进程之和，
 * 而不是整机负载（整机数字只在悬浮面板里作对照）。口径与算法见
 * `apps/kernel/src/services/system_stats.rs`。
 *
 * 刷新节奏是自己定的（3s，且**窗口隐藏时不拉**）：这类数字的唯一作用是"一眼看到涨没涨"，
 * 秒级刷新只是白白唤醒 CPU。
 *
 * 分解信息**不用原生 `title`**（那一版只能吐一整块无排版的纯文本）：
 * 自绘悬浮面板按「进程分解 / 整机对照」两张表排版，颜色 / 字体 / 间距全部吃 DESIGN 令牌，
 * 宽度按视口自适应（窗口被拉窄时收窄，最多占满一行）。
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

// ── 悬浮面板的展开时机 ───────────────────────────────────────
/** 悬停稍作停留才展开：鼠标横穿搜索栏去点齿轮时不该闪一下面板 */
const OPEN_DELAY_MS = 120
/** 离开后短暂保留：够跨过「状态条 → 面板」之间那段视觉留白 */
const CLOSE_DELAY_MS = 140
const open = ref(false)
let hoverTimer = 0

function showSoon(): void {
  window.clearTimeout(hoverTimer)
  hoverTimer = window.setTimeout(() => {
    open.value = true
  }, OPEN_DELAY_MS)
}

function hideSoon(): void {
  window.clearTimeout(hoverTimer)
  hoverTimer = window.setTimeout(() => {
    open.value = false
  }, CLOSE_DELAY_MS)
}

watch(
  () => props.active,
  (value) => {
    // 窗口藏起来了：面板没有存在的理由（数据也不再刷新，留着只会是过期的数字）
    if (!value) {
      window.clearTimeout(hoverTimer)
      hoverTimer = 0
      open.value = false
    }
    start()
  },
  { immediate: true },
)

onUnmounted(() => {
  stop()
  window.clearTimeout(hoverTimer)
})

/** 自身 CPU 百分比：没有差分基线时显示占位符（绝不拿一半的差值冒充整体） */
const cpuText = computed(() => {
  const value = stats.value?.app.cpu
  return value === null || value === undefined ? '—' : `${value.toFixed(1)}%`
})

const memText = computed(() => {
  const value = stats.value
  return value ? formatBytes(value.app.rss) : '—'
})

/** 状态条本身只有两个数字，完整口径挂在 `aria-label` 上（原生 title 已让位给自绘面板） */
const chipLabel = computed(() => `启动台占用：CPU ${cpuText.value}，内存 ${memText.value}`)

/** 采样时刻（面板里给出"这几行数字有多新"） */
const sampledAtText = computed(() => {
  const at = stats.value?.sampledAt
  if (!at) return '—'
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
})

const machineCpuText = computed(() => (stats.value ? `${stats.value.cpu.toFixed(1)}%` : '—'))
const machineMemText = computed(() =>
  stats.value ? `${formatBytes(stats.value.memUsed)} / ${formatBytes(stats.value.memTotal)}` : '—',
)
const loadText = computed(() =>
  stats.value ? stats.value.loadAvg.map((value) => value.toFixed(2)).join(' / ') : '—',
)
/** CPU 百分比按核心数归一（内核侧的算法）：单核满载 = 100 / 核数 */
const singleCoreText = computed(() => {
  const cores = stats.value?.app.cores ?? 0
  return cores > 0 ? `${(100 / cores).toFixed(1)}%` : '—'
})

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}
</script>

<template>
  <div v-if="stats" class="stats" @mouseenter="showSoon" @mouseleave="hideSoon">
    <div class="stats-chip" role="img" :aria-label="chipLabel">
      <span class="stats-item">CPU {{ cpuText }}</span>
      <span class="stats-sep" />
      <span class="stats-item">内存 {{ memText }}</span>
    </div>

    <Transition name="motion-menu" :duration="{ enter: 140, leave: 90 }">
      <!-- @mousedown.stop：面板落在搜索栏这一行里（父级是 data-drag-region），
           不拦住的话按住面板会变成"拖窗口"——表格里的文字就没法选了 -->
      <div v-if="open" class="stats-anchor" role="tooltip" aria-hidden="true" @mousedown.stop>
        <div class="stats-panel">
          <div class="stats-head">
            <span class="stats-title">启动台占用</span>
            <span class="stats-time">采样 {{ sampledAtText }}</span>
          </div>

          <div class="stats-caption">进程分解</div>
          <table class="stats-table">
            <thead>
              <tr>
                <th>进程</th>
                <th class="col-num">CPU</th>
                <th class="col-num">内存</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>壳 launcher-shell</td>
                <td class="col-num col-muted">—</td>
                <td class="col-num">{{ formatBytes(stats.app.rssShell) }}</td>
              </tr>
              <tr>
                <td>内核 launcher-kernel（含插件进程）</td>
                <td class="col-num col-muted">—</td>
                <td class="col-num">{{ formatBytes(stats.app.rssKernel) }}</td>
              </tr>
              <tr class="stats-total">
                <td>合计</td>
                <td class="col-num">{{ cpuText }}</td>
                <td class="col-num">{{ memText }}</td>
              </tr>
            </tbody>
          </table>

          <div class="stats-caption">整机对照</div>
          <table class="stats-table">
            <thead>
              <tr>
                <th>指标</th>
                <th class="col-num">数值</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>CPU 使用率</td>
                <td class="col-num">{{ machineCpuText }}</td>
              </tr>
              <tr>
                <td>内存（系统「已用」口径）</td>
                <td class="col-num">{{ machineMemText }}</td>
              </tr>
              <tr>
                <td>平均负载 1 / 5 / 15 分钟</td>
                <td class="col-num">{{ loadText }}</td>
              </tr>
            </tbody>
          </table>

          <ul class="stats-notes">
            <li>分进程 CPU 未单独采样，合计 = 壳 + 内核两进程之和</li>
            <li>CPU% = 累计 CPU 时间差分 ÷ 墙钟 ÷ {{ stats.app.cores }} 核（占整机，单核满载 {{ singleCoreText }}）</li>
            <li>不含系统托管的 WebKit 渲染进程（界面绘制走系统共享进程）</li>
          </ul>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* 状态条刻意做得"安静"：它是背景信息，不该和搜索框 / 结果抢注意力 */
.stats {
  position: relative;
  flex: none;
  display: flex;
}

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

/* ── 悬浮面板 ────────────────────────────────────────────────
   贴着状态条右缘向下弹出。锚点自己垫 8px 上内边距当"桥梁"：
   鼠标从状态条移向面板时不会穿过一段"空隙"而提前触发 mouseleave。 */
.stats-anchor {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 50;
  padding-top: 8px;
  --motion-origin: top right; /* 从状态条那一角长出来（.motion-menu-* 消费） */
}

.stats-panel {
  /* 宽度取"面板理想宽度"与"窗口里真正放得下的宽度"的较小者：
     状态条右缘距窗口右边约 62px，所以要把这段留白一起扣掉。
     窄窗（480px 是壳允许的最小宽度）下自动收窄，不会被窗口裁掉。 */
  width: min(340px, calc(100vw - 84px));
  max-height: calc(100vh - 72px);
  overflow-y: auto;
  padding: 10px 12px 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  backdrop-filter: blur(18px);
  box-shadow:
    0 16px 40px rgba(0, 0, 0, 0.28),
    0 2px 8px rgba(0, 0, 0, 0.12);
  color: var(--fg);
  font-size: 11.5px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  user-select: text;
  -webkit-user-select: text;
  cursor: default;
}

.stats-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.stats-title {
  font-size: 12px;
  font-weight: 500;
}

.stats-time {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--fg-muted);
}

.stats-caption {
  margin: 8px 0 2px;
  font-size: 10.5px;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
}

/* 三线表：表头一条底线、行间发丝线，合计行用底色挑出来 */
.stats-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
}

.stats-table th,
.stats-table td {
  padding: 3px 0;
  text-align: left;
  vertical-align: top;
}

.stats-table th {
  border-bottom: 1px solid var(--border);
  font-size: 10.5px;
  font-weight: 400;
  letter-spacing: 0.04em;
  color: var(--fg-muted);
}

.stats-table tbody tr + tr td {
  border-top: 1px solid var(--border);
}

.stats-table .col-num {
  padding-left: 10px;
  text-align: right;
  white-space: nowrap;
}

.col-muted {
  color: var(--fg-muted);
}

.stats-total td {
  background: var(--hover);
  font-weight: 500;
  color: var(--fg);
}

.stats-total td:first-child {
  border-radius: 6px 0 0 6px;
}

.stats-total td:last-child {
  border-radius: 0 6px 6px 0;
}

/* 口径说明：和数字同处一个面板，但不该跟数字抢注意力 */
.stats-notes {
  display: grid;
  gap: 3px;
  margin: 8px 0 0;
  padding: 8px 0 0;
  border-top: 1px solid var(--border);
  list-style: none;
  color: var(--fg-muted);
  font-size: 10.5px;
  line-height: 1.45;
}

/* 窄窗（含窗口被拉到最窄时）：同样的信息，收一档间距与字号 */
@media (max-width: 560px) {
  .stats-panel {
    padding: 8px 10px 10px;
    font-size: 11px;
  }

  .stats-caption {
    margin-top: 6px;
  }

  .stats-table th,
  .stats-table td {
    padding: 2px 0;
  }

  .stats-notes {
    gap: 2px;
    font-size: 10px;
  }
}
</style>
