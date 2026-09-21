<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import AppShell from '@launcher/ui/AppShell.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import UiSelect from '@launcher/ui/UiSelect.vue'
import { useToast } from '@launcher/ui/toast'
import { matchKey, modLabel } from '@launcher/ui/keys'
import { exec, host, hostUi, shell, storage } from '@launcher/api'
import type {
  EnvResult,
  Features,
  Issue,
  ListResult,
  PauseResult,
  RecentFile,
  RecordMode,
  ShotMode,
  ShotResult,
  StartResult,
  StatusResult,
  StopResult,
} from './core/recorder'
import {
  FALLBACK_FEATURES,
  SHOT_MODES,
  backendLabel,
  formatBytes,
  formatClock,
  formatWhen,
  issueFromStart,
  issueFromStatusEnd,
  modeLabel,
  nextPollDelay,
  recordModes,
  shotArgs,
  startArgs,
} from './core/recorder'

const SETTINGS_KEY = 'screen-recorder:settings'
/** rec-start 会探活后端（macOS 1.5s / Windows 4s）+ 区域选择框要等用户拖，给足时间 */
const START_TIMEOUT = 60_000
const STOP_TIMEOUT = 40_000
const SHOT_TIMEOUT = 120_000

const mode = ref<RecordMode>('full')
const delaySec = ref(0)
const maxMinutes = ref(0)
const audio = ref(false)
const clicks = ref(false)
const cursor = ref(true)
const dirText = ref('')
const recentKind = ref<'video' | 'image'>('video')
const env = ref<EnvResult | null>(null)
const recording = ref<StatusResult | null>(null)
const lastShot = ref<ShotResult | null>(null)
const recent = ref<RecentFile[]>([])
const recentDir = ref('')
const busy = ref(false)
/** 本地的秒表：录制中每 500ms 自己走一格，不靠 rec-status 的往返 */
const now = ref(Date.now())
/** 秒表的基准 = 最近一次 rec-status 的采样时刻（暂停 / 继续之后要重新对齐） */
const sampledAt = ref(Date.now())
const issue = ref<Issue | null>(null)
const toast = useToast()

const features = computed<Features>(() => env.value?.features ?? FALLBACK_FEATURES)
const modes = computed(() => recordModes(features.value))
const delayOptions = [0, 3, 5, 10].map((value) => ({ value, label: value === 0 ? '不延迟' : `${value} 秒后` }))
const limitOptions = [0, 1, 5, 10, 30].map((value) => ({ value, label: value === 0 ? '不限时' : `最长 ${value} 分钟` }))
const recentKinds = [
  { value: 'video' as const, label: '录制' },
  { value: 'image' as const, label: '截图' },
]
const isRecording = computed(() => recording.value?.recording === true)
/** 交互式录制：系统选择框还开着，视频文件还没出现 */
const waitingPick = computed(() => isRecording.value && recording.value?.interactive === true && !recording.value?.size)
const grantedCaps = ref<string[] | null>(null)
const hasExec = computed(() => grantedCaps.value === null || grantedCaps.value.includes('exec.spawn'))
const ready = computed(() => env.value?.ready !== false)
/** 延迟在交互式下是否还能用（macOS 不行，Windows 行） */
const delayUsable = computed(() => !isRecording.value && (!isInteractive.value || features.value.delayInInteractive))
const isInteractive = computed(() => mode.value !== 'full')
const maxSeconds = computed(() => (maxMinutes.value > 0 ? maxMinutes.value * 60_000 : 0))
/**
 * 秒表 = **有效录制时长**（与托盘同一口径）：暂停期间停住，继续之后接着走。
 * 后端报了 `activeMs` 就以它为准（跨进程读到的真值），没报才退回墙钟。
 */
const elapsed = computed(() => {
  const state = recording.value
  if (!state?.startedAt) return 0
  if (state.paused) return state.activeMs ?? 0
  if (state.activeMs === undefined) return Math.max(0, now.value - state.startedAt)
  return state.activeMs + Math.max(0, now.value - sampledAt.value)
})
const remaining = computed(() => (maxSeconds.value > 0 ? Math.max(0, maxSeconds.value - elapsed.value) : 0))
const currentMode = computed(() => modes.value.find((item) => item.value === mode.value))
/** 底部说明：后端还没探到时不要留个空的「录制后端：。」 */
const backendLine = computed(() => {
  const tail = `${currentMode.value?.hint ?? ''}：停止时会把录制进程正常收尾（把文件写完整），文件放在保存目录里。`
  return env.value?.backend ? `录制后端：${backendLabel(env.value.backend)}。${tail}` : tail
})

