<script setup lang="ts">
/**
 * 聚合翻译 · 翻译工作台（view 命令 `panel`）。
 *
 * 职责边界：这一页只做界面与复制 —— 翻译、命名风格转换全在逻辑层（Rust）算，
 * 视图层不重写一遍（避免两份实现漂移）。
 *
 * 键盘：`⌘↵` 翻译、`⌘⇧C` 复制译文、`⌘1`–`⌘9` 复制第 n 种命名风格。
 * `Esc` **不消费**：交给 SDK 交还宿主，退回启动台搜索态（弹层打开时由 UiDialog 先接住）。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import AppShell from '@launcher/ui/AppShell.vue'
import UiDialog from '@launcher/ui/UiDialog.vue'
import UiIcon from '@launcher/ui/UiIcon.vue'
import UiSelect from '@launcher/ui/UiSelect.vue'
import { copyText, textFromDataTransfer } from '@launcher/ui/clipboard'
import { matchKey, modLabel } from '@launcher/ui/keys'
import { useToast } from '@launcher/ui/toast'
import { clipboard, exec, host, hostUi, storage } from '@launcher/api'

interface Option {
  value: string
  label: string
}

interface Variant {
  id: string
  label: string
  value: string
}

/** 一次成功翻译的快照（存插件 storage，跨会话保留） */
interface HistoryEntry {
  text: string
  translation: string
  providerTitle?: string
  direction?: string
  /** 当时的目标语言模式（auto / zh / en…），只用于去重键 */
  target: string
  at: number
}

const HISTORY_KEY = 'history'
const HISTORY_MAX = 50

interface TranslateReply {
  ok: boolean
  error?: string
  provider?: string
  providerTitle?: string
  target?: string
  direction?: string
  elapsedMs?: number
  text?: string
  translation?: string
  variants?: Variant[]
  configured?: boolean
  targets?: Option[]
  providers?: Option[]
}

const inLauncher = host.isLauncher()
const toast = useToast()

const source = ref('')
const target = ref('zh')
const provider = ref('auto')
const targetOptions = ref<Option[]>([{ value: 'zh', label: '中文' }])
const providerOptions = ref<Option[]>([{ value: 'auto', label: '自动' }])
const configured = ref(true)
const reply = ref<TranslateReply | null>(null)
const pending = ref(false)
const errorText = ref('')
const inputEl = ref<HTMLTextAreaElement | null>(null)
const history = ref<HistoryEntry[]>([])
const historyOpen = ref(false)
/** 当前展开了命名风格的那条历史（键见 historyKey）；null = 都收起 */
const expandedHistory = ref<string | null>(null)
/** 历史条目 → 九个命名风格变体（按需向逻辑层要，算好缓存住） */
const historyVariants = ref<Record<string, Variant[]>>({})

const variants = computed<Variant[]>(() => reply.value?.variants ?? [])
const targetLabel = computed(
  () => targetOptions.value.find((item) => item.value === target.value)?.label ?? target.value,
)
const metaLine = computed(() => {
  const data = reply.value
  if (!data?.translation) return ''
  const parts = [data.providerTitle, data.direction].filter(Boolean)
  if (data.elapsedMs) parts.push(`${data.elapsedMs}ms`)
  return parts.join(' · ')
})

/** 逻辑层调用：空 args = 问状态，带 text = 翻一次（返回译文 + 命名风格变体） */
async function call(args: Record<string, unknown>, timeoutMs = 9000): Promise<TranslateReply | null> {
  try {
    return (await exec.run({ command: 'translate', args, timeoutMs })) as TranslateReply
  } catch (err) {
    errorText.value = err instanceof Error ? err.message : '翻译不可用'
    return null
  }
}

