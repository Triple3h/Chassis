<script setup lang="ts">
import { computed, ref } from 'vue'
import UiDialog from '@launcher/ui/UiDialog.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import { copyText } from '@launcher/ui/clipboard'
import { useToast } from '@launcher/ui/toast'
import { exec } from '@launcher/api'
import { formatBytes, formatPercent, RISK_HINT, RISK_LABEL } from '../core/format'
import type { KillOutcome, KillTarget } from '../core/types'

/**
 * 终止确认（安全机制的核心）：
 * - 先展示完整目标信息与风险级别，**默认优雅终止**（SIGTERM / 无 /F 的 taskkill）；
 * - 系统组件（caution）要额外勾选「我了解风险」；受保护进程（blocked）不提供终止操作；
 * - 优雅终止后若进程仍在运行，才出现「强制终止」这一档；
 * - 权限不足：给两条路 —— 复制等价命令自行执行 / 走系统授权窗口提权终止。
 */
const props = defineProps<{
  target: KillTarget
  platform: string
  /** 演示模式（无宿主）：操作只做模拟 */
  demo: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'done', pid: number): void
}>()

type Phase = 'confirm' | 'busy' | 'alive' | 'denied' | 'done' | 'failed'

const toast = useToast()
const phase = ref<Phase>('confirm')
const acknowledged = ref(false)
const outcome = ref<KillOutcome | null>(null)
const failure = ref('')
/** 正在执行的操作是不是强制终止（只影响等待文案） */
const busyForce = ref(false)

const blocked = computed(() => props.target.risk === 'blocked' || props.target.selfRelated)
const caution = computed(() => props.target.risk === 'caution')
const canSubmit = computed(() => !blocked.value && (!caution.value || acknowledged.value))

const portsText = computed(() => {
  const ports = props.target.ports ?? []
  return ports.length > 0 ? ports.map((port) => `:${port}`).join(' ') : '—'
})

/** 提权说明（按平台） */
const elevateNote = computed(() =>
  props.platform === 'win32'
    ? '会弹出系统 UAC 授权窗口，需要管理员账户确认'
    : '会弹出系统授权窗口（输入密码或使用 Touch ID）',
)

/** 没拿到脚本返回时的兜底展示命令 */
const fallbackCommand = computed(() =>
  props.platform === 'win32'
    ? `taskkill /PID ${props.target.pid} /F`
    : `sudo kill -TERM ${props.target.pid}`,
)

const shownCommand = computed(() => outcome.value?.manualCommand || fallbackCommand.value)

async function run(force: boolean, elevate = false) {
  if (props.demo) {
    phase.value = 'done'
    outcome.value = {
      ok: true,
      pid: props.target.pid,
      name: props.target.name,
      force,
      elevated: elevate,
      alive: false,
      notFound: false,
      permissionDenied: false,
      manualCommand: '',
      message: '演示模式：没有真的执行终止',
      error: null,
    }
    emit('done', props.target.pid)
    return
  }

  phase.value = 'busy'
  busyForce.value = force
  const result = (await exec
    .run({ command: 'proc-kill', args: { pid: props.target.pid, force, elevate }, timeoutMs: 60_000 })
    .catch(() => null)) as KillOutcome | null

  if (!result) {
    phase.value = 'failed'
    failure.value = '调用终止脚本失败（宿主不可用或超时）'
    return
  }
  outcome.value = result

  if (result.notFound || (result.ok && !result.alive)) {
    phase.value = 'done'
    emit('done', result.pid)
  } else if (result.permissionDenied) {
    phase.value = 'denied'
  } else if (result.alive) {
    phase.value = 'alive'
  } else {
    phase.value = 'failed'
    failure.value = result.error || result.message
  }
}

async function copyCommand() {
  if (await copyText(shownCommand.value)) toast.ok('命令已复制')
}
</script>

