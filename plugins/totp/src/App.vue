<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import AppShell from '@launcher/ui/AppShell.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import { useVirtualList } from '@launcher/ui/virtual'
import { useToast } from '@launcher/ui/toast'
import { copyText, downloadBlob, readClipboardText } from '@launcher/ui/clipboard'
import { hostUi } from '@launcher/api'
import { isMod } from '@launcher/ui/keys'
import { useTheme } from '@launcher/ui/theme'
import { hotp, TotpCache } from './core/totp'
import { isMigrationUri, isOtpAuthUri } from './core/otpauth'
import { warmupQr } from './core/qr'
import { decryptJson, encryptJson, type VaultBlob } from './core/vault'
import { clearVault, loadState, saveAccounts, saveSettings, saveVault } from './core/store'
import { DEFAULT_SETTINGS, normalizeAccount, newId, type Account, type Settings } from './core/types'
import AccountDialog from './components/AccountDialog.vue'
import ImportDialog from './components/ImportDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'

/** 虚拟滚动的行高 = 卡片高 + 6px 间隙（卡片高度写在模板的行内 style 上） */
const ROW = 60
const CARD_H = 54
/** 倒计时环的「周长」：取 66 > 2πr(r=10.5)，整圈覆盖、末位留白可忽略。
 *  同值出现在 app.css 的 `stroke-dasharray`（两处必须一起改）。 */
const RING_DASH = 66

const accounts = ref<Account[]>([])
const settings = ref<Settings>({ ...DEFAULT_SETTINGS })
const vault = ref<VaultBlob | null>(null)
const unlocked = ref(true)
const passphrase = ref('')
const unlockError = ref('')
const now = ref(Date.now())
const query = ref('')
const selected = ref(0)
/** 分组筛选：'' = 全部；分组名来自账户的 group 字段（标签页只在其非空时出现） */
const groupFilter = ref('')
/** 刚复制过的账户 id（1.4s 内该行打勾反馈） */
const copiedId = ref('')
const dialog = ref<'none' | 'import' | 'account' | 'settings'>('none')
const editing = ref<Account | null>(null)
const seed = ref('')
const loading = ref(true)
const codeMap = shallowRef(new Map<string, string>())
const hotpCodes = shallowRef(new Map<string, string>())
const searchEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const toast = useToast()
// 主题由宿主裁决（会话 URL 的 ?theme=），本页只跟随、不提供切换
useTheme()
const cache = new TotpCache()

let clearTimer = 0
let tickTimer = 0
let copiedTimer = 0

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  const group = groupFilter.value
  const list = accounts.value.filter((a) => {
    if (group && a.group !== group) return false
    if (!q) return true
    return [a.issuer, a.name, a.group, a.note].some((v) => v && v.toLowerCase().includes(q))
  })
  return [...list].sort((a, b) => (a.issuer || a.name).localeCompare(b.issuer || b.name, 'zh-Hans-CN'))
})

/** 分组标签（含各自账户数）—— 没有任何账户填过分组时整条标签栏不出现 */
const groups = computed(() => {
  const counts = new Map<string, number>()
  for (const a of accounts.value) {
    const name = (a.group || '').trim()
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((x, y) => x.name.localeCompare(y.name, 'zh-Hans-CN'))
})

// 过滤条件变化后选中项可能越界（换分组 / 输入关键词），夹回合法区间
watch(filtered, (list) => {
  if (selected.value > list.length - 1) selected.value = Math.max(0, list.length - 1)
})

const { startIndex, endIndex, totalHeight, scrollToIndex } = useVirtualList(listEl, {
  count: computed(() => filtered.value.length),
  rowHeight: ROW,
})

const visibleRows = computed(() => filtered.value.slice(startIndex.value, endIndex.value))

/* --------------------------------------------------------------- 验证码 */

function paramsOf(a: Account) {
  return { secret: a.secret, algorithm: a.algorithm, digits: a.digits, period: a.period }
}

async function refreshCodes() {
  const next = new Map<string, string>()
  for (const a of filtered.value) {
    if (a.type === 'hotp') continue
    const res = await cache.code(a.id, paramsOf(a), now.value)
    next.set(a.id, res.code)
  }
  codeMap.value = next
}

async function ensureHotp(a: Account) {
  if (hotpCodes.value.has(a.id)) return
  const code = await hotp(paramsOf(a), a.counter)
  hotpCodes.value = new Map(hotpCodes.value).set(a.id, code)
}

function codeOf(a: Account): string {
  if (a.type === 'hotp') return hotpCodes.value.get(a.id) ?? '······'
  return codeMap.value.get(a.id) ?? '······'
}

function remainingSeconds(a: Account): number {
  const period = a.period * 1000
  return Math.ceil((period - (now.value % period)) / 1000)
}

function progressOf(a: Account): number {
  const period = a.period * 1000
  return (period - (now.value % period)) / period
}

function formatCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : `${code.slice(0, 3)} ${code.slice(3)}`
}

