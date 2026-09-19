<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import AppShell from '@launcher/ui/AppShell.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import { useToast } from '@launcher/ui/toast'
import { exec, host, hostUi, storage } from '@launcher/api'
import DetailDialog from './components/DetailDialog.vue'
import KillDialog from './components/KillDialog.vue'
import { DEMO_CORES, DEMO_DETAIL, DEMO_PORTS, DEMO_PROCS, DEMO_TOTAL_MEMORY } from './core/demo'
import {
  formatBytes,
  formatClock,
  formatPercent,
  killTargetFromProc,
  matchesPortQuery,
  matchesProcQuery,
  sortPorts,
  sortProcs,
  stateLabel,
  type PortSortKey,
  type ProcSortKey,
} from './core/format'
import type {
  KillTarget,
  PortEntry,
  PortListResult,
  ProcDetail,
  ProcDetailResult,
  ProcEntry,
  ProcListResult,
} from './core/types'

/**
 * 进程与端口面板。
 *
 * 两个视角：**端口**（谁占着我的 3000）与**进程**（谁在吃 CPU / 内存），
 * 数据全部来自本插件的 script 命令（Rust 逻辑层），这里只做展示、过滤与确认交互。
 * 终止是两段式的：默认优雅（SIGTERM / WM_CLOSE），退不掉才让用户决定要不要强杀。
 */

const toast = useToast()

const demoMode = ref(false)
const platform = ref('')
const tab = ref<'ports' | 'procs'>('ports')
const query = ref('')
const scope = ref<'listen' | 'all'>('listen')
const portSort = ref<PortSortKey>('port')
const procSort = ref<ProcSortKey>('cpu')
const autoRefresh = ref(true)
const loading = ref(false)
const scanError = ref<string | null>(null)

const ports = shallowRef<PortEntry[]>([])
const procs = shallowRef<ProcEntry[]>([])
const totalMemory = ref(0)
const cores = ref(1)
const scannedAt = ref(0)

const killTarget = shallowRef<KillTarget | null>(null)
const detail = shallowRef<ProcDetail | null>(null)

const searchRef = ref<HTMLInputElement | null>(null)

const AUTO_INTERVAL_MS = 10_000
const PREFS_KEY = 'prefs'

let timer: number | null = null
let refreshSeq = 0
let stopSearchWatch: (() => void) | null = null

const visiblePorts = computed(() =>
  sortPorts(ports.value.filter((entry) => matchesPortQuery(entry, query.value)), portSort.value),
)
const visibleProcs = computed(() => sortProcs(procs.value.filter((entry) => matchesProcQuery(entry, query.value)), procSort.value))
const currentPid = computed(() => detail.value?.pid ?? killTarget.value?.pid ?? 0)

/** 某个 PID 占用的全部端口号（终止确认时展示完整信息） */
function portsOfPid(pid: number): number[] {
  return [...new Set(ports.value.filter((entry) => entry.pid === pid).map((entry) => entry.port))].sort((a, b) => a - b)
}

function requestKillPort(entry: PortEntry) {
  killTarget.value = {
    pid: entry.pid,
    name: entry.process || '未知进程',
    user: entry.user,
    memory: entry.memory,
    risk: entry.risk,
    selfRelated: entry.selfRelated,
    ports: portsOfPid(entry.pid),
  }
}

function requestKillProc(entry: ProcEntry) {
  killTarget.value = killTargetFromProc(entry, portsOfPid(entry.pid))
}

async function openDetail(pid: number) {
  if (pid <= 0) return
  if (demoMode.value) {
    detail.value = { ...DEMO_DETAIL, pid, ports: DEMO_DETAIL.ports }
    return
  }
  const result = (await exec
    .run({ command: 'proc-detail', args: { pid }, timeoutMs: 20_000 })
    .catch(() => null)) as ProcDetailResult | null
  if (result?.ok && result.detail) {
    detail.value = result.detail
  } else {
    toast.err(result?.notFound ? '进程已不存在' : '读取进程详情失败')
  }
}

function requestKillFromDetail() {
  const current = detail.value
  if (!current) return
  const target = killTargetFromProc(current, current.ports.map((port) => port.port))
  target.cmd = current.cmd
  detail.value = null
  killTarget.value = target
}