async function translate(text = source.value): Promise<void> {
  const value = text.trim()
  if (!value || pending.value) return
  pending.value = true
  errorText.value = ''
  const data = await call({ text: value, target: target.value, provider: provider.value })
  pending.value = false
  if (!data) return
  if (!data.ok) {
    reply.value = null
    errorText.value = data.error ?? '翻译失败'
    return
  }
  reply.value = data
  // 逻辑层会把前缀触发词（`fy …`）剥掉，用它回填输入框，用户看到的就是真正的原文。
  // 只剩触发词时（比如从搜索框带进来一个"翻译"）逻辑层给空串 ⇒ 一并清空，
  // 否则输入框里留着一个没被翻译的词，看起来就像"点了没反应"。
  if (typeof data.text === 'string' && data.text !== source.value) source.value = data.text
  remember(data)
}

/** 记一条历史：同一段原文（+目标模式）只留最新的一条并置顶 */
function remember(data: TranslateReply): void {
  const text = (data.text ?? '').trim()
  const translation = (data.translation ?? '').trim()
  if (!text || !translation) return
  const mode = data.target ?? target.value
  const rest = history.value.filter((item) => !(item.text === text && item.target === mode))
  history.value = [
    {
      text,
      translation,
      providerTitle: data.providerTitle,
      direction: data.direction,
      target: mode,
      at: Date.now(),
    },
    ...rest,
  ].slice(0, HISTORY_MAX)
  saveHistory()
}

function saveHistory(): void {
  // storage 走 postMessage（结构化克隆）：先把 reactive 数组拍平成纯对象
  void storage.set(HISTORY_KEY, history.value.map((item) => ({ ...item }))).catch(() => undefined)
}

/** 点历史项 = 把原文放回输入框，按**当前**引擎 / 目标重新翻一次（用户可能已换过设置） */
function loadHistory(item: HistoryEntry): void {
  historyOpen.value = false
  source.value = item.text
  void translate(item.text)
}

function clearHistory(): void {
  history.value = []
  saveHistory()
  toast.ok('历史已清空')
}

/** 历史条目的键：同一时间戳的多条（理论上不会）也不撞 */
function historyKey(item: HistoryEntry, index: number): string {
  return `${item.at}:${index}`
}

/**
 * 展开 / 收起某条历史的九个命名风格。
 * 变体在逻辑层算（`variantsOnly`：不联网、不看凭据、不剥触发词），视图层不重写转换规则。
 */
async function toggleHistoryVariants(key: string, translation: string): Promise<void> {
  if (expandedHistory.value === key) {
    expandedHistory.value = null
    return
  }
  expandedHistory.value = key
  if (historyVariants.value[key]) return
  const data = await call({ text: translation, variantsOnly: true }, 4000)
  if (data?.variants) historyVariants.value = { ...historyVariants.value, [key]: data.variants }
}

/** 历史项的元信息行：方向 · 引擎 · 时间 */
function historyMeta(item: HistoryEntry): string {
  return [item.direction, item.providerTitle, formatTime(item.at)].filter(Boolean).join(' · ')
}

function formatTime(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** 读回来的历史先过一遍形状校验（文件被手改 / 旧版本残留都不该让页面崩） */
function sanitizeHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return []
  const out: HistoryEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Partial<HistoryEntry>
    if (typeof entry.text !== 'string' || typeof entry.translation !== 'string') continue
    out.push({
      text: entry.text,
      translation: entry.translation,
      providerTitle: typeof entry.providerTitle === 'string' ? entry.providerTitle : undefined,
      direction: typeof entry.direction === 'string' ? entry.direction : undefined,
      target: typeof entry.target === 'string' ? entry.target : 'auto',
      at: typeof entry.at === 'number' ? entry.at : 0,
    })
    if (out.length >= HISTORY_MAX) break
  }
  return out
}

async function copyValue(label: string, value: string): Promise<void> {
  if (!value) return
  let ok = false
  try {
    // 宿主剪贴板（能力 clipboard.write）最稳；不在宿主里时退回前端三级兜底
    await clipboard.writeText(value)
    ok = true
  } catch {
    ok = await copyText(value)
  }
  if (ok) toast.ok(`已复制 ${label}`)
  else toast.err('复制失败')
}