function codeVisible(rowIndex: number): boolean {
  return !settings.value.hideCodes || selected.value === rowIndex
}

/** 隐私模式下打点的占位串：位数与真实验证码一致，换行时列宽不跳 */
function displayCode(a: Account, rowIndex: number): string {
  if (codeVisible(rowIndex)) return formatCode(codeOf(a))
  return a.digits === 8 ? '•••• ••••' : '••• •••'
}

/* ------------------------------------------------------------------ 外观 */

function initial(a: Account): string {
  return ((a.issuer || a.name || '?').trim()[0] ?? '?').toUpperCase()
}

/** 头像底色由服务名散列而来：同一个服务永远同色，不同服务一眼可辨 */
function avatarStyle(a: Account): Record<string, string> {
  const text = a.issuer || a.name || '?'
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 360
  return { background: `linear-gradient(145deg, hsl(${hash} 58% 54%), hsl(${(hash + 26) % 360} 56% 41%))` }
}

/** 临期提示：最后 10 秒转警示色，最后 5 秒转危险色并轻微呼吸 */
function urgency(a: Account): '' | 'is-warn' | 'is-danger' {
  if (a.type !== 'totp') return ''
  const left = remainingSeconds(a)
  if (left <= 5) return 'is-danger'
  if (left <= 10) return 'is-warn'
  return ''
}

/**
 * 倒计时环的进度：每秒按时间步算一次目标 `stroke-dashoffset`，平滑由 CSS 的
 * `transition: stroke-dashoffset 1s linear` 补间（见 app.css 的说明）。
 * 只有这一个时间源 —— 环与秒数、验证码都出自同一个 `now`。
 */
function ringOffset(a: Account): string {
  return `${RING_DASH * (1 - progressOf(a))}px`
}

/** 刚跨过时间步的账户：这一帧要瞬时把环复位到满圈 */
const ringReset = ref<Set<string>>(new Set())
/** 各账户上次落笔的时间步序号（用来发现「刚跨了一步」） */
const ringStep = new Map<string, number>()

/**
 * 跨时间步的那一帧把过渡关掉（模板加 `is-reset`）。
 *
 * 不关的话，1s 的补间会把「offset 66 → 0」演成环沿逆时针**倒转一整圈**回来 ——
 * 那是全表最扎眼的一处动效。复位只活一帧，下一次 tick 集合清空、过渡自然恢复。
 */
function markStepReset(): void {
  const resets = new Set<string>()
  for (const a of filtered.value) {
    if (a.type !== 'totp') continue
    const step = Math.floor(now.value / ((a.period || 30) * 1000))
    const prev = ringStep.get(a.id)
    ringStep.set(a.id, step)
    // 首次见到（插件页刚打开 / 行刚滚进视口）不复位：首帧本来就没有过渡
    if (prev !== undefined && prev !== step) resets.add(a.id)
  }
  ringReset.value = resets
}

/* ------------------------------------------------------------------ 交互 */

function setGroup(name: string) {
  groupFilter.value = name
  selected.value = 0
  if (listEl.value) listEl.value.scrollTop = 0
}