<template>
  <UiDialog
    :title="blocked ? '受保护进程' : '终止进程'"
    :subtitle="`${target.name || '未知进程'}（PID ${target.pid}）`"
    @close="emit('close')"
  >
    <div class="flex flex-col gap-3">
      <!-- 目标信息 -->
      <div class="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-lg border border-line bg-panel2 p-3 text-[12px]">
        <div class="flex justify-between"><span class="text-muted">PID</span><span class="launcher-mono">{{ target.pid }}</span></div>
        <div class="flex justify-between"><span class="text-muted">用户</span><span class="launcher-mono">{{ target.user || '—' }}</span></div>
        <div class="flex justify-between">
          <span class="text-muted">CPU</span>
          <span class="launcher-mono">{{ target.cpu != null ? formatPercent(target.cpu) : '—' }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-muted">内存</span>
          <span class="launcher-mono">{{ formatBytes(target.memory) }}</span>
        </div>
        <div class="col-span-2 flex justify-between gap-2">
          <span class="text-muted shrink-0">占用端口</span>
          <span class="launcher-mono truncate">{{ portsText }}</span>
        </div>
        <div v-if="target.cmd" class="col-span-2 flex justify-between gap-2">
          <span class="text-muted shrink-0">命令行</span>
          <span class="launcher-mono truncate" :title="target.cmd">{{ target.cmd }}</span>
        </div>
      </div>

      <!-- 风险级别 -->
      <div
        v-if="!blocked"
        class="flex items-start gap-2 rounded-lg border border-line p-2.5 text-[11.5px] leading-relaxed"
        :class="caution ? 'text-warn' : 'text-muted'"
      >
        <span class="mt-0.5"><UiIcon :name="caution ? 'alert' : 'info'" :size="13" /></span>
        <div>
          <span class="font-semibold">{{ RISK_LABEL[target.risk] }}</span>
          <span v-if="RISK_HINT[target.risk]"> · {{ RISK_HINT[target.risk] }}</span>
        </div>
      </div>
      <div v-else class="flex items-start gap-2 rounded-lg border border-line bg-panel2 p-2.5 text-[11.5px] leading-relaxed text-muted">
        <span class="mt-0.5 text-danger"><UiIcon name="shield" :size="13" /></span>
        <div>
          「{{ target.name }}」{{ RISK_HINT.blocked }}。要处理它，请走系统自带的工具或启动台自己的退出入口。
        </div>
      </div>

      <!-- 系统组件：需要显式勾选 -->
      <label v-if="caution && phase === 'confirm'" class="flex items-center gap-2 text-[12px]">
        <input v-model="acknowledged" type="checkbox" class="accent-[var(--launcher-warn,orange)]" />
        我了解风险，仍要终止
      </label>

      <!-- 进程还在 -->
      <div v-if="phase === 'alive'" class="rounded-lg border border-line bg-panel2 p-2.5 text-[11.5px] leading-relaxed">
        <div class="font-semibold text-warn">信号已送达，但进程仍在运行</div>
        <div class="mt-0.5 text-muted">
          它可能在处理收尾工作，也可能忽略了终止信号。可以稍后再看，或直接强制终止（SIGKILL，不给收尾机会）。
        </div>
      </div>

      <!-- 权限不足 -->
      <div v-if="phase === 'denied'" class="flex flex-col gap-2 rounded-lg border border-line bg-panel2 p-2.5 text-[11.5px] leading-relaxed">
        <div class="font-semibold text-warn">需要管理员权限</div>
        <div class="text-muted">
          「{{ target.name }}」不属于当前用户（{{ target.user || 'root' }}）。{{ elevateNote }}，
          或者复制下面的命令到终端自行执行。
        </div>
        <div class="launcher-mono launcher-scroll max-h-16 rounded border border-line bg-bg p-2 text-[11.5px] break-all">
          {{ shownCommand }}
        </div>
      </div>

      <!-- 完成 / 失败 -->
      <div v-if="phase === 'done'" class="flex items-center gap-2 rounded-lg border border-line bg-panel2 p-2.5 text-[12px] text-success">
        <UiIcon name="check" :size="14" />
        {{ outcome?.notFound ? '进程已不存在（可能刚刚自己退出）' : `已终止「${target.name}」` }}
      </div>
      <div v-if="phase === 'failed'" class="rounded-lg border border-line bg-panel2 p-2.5 text-[11.5px] leading-relaxed text-warn">
        <div class="font-semibold">没能完成</div>
        <div class="mt-0.5 break-all">{{ failure }}</div>
      </div>

      <div v-if="phase === 'busy'" class="flex items-center gap-2 text-[12px] text-muted">
        <UiIcon name="refresh" :size="13" class="animate-spin" />
        {{ busyForce ? '正在强制终止…' : '正在发送终止信号…' }}
      </div>
    </div>

    <template #footer>
      <button v-if="phase === 'denied' || phase === 'failed'" class="launcher-btn" @click="copyCommand">
        <UiIcon name="copy" :size="12" /> 复制命令
      </button>
      <div class="flex-1" />
      <button class="launcher-btn" :disabled="phase === 'busy'" @click="emit('close')">
        {{ phase === 'done' ? '关闭' : '取消' }}
      </button>

      <template v-if="!blocked">
        <template v-if="phase === 'confirm'">
          <button class="launcher-btn danger" :disabled="!canSubmit" title="SIGKILL / taskkill /F：不给收尾机会" @click="run(true)">
            强制终止
          </button>
          <button class="launcher-btn primary" :disabled="!canSubmit" @click="run(false)">优雅终止</button>
        </template>
        <button v-else-if="phase === 'alive'" class="launcher-btn danger" @click="run(true)">强制终止</button>
        <button v-else-if="phase === 'denied'" class="launcher-btn primary" @click="run(false, true)">
          以管理员身份终止
        </button>
      </template>
    </template>
  </UiDialog>
</template>