async function refresh() {
  if (demoMode.value) return
  const seq = ++refreshSeq
  loading.value = true
  const [portResult, procResult] = await Promise.all([
    exec.run({ command: 'port-list', args: { scope: scope.value }, timeoutMs: 25_000 }).catch(() => null) as Promise<PortListResult | null>,
    exec.run({ command: 'proc-list', args: {}, timeoutMs: 25_000 }).catch(() => null) as Promise<ProcListResult | null>,
  ])
  if (seq !== refreshSeq) return // 新一轮刷新已开始，丢弃这次的迟到结果

  if (portResult?.ok) {
    ports.value = portResult.entries
    if (portResult.platform) platform.value = portResult.platform
    scanError.value = null
  } else if (portResult) {
    scanError.value = portResult.error ?? '端口扫描失败'
  } else {
    scanError.value = '端口扫描脚本调用失败（宿主不可用或超时）'
  }

  if (procResult?.ok) {
    procs.value = procResult.entries
    totalMemory.value = procResult.totalMemory
    cores.value = procResult.cores
    if (procResult.platform) platform.value = procResult.platform
  } else if (!procResult) {
    scanError.value = scanError.value ?? '进程列表脚本调用失败（宿主不可用或超时）'
  }

  scannedAt.value = Math.max(portResult?.scannedAt ?? 0, procResult?.scannedAt ?? 0)
  loading.value = false
}

function onKilled(pid: number) {
  toast.ok(`已处理 PID ${pid}`)
  void refresh()
}

function startTimer() {
  stopTimer()
  timer = window.setInterval(() => void refresh(), AUTO_INTERVAL_MS)
}

function stopTimer() {
  if (timer != null) {
    window.clearInterval(timer)
    timer = null
  }
}

watch(autoRefresh, (value) => {
  if (demoMode.value) return
  if (value) startTimer()
  else stopTimer()
})

watch(scope, () => void refresh())

// 界面偏好存宿主 storage（跨会话记住上次看的是哪个 tab / 排序）
watch([tab, scope, autoRefresh, portSort, procSort], () => {
  if (demoMode.value) return
  void storage
    .set(PREFS_KEY, {
      tab: tab.value,
      scope: scope.value,
      autoRefresh: autoRefresh.value,
      portSort: portSort.value,
      procSort: procSort.value,
    })
    .catch(() => undefined)
})

async function loadPrefs() {
  const prefs = (await storage.get<Record<string, unknown>>(PREFS_KEY).catch(() => undefined)) as
    | { tab?: string; scope?: string; autoRefresh?: boolean; portSort?: string; procSort?: string }
    | undefined
  if (!prefs) return
  if (prefs.tab === 'ports' || prefs.tab === 'procs') tab.value = prefs.tab
  if (prefs.scope === 'listen' || prefs.scope === 'all') scope.value = prefs.scope
  if (typeof prefs.autoRefresh === 'boolean') autoRefresh.value = prefs.autoRefresh
  if (prefs.portSort === 'port' || prefs.portSort === 'process' || prefs.portSort === 'memory') portSort.value = prefs.portSort
  if (prefs.procSort === 'cpu' || prefs.procSort === 'memory' || prefs.procSort === 'name' || prefs.procSort === 'pid') procSort.value = prefs.procSort
}

onMounted(async () => {
  if (!host.isLauncher()) {
    // 演示模式：让每一处 UI（风险徽标 / 确认弹窗）都能在浏览器里点一遍
    demoMode.value = true
    platform.value = navigator.userAgent.includes('Mac') ? 'darwin' : 'win32'
    ports.value = DEMO_PORTS
    procs.value = DEMO_PROCS
    totalMemory.value = DEMO_TOTAL_MEMORY
    cores.value = DEMO_CORES
    scannedAt.value = Date.now()
  } else {
    const initial = await hostUi.getSearchContent().catch(() => '')
    if (initial) query.value = initial
    stopSearchWatch = hostUi.watchSearchContent((value) => {
      query.value = value
    })
    await loadPrefs()
    await refresh()
    if (autoRefresh.value) startTimer()
  }
  await nextTick()
  searchRef.value?.focus()
})

onUnmounted(() => {
  stopTimer()
  stopSearchWatch?.()
})

const tabCount = computed(() => (tab.value === 'ports' ? visiblePorts.value.length : visibleProcs.value.length))
</script>