/**
 * 整行单击 = 选中 + 复制。
 * 双击的第二次 click 丢掉：`detail > 1` 只让第一次生效，否则 HOTP 行会被扣掉两个计数器。
 */
function onRowClick(e: MouseEvent, index: number, a: Account) {
  selected.value = index
  if (e.detail > 1) return
  void copyAccount(a)
}

function togglePrivacy() {
  void updateSettings({ ...settings.value, hideCodes: !settings.value.hideCodes })
}

async function copyAccount(a: Account) {
  const code = codeOf(a)
  if (code.includes('·')) return
  const ok = await copyText(code)
  if (!ok) {
    toast.err('复制失败，请手动输入')
    return
  }
  toast.ok(a.type === 'hotp' ? `已复制 ${code}（计数器 +1）` : `已复制 ${formatCode(code)}`)
  flashCopied(a.id)
  if (a.type === 'hotp') {
    try {
      await persist(accounts.value.map((x) => (x.id === a.id ? { ...x, counter: x.counter + 1 } : x)))
    } catch (err) {
      toast.err(`计数器保存失败：${errorText(err)}`)
    }
    hotpCodes.value = new Map(hotpCodes.value)
    hotpCodes.value.delete(a.id)
    await ensureHotp({ ...a, counter: a.counter + 1 })
  }
  scheduleClear(code)
}

/** 复制后按设置延时清空剪贴板（仅在剪贴板里还是这段验证码时才清） */
function scheduleClear(code: string) {
  clearTimeout(clearTimer)
  const seconds = settings.value.clearClipboardAfter
  if (!seconds) return
  clearTimer = window.setTimeout(async () => {
    const current = await readClipboardText()
    if (current === code) await copyText('')
  }, seconds * 1000)
}

/** 复制成功的行内回执：按钮换成对勾、卡片描边泛绿，1.4 秒后复原 */
function flashCopied(id: string) {
  clearTimeout(copiedTimer)
  copiedId.value = id
  copiedTimer = window.setTimeout(() => (copiedId.value = ''), 1400)
}

/* ------------------------------------------------------------------ 存储 */

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 落库成功后才更新内存 —— 写失败时界面不该展示一个并未保存的状态。
 * （反面教材：先前 `accounts.value = list` 提前执行，于是「列表看起来改好了、其实没落盘」。）
 */
async function persist(list: Account[]) {
  if (vault.value && passphrase.value) {
    const blob = await encryptJson(passphrase.value, list)
    await saveVault(blob)
    vault.value = blob
  } else {
    await saveAccounts(list)
  }
  accounts.value = list
}

async function updateSettings(next: Settings) {
  try {
    await saveSettings(next)
  } catch (err) {
    toast.err(`设置保存失败：${errorText(err)}`)
    return
  }
  settings.value = next
}

async function enableVault(password: string) {
  passphrase.value = password
  const blob = await encryptJson(password, accounts.value)
  vault.value = blob
  await saveVault(blob)
}

async function disableVault(password: string) {
  try {
    await decryptJson(password, vault.value as VaultBlob)
  } catch {
    toast.err('口令不正确，未关闭加密')
    return
  }
  vault.value = null
  passphrase.value = ''
  await clearVault()
  await saveAccounts(accounts.value)
}

async function tryUnlock() {
  if (!vault.value) return
  try {
    const list = await decryptJson<Account[]>(passphrase.value, vault.value)
    accounts.value = (Array.isArray(list) ? list : []).map(normalizeAccount)
    unlocked.value = true
    unlockError.value = ''
    await refreshCodes()
    for (const a of accounts.value) if (a.type === 'hotp') void ensureHotp(a)
  } catch {
    unlockError.value = '口令不正确'
  }
}