/** rec-shot / rec-status 里可以直接引用的系统设置入口 */
function openEnvSettings(): void {
  const url = env.value?.settingsUrl
  if (!url) return
  void shell.openUrl(url).catch(() => toast.err('打不开系统设置'))
}

function openMicSettings(): void {
  const url = env.value?.micSettingsUrl
  if (!url) {
    toast.info('到系统设置的隐私页里给 Chassis 麦克风权限')
    return
  }
  void shell.openUrl(url).catch(() => toast.err('打不开系统设置'))
}

/* ------------------------------------------------------------- 脚本调用 */

async function run<T>(command: string, args: Record<string, unknown>, timeoutMs: number): Promise<T | null> {
  if (!host.isLauncher()) {
    toast.err('当前不在启动台中运行，脚本命令不可用')
    return null
  }
  return (await exec.run({ command, args, timeoutMs }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    toast.err(`脚本调用失败：${message}`)
    return null
  })) as T | null
}

/**
 * 环境体检：权限 + 后端就绪度 + 能力矩阵，一次问清。
 * `request` = 主动申请（macOS 会弹系统提示）。
 */
async function refreshEnv(request = false): Promise<void> {
  const result = await run<EnvResult>('rec-permission', { request }, 20_000)
  if (!result) return
  env.value = result
  if (request) {
    toast[result.granted ? 'ok' : 'info'](
      result.granted ? '屏幕录制权限已就绪' : '系统会弹一次提示；之前拒过的话需要到系统设置里手动勾选',
    )
  }
}

async function refreshRecent(): Promise<void> {
  const result = await run<ListResult>('rec-list', { kind: recentKind.value, limit: 8, dir: dirText.value.trim() || undefined }, 15_000)
  if (!result) return
  recent.value = result.files ?? []
  recentDir.value = result.dir ?? ''
}

/* ------------------------------------------------------------- 录制 */

async function startRecording(overrides: Partial<Parameters<typeof startArgs>[0]> = {}): Promise<void> {
  if (busy.value || isRecording.value) return
  if (!ready.value) {
    issue.value = { tone: 'error', message: env.value?.readyHint ?? '录制依赖没就绪', actions: [{ id: 'open-dep', label: '怎么办' }] }
    return
  }
  busy.value = true
  issue.value = null
  const result = await run<StartResult>(
    'rec-start',
    startArgs({
      mode: mode.value,
      delaySec: delaySec.value,
      maxMinutes: maxMinutes.value,
      audio: audio.value,
      clicks: clicks.value,
      cursor: cursor.value,
      dir: dirText.value,
      ...overrides,
    }),
    START_TIMEOUT,
  )
  busy.value = false
  if (!result?.ok) {
    issue.value = issueFromStart(result, env.value?.platform === 'macos')
    if (result?.needsPermission) await refreshEnv()
    return
  }
  recording.value = {
    recording: true,
    path: result.path,
    startedAt: result.startedAt,
    interactive: result.interactive,
    mode: mode.value,
    seconds: result.seconds ?? null,
    backend: result.backend,
    audio: result.audio,
    paused: false,
  }
  sampledAt.value = Date.now()
  toast.ok(result.interactive ? '已切到系统选择框：选好区域/窗口后开始录' : '开始录制')
  schedulePoll()
}

/**
 * 暂停 / 继续：与托盘菜单里的那一项是同一条命令（`rec-pause`）。
 * 两端语义见 `src/lib.rs`：macOS 冻住画面（暂停段留在视频里），Windows 暂停段不进视频。
 */