<template>
  <AppShell>
    <!-- 顶栏：标题 + 过滤 + 刷新 -->
    <header class="flex items-center gap-2 border-b border-line px-3 py-2.5">
      <span class="text-accent"><UiIcon name="list" :size="15" /></span>
      <span class="text-[13.5px] font-semibold">进程与端口</span>
      <div class="ml-2 min-w-0 flex-1">
        <input
          ref="searchRef"
          v-model="query"
          class="w-full rounded-lg border border-line bg-panel2 px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-faint focus:border-linestrong"
          :placeholder="tab === 'ports' ? '过滤：端口号 / 进程名 / PID / 用户' : '过滤：进程名 / PID / 用户'"
        />
      </div>
      <button class="launcher-btn ghost" title="刷新" :disabled="loading || demoMode" @click="refresh()">
        <UiIcon name="refresh" :size="14" :class="loading ? 'animate-spin' : ''" />
      </button>
      <label class="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11.5px] text-muted">
        <input v-model="autoRefresh" type="checkbox" :disabled="demoMode" />
        自动
      </label>
    </header>

    <div v-if="demoMode" class="border-b border-line bg-panel2 px-3 py-1.5 text-[11.5px] text-warn">
      演示模式：未检测到启动台宿主，下面是示例数据，「终止」不会真的执行。
    </div>

    <!-- 标签 + 排序 / 范围 -->
    <div class="flex items-center gap-1.5 border-b border-line px-3 py-1.5 text-[12px]">
      <button
        class="rounded-md px-2 py-1"
        :class="tab === 'ports' ? 'bg-active text-fg' : 'text-muted hover:bg-hover'"
        @click="tab = 'ports'"
      >
        端口 <span class="text-muted">{{ visiblePorts.length }}</span>
      </button>
      <button
        class="rounded-md px-2 py-1"
        :class="tab === 'procs' ? 'bg-active text-fg' : 'text-muted hover:bg-hover'"
        @click="tab = 'procs'"
      >
        进程 <span class="text-muted">{{ visibleProcs.length }}</span>
      </button>
      <div class="flex-1" />
      <template v-if="tab === 'ports'">
        <button
          class="rounded-md border border-line px-2 py-0.5 text-[11.5px]"
          :class="scope === 'listen' ? 'bg-active text-fg' : 'text-muted hover:bg-hover'"
          title="只看监听中的端口（TCP LISTEN + UDP）"
          @click="scope = 'listen'"
        >
          监听
        </button>
        <button
          class="rounded-md border border-line px-2 py-0.5 text-[11.5px]"
          :class="scope === 'all' ? 'bg-active text-fg' : 'text-muted hover:bg-hover'"
          title="包含所有连接（established 等）"
          @click="scope = 'all'"
        >
          全部连接
        </button>
      </template>
    </div>

    <!-- 错误 -->
    <div v-if="scanError" class="border-b border-line bg-panel2 px-3 py-1.5 text-[11.5px] text-warn">
      {{ scanError }}
    </div>

    <!-- 列表 -->
    <div class="launcher-scroll min-h-0 flex-1">
      <!-- 端口表 -->
      <template v-if="tab === 'ports'">
        <div class="grid grid-cols-[70px_78px_minmax(0,1fr)_70px_84px_80px_56px] items-center gap-2 border-b border-line px-3 py-1.5 text-[11px] text-muted">
          <button class="flex items-center gap-0.5 hover:text-fg" @click="portSort = 'port'">
            端口 <UiIcon v-if="portSort === 'port'" name="sortAsc" :size="10" />
          </button>
          <span>协议</span>
          <button class="flex items-center gap-0.5 hover:text-fg" @click="portSort = 'process'">
            进程 <UiIcon v-if="portSort === 'process'" name="sortAsc" :size="10" />
          </button>
          <span>PID</span>
          <span>用户</span>
          <button class="flex items-center gap-0.5 hover:text-fg" @click="portSort = 'memory'">
            内存 <UiIcon v-if="portSort === 'memory'" name="sortAsc" :size="10" />
          </button>
          <span />
        </div>
        <div v-if="visiblePorts.length === 0" class="px-3 py-8 text-center text-[12px] text-muted">
          {{ ports.length === 0 ? '没有扫描到端口占用。' : '没有匹配的端口。' }}
        </div>
        <div
          v-for="entry in visiblePorts"
          :key="`${entry.protocol}-${entry.port}-${entry.pid}`"
          class="grid cursor-pointer grid-cols-[70px_78px_minmax(0,1fr)_70px_84px_80px_56px] items-center gap-2 border-b border-line/60 px-3 py-1.5 text-[12px] hover:bg-hover"
          @click="openDetail(entry.pid)"
        >
          <span class="launcher-mono font-semibold text-accent">:{{ entry.port }}</span>
          <span class="truncate text-muted">{{ entry.protocol.toUpperCase() }} · {{ stateLabel(entry.state) }}</span>
          <span class="flex min-w-0 items-center gap-1.5">
            <UiIcon v-if="entry.risk === 'blocked'" name="shield" :size="11" class="shrink-0 text-danger" />
            <UiIcon v-else-if="entry.risk === 'caution'" name="alert" :size="11" class="shrink-0 text-warn" />
            <span class="truncate" :title="`${entry.process}（${entry.address}）`">{{ entry.process || '未知进程' }}</span>
          </span>
          <span class="launcher-mono text-muted">{{ entry.pid }}</span>
          <span class="truncate text-muted">{{ entry.user || '—' }}</span>
          <span class="launcher-mono text-muted">{{ formatBytes(entry.memory) }}</span>
          <span class="flex justify-end">
            <button
              class="launcher-btn ghost px-1.5 py-0.5"
              :disabled="entry.risk === 'blocked' || entry.selfRelated"
              :title="entry.risk === 'blocked' || entry.selfRelated ? '受保护进程，不允许终止' : '终止该进程'"
              @click.stop="requestKillPort(entry)"
            >
              <UiIcon name="close" :size="12" />
            </button>
          </span>
        </div>
      </template>

      <!-- 进程表 -->
      <template v-else>
        <div class="grid grid-cols-[minmax(0,1fr)_70px_62px_80px_84px_56px] items-center gap-2 border-b border-line px-3 py-1.5 text-[11px] text-muted">
          <button class="flex items-center gap-0.5 hover:text-fg" @click="procSort = 'name'">
            进程 <UiIcon v-if="procSort === 'name'" name="sortAsc" :size="10" />
          </button>
          <button class="flex items-center gap-0.5 hover:text-fg" @click="procSort = 'pid'">
            PID <UiIcon v-if="procSort === 'pid'" name="sortAsc" :size="10" />
          </button>
          <button class="flex items-center gap-0.5 hover:text-fg" @click="procSort = 'cpu'">
            CPU <UiIcon v-if="procSort === 'cpu'" name="sortAsc" :size="10" />
          </button>
          <button class="flex items-center gap-0.5 hover:text-fg" @click="procSort = 'memory'">
            内存 <UiIcon v-if="procSort === 'memory'" name="sortAsc" :size="10" />
          </button>
          <span>用户</span>
          <span />
        </div>
        <div v-if="visibleProcs.length === 0" class="px-3 py-8 text-center text-[12px] text-muted">
          {{ procs.length === 0 ? '没有扫描到进程。' : '没有匹配的进程。' }}
        </div>
        <div
          v-for="entry in visibleProcs"
          :key="entry.pid"
          class="grid cursor-pointer grid-cols-[minmax(0,1fr)_70px_62px_80px_84px_56px] items-center gap-2 border-b border-line/60 px-3 py-1.5 text-[12px] hover:bg-hover"
          :class="{ 'opacity-60': currentPid === entry.pid && killTarget != null }"
          @click="openDetail(entry.pid)"
        >
          <span class="flex min-w-0 items-center gap-1.5">
            <UiIcon v-if="entry.risk === 'blocked'" name="shield" :size="11" class="shrink-0 text-danger" />
            <UiIcon v-else-if="entry.risk === 'caution'" name="alert" :size="11" class="shrink-0 text-warn" />
            <span class="truncate" :title="entry.name">{{ entry.name || '未知进程' }}</span>
            <span v-if="entry.selfRelated" class="shrink-0 rounded border border-line px-1 text-[10px] text-danger">自身</span>
          </span>
          <span class="launcher-mono text-muted">{{ entry.pid }}</span>
          <span class="launcher-mono" :class="entry.cpu >= 20 ? 'text-warn' : 'text-muted'">{{ formatPercent(entry.cpu) }}</span>
          <span class="launcher-mono text-muted">{{ formatBytes(entry.memory) }}</span>
          <span class="truncate text-muted">{{ entry.user || '—' }}</span>
          <span class="flex justify-end">
            <button
              class="launcher-btn ghost px-1.5 py-0.5"
              :disabled="entry.risk === 'blocked' || entry.selfRelated"
              :title="entry.risk === 'blocked' || entry.selfRelated ? '受保护进程，不允许终止' : '终止该进程'"
              @click.stop="requestKillProc(entry)"
            >
              <UiIcon name="close" :size="12" />
            </button>
          </span>
        </div>
      </template>
    </div>

    <!-- 状态条 -->
    <footer class="flex items-center gap-2 border-t border-line px-3 py-1.5 text-[11px] text-muted">
      <span>{{ tabCount }} / {{ tab === 'ports' ? ports.length : procs.length }} 条</span>
      <span v-if="scannedAt">· 扫描于 {{ formatClock(scannedAt) }}</span>
      <span v-if="cores > 1 && tab === 'procs'">· {{ cores }} 核</span>
      <div class="flex-1" />
      <span v-if="tab === 'procs' && totalMemory > 0">总内存 {{ formatBytes(totalMemory) }}</span>
      <span>{{ platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : '' }}</span>
    </footer>

    <KillDialog
      v-if="killTarget"
      :target="killTarget"
      :platform="platform"
      :demo="demoMode"
      @close="killTarget = null"
      @done="onKilled"
    />
    <DetailDialog v-if="detail" :detail="detail" :total-memory="totalMemory" @close="detail = null" @kill="requestKillFromDetail" />
  </AppShell>
</template>