function clearAll(): void {
  source.value = ''
  reply.value = null
  errorText.value = ''
  inputEl.value?.focus()
}

function onKeydown(event: KeyboardEvent): void {
  if (matchKey(event, 'Mod+Enter')) {
    event.preventDefault()
    void translate()
    return
  }
  if (matchKey(event, 'Mod+Shift+C')) {
    event.preventDefault()
    void copyValue('译文', reply.value?.translation ?? '')
    return
  }
  // ⌘1–⌘9：第 n 种命名风格
  if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
    const chip = variants.value[Number(event.key) - 1]
    if (chip) {
      event.preventDefault()
      void copyValue(chip.label, chip.value)
    }
  }
}

/** 粘贴 = 替换全文并立刻翻译（这是最常用的入口） */
function onPaste(event: ClipboardEvent): void {
  if (!inLauncher) return
  const text = textFromDataTransfer(event.clipboardData).trim()
  if (!text) return
  event.preventDefault()
  source.value = text
  void translate(text)
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)

  if (!inLauncher) {
    // 降级：浏览器里只能看界面（宿主 API 一律 NOT_FOUND）
    configured.value = false
    return
  }

  hostUi
    .setFooter([
      { type: 'button', label: '翻译', icon: 'languages', keys: ['Mod+Enter'], onClick: () => void translate() },
      { type: 'button', label: '清空', icon: 'x', onClick: clearAll },
    ])
    .catch(() => undefined)

  const status = await call({}, 4000)
  if (status) {
    if (status.targets?.length) targetOptions.value = status.targets
    if (status.providers?.length) providerOptions.value = status.providers
    if (status.target) target.value = status.target
    if (status.provider) provider.value = status.provider
    configured.value = Boolean(status.configured)
  }
  // 上次用过的目标语言 / 引擎（本页记忆，不写设置 —— 设置页才是默认值的真源）
  const prefs = await storage.get<{ target?: string; provider?: string }>('panel-prefs').catch(() => null)
  if (prefs && typeof prefs === 'object') {
    if (typeof prefs.target === 'string') target.value = prefs.target
    if (typeof prefs.provider === 'string') provider.value = prefs.provider
  }
  // 历史翻译（跨会话保留，最近 50 条）
  history.value = sanitizeHistory(await storage.get<unknown>(HISTORY_KEY).catch(() => null))

  // 带原文进来的两条路：搜索列表的「翻译「…」」入口（会话 URL 的 `args`）优先，其次搜索框内容
  const argsText = (() => {
    try {
      const parsed = JSON.parse(new URLSearchParams(location.search).get('args') ?? '{}') as { text?: unknown }
      return typeof parsed.text === 'string' ? parsed.text : ''
    } catch {
      return ''
    }
  })()
  const seed = argsText.trim() || (await hostUi.getSearchContent().catch(() => '')).trim()
  if (seed) {
    source.value = seed
    void translate(seed)
  } else {
    inputEl.value?.focus()
  }
})

onUnmounted(() => window.removeEventListener('keydown', onKeydown))

watch([target, provider], () => {
  void storage
    .set('panel-prefs', { target: target.value, provider: provider.value })
    .catch(() => undefined)
  if (source.value.trim() && reply.value) void translate()
})
</script>