async function togglePause(): Promise<void> {
  const state = recording.value
  if (busy.value || !isRecording.value || !state) return
  busy.value = true
  const result = await run<PauseResult>('rec-pause', { action: state.paused ? 'resume' : 'pause' }, STOP_TIMEOUT)
  busy.value = false
  if (!result?.ok) {
    toast.err(result?.error ?? '暂停切换失败')
    await pollStatus()
    return
  }
  state.paused = result.paused === true
  state.activeMs = result.activeMs
  sampledAt.value = Date.now()
  now.value = Date.now()
  // 两端暂停的**后果**不一样，如实说：macOS 只能冻住系统录屏进程（暂停段冻在画面里），
  // Windows 是挂起 ffmpeg（暂停段不进视频）。计时口径两端一致：都是有效录制时长。
  const frozen = env.value?.platform === 'macos' ? '画面冻在最后一帧' : '暂停段不进视频'
  toast[state.paused ? 'info' : 'ok'](state.paused ? `已暂停：${frozen}` : '继续录制')
}

async function stopRecording(): Promise<void> {
  if (busy.value) return
  busy.value = true
  const result = await run<StopResult>('rec-stop', {}, STOP_TIMEOUT)
  busy.value = false
  recording.value = null
  if (!result?.ok) {
    issue.value = {
      tone: 'info',
      message: result?.error ?? '停止失败',
      detail: result?.detail ?? undefined,
    }
    return
  }
  issue.value = null
  toast.ok(`已保存：${formatBytes(result.size)} · ${formatClock(result.durationMs ?? 0)}`)
  recentKind.value = 'video'
  await refreshRecent()
}

/* ------------------------------------------------------------- 截图 */

async function takeShot(shot: ShotMode): Promise<void> {
  if (busy.value) return
  busy.value = true
  const result = await run<ShotResult>(
    'rec-shot',
    shotArgs({ mode: shot, delaySec: delaySec.value, cursor: cursor.value, dir: dirText.value }),
    SHOT_TIMEOUT,
  )
  busy.value = false
  if (!result?.ok) {
    if (result?.cancelled) {
      toast.info('截图已取消')
      return
    }
    issue.value = {
      tone: 'error',
      message: result?.error ?? '截图失败',
      detail: result?.detail?.trim() ? result.detail.trim() : undefined,
      actions: result?.code === 'PERMISSION' ? [{ id: 'settings', label: '打开系统设置' }] : undefined,
    }
    return
  }
  issue.value = null
  lastShot.value = result
  if (result.delegated) {
    toast.ok(result.note ?? '已交给系统截图工具')
    window.setTimeout(() => void refreshRecent(), 1500)
    return
  }
  if (result.clipboard) {
    toast.ok('截图已进剪贴板')
    return
  }
  toast.ok(`截图已保存：${formatBytes(result.size)}`)
  recentKind.value = 'image'
  await refreshRecent()
}

/* ------------------------------------------------------------- 问题横幅的动作 */

function runIssueAction(id: NonNullable<Issue['actions']>[number]['id']): void {
  switch (id) {
    case 'settings':
      openEnvSettings()
      break
    case 'mic-settings':
      openMicSettings()
      break
    case 'retry-silent':
      audio.value = false
      void startRecording({ audio: false })
      break
    case 'stop':
      issue.value = null
      void stopRecording()
      break
    case 'open-dep':
      void shell
        .openUrl('https://www.gyan.dev/ffmpeg/builds/')
        .catch(() => toast.info('装 ffmpeg：winget install Gyan.FFmpeg，然后重启启动台'))
      break
    case 'reveal':
      issue.value = null
      break
  }
}

/* ------------------------------------------------------------- 文件操作 */

async function reveal(path: string): Promise<void> {
  await shell.reveal(path).catch(() => toast.err('在文件管理器中显示失败'))
}

async function openPath(path: string): Promise<void> {
  await shell.openPath(path).catch(() => toast.err('打开失败'))
}

/* ------------------------------------------------------------- 轮询与持久化 */

let pollTimer = 0
let clockTimer = 0

/** 用递进的间隔轮询 rec-status：前 15 秒 1s（首帧 / 报错 / 框选都在这几秒），之后 5s */
function schedulePoll(): void {
  window.clearTimeout(pollTimer)
  if (!isRecording.value) return
  const delay = nextPollDelay(recording.value?.startedAt ? Date.now() - recording.value.startedAt : 0)
  pollTimer = window.setTimeout(() => void pollStatus(), delay)
}