function exportAccounts() {
  const payload = {
    format: 'totp',
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts: accounts.value,
  }
  downloadBlob(`totp-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'application/json')
  toast.ok('已导出明文备份')
}

async function clearAll() {
  try {
    await persist([])
  } catch (err) {
    toast.err(`清空失败：${errorText(err)}`)
    return
  }
  codeMap.value = new Map()
  hotpCodes.value = new Map()
  cache.clear()
  toast.info('已清空')
}

/* ------------------------------------------------------------------ 操作 */

function openAdd() {
  editing.value = null
  dialog.value = 'account'
}

function openEdit(a: Account) {
  editing.value = a
  dialog.value = 'account'
}

async function saveAccount(account: Account) {
  const exists = accounts.value.some((a) => a.id === account.id)
  const list = exists ? accounts.value.map((a) => (a.id === account.id ? account : a)) : [...accounts.value, account]
  try {
    await persist(list)
  } catch (err) {
    toast.err(`保存失败：${errorText(err)}`)
    return
  }
  dialog.value = 'none'
  await refreshCodes()
  toast.ok(exists ? '已保存' : '已添加')
}

async function removeAccount(id: string) {
  try {
    await persist(accounts.value.filter((a) => a.id !== id))
  } catch (err) {
    toast.err(`删除失败：${errorText(err)}`)
    return
  }
  dialog.value = 'none'
  toast.info('已删除')
}

async function importAccounts(list: Account[]) {
  const merged = [...accounts.value]
  for (const item of list) {
    if (merged.some((a) => a.secret === item.secret && a.issuer === item.issuer && a.name === item.name)) continue
    merged.push({ ...item, id: newId() })
  }
  try {
    await persist(merged)
  } catch (err) {
    toast.err(`导入失败：${errorText(err)}`)
    return
  }
  dialog.value = 'none'
  await refreshCodes()
  for (const a of merged) if (a.type === 'hotp') void ensureHotp(a)
}

/* ---------------------------------------------------------------- 交互 */

function onKeydown(e: KeyboardEvent) {
  if (dialog.value !== 'none') return
  if (isMod(e) && e.key.toLowerCase() === 'n') {
    e.preventDefault()
    openAdd()
    return
  }
  if (isMod(e) && e.key.toLowerCase() === 'i') {
    e.preventDefault()
    dialog.value = 'import'
    return
  }
  if (isMod(e) && e.key === ',') {
    e.preventDefault()
    dialog.value = 'settings'
    return
  }
  if (isMod(e) && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    searchEl.value?.focus()
    return
  }
  const tag = (e.target as HTMLElement | null)?.tagName
  const typing = tag === 'INPUT' || tag === 'TEXTAREA'
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const delta = e.key === 'ArrowDown' ? 1 : -1
    selected.value = Math.max(0, Math.min(filtered.value.length - 1, selected.value + delta))
    scrollToIndex(selected.value)
    return
  }
  if (e.key === 'Enter' && !typing) {
    e.preventDefault()
    const account = filtered.value[selected.value]
    if (account) void copyAccount(account)
    return
  }
  if (e.key === 'Escape' && query.value) {
    // 标记「已消费」：SDK 只把没人认领的 Esc 交还宿主（退回启动台），清搜索词时不退
    e.preventDefault()
    query.value = ''
  }
}

/* ------------------------------------------------------------- 宿主集成 */

async function syncFooter() {
  await hostUi.setFooter([
    {
      type: 'button',
      id: 'copy',
      label: '复制验证码',
      icon: 'Copy',
      keys: ['Enter'],
      onClick: () => {
        const account = filtered.value[selected.value]
        if (account) void copyAccount(account)
      },
    },
    { type: 'button', id: 'add', label: '添加', icon: 'Plus', keys: ['Mod+N'], onClick: openAdd },
    { type: 'button', id: 'import', label: '导入', icon: 'QrCode', keys: ['Mod+I'], onClick: () => (dialog.value = 'import') },
    {
      type: 'action-panel',
      id: 'more',
      label: '更多',
      icon: 'Sliders',
      keys: ['Mod+K'],
      title: '双重验证',
      items: [
        { id: 'settings', name: '设置', onSelect: () => (dialog.value = 'settings') },
        {
          id: 'hide',
          name: settings.value.hideCodes ? '关闭隐私模式' : '开启隐私模式',
          onSelect: () => void updateSettings({ ...settings.value, hideCodes: !settings.value.hideCodes }),
        },
        { id: 'export', name: '导出备份', onSelect: exportAccounts },
      ],
    },
  ])
}

/**
 * 对齐到「整秒边界」再自排下一次，而不是 setInterval(1000)。
 * 间隔定时器会累积漂移，而验证码与倒计时环都按整秒判定 —— 漂几百毫秒就会出现
 * 「环已经重来、数字还没换」的错位；对齐后界面换码与 TOTP 时间步最多差几十毫秒。
 */
function scheduleTick() {
  tickTimer = window.setTimeout(async () => {
    now.value = Date.now()
    markStepReset()
    await refreshCodes()
    scheduleTick()
  }, 1000 - (Date.now() % 1000))
}

let stopWatch: (() => void) | null = null

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  const state = await loadState()
  accounts.value = state.accounts
  settings.value = state.settings
  vault.value = state.vault
  unlocked.value = !state.vault
  loading.value = false
  scheduleTick()
  await refreshCodes()
  for (const a of accounts.value) if (a.type === 'hotp') void ensureHotp(a)
  void warmupQr().catch(() => undefined)
  void syncFooter()

  // 用户在宿主搜索框里粘的链接 / 密钥，直接送进导入面板
  const fromSearch = (await hostUi.getSearchContent()).trim()
  if (fromSearch && (isOtpAuthUri(fromSearch) || isMigrationUri(fromSearch))) {
    seed.value = fromSearch
    dialog.value = 'import'
    void hostUi.clearSearchContent()
  }
  stopWatch = hostUi.watchSearchContent((val) => {
    const text = val.trim()
    if (text && (isOtpAuthUri(text) || isMigrationUri(text))) {
      seed.value = text
      dialog.value = 'import'
    }
  })
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  clearTimeout(tickTimer)
  clearTimeout(clearTimer)
  clearTimeout(copiedTimer)
  stopWatch?.()
})

watch(settings, () => void syncFooter())
watch(selected, (i) => {
  const account = filtered.value[i]
  if (account?.type === 'hotp') void ensureHotp(account)
})
</script>

<template>
  <AppShell>
    <!-- ══ 顶栏：身份 / 搜索 / 动作 ══════════════════════════════ -->
    <header class="flex h-[54px] shrink-0 items-center gap-3 border-b border-line bg-panel px-3.5">
      <div class="flex shrink-0 items-center gap-2.5">
        <span class="launcher-brand"><UiIcon name="shield" :size="15" /></span>
        <span class="leading-tight">
          <span class="block text-[12.5px] font-semibold">双重验证器</span>
          <span class="block text-[10.5px] text-faint">
            {{ accounts.length }} 个账户<template v-if="vault"> · 已加密</template>
          </span>
        </span>
      </div>

      <div class="relative min-w-[120px] flex-1">
        <UiIcon name="search" :size="13" class="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
        <input
          ref="searchEl"
          v-model="query"
          class="launcher-input launcher-search pl-7"
          placeholder="搜索服务、账号或分组…"
          spellcheck="false"
        />
        <button v-if="query" class="launcher-clear" title="清空搜索" @click="query = ''">
          <UiIcon name="close" :size="12" />
        </button>
      </div>

      <div class="flex shrink-0 items-center gap-1.5">
        <button class="launcher-btn" title="导入（⌘I）" @click="dialog = 'import'">
          <UiIcon name="qr" :size="13" />导入
        </button>
        <button class="launcher-btn primary" title="添加（⌘N）" @click="openAdd">
          <UiIcon name="plus" :size="13" />添加
        </button>
        <span class="launcher-vsep" />
        <button
          class="launcher-btn ghost"
          :class="{ 'is-on': settings.hideCodes }"
          :title="settings.hideCodes ? '关闭隐私模式' : '开启隐私模式'"
          @click="togglePrivacy"
        >
          <UiIcon :name="settings.hideCodes ? 'eyeOff' : 'eye'" :size="13" />
        </button>
        <button class="launcher-btn ghost" title="设置（⌘,）" @click="dialog = 'settings'">
          <UiIcon name="sliders" :size="13" />
        </button>
      </div>
    </header>

    <!-- ══ 分组标签（账户都没填分组时整条不出现） ══════════════════ -->
    <div
      v-if="groups.length"
      class="launcher-noscroll flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line px-3.5 py-2"
    >
      <button class="launcher-filter" :class="{ 'is-active': !groupFilter }" @click="setGroup('')">
        全部<span class="launcher-n">{{ accounts.length }}</span>
      </button>
      <button
        v-for="g in groups"
        :key="g.name"
        class="launcher-filter"
        :class="{ 'is-active': groupFilter === g.name }"
        @click="setGroup(g.name)"
      >
        {{ g.name }}<span class="launcher-n">{{ g.count }}</span>
      </button>
    </div>

    <!-- ══ 账户卡片列表 ══════════════════════════════════════════ -->
    <div ref="listEl" class="launcher-scroll relative min-h-0 flex-1 px-2.5 py-2">
      <div class="relative" :style="{ height: totalHeight + 'px' }">
        <div
          v-for="(account, i) in visibleRows"
          :key="account.id"
          class="launcher-card absolute inset-x-0 flex cursor-pointer items-center gap-3 px-3"
          :class="{ 'is-selected': startIndex + i === selected, 'is-copied': copiedId === account.id }"
          :style="{ top: (startIndex + i) * ROW + 'px', height: CARD_H + 'px' }"
          @click="onRowClick($event, startIndex + i, account)"
        >
          <span class="launcher-avatar" :style="avatarStyle(account)">{{ initial(account) }}</span>

          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="truncate text-[13px] font-semibold">{{ account.issuer || '未命名服务' }}</span>
              <span v-if="account.group" class="launcher-chip">{{ account.group }}</span>
              <span v-if="account.type === 'hotp'" class="launcher-chip">HOTP · {{ account.counter }}</span>
            </div>
            <div class="mt-0.5 truncate text-[11.5px] text-muted">{{ account.name || account.note || '—' }}</div>
          </div>

          <div class="flex shrink-0 items-center gap-2.5">
            <button
              class="launcher-code-btn"
              :title="codeVisible(startIndex + i) ? '点击复制验证码' : '隐私模式：选中这一行才显示'"
              @click.stop="copyAccount(account)"
            >
              <span
                :key="displayCode(account, startIndex + i)"
                class="launcher-code launcher-code-big launcher-code-swap"
                :class="codeVisible(startIndex + i) ? 'text-fg' : 'text-faint'"
                >{{ displayCode(account, startIndex + i) }}</span
              >
            </button>

            <!-- 固定宽度计时列：TOTP 是环 + 秒数，HOTP 留空 —— 各行的按钮因此纵向对齐 -->
            <span class="launcher-timer">
              <template v-if="account.type === 'totp'">
                <svg v-if="settings.showRing" class="launcher-ring" width="26" height="26" viewBox="0 0 26 26">
                  <circle class="track" cx="13" cy="13" r="10.5" />
                  <circle
                    class="progress"
                    :class="[urgency(account), ringReset.has(account.id) ? 'is-reset' : '']"
                    cx="13"
                    cy="13"
                    r="10.5"
                    :style="{ strokeDashoffset: ringOffset(account) }"
                  />
                </svg>
                <span class="launcher-timer-n launcher-code" :class="urgency(account)">
                  {{ remainingSeconds(account) }}
                </span>
              </template>
            </span>

            <span class="launcher-row-actions">
              <button
                class="launcher-btn ghost"
                :title="copiedId === account.id ? '已复制' : '复制'"
                @click.stop="copyAccount(account)"
              >
                <UiIcon
                  :name="copiedId === account.id ? 'check' : 'copy'"
                  :size="13"
                  :class="copiedId === account.id ? 'text-success' : ''"
                />
              </button>
              <button class="launcher-btn ghost" title="编辑" @click.stop="openEdit(account)">
                <UiIcon name="pencil" :size="13" />
              </button>
            </span>
          </div>
        </div>
      </div>

      <div v-if="!loading && !filtered.length" class="absolute inset-0 grid place-items-center px-6">
        <div class="text-center">
          <span class="launcher-empty-icon"><UiIcon name="shield" :size="24" /></span>
          <p class="mt-3 text-[13.5px] font-semibold">
            {{ accounts.length ? '没有匹配的账户' : '还没有账户' }}
          </p>
          <p class="mx-auto mt-1 max-w-[330px] text-[11.5px] text-muted">
            {{
              accounts.length
                ? '换个关键词，或点上方的分组标签'
                : '扫码导入 Google Authenticator 的迁移二维码，也可以手动填入密钥'
            }}
          </p>
          <div class="mt-4 flex justify-center gap-2">
            <button class="launcher-btn primary" @click="dialog = 'import'">
              <UiIcon name="qr" :size="13" />扫码导入
            </button>
            <button class="launcher-btn" @click="openAdd"><UiIcon name="plus" :size="13" />手动添加</button>
          </div>
        </div>
      </div>
    </div>

    <footer class="flex shrink-0 items-center gap-3 border-t border-line px-3.5 py-2 text-[11px] text-faint">
      <span class="launcher-hint"><span class="launcher-kbd">↑</span><span class="launcher-kbd">↓</span>选择</span>
      <span class="launcher-hint"><span class="launcher-kbd">↵</span>复制</span>
      <span class="launcher-hint">单击整行即可复制</span>
      <span v-if="settings.clearClipboardAfter" class="launcher-hint">
        复制 {{ settings.clearClipboardAfter }} 秒后清空剪贴板
      </span>
      <span class="launcher-hint ml-auto"><UiIcon name="lock" :size="11" />密钥仅存本机，插件不联网</span>
    </footer>

    <!-- 解锁：整页遮住（加密状态下列表本就不该渲染出来） -->
    <div v-if="!unlocked" class="absolute inset-0 z-30 grid place-items-center bg-bg">
      <div class="launcher-dialog-pop w-[330px] rounded-2xl border border-line bg-panel p-5 shadow-lg">
        <span class="launcher-empty-icon"><UiIcon name="lock" :size="22" /></span>
        <p class="mt-3 text-center text-[13.5px] font-semibold">输入口令解锁</p>
        <p class="mt-1 text-center text-[11.5px] text-muted">
          账户表已用 PBKDF2 + AES-GCM 加密。口令只在本机内存里用于解密，不会被保存。
        </p>
        <input
          v-model="passphrase"
          class="launcher-input mt-3"
          type="password"
          placeholder="口令"
          autocomplete="current-password"
          @keydown.enter="tryUnlock"
        />
        <p v-if="unlockError" class="mt-2 text-center text-[11.5px] text-danger">{{ unlockError }}</p>
        <button class="launcher-btn primary mt-3 w-full justify-center" @click="tryUnlock">
          <UiIcon name="unlock" :size="13" />解锁
        </button>
      </div>
    </div>

    <AccountDialog
      v-if="dialog === 'account'"
      :account="editing"
      @close="dialog = 'none'"
      @save="saveAccount"
      @delete="removeAccount"
    />
    <ImportDialog
      v-else-if="dialog === 'import'"
      :existing="accounts"
      :seed="seed"
      @close="dialog = 'none'"
      @import="importAccounts"
    />
    <SettingsDialog
      v-else-if="dialog === 'settings'"
      :settings="settings"
      :accounts="accounts"
      :has-vault="!!vault"
      @close="dialog = 'none'"
      @update="updateSettings"
      @enable-vault="enableVault"
      @disable-vault="disableVault"
      @export="exportAccounts"
      @clear-all="clearAll"
    />
  </AppShell>
</template>
