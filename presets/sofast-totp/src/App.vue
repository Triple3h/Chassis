<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import AppShell from '@shared/ui/AppShell.vue'
import SofIcon from '@shared/ui/SofIcon.vue'
import { useVirtualList } from '@shared/lib/virtual'
import { useToast } from '@shared/lib/toast'
import { copyText, downloadBlob, readClipboardText } from '@shared/lib/clipboard'
import { clearSearchContent, getSearchContent, setFooter, watchSearchContent } from '@shared/lib/platform'
import { isMod } from '@shared/lib/keys'
import { useTheme } from '@shared/lib/theme'
import { hotp, TotpCache } from './core/totp'
import { isMigrationUri, isOtpAuthUri } from './core/otpauth'
import { warmupQr } from './core/qr'
import { decryptJson, encryptJson, type VaultBlob } from './core/vault'
import { clearVault, loadState, saveAccounts, saveSettings, saveVault } from './core/store'
import { DEFAULT_SETTINGS, normalizeAccount, newId, type Account, type Settings } from './core/types'
import AccountDialog from './components/AccountDialog.vue'
import ImportDialog from './components/ImportDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'

const ROW = 56
const CIRC = 2 * Math.PI * 9

const accounts = ref<Account[]>([])
const settings = ref<Settings>({ ...DEFAULT_SETTINGS })
const vault = ref<VaultBlob | null>(null)
const unlocked = ref(true)
const passphrase = ref('')
const unlockError = ref('')
const now = ref(Date.now())
const query = ref('')
const selected = ref(0)
const dialog = ref<'none' | 'import' | 'account' | 'settings'>('none')
const editing = ref<Account | null>(null)
const seed = ref('')
const loading = ref(true)
const codeMap = shallowRef(new Map<string, string>())
const hotpCodes = shallowRef(new Map<string, string>())
const searchEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const toast = useToast()
const { theme, toggle: toggleTheme } = useTheme()
const cache = new TotpCache()

let clearTimer = 0
let tickTimer = 0

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = q
    ? accounts.value.filter((a) =>
        [a.issuer, a.name, a.group, a.note].some((v) => v && v.toLowerCase().includes(q)),
      )
    : accounts.value
  return [...list].sort((a, b) => (a.issuer || a.name).localeCompare(b.issuer || b.name, 'zh-Hans-CN'))
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

