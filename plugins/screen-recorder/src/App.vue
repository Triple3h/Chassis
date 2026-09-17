<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import AppShell from '@launcher/ui/AppShell.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import UiSelect from '@launcher/ui/UiSelect.vue'
import { useToast } from '@launcher/ui/toast'
import { matchKey, modLabel } from '@launcher/ui/keys'
import { exec, host, hostUi, shell, storage } from '@launcher/api'
import type {
  ListResult,
  PermissionResult,
  RecentFile,
  RecordMode,
  ShotMode,
  ShotResult,
  StartResult,
  StatusResult,
  StopResult,
} from './core/recorder'
import { RECORD_MODES, SHOT_MODES, formatBytes, formatClock, formatWhen, modeLabel, shotArgs, startArgs } from './core/recorder'

const SETTINGS_KEY = 'screen-recorder:settings'
/** rec-start 里会 sleep 500ms 探活；交互式截图要等用户框选，给足时间 */
const START_TIMEOUT = 20_000
const STOP_TIMEOUT = 30_000
const SHOT_TIMEOUT = 120_000

const mode = ref<RecordMode>('full')
const delaySec = ref(0)
const maxMinutes = ref(0)
const audio = ref(false)
const clicks = ref(false)
const cursor = ref(true)
const dirText = ref('')
const recentKind = ref<'video' | 'image'>('video')
const permission = ref<PermissionResult | null>(null)
const recording = ref<StatusResult | null>(null)
const lastShot = ref<ShotResult | null>(null)
const recent = ref<RecentFile[]>([])
const recentDir = ref('')
const busy = ref(false)
const elapsed = ref(0)
const now = ref(Date.now())
const toast = useToast()

const delayOptions = [0, 3, 5, 10].map((value) => ({ value, label: value === 0 ? '不延迟' : `${value} 秒后` }))
const limitOptions = [0, 1, 5, 10, 30].map((value) => ({ value, label: value === 0 ? '不限时' : `最长 ${value} 分钟` }))
const recentKinds = [
  { value: 'video' as const, label: '录制' },
  { value: 'image' as const, label: '截图' },
]
const isRecording = computed(() => recording.value?.recording === true)
/** null = 还没问到（开发态 / 宿主不可用）：不拦，交给调用点兜错 */
const grantedCaps = ref<string[] | null>(null)
const hasExec = computed(() => grantedCaps.value === null || grantedCaps.value.includes('exec.spawn'))
const maxSeconds = computed(() => (maxMinutes.value > 0 ? maxMinutes.value * 60_000 : 0))
const remaining = computed(() => (maxSeconds.value > 0 ? Math.max(0, maxSeconds.value - elapsed.value) : 0))
const currentMode = computed(() => RECORD_MODES.find((item) => item.value === mode.value))

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

