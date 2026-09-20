<script setup lang="ts">
/**
 * 更新页（internal-store）：**插件**（plugins-latest）与**内核**（kernel-latest）两条独立通道。
 *
 * 分工（两条通道同构）：
 *   - 拉索引 / 下载 / 校验 → 逻辑层命令 `update`（子进程，网络在插件侧）
 *   - 安装 → **本页发起**：插件走 `installZip`、内核走 `applyKernelUpdate`
 *     （安装会杀掉命令进程、内核更新还会重启内核，view 跑在宿主 webview 不受影响）
 *   - 覆盖规则 / 原子替换 / 回滚 → 内核（插件只给本地路径）
 */
import { computed, onMounted, ref } from 'vue'
import AppShell from '@launcher/ui/AppShell.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import { exec, host, hostUi, settings } from '@launcher/api'

interface PluginInfo {
  id: string
  title: string
  version: string
  builtin?: boolean
  essential?: boolean
  dir?: string
}

interface UpdateItem {
  id: string
  title: string
  current: string
  latest: string
  notes?: string | null
  minKernelOk: boolean
}

interface OverriddenItem {
  id: string
  title: string
  version: string
}

/** 内核更新（kernel-latest 通道；`hotOk=false` ⇒ 客户端机制版本不够，不给「更新」） */
interface KernelUpdateItem {
  current: string
  latest: string
  notes?: string | null
  hotVersion?: string | null
  minHotVersion?: string | null
  hotOk: boolean
}

/** 应用（壳）自身信息：壳是唯一知道自己版本与安装位置的角色 */
interface ShellInfo {
  available: boolean
  version?: string
  hotVersion?: string
  platform?: string | null
  arch?: string | null
  bundlePath?: string | null
  /** 打包态 + 安装位置可写才为 true（开发态 / 只读位置 ⇒ 不给「更新应用」） */
  canSelfUpdate?: boolean
}

/** 应用（壳）更新（app-latest 通道；更新会重启整个应用） */
interface AppUpdateItem {
  current: string
  latest: string
  notes?: string | null
  shellHotVersion?: string | null
  minShellHotVersion?: string | null
  hotOk: boolean
}

type Stage = 'idle' | 'checking' | 'error' | 'ready'

const inHost = host.isLauncher()
const stage = ref<Stage>('idle')
const error = ref('')
const notice = ref('')
const busy = ref('')
const updates = ref<UpdateItem[]>([])
const overridden = ref<OverriddenItem[]>([])
const checkedAt = ref(0)
const kernelVersion = ref('')
const hotVersion = ref('')
const kernelUpdate = ref<KernelUpdateItem | null>(null)
const shellInfo = ref<ShellInfo | null>(null)
const appUpdate = ref<AppUpdateItem | null>(null)

const updatable = computed(() => updates.value.filter((item) => item.minKernelOk))

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 已装插件里「参与更新」的那部分：出厂（builtin）且非 essential。第三方插件不参与。 */
async function collectInstalled(): Promise<Array<{ id: string; version: string }>> {
  const plugins = (await settings.plugins()) as PluginInfo[]
  const installed: Array<{ id: string; version: string }> = []
  const covered: OverriddenItem[] = []
  for (const plugin of plugins) {
    if (plugin.builtin && !plugin.essential) {
      installed.push({ id: plugin.id, version: plugin.version })
    }
    // 出厂插件的目录落在 extensions 下 = 装过新版本（可以给「恢复出厂版本」）
    const dir = (plugin.dir ?? '').replace(/\\/g, '/')
    if (plugin.builtin && dir.includes('/extensions/')) {
      covered.push({ id: plugin.id, title: plugin.title, version: plugin.version })
    }
  }
  overridden.value = covered
  return installed
}

async function check(): Promise<void> {
  if (!inHost) return
  stage.value = 'checking'
  error.value = ''
  notice.value = ''
  try {
    const info = await host.info()
    kernelVersion.value = info.version
    hotVersion.value = info.hotVersion ?? ''
    const installed = await collectInstalled()
    const result = (await exec.run({
      command: 'update',
      args: { mode: 'check', installed, kernel: info.version },
      timeoutMs: 20000,
    })) as { ok?: boolean; error?: string; updates?: UpdateItem[]; checkedAt?: number }
    if (!result?.ok) {
      error.value = result?.error ?? '无法检查更新'
      stage.value = 'error'
      return
    }
    updates.value = result.updates ?? []
    checkedAt.value = result.checkedAt ?? Date.now()
    stage.value = 'ready'
    await checkKernel()
    await checkApp()
  } catch (err) {
    error.value = messageOf(err)
    stage.value = 'error'
  }
}

