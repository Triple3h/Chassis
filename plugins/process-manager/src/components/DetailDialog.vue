<script setup lang="ts">
import { computed, ref } from 'vue'
import UiDialog from '@launcher/ui/UiDialog.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import {
  formatBytes,
  formatClock,
  formatPercent,
  formatUptime,
  memoryShare,
  RISK_HINT,
  RISK_LABEL,
  stateLabel,
} from '../core/format'
import type { ProcDetail } from '../core/types'

/** 进程详情：命令行、父进程、启动时刻、它此刻占用的端口 —— 点「终止」前先看个清楚。 */
const props = defineProps<{
  detail: ProcDetail
  totalMemory: number
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'kill'): void
}>()

const nowMs = ref(Date.now())
const blocked = computed(() => props.detail.risk === 'blocked' || props.detail.selfRelated)
const share = computed(() => memoryShare(props.detail.memory, props.totalMemory))
const uptime = computed(() => formatUptime(props.detail.startedAt, nowMs.value))
</script>

<template>
  <UiDialog title="进程详情" :subtitle="`${detail.name}（PID ${detail.pid}）`" size="wide" @close="emit('close')">
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-2 text-[11.5px]">
        <span
          class="rounded-full border border-line px-2 py-0.5"
          :class="{
            'text-muted': detail.risk === 'safe',
            'text-warn': detail.risk === 'caution',
            'text-danger': detail.risk === 'blocked',
          }"
        >
          {{ RISK_LABEL[detail.risk] }}
        </span>
        <span v-if="detail.selfRelated" class="rounded-full border border-line px-2 py-0.5 text-danger">启动台自身</span>
        <span v-if="RISK_HINT[detail.risk]" class="text-muted">{{ RISK_HINT[detail.risk] }}</span>
      </div>

      <div class="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border border-line bg-panel2 p-3 text-[12px]">
        <div class="flex justify-between gap-2"><span class="text-muted">PID</span><span class="launcher-mono">{{ detail.pid }}</span></div>
        <div class="flex justify-between gap-2"><span class="text-muted">用户</span><span class="launcher-mono">{{ detail.user || '—' }}</span></div>
        <div class="flex justify-between gap-2">
          <span class="text-muted">CPU</span>
          <span class="launcher-mono">{{ formatPercent(detail.cpu) }}</span>
        </div>
        <div class="flex justify-between gap-2">
          <span class="text-muted">内存</span>
          <span class="launcher-mono">
            {{ formatBytes(detail.memory) }}<span v-if="share != null" class="text-muted"> · {{ share.toFixed(1) }}%</span>
          </span>
        </div>
        <div class="flex justify-between gap-2">
          <span class="text-muted">父进程</span>
          <span class="launcher-mono">{{ detail.parent ?? '—' }}</span>
        </div>
        <div class="flex justify-between gap-2">
          <span class="text-muted">运行时长</span>
          <span class="launcher-mono">{{ uptime }}</span>
        </div>
        <div class="col-span-2 flex justify-between gap-2">
          <span class="text-muted shrink-0">启动于</span>
          <span class="launcher-mono">{{ detail.startedAt ? `${formatClock(detail.startedAt * 1000)}（${new Date(detail.startedAt * 1000).toLocaleDateString()}）` : '—' }}</span>
        </div>
        <div class="col-span-2 flex justify-between gap-2">
          <span class="text-muted shrink-0">可执行文件</span>
          <span class="launcher-mono truncate" :title="detail.exe ?? ''">{{ detail.exe || '—' }}</span>
        </div>
        <div class="col-span-2 flex flex-col gap-0.5">
          <span class="text-muted">命令行</span>
          <span class="launcher-mono break-all">{{ detail.cmd || '—' }}</span>
        </div>
      </div>

      <div>
        <div class="mb-1.5 text-[11.5px] text-muted">占用的端口（{{ detail.ports.length }}）</div>
        <div v-if="detail.ports.length === 0" class="rounded-lg border border-line bg-panel2 p-2.5 text-[11.5px] text-muted">
          没有监听或连接的端口。
        </div>
        <div v-else class="flex flex-col gap-1">
          <div
            v-for="port in detail.ports"
            :key="`${port.protocol}-${port.port}-${port.pid}`"
            class="flex items-center gap-2 rounded-lg border border-line bg-panel2 px-2.5 py-1.5 text-[11.5px]"
          >
            <span class="launcher-mono font-semibold">:{{ port.port }}</span>
            <span class="text-muted">{{ port.protocol.toUpperCase() }}</span>
            <span class="text-muted">{{ stateLabel(port.state) }}</span>
            <span class="launcher-mono text-muted truncate">{{ port.address }}</span>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="flex-1" />
      <button class="launcher-btn" @click="emit('close')">关闭</button>
      <button class="launcher-btn danger" :disabled="blocked" :title="blocked ? '受保护进程，不允许终止' : ''" @click="emit('kill')">
        <UiIcon name="close" :size="12" /> 终止进程
      </button>
    </template>
  </UiDialog>
</template>