async function pollStatus(): Promise<void> {
  const wasRecording = isRecording.value
  const result = await run<StatusResult>('rec-status', {}, 10_000)
  if (!result) {
    schedulePoll()
    return
  }
  now.value = Date.now()
  if (result.recording) {
    recording.value = result
    sampledAt.value = now.value
    schedulePoll()
    return
  }
  recording.value = null
  if (result.orphan) {
    issue.value = {
      tone: 'error',
      message: '系统里还有一段录制在跑，但插件的记录丢了',
      actions: [{ id: 'stop', label: '把它停掉' }],
    }
    return
  }
  if (wasRecording) {
    const problem = issueFromStatusEnd(result)
    if (problem) {
      issue.value = problem
    } else if (result.last) {
      toast.ok('录制结束，文件已保存')
      recentKind.value = 'video'
      void refreshRecent()
    }
  } else if (result.last) {
    recentKind.value = 'video'
    void refreshRecent()
  }
}

let settingsTimer = 0

function saveSettings(): void {
  window.clearTimeout(settingsTimer)
  settingsTimer = window.setTimeout(() => {
    void storage
      .set(SETTINGS_KEY, {
        mode: mode.value,
        delaySec: delaySec.value,
        maxMinutes: maxMinutes.value,
        audio: audio.value,
        clicks: clicks.value,
        cursor: cursor.value,
        dirText: dirText.value,
      })
      .catch(() => undefined)
  }, 300)
}

watch([mode, delaySec, maxMinutes, audio, clicks, cursor, dirText], saveSettings)
watch(recentKind, () => void refreshRecent())
// 切到不被支持的模式（比如在 Windows 上之前存过「窗口录制」）时回落全屏
watch(modes, (list) => {
  if (!list.some((item) => item.value === mode.value)) mode.value = 'full'
})

/* ------------------------------------------------------------- 快捷键 */

function onKeydown(event: KeyboardEvent): void {
  if (matchKey(event, 'Mod+Enter')) {
    event.preventDefault()
    if (isRecording.value) void stopRecording()
    else void startRecording()
    return
  }
  if (matchKey(event, 'Mod+Shift+S')) {
    event.preventDefault()
    void takeShot('region')
  }
}

/* ------------------------------------------------------------- 宿主 footer */

async function syncFooter(): Promise<void> {
  await hostUi
    .setFooter([
      {
        type: 'button',
        id: 'toggle',
        label: isRecording.value ? '停止并保存' : '开始录制',
        icon: isRecording.value ? 'Save' : 'Power',
        keys: [`${modLabel}+Enter`],
        onClick: () => (isRecording.value ? void stopRecording() : void startRecording()),
      },
      { type: 'button', id: 'shot', label: '框选截图', icon: 'Maximize', keys: [`${modLabel}+Shift+S`], onClick: () => void takeShot('region') },
      {
        type: 'action-panel',
        id: 'more',
        label: '更多',
        icon: 'SlidersHorizontal',
        keys: [`${modLabel}+K`],
        title: '录屏助手',
        items: [
          { id: 'video-dir', name: '打开保存文件夹', icon: 'Folder', onSelect: () => recentDir.value && void openPath(recentDir.value) },
          { id: 'permission', name: '申请屏幕录制权限', icon: 'ShieldCheck', onSelect: () => void refreshEnv(true) },
          ...(env.value?.settingsUrl
            ? [{ id: 'settings', name: '打开系统设置（屏幕录制）', icon: 'Settings', onSelect: () => openEnvSettings() }]
            : []),
          { id: 'refresh', name: '刷新最近产物', icon: 'Refresh', onSelect: () => void refreshRecent() },
        ],
      },
    ])
    .catch(() => undefined)
}

watch(isRecording, () => void syncFooter())