/** 内核通道（kernel-latest）：失败不覆盖插件那侧的错误（两个通道网络条件相同，插件侧已会提示） */
async function checkKernel(): Promise<void> {
  if (!kernelVersion.value) return
  try {
    const result = (await exec.run({
      command: 'update',
      args: { mode: 'check-kernel', current: kernelVersion.value, hotVersion: hotVersion.value },
      timeoutMs: 20000,
    })) as { ok?: boolean; update?: KernelUpdateItem | null }
    kernelUpdate.value = result?.ok ? (result.update ?? null) : null
  } catch {
    kernelUpdate.value = null
  }
}

/**
 * 应用（壳）通道：先问壳自己的版本 / 安装位置（`pluginAction('shellInfo')`），再拉 app-latest 索引。
 *
 * 壳不在可自更新状态（开发态 / 只读安装位置）⇒ 不查也不显示「更新」：
 * 查出来的更新也装不上（替换 `.app` 只能由壳在打包态做）。
 */
async function checkApp(): Promise<void> {
  try {
    const info = (await settings.pluginAction('shellInfo', {})) as ShellInfo | null
    shellInfo.value = info?.available ? info : null
    if (!shellInfo.value?.canSelfUpdate || !shellInfo.value.version) {
      appUpdate.value = null
      return
    }
    const result = (await exec.run({
      command: 'update',
      args: {
        mode: 'check-app',
        current: shellInfo.value.version,
        shellHotVersion: shellInfo.value.hotVersion ?? '',
      },
      timeoutMs: 20000,
    })) as { ok?: boolean; update?: AppUpdateItem | null }
    appUpdate.value = result?.ok ? (result.update ?? null) : null
  } catch {
    // 壳信息拿不到（老壳 / 未连接）：这一块整体不显示，不影响插件与内核两条通道
    shellInfo.value = null
    appUpdate.value = null
  }
}

/** 应用更新：下载在逻辑层 → 解压 → **本页发起** `applyShellUpdate`（壳校验候选包后整体重启） */
async function updateApp(): Promise<void> {
  const item = appUpdate.value
  if (busy.value || !item || !item.hotOk || !shellInfo.value?.canSelfUpdate) return
  busy.value = 'app'
  error.value = ''
  try {
    notice.value = `正在下载应用 ${item.latest}…`
    const downloaded = (await exec.run({
      command: 'update',
      args: {
        mode: 'download-app',
        current: item.current,
        shellHotVersion: shellInfo.value.hotVersion ?? '',
      },
      timeoutMs: 180000,
    })) as { ok?: boolean; error?: string; appPath?: string; version?: string }
    if (!downloaded?.ok || !downloaded.appPath) {
      error.value = downloaded?.error ?? '下载失败'
      notice.value = ''
      return
    }
    const version = downloaded.version ?? item.latest
    notice.value = `正在应用 ${version}（应用会整体重启，稍等几秒）…`
    await settings.pluginAction('applyShellUpdate', { appPath: downloaded.appPath, version })
    notice.value = `应用已更新到 ${version}，正在重启…`
  } catch (err) {
    error.value = messageOf(err)
    notice.value = ''
  } finally {
    busy.value = ''
  }
}

/** 内核更新：下载在逻辑层 → 解压 → **本页发起** `applyKernelUpdate`（内核会优雅重启，本页自动重开） */
async function updateKernel(): Promise<void> {
  const item = kernelUpdate.value
  if (busy.value || !item || !item.hotOk) return
  busy.value = 'kernel'
  error.value = ''
  try {
    notice.value = `正在下载内核 ${item.latest}…`
    const downloaded = (await exec.run({
      command: 'update',
      args: { mode: 'download-kernel', current: item.current, hotVersion: hotVersion.value },
      timeoutMs: 120000,
    })) as { ok?: boolean; error?: string; path?: string; uiPath?: string; version?: string }
    if (!downloaded?.ok || !downloaded.path) {
      error.value = downloaded?.error ?? '下载失败'
      notice.value = ''
      return
    }
    const version = downloaded.version ?? item.latest
    notice.value = `正在应用内核 ${version}（优雅重启，本页会自动重开）…`
    await settings.pluginAction('applyKernelUpdate', {
      path: downloaded.path,
      uiPath: downloaded.uiPath,
      version,
    })
    notice.value = `内核已更新到 ${version}，正在重启…`
  } catch (err) {
    error.value = messageOf(err)
    notice.value = ''
  } finally {
    busy.value = ''
  }
}