<template>
  <AppShell>
    <div class="flex h-full flex-col">
      <!-- 顶栏：标题 + 引擎/语言（改了就重译；下拉用 UiSelect，原生 select 的菜单是系统绘制的） -->
      <header class="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
        <UiIcon name="languages" :size="15" class="text-accent" />
        <span class="text-[13px] font-semibold">聚合翻译</span>
        <span class="launcher-chip">{{ configured ? metaLine || targetLabel : '未配置 API' }}</span>
        <span class="flex-1" />
        <button
          class="launcher-btn ghost"
          :title="history.length ? `历史翻译（${history.length}）` : '历史翻译'"
          @click="historyOpen = true"
        >
          <UiIcon name="history" :size="14" />
          历史
          <span v-if="history.length" class="launcher-chip">{{ history.length }}</span>
        </button>
        <div class="w-[160px]">
          <UiSelect v-model="target" :options="targetOptions" />
        </div>
        <div class="w-[176px]">
          <UiSelect v-model="provider" :options="providerOptions" />
        </div>
      </header>

      <div class="launcher-scroll min-h-0 flex-1 px-4 py-3">
        <!-- 输入 -->
        <section class="overflow-hidden rounded-xl border border-line bg-panel">
          <textarea
            ref="inputEl"
            v-model="source"
            class="tr-input launcher-scroll"
            spellcheck="false"
            placeholder="粘贴或输入要翻译的文本（选中文本按热键唤出启动台也能带进来）"
            @paste="onPaste"
          />
          <div class="flex items-center gap-2 border-t border-line px-2.5 py-1.5">
            <span class="text-[11px] text-faint">{{ source.length }} 字</span>
            <span class="flex-1" />
            <button
              class="launcher-btn ghost"
              :disabled="!source.trim()"
              @click="copyValue('原文', source)"
            >
              <UiIcon name="copy" :size="14" />
              复制原文
            </button>
            <button class="launcher-btn primary" :disabled="pending || !source.trim()" @click="translate()">
              <UiIcon name="languages" :size="14" :class="{ 'animate-spin': pending }" />
              {{ pending ? '翻译中…' : '翻译' }}
              <span class="launcher-kbd">{{ modLabel }}↵</span>
            </button>
          </div>
        </section>

        <!-- 出错 / 未配置 -->
        <section v-if="errorText" class="tr-notice mt-3 rounded-xl px-3 py-2.5 text-[12.5px]">
          {{ errorText }}
        </section>

        <!-- 译文 -->
        <section v-if="reply?.translation" class="mt-3 rounded-xl border border-line bg-panel px-3.5 py-3">
          <div class="mb-2 flex items-center gap-2">
            <span class="text-[11.5px] text-muted">{{ metaLine }}</span>
            <span class="flex-1" />
            <button class="launcher-btn" @click="copyValue('译文', reply.translation)">
              <UiIcon name="copy" :size="14" />
              复制译文
              <span class="launcher-kbd">{{ modLabel }}⇧C</span>
            </button>
          </div>
          <p class="tr-output">{{ reply.translation }}</p>

          <!-- 多种复制方式：命名风格（⌘1–⌘9 直接复制） -->
          <template v-if="variants.length">
            <div class="launcher-divider my-3" />
            <div class="mb-2 flex items-center gap-2">
              <span class="text-[11.5px] text-muted">按命名风格复制</span>
              <span class="launcher-chip">{{ modLabel }}1 – {{ modLabel }}9</span>
            </div>
            <div class="grid grid-cols-2 gap-1.5">
              <button
                v-for="(variant, index) in variants"
                :key="variant.id"
                class="tr-variant"
                :title="variant.value"
                @click="copyValue(variant.label, variant.value)"
              >
                <span class="launcher-kbd">{{ index + 1 }}</span>
                <span class="tr-variant-label">{{ variant.label }}</span>
                <span class="tr-variant-value">{{ variant.value || '—' }}</span>
              </button>
            </div>
          </template>
        </section>

        <!-- 空态 -->
        <section v-if="!reply?.translation && !errorText" class="tr-hint mt-3 rounded-xl px-3.5 py-3 text-[12.5px]">
          <template v-if="!inLauncher">
            当前不在启动台中运行：这里只显示界面。翻译需要宿主（启动台里的插件页有完整能力）。
          </template>
          <template v-else-if="!configured">
            <p class="mb-1 font-semibold text-fg">还没配置翻译 API</p>
            <p>打开「设置 → 插件 → 聚合翻译」，填一家的凭据即可（都有免费额度）：</p>
            <p class="mt-1">· 有道智云：AppKey + AppSecret</p>
            <p>· 百度翻译开放平台：AppID + 密钥</p>
            <p class="mt-1 text-faint">
              百度的通用文本翻译与大模型文本翻译共用同一对凭据，大模型服务需先在控制台单独开通。
            </p>
          </template>
          <template v-else>
            粘贴或输入文本，按 <span class="launcher-kbd">{{ modLabel }}↵</span> 翻译；
            粘贴会自动翻译，译文可以按 camelCase / snake_case 等九种风格直接复制。
            <p class="mt-1">
              搜索列表里的「翻译「…」」条目就是这一页的入口：选中文本按热键唤出启动台，
              点那条入口，原文会自动带进来并翻译。
            </p>
          </template>
        </section>
      </div>
    </div>

    <!-- 历史翻译：点击一条 = 原文回填输入框并按当前引擎 / 目标重译 -->
    <UiDialog
      v-if="historyOpen"
      title="历史翻译"
      :subtitle="`最近 ${HISTORY_MAX} 次成功翻译，点一条重新翻；同一段原文只留最新`"
      size="wide"
      @close="historyOpen = false"
    >
      <div v-if="!history.length" class="tr-hint rounded-xl px-3.5 py-3 text-[12.5px]">
        还没有翻译记录。翻过一次之后，原文与译文会留在这里（本机保存，最多 {{ HISTORY_MAX }} 条）。
      </div>
      <div v-else class="flex flex-col gap-1.5">
        <div v-for="(item, index) in history" :key="historyKey(item, index)" class="tr-history-item">
          <div class="tr-history-main">
            <button class="tr-history" :title="`重新翻译「${item.text}」`" @click="loadHistory(item)">
              <span class="tr-history-text">{{ item.text }}</span>
              <span class="tr-history-trans">{{ item.translation }}</span>
              <span class="tr-history-meta">{{ historyMeta(item) }}</span>
            </button>
            <div class="tr-history-actions">
              <button class="launcher-btn ghost" title="复制译文" @click="copyValue('译文', item.translation)">
                <UiIcon name="copy" :size="13" />
              </button>
              <button
                class="launcher-btn ghost"
                :title="expandedHistory === historyKey(item, index) ? '收起命名风格' : '按命名风格复制'"
                @click="toggleHistoryVariants(historyKey(item, index), item.translation)"
              >
                <UiIcon name="braces" :size="13" />
              </button>
            </div>
          </div>

          <!-- 展开的九种命名风格：点一个即复制该风格的值 -->
          <div v-if="expandedHistory === historyKey(item, index)" class="tr-history-variants">
            <template v-if="historyVariants[historyKey(item, index)]">
              <button
                v-for="variant in historyVariants[historyKey(item, index)]"
                :key="variant.id"
                class="tr-variant"
                :title="variant.value"
                @click="copyValue(variant.label, variant.value)"
              >
                <span class="tr-variant-label">{{ variant.label }}</span>
                <span class="tr-variant-value">{{ variant.value || '—' }}</span>
              </button>
            </template>
            <p v-else class="col-span-2 text-[11.5px] text-faint">正在计算命名风格…</p>
          </div>
        </div>
      </div>

      <template #footer>
        <span class="text-[11.5px] text-faint">{{ history.length }} / {{ HISTORY_MAX }}</span>
        <span class="flex-1" />
        <button class="launcher-btn ghost" :disabled="!history.length" @click="clearHistory">
          <UiIcon name="trash" :size="14" />
          清空历史
        </button>
        <button class="launcher-btn" @click="historyOpen = false">关闭</button>
      </template>
    </UiDialog>
  </AppShell>
</template>