/* ------------------------------------------------------------- 生命周期 */

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  grantedCaps.value = (await host.info().catch(() => null))?.capabilities ?? null
  const saved = await storage.get<Record<string, unknown>>(SETTINGS_KEY).catch(() => undefined)
  if (saved) {
    if (typeof saved.mode === 'string') mode.value = saved.mode as RecordMode
    if (typeof saved.delaySec === 'number') delaySec.value = saved.delaySec
    if (typeof saved.maxMinutes === 'number') maxMinutes.value = saved.maxMinutes
    audio.value = saved.audio === true
    clicks.value = saved.clicks === true
    cursor.value = saved.cursor !== false
    if (typeof saved.dirText === 'string') dirText.value = saved.dirText
  }
  await refreshEnv()
  if (!modes.value.some((item) => item.value === mode.value)) mode.value = 'full'
  await refreshRecent()
  await pollStatus()
  clockTimer = window.setInterval(() => {
    if (isRecording.value) now.value = Date.now()
  }, 500)
  void syncFooter()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.clearTimeout(pollTimer)
  window.clearInterval(clockTimer)
  window.clearTimeout(settingsTimer)
})
</script>

<template>
  <AppShell>
    <header class="flex items-center gap-2 border-b border-line px-3 py-2">
      <UiIcon name="video" :size="16" class="text-accent" />
      <span class="text-[13px] font-semibold">录屏助手</span>
      <button
        v-if="env?.supported"
        class="launcher-chip"
        :class="env?.granted ? 'text-success' : 'text-danger'"
        :title="env?.hint || '点击申请 / 检查屏幕录制权限'"
        @click="refreshEnv(true)"
      >
        <UiIcon name="shield" :size="11" />
        {{ env === null ? '检查环境…' : env.granted ? '已授权' : '缺屏幕录制权限' }}
      </button>
      <span v-if="env?.backend" class="launcher-chip text-faint" :title="'当前后端：' + backendLabel(env.backend)">
        {{ backendLabel(env.backend) }}
      </span>
      <div class="ml-auto flex items-center gap-1.5">
        <button v-if="env && !env.granted && env.supported" class="launcher-btn ghost" @click="openEnvSettings">
          <UiIcon name="external" :size="13" />
          打开系统设置
        </button>
        <button class="launcher-btn ghost" @click="refreshRecent">
          <UiIcon name="refresh" :size="13" />
          刷新
        </button>
      </div>
    </header>

    <div v-if="!hasExec" class="border-b border-line bg-[color:var(--launcher-del-bg)] px-3 py-2 text-[11.5px]">
      没有拿到 <span class="launcher-kbd">exec.spawn</span> 能力，录屏 / 截图都跑不起来 —— 到设置页的插件管理里重新授权（或重装本插件）。
    </div>

    <div v-else class="launcher-scroll min-h-0 flex-1 px-3 py-3">
      <!-- 需要处理的事：权限 / 依赖 / 上一段没停掉 / 失败原因，都带上能点的补救动作 -->
      <section
        v-if="issue"
        class="mb-3 rounded-lg border px-3 py-2"
        :class="issue.tone === 'error' ? 'border-danger/60 bg-[color:var(--launcher-del-bg)]' : 'border-line bg-panel'"
      >
        <div class="flex items-start gap-2">
          <UiIcon :name="issue.tone === 'error' ? 'alert' : 'info'" :size="14" class="mt-0.5 shrink-0" />
          <div class="min-w-0 flex-1">
            <p class="text-[12.5px]">{{ issue.message }}</p>
            <pre v-if="issue.detail" class="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-[10.5px] leading-4 text-faint">{{ issue.detail }}</pre>
            <div v-if="issue.actions?.length" class="mt-1.5 flex flex-wrap items-center gap-1.5">
              <button v-for="action in issue.actions" :key="action.id" class="launcher-btn ghost" @click="runIssueAction(action.id)">
                {{ action.label }}
              </button>
              <button class="launcher-btn ghost ml-auto" @click="issue = null">知道了</button>
            </div>
          </div>
        </div>
      </section>

      <div v-if="!ready" class="mb-3 rounded-lg border border-line bg-panel px-3 py-2 text-[11.5px] text-muted">
        {{ env?.readyHint }}（截图不受影响）
      </div>

      <!-- 录制中 -->
      <section v-if="isRecording" class="mb-3 rounded-lg border border-line bg-panel px-3 py-3">
        <div class="flex items-center gap-2">
          <span class="rec-dot h-2 w-2 rounded-full bg-danger" />
          <span class="text-[12.5px] font-semibold text-danger">
            {{ waitingPick ? '等待选择…' : recording?.paused ? '已暂停' : '正在录制' }} · {{ modeLabel(recording?.mode ?? mode) }}
          </span>
          <span v-if="recording?.interactive && recording?.size" class="text-[11px] text-faint">（已在录制选区）</span>
          <span v-else-if="waitingPick" class="text-[11px] text-faint">（系统选择框已弹出，选完才开始）</span>
          <span v-if="!waitingPick" class="rec-clock ml-auto">{{ formatClock(elapsed) }}</span>
        </div>
        <div class="mt-1.5 flex items-center gap-2 text-[11.5px] text-faint">
          <span class="min-w-0 flex-1 truncate" :title="recording?.path ?? ''">{{ recording?.path }}</span>
          <span v-if="recording?.audio" title="带麦克风">🎙</span>
          <span v-if="recording?.size">{{ formatBytes(recording?.size) }}</span>
          <span v-if="maxSeconds && !waitingPick">{{ '剩余 ' + formatClock(remaining) }}</span>
        </div>
        <div class="mt-2 flex items-center gap-1.5">
          <button class="launcher-btn primary" @click="stopRecording">
            <UiIcon name="stop" :size="12" />
            停止并保存
          </button>
          <!-- 与托盘菜单里那一项是同一个命令（rec-pause）：两处状态必须一致 -->
          <button class="launcher-btn ghost" :disabled="busy" @click="togglePause">
            {{ recording?.paused ? '继续录制' : '暂停录制' }}
          </button>
          <button class="launcher-btn ghost" @click="recording?.path && reveal(recording.path)">
            <UiIcon name="folder" :size="12" />
            在文件管理器中显示
          </button>
        </div>
      </section>

      <!-- 录制模式 -->
      <section class="mb-3">
        <h2 class="mb-1.5 text-[11.5px] font-semibold text-muted">录制模式</h2>
        <div class="grid gap-2" :class="modes.length > 2 ? 'grid-cols-3 max-[560px]:grid-cols-1' : 'grid-cols-2 max-[560px]:grid-cols-1'">
          <button
            v-for="item in modes"
            :key="item.value"
            class="flex flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left"
            :class="mode === item.value ? 'border-accent bg-active' : 'border-line bg-panel hover:bg-hover'"
            :disabled="isRecording"
            @click="mode = item.value"
          >
            <span class="flex items-center gap-1.5 text-[12.5px] font-medium" :class="mode === item.value ? 'text-accent' : ''">
              <UiIcon :name="item.icon" :size="14" />
              {{ item.label }}
            </span>
            <span class="text-[11px] leading-4 text-faint">{{ item.hint }}</span>
          </button>
        </div>
      </section>

      <!-- 录制选项 -->
      <section class="mb-3 flex flex-wrap items-center gap-2 text-[11.5px] text-muted">
        <span>开始前</span>
        <div class="w-[104px]" :title="delayUsable ? '' : '交互式录制下系统不支持延迟'">
          <UiSelect
            :model-value="delaySec"
            :options="delayOptions"
            :disabled="!delayUsable"
            @update:model-value="(value) => (delaySec = Number(value))"
          />
        </div>
        <div class="w-[124px]">
          <UiSelect
            :model-value="maxMinutes"
            :options="limitOptions"
            :disabled="isRecording"
            @update:model-value="(value) => (maxMinutes = Number(value))"
          />
        </div>
        <button
          v-if="features.audio"
          class="launcher-btn ghost"
          :class="audio ? 'text-accent' : ''"
          :disabled="isRecording"
          title="用系统默认输入设备（麦克风）录一条音轨；首次会弹麦克风授权"
          @click="audio = !audio"
        >
          <UiIcon name="bell" :size="12" />
          麦克风
        </button>
        <button
          v-if="features.clicks"
          class="launcher-btn ghost"
          :class="clicks ? 'text-accent' : ''"
          :disabled="isRecording"
          title="录制时高亮鼠标点击"
          @click="clicks = !clicks"
        >
          <UiIcon name="zap" :size="12" />
          点击高亮
        </button>
        <button
          v-if="features.cursor"
          class="launcher-btn ghost"
          :class="cursor ? 'text-accent' : ''"
          :disabled="isRecording"
          :title="isInteractive ? '截图时带光标（交互式录制下系统不支持把光标录进视频）' : '截图与录制都带上鼠标指针'"
          @click="cursor = !cursor"
        >
          <UiIcon name="arrowRight" :size="12" />
          显示指针
        </button>
        <input v-model="dirText" class="launcher-input ml-auto w-[190px]" :disabled="isRecording" placeholder="保存目录（留空=默认目录）" />
        <button class="launcher-btn primary" :disabled="busy || isRecording || !ready" @click="startRecording()">
          <UiIcon name="play" :size="12" />
          {{ busy ? '启动中…' : waitingPick ? '等待选择…' : '开始录制' }}
        </button>
      </section>

      <!-- 截图 -->
      <section class="mb-3">
        <h2 class="mb-1.5 text-[11.5px] font-semibold text-muted">顺手截图</h2>
        <div class="flex flex-wrap items-center gap-1.5">
          <button v-for="shot in SHOT_MODES" :key="shot.value" class="launcher-btn ghost" :disabled="busy" @click="takeShot(shot.value)">
            <UiIcon :name="shot.icon" :size="12" />
            {{ shot.label }}
          </button>
          <button v-if="lastShot?.path" class="launcher-btn ghost text-accent" @click="reveal(lastShot.path ?? '')">
            <UiIcon name="folder" :size="12" />
            显示刚存的那张
          </button>
          <span v-if="lastShot?.clipboard" class="text-[11.5px] text-faint">上一张已进剪贴板</span>
        </div>
      </section>

      <!-- 最近产物 -->
      <section>
        <div class="mb-1.5 flex items-center gap-2">
          <h2 class="text-[11.5px] font-semibold text-muted">最近产物</h2>
          <button
            v-for="kind in recentKinds"
            :key="kind.value"
            class="launcher-btn ghost"
            :class="recentKind === kind.value ? 'bg-active text-accent' : ''"
            @click="recentKind = kind.value"
          >
            {{ kind.label }}
          </button>
          <span class="ml-auto truncate text-[10.5px] text-faint" :title="recentDir">{{ recentDir }}</span>
        </div>
        <div v-if="recent.length" class="flex flex-col">
          <div v-for="file in recent" :key="file.path" class="group flex items-center gap-2 border-b border-line py-1.5">
            <UiIcon :name="recentKind === 'video' ? 'video' : 'image'" :size="13" class="shrink-0 text-faint" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-[12px]">{{ file.name }}</div>
              <div class="text-[10.5px] text-faint">{{ formatWhen(file.mtimeMs, now) }} · {{ formatBytes(file.size) }}</div>
            </div>
            <button class="launcher-btn ghost shrink-0 opacity-0 group-hover:opacity-100" @click="openPath(file.path)">
              <UiIcon name="external" :size="12" />
              打开
            </button>
            <button class="launcher-btn ghost shrink-0 opacity-0 group-hover:opacity-100" @click="reveal(file.path)">
              <UiIcon name="folder" :size="12" />
              定位
            </button>
          </div>
        </div>
        <p v-else class="py-3 text-[11.5px] text-faint">
          还没有{{ recentKind === 'video' ? '录制' : '截图' }}记录。{{ env?.granted ? '' : '（先解决屏幕录制权限）' }}
        </p>
      </section>

      <p class="mt-3 text-[10.5px] leading-4 text-faint">{{ backendLine }}</p>
      <ul v-if="features.notes.length" class="mt-1.5 flex flex-col gap-0.5 text-[10.5px] leading-4 text-faint">
        <li v-for="note in features.notes" :key="note">· {{ note }}</li>
      </ul>
    </div>

    <footer class="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[11.5px] text-faint">
      <span><span class="launcher-kbd">{{ modLabel }}Enter</span> 开始 / 停止</span>
      <span><span class="launcher-kbd">{{ modLabel }}⇧S</span> 框选截图</span>
      <span class="ml-auto">
        {{ !ready ? '录制依赖未就绪（截图可用）' : env?.granted === false && env?.supported ? '缺屏幕录制权限' : '就绪' }}
      </span>
    </footer>
  </AppShell>
</template>