async function refreshPermission(request = false): Promise<void> {
  const result = await run<PermissionResult>('rec-permission', {}, 15_000)
  if (!result) return
  permission.value = result
  if (request) {
    toast[result.granted ? 'ok' : 'info'](
      result.granted ? '屏幕录制权限已就绪' : '系统会弹一次提示；如果之前拒绝过，需要到系统设置里手动勾选',
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

async function startRecording(): Promise<void> {
  if (busy.value || isRecording.value) return
  busy.value = true
  const result = await run<StartResult>(
    'rec-start',
    startArgs({
      mode: mode.value,
      delaySec: delaySec.value,
      maxMinutes: maxMinutes.value,
      audio: audio.value,
      clicks: clicks.value,
      dir: dirText.value,
    }),
    START_TIMEOUT,
  )
  busy.value = false
  if (!result?.ok) {
    if (result?.needsPermission) {
      await refreshPermission()
      toast.err(result.error ?? '没有屏幕录制权限')
    } else {
      toast.err(result?.error ?? '没能开始录制')
    }
    return
  }
  recording.value = { recording: true, path: result.path, startedAt: result.startedAt, interactive: result.interactive }
  elapsed.value = 0
  toast.ok(result.interactive ? '已切到系统选择框：选好区域/窗口后开始录' : '开始录制')
}

async function stopRecording(): Promise<void> {
  if (busy.value) return
  busy.value = true
  const result = await run<StopResult>('rec-stop', {}, STOP_TIMEOUT)
  busy.value = false
  recording.value = null
  elapsed.value = 0
  if (!result?.ok) {
    toast.err(result?.error ?? '停止失败')
    return
  }
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
    toast.err(result?.error ?? '截图失败（多半是屏幕录制权限没给）')
    return
  }
  lastShot.value = result
  if (result.clipboard) {
    toast.ok('截图已进剪贴板')
    return
  }
  toast.ok(`截图已保存：${formatBytes(result.size)}`)
  recentKind.value = 'image'
  await refreshRecent()
}

/* ------------------------------------------------------------- 文件操作 */

async function reveal(path: string): Promise<void> {
  await shell.reveal(path).catch(() => toast.err('在 Finder 中显示失败'))
}

async function openPath(path: string): Promise<void> {
  await shell.openPath(path).catch(() => toast.err('打开失败'))
}

async function openCaptureSettings(): Promise<void> {
  await shell
    .openUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    .catch(() => toast.err('打不开系统设置，请手动前往 隐私与安全性 → 屏幕录制'))
}

/* ------------------------------------------------------------- 轮询与持久化 */

let timer = 0

async function pollStatus(): Promise<void> {
  const result = await run<StatusResult>('rec-status', {}, 10_000)
  if (!result) return
  now.value = Date.now()
  if (result.recording) {
    recording.value = result
    elapsed.value = result.elapsedMs ?? 0
    return
  }
  const wasRecording = isRecording.value
  recording.value = null
  elapsed.value = 0
  if (result.last) {
    if (wasRecording) toast.ok('录制结束，文件已保存')
    recentKind.value = 'video'
    void refreshRecent()
  }
}

function startPolling(): void {
  window.clearInterval(timer)
  timer = window.setInterval(() => {
    if (isRecording.value) void pollStatus()
  }, 1000)
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
        icon: isRecording.value ? 'Stop' : 'Play',
        keys: [`${modLabel}+Enter`],
        onClick: () => (isRecording.value ? void stopRecording() : void startRecording()),
      },
      { type: 'button', id: 'shot', label: '框选截图', icon: 'Camera', keys: [`${modLabel}+Shift+S`], onClick: () => void takeShot('region') },
      {
        type: 'action-panel',
        id: 'more',
        label: '更多',
        icon: 'Sliders',
        keys: [`${modLabel}+K`],
        title: '录屏助手',
        items: [
          { id: 'video-dir', name: '打开录制文件夹', icon: 'Folder', onSelect: () => recentDir.value && void openPath(recentDir.value) },
          { id: 'permission', name: '申请屏幕录制权限', icon: 'ShieldCheck', onSelect: () => void refreshPermission(true) },
          { id: 'settings', name: '打开系统设置（屏幕录制）', icon: 'Settings', onSelect: () => void openCaptureSettings() },
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
  const saved = await storage
    .get<Record<string, unknown>>(SETTINGS_KEY)
    .catch(() => undefined)
  if (saved) {
    if (typeof saved.mode === 'string') mode.value = (RECORD_MODES.find((item) => item.value === saved.mode)?.value ?? 'full') as RecordMode
    if (typeof saved.delaySec === 'number') delaySec.value = saved.delaySec
    if (typeof saved.maxMinutes === 'number') maxMinutes.value = saved.maxMinutes
    audio.value = saved.audio === true
    clicks.value = saved.clicks === true
    cursor.value = saved.cursor !== false
    if (typeof saved.dirText === 'string') dirText.value = saved.dirText
  }
  await refreshPermission()
  await refreshRecent()
  await pollStatus()
  startPolling()
  void syncFooter()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.clearInterval(timer)
  window.clearTimeout(settingsTimer)
})
</script>

<template>
  <AppShell>
    <header class="flex items-center gap-2 border-b border-line px-3 py-2">
      <UiIcon name="video" :size="16" class="text-accent" />
      <span class="text-[13px] font-semibold">录屏助手</span>
      <button
        class="launcher-chip"
        :class="permission?.granted ? 'text-success' : 'text-danger'"
        :title="permission?.hint || '点击申请 / 检查屏幕录制权限'"
        @click="refreshPermission(true)"
      >
        <UiIcon name="shield" :size="11" />
        {{ permission === null ? '检查权限中…' : permission.granted ? '已授权' : '缺屏幕录制权限' }}
      </button>
      <div class="ml-auto flex items-center gap-1.5">
        <button v-if="!permission?.granted && permission !== null" class="launcher-btn ghost" @click="openCaptureSettings">
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
      <!-- 录制中 -->
      <section v-if="isRecording" class="mb-3 rounded-lg border border-line bg-panel px-3 py-3">
        <div class="flex items-center gap-2">
          <span class="rec-dot h-2 w-2 rounded-full bg-danger" />
          <span class="text-[12.5px] font-semibold text-danger">正在录制 · {{ modeLabel(recording?.mode ?? mode) }}</span>
          <span v-if="recording?.interactive" class="text-[11px] text-faint">（系统选择框已弹出，选完就开始）</span>
          <span class="rec-clock ml-auto">{{ formatClock(elapsed) }}</span>
        </div>
        <div class="mt-1.5 flex items-center gap-2 text-[11.5px] text-faint">
          <span class="min-w-0 flex-1 truncate" :title="recording?.path ?? ''">{{ recording?.path }}</span>
          <span v-if="recording?.size">{{ formatBytes(recording?.size) }}</span>
          <span v-if="maxSeconds">{{ '剩余 ' + formatClock(remaining) }}</span>
        </div>
        <div class="mt-2 flex items-center gap-1.5">
          <button class="launcher-btn primary" @click="stopRecording">
            <UiIcon name="stop" :size="12" />
            停止并保存
          </button>
          <button class="launcher-btn ghost" @click="recording?.path && reveal(recording.path)">
            <UiIcon name="folder" :size="12" />
            在 Finder 中显示
          </button>
        </div>
      </section>

      <!-- 录制模式 -->
      <section class="mb-3">
        <h2 class="mb-1.5 text-[11.5px] font-semibold text-muted">录制模式</h2>
        <div class="grid grid-cols-3 gap-2 max-[560px]:grid-cols-1">
          <button
            v-for="item in RECORD_MODES"
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
        <div class="w-[104px]">
          <UiSelect
            :model-value="delaySec"
            :options="delayOptions"
            :disabled="isRecording"
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
          class="launcher-btn ghost"
          :class="audio ? 'text-accent' : ''"
          :disabled="isRecording"
          title="用系统默认输入设备（麦克风）录一条音轨"
          @click="audio = !audio"
        >
          <UiIcon name="bell" :size="12" />
          麦克风
        </button>
        <button
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
          class="launcher-btn ghost"
          :class="cursor ? 'text-accent' : ''"
          :disabled="isRecording"
          title="截图时带上鼠标指针"
          @click="cursor = !cursor"
        >
          <UiIcon name="arrowRight" :size="12" />
          截图带光标
        </button>
        <input v-model="dirText" class="launcher-input ml-auto w-[190px]" :disabled="isRecording" placeholder="保存目录（留空=影片/图片）" />
        <button class="launcher-btn primary" :disabled="busy || isRecording" @click="startRecording">
          <UiIcon name="play" :size="12" />
          {{ busy ? '启动中…' : '开始录制' }}
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
              Finder
            </button>
          </div>
        </div>
        <p v-else class="py-3 text-[11.5px] text-faint">
          还没有{{ recentKind === 'video' ? '录制' : '截图' }}记录。{{ permission?.granted ? '' : '（先解决屏幕录制权限）' }}
        </p>
      </section>

      <p class="mt-3 text-[10.5px] leading-4 text-faint">
        录制走系统 <span class="launcher-kbd">screencapture</span>：{{ currentMode?.hint }}。停止时会向录制进程发 SIGINT（等同终端 Ctrl+C），它会先把文件收尾写完。
      </p>
    </div>

    <footer class="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[11.5px] text-faint">
      <span><span class="launcher-kbd">{{ modLabel }}Enter</span> 开始 / 停止</span>
      <span><span class="launcher-kbd">{{ modLabel }}⇧S</span> 框选截图</span>
      <span class="ml-auto">{{ permission?.granted ? '屏幕录制权限已就绪' : '缺权限时先点标题旁的红标' }}</span>
    </footer>
  </AppShell>
</template>