async function copyAccount(a: Account) {
  const code = codeOf(a)
  if (code.includes('·')) return
  const ok = await copyText(code)
  if (!ok) {
    toast.err('复制失败，请手动输入')
    return
  }
  toast.ok(a.type === 'hotp' ? `已复制 ${code}（计数器 +1）` : `已复制 ${formatCode(code)}`)
  if (a.type === 'hotp') {
    await persist(accounts.value.map((x) => (x.id === a.id ? { ...x, counter: x.counter + 1 } : x)))
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

/* ------------------------------------------------------------------ 存储 */

async function persist(list: Account[]) {
  accounts.value = list
  if (vault.value && passphrase.value) {
    const blob = await encryptJson(passphrase.value, list)
    vault.value = blob
    await saveVault(blob)
  } else {
    await saveAccounts(list)
  }
}

async function updateSettings(next: Settings) {
  settings.value = next
  await saveSettings(next)
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
    format: 'sofast-totp',
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts: accounts.value,
  }
  downloadBlob(`totp-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'application/json')
  toast.ok('已导出明文备份')
}

async function clearAll() {
  accounts.value = []
  codeMap.value = new Map()
  hotpCodes.value = new Map()
  cache.clear()
  await persist([])
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
  await persist(list)
  dialog.value = 'none'
  await refreshCodes()
  toast.ok(exists ? '已保存' : '已添加')
}

async function removeAccount(id: string) {
  await persist(accounts.value.filter((a) => a.id !== id))
  dialog.value = 'none'
  toast.info('已删除')
}

async function importAccounts(list: Account[]) {
  const merged = [...accounts.value]
  for (const item of list) {
    if (merged.some((a) => a.secret === item.secret && a.issuer === item.issuer && a.name === item.name)) continue
    merged.push({ ...item, id: newId() })
  }
  await persist(merged)
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
    query.value = ''
  }
}

/* ------------------------------------------------------------- 宿主集成 */

async function syncFooter() {
  await setFooter([
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
        { id: 'settings', name: '设置', keys: ['Mod+,'], onSelect: () => (dialog.value = 'settings') },
        {
          id: 'hide',
          name: settings.value.hideCodes ? '关闭隐私模式' : '开启隐私模式',
          onSelect: () => void updateSettings({ ...settings.value, hideCodes: !settings.value.hideCodes }),
        },
        { id: 'theme', name: '切换主题', onSelect: toggleTheme },
        { id: 'export', name: '导出备份', onSelect: exportAccounts },
      ],
    },
  ])
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
  tickTimer = window.setInterval(() => {
    now.value = Date.now()
    void refreshCodes()
  }, 1000)
  await refreshCodes()
  for (const a of accounts.value) if (a.type === 'hotp') void ensureHotp(a)
  void warmupQr().catch(() => undefined)
  void syncFooter()

  // 用户在宿主搜索框里粘的链接 / 密钥，直接送进导入面板
  const fromSearch = (await getSearchContent()).trim()
  if (fromSearch && (isOtpAuthUri(fromSearch) || isMigrationUri(fromSearch))) {
    seed.value = fromSearch
    dialog.value = 'import'
    void clearSearchContent()
  }
  stopWatch = watchSearchContent((val) => {
    const text = val.trim()
    if (text && (isOtpAuthUri(text) || isMigrationUri(text))) {
      seed.value = text
      dialog.value = 'import'
    }
  })
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  clearInterval(tickTimer)
  clearTimeout(clearTimer)
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
    <header class="flex items-center gap-2 border-b border-line px-3 py-2">
      <SofIcon name="shield" :size="16" class="text-accent" />
      <span class="text-[13px] font-semibold">双重验证器</span>
      <span class="sof-chip">{{ accounts.length }}</span>
      <span v-if="vault" class="sof-chip">
        <SofIcon name="lock" :size="11" />已加密
      </span>

      <div class="relative ml-3 min-w-[140px] flex-1">
        <SofIcon name="search" :size="13" class="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
        <input
          ref="searchEl"
          v-model="query"
          class="sof-input pl-7"
          placeholder="搜索服务或账号…"
          spellcheck="false"
        />
      </div>

      <button class="sof-btn" title="导入（⌘I）" @click="dialog = 'import'">
        <SofIcon name="qr" :size="13" />导入
      </button>
      <button class="sof-btn" title="添加（⌘N）" @click="openAdd">
        <SofIcon name="plus" :size="13" />添加
      </button>
      <button class="sof-btn ghost" title="设置" @click="dialog = 'settings'">
        <SofIcon name="sliders" :size="13" />
      </button>
      <button class="sof-btn ghost" :title="theme === 'dark' ? '切换到浅色' : '切换到深色'" @click="toggleTheme">
        <SofIcon :name="theme === 'dark' ? 'sun' : 'moon'" :size="13" />
      </button>
    </header>

    <div ref="listEl" class="sof-scroll relative min-h-0 flex-1">
      <div class="relative" :style="{ height: totalHeight + 'px' }">
        <div
          v-for="(account, i) in visibleRows"
          :key="account.id"
          class="sof-row absolute inset-x-0 flex h-14 cursor-default items-center gap-3 px-3"
          :class="startIndex + i === selected ? 'bg-active' : 'hover:bg-hover'"
          :style="{ top: (startIndex + i) * ROW + 'px' }"
          @click="selected = startIndex + i"
          @dblclick="copyAccount(account)"
        >
          <div
            class="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-panel2 text-[13px] font-semibold text-muted"
          >
            {{ (account.issuer || account.name || '?').slice(0, 1).toUpperCase() }}
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="truncate text-[13px] font-medium">{{ account.issuer || '未命名服务' }}</span>
              <span v-if="account.group" class="sof-chip">{{ account.group }}</span>
              <span v-if="account.type === 'hotp'" class="sof-chip">HOTP {{ account.counter }}</span>
            </div>
            <div class="truncate text-[11.5px] text-muted">{{ account.name || account.note || '—' }}</div>
          </div>

          <div class="flex items-center gap-3">
            <span
              class="sof-code sof-code-big tabular-nums"
              :class="codeVisible(startIndex + i) ? 'text-fg' : 'text-faint'"
            >
              {{ codeVisible(startIndex + i) ? formatCode(codeOf(account)) : '••• •••' }}
            </span>

            <!-- 固定宽度的计时列，保证 HOTP 行与 TOTP 行的按钮纵向对齐 -->
            <span class="flex w-[46px] items-center justify-end gap-1">
              <template v-if="account.type === 'totp'">
                <svg v-if="settings.showRing" class="sof-ring" width="22" height="22" viewBox="0 0 22 22">
                  <circle cx="11" cy="11" r="9" stroke="var(--sof-line)" stroke-width="2.4" />
                  <circle
                    cx="11"
                    cy="11"
                    r="9"
                    stroke="var(--sof-accent)"
                    stroke-width="2.4"
                    :stroke-dasharray="CIRC"
                    :stroke-dashoffset="CIRC * (1 - progressOf(account))"
                  />
                </svg>
                <span class="sof-code text-right text-[11.5px] text-faint">{{ remainingSeconds(account) }}</span>
              </template>
            </span>

            <button class="sof-btn ghost" title="复制" @click.stop="copyAccount(account)">
              <SofIcon name="copy" :size="13" />
            </button>
            <button class="sof-btn ghost" title="编辑" @click.stop="openEdit(account)">
              <SofIcon name="pencil" :size="13" />
            </button>
          </div>
        </div>
      </div>

      <div v-if="!loading && !filtered.length" class="grid h-full place-items-center px-6 text-center">
        <div class="space-y-2">
          <SofIcon name="shield" :size="26" class="mx-auto text-faint" />
          <p class="text-[13px] text-muted">
            {{ accounts.length ? '没有匹配的账户' : '还没有账户' }}
          </p>
          <p class="text-[11.5px] text-faint">
            点「导入」扫码，可以直接把 Google Authenticator 的账户迁过来
          </p>
          <button class="sof-btn primary mx-auto" @click="dialog = 'import'">
            <SofIcon name="qr" :size="13" />开始导入
          </button>
        </div>
      </div>
    </div>

    <footer class="flex items-center gap-3 border-t border-line px-3 py-1.5 text-[11.5px] text-faint">
      <span>双击复制 · ↑↓ 选择 · Enter 复制</span>
      <span v-if="settings.clearClipboardAfter" class="ml-auto">
        复制 {{ settings.clearClipboardAfter }} 秒后清空剪贴板
      </span>
      <span class="ml-auto">密钥仅存本机，插件不联网</span>
    </footer>

    <!-- 解锁 -->
    <div v-if="!unlocked" class="absolute inset-0 z-30 grid place-items-center bg-bg">
      <div class="w-[320px] space-y-3 rounded-xl border border-line bg-panel p-5">
        <div class="flex items-center gap-2">
          <SofIcon name="lock" :size="16" class="text-accent" />
          <span class="text-[13.5px] font-semibold">输入口令解锁</span>
        </div>
        <p class="text-[11.5px] text-muted">
          账户表已用 PBKDF2 + AES-GCM 加密。口令仅在本机内存中用于解密，不会被保存。
        </p>
        <input
          v-model="passphrase"
          class="sof-input"
          type="password"
          placeholder="口令"
          autocomplete="current-password"
          @keydown.enter="tryUnlock"
        />
        <p v-if="unlockError" class="text-[11.5px] text-danger">{{ unlockError }}</p>
        <button class="sof-btn primary w-full justify-center" @click="tryUnlock">
          <SofIcon name="unlock" :size="13" />解锁
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