async function updateOne(item: UpdateItem): Promise<void> {
  if (busy.value || !item.minKernelOk) return
  busy.value = item.id
  error.value = ''
  try {
    notice.value = `正在下载 ${item.title} ${item.latest}…`
    const downloaded = (await exec.run({
      command: 'update',
      args: { mode: 'download', id: item.id },
      timeoutMs: 90000,
    })) as { ok?: boolean; error?: string; path?: string }
    if (!downloaded?.ok || !downloaded.path) {
      error.value = downloaded?.error ?? '下载失败'
      notice.value = ''
      return
    }
    notice.value = `正在安装 ${item.title}…`
    await settings.pluginAction('installZip', { path: downloaded.path, overwrite: true })
    notice.value = `${item.title} 已更新到 ${item.latest}`
    await check()
  } catch (err) {
    error.value = messageOf(err)
    notice.value = ''
  } finally {
    busy.value = ''
  }
}

async function updateAll(): Promise<void> {
  for (const item of updatable.value) {
    await updateOne(item)
  }
  // 内核放最后：它会重启内核（页面重开），前面插件的进度与提示要先落定
  if (kernelUpdate.value?.hotOk) await updateKernel()
}

async function revert(item: OverriddenItem): Promise<void> {
  if (busy.value) return
  busy.value = item.id
  error.value = ''
  try {
    await settings.pluginAction('revertToBuiltin', { id: item.id })
    notice.value = `${item.title} 已恢复出厂版本`
    await check()
  } catch (err) {
    error.value = messageOf(err)
  } finally {
    busy.value = ''
  }
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

onMounted(async () => {
  await hostUi.setFooter([
    { type: 'button', id: 'check', label: '检查更新', icon: 'refresh', onClick: () => void check() },
    { type: 'button', id: 'update-all', label: '全部更新', icon: 'download', onClick: () => void updateAll() },
  ])
  await check()
})
</script>

<template>
  <AppShell>
    <div class="flex h-full flex-col">
      <header class="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div class="flex items-center gap-2">
          <UiIcon name="refresh" :size="15" class="text-muted" />
          <h1 class="text-[13.5px] font-medium">更新</h1>
        </div>
        <div class="text-[11.5px] text-faint">
          <span v-if="shellInfo">应用 v{{ shellInfo.version }}</span>
          <span v-if="shellInfo && kernelVersion" class="mx-1">·</span>
          <span v-if="kernelVersion">内核 v{{ kernelVersion }}</span>
          <span v-if="shellInfo || kernelVersion" class="mx-1">·</span>
          {{ stage === 'checking' ? '检查中…' : checkedAt ? `检查于 ${formatTime(checkedAt)}` : '' }}
        </div>
      </header>

      <div class="flex-1 overflow-y-auto px-4 py-3">
        <p v-if="!inHost" class="text-[12px] text-muted">请在启动台中打开此页。</p>

        <template v-else>
          <p v-if="stage === 'checking'" class="text-[12px] text-muted">正在检查更新…</p>

          <div v-else-if="stage === 'error'" class="space-y-2">
            <p class="text-[12px] text-danger">{{ error || '无法检查更新' }}</p>
            <button
              class="rounded-md border border-line px-2.5 py-1 text-[12px] hover:bg-hover"
              @click="check"
            >
              重试
            </button>
          </div>

          <p v-else-if="!updates.length && !overridden.length && !kernelUpdate && !appUpdate" class="text-[12px] text-muted">
            插件、内核与应用都是最新版本。
          </p>

          <template v-else>
            <!-- 应用（壳）自身：第三块状态卡。更新会重启整个应用（含内核），所以按钮独立、不并进「全部更新」 -->
            <section v-if="shellInfo" class="mb-3 rounded-lg border border-line bg-panel px-3 py-2.5">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5">
                    <UiIcon name="refresh" :size="14" class="text-muted" />
                    <span class="text-[13px]">应用</span>
                  </div>
                  <div class="mt-0.5 text-[11.5px] text-muted">
                    <span>v{{ shellInfo.version }}</span>
                    <template v-if="appUpdate">
                      <span class="mx-1">→</span>
                      <span class="text-fg">{{ appUpdate.latest }}</span>
                    </template>
                  </div>
                  <p v-if="appUpdate?.notes" class="mt-1 text-[11.5px] text-faint">{{ appUpdate.notes }}</p>
                  <p v-if="!shellInfo.canSelfUpdate" class="mt-1 text-[11px] text-faint">
                    开发态或安装位置不可写：自更新只在打包安装的应用里生效
                  </p>
                  <p v-else-if="appUpdate && !appUpdate.hotOk" class="mt-1 text-[11.5px] text-danger">
                    当前壳的自更新机制版本过低（需要 {{ appUpdate.minShellHotVersion ?? '—' }}），请手动换包
                  </p>
                  <p v-else-if="appUpdate" class="mt-1 text-[11px] text-faint">
                    更新会重启整个应用（含内核）；由你决定何时更新（托盘菜单与「关于」页也会提示）。
                  </p>
                  <p v-else class="mt-1 text-[11px] text-faint">已是最新（发现新版本会在托盘与「关于」页提示）。</p>
                </div>
                <button
                  v-if="appUpdate"
                  class="shrink-0 rounded-md border border-line px-2.5 py-1 text-[12px] hover:bg-hover disabled:opacity-45"
                  :disabled="!appUpdate.hotOk || !shellInfo.canSelfUpdate || !!busy"
                  @click="updateApp"
                >
                  {{ busy === 'app' ? '更新中…' : '更新应用' }}
                </button>
              </div>
            </section>

            <section v-if="kernelUpdate" class="mb-3 rounded-lg border border-line bg-panel px-3 py-2.5">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5">
                    <UiIcon name="cpu" :size="14" class="text-muted" />
                    <span class="text-[13px]">内核</span>
                  </div>
                  <div class="mt-0.5 text-[11.5px] text-muted">
                    <span>{{ kernelUpdate.current }}</span>
                    <span class="mx-1">→</span>
                    <span class="text-fg">{{ kernelUpdate.latest }}</span>
                  </div>
                  <p v-if="kernelUpdate.notes" class="mt-1 text-[11.5px] text-faint">{{ kernelUpdate.notes }}</p>
                  <p v-if="!kernelUpdate.hotOk" class="mt-1 text-[11.5px] text-danger">
                    当前热更新机制版本过低（需要 {{ kernelUpdate.minHotVersion ?? '—' }}），请先升级应用
                  </p>
                  <p v-else class="mt-1 text-[11px] text-faint">
                    替换内核与 UI 并优雅重启内核（不重启 App）；连续两次启动失败会自动回滚。
                  </p>
                </div>
                <button
                  class="shrink-0 rounded-md border border-line px-2.5 py-1 text-[12px] hover:bg-hover disabled:opacity-45"
                  :disabled="!kernelUpdate.hotOk || !!busy"
                  @click="updateKernel"
                >
                  {{ busy === 'kernel' ? '更新中…' : '更新内核' }}
                </button>
              </div>
            </section>

            <ul v-if="updates.length" class="space-y-2">
              <li
                v-for="item in updates"
                :key="item.id"
                class="rounded-lg border border-line bg-panel px-3 py-2.5"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="truncate text-[13px]">{{ item.title }}</div>
                    <div class="mt-0.5 text-[11.5px] text-muted">
                      <span>{{ item.current }}</span>
                      <span class="mx-1">→</span>
                      <span class="text-fg">{{ item.latest }}</span>
                    </div>
                    <p v-if="item.notes" class="mt-1 text-[11.5px] text-faint">{{ item.notes }}</p>
                    <p v-if="!item.minKernelOk" class="mt-1 text-[11.5px] text-danger">
                      当前底座版本过低，请先升级应用
                    </p>
                  </div>
                  <button
                    class="shrink-0 rounded-md border border-line px-2.5 py-1 text-[12px] hover:bg-hover disabled:opacity-45"
                    :disabled="!item.minKernelOk || !!busy"
                    @click="updateOne(item)"
                  >
                    {{ busy === item.id ? '更新中…' : '更新' }}
                  </button>
                </div>
              </li>
            </ul>

            <div v-if="overridden.length" class="mt-4">
              <div class="mb-1.5 text-[11.5px] text-faint">已装新版本（可回到 App 自带的那份）</div>
              <ul class="space-y-2">
                <li
                  v-for="item in overridden"
                  :key="item.id"
                  class="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2"
                >
                  <div class="min-w-0">
                    <div class="truncate text-[12.5px]">{{ item.title }}</div>
                    <div class="text-[11.5px] text-faint">当前 {{ item.version }}</div>
                  </div>
                  <button
                    class="shrink-0 rounded-md border border-line px-2.5 py-1 text-[12px] hover:bg-hover disabled:opacity-45"
                    :disabled="!!busy"
                    @click="revert(item)"
                  >
                    {{ busy === item.id ? '处理中…' : '恢复出厂版本' }}
                  </button>
                </li>
              </ul>
            </div>
          </template>
        </template>
      </div>

      <footer
        v-if="error || notice"
        class="border-t border-line px-4 py-2 text-[11.5px]"
        :class="error ? 'text-danger' : 'text-muted'"
      >
        {{ error || notice }}
      </footer>
    </div>
  </AppShell>
</template>
