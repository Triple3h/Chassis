import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Config, HistoryItem, PinnedItem, PluginRuntimeInfo } from '@launcher/plugin-manifest'
import { api, type BootstrapData } from '../lib/api'
import type { RankedResult, SearchResponse } from '../lib/types'

export const useDataStore = defineStore('data', () => {
  const bootstrap = ref<BootstrapData | null>(null)
  const config = ref<Config | null>(null)
  const plugins = ref<PluginRuntimeInfo[]>([])
  const commands = ref<BootstrapData['snapshot']['commands']>([])
  const pinned = ref<PinnedItem[]>([])
  const recent = ref<HistoryItem[]>([])
  const response = ref<SearchResponse | null>(null)
  const searching = ref(false)
  const connected = ref(false)
  const hotkeyIssue = ref<{ accelerator: string; reason?: string } | null>(null)

  let searchSeq = 0
  let debounceTimer: number | null = null
  let lastQuery = ''

  const results = computed<RankedResult[]>(() => response.value?.groups.best ?? [])
  const pinnedResults = computed<RankedResult[]>(() => response.value?.groups.pinned ?? [])
  const recentResults = computed<RankedResult[]>(() => response.value?.groups.recent ?? [])
  /** 空输入首页的「已安装插件」入口（内核按最近打开倒序排好） */
  const pluginResults = computed<RankedResult[]>(() => response.value?.groups.plugins ?? [])

  async function init(): Promise<void> {
    const data = await api.bootstrap()
    bootstrap.value = data
    config.value = data.config
    plugins.value = data.plugins
    commands.value = data.snapshot.commands
    pinned.value = data.snapshot.pinned as PinnedItem[]
    recent.value = data.snapshot.recent as HistoryItem[]
  }

  async function loadConfig(): Promise<void> {
    const data = await api.bootstrap()
    const cfg = data.config
    config.value = cfg
    plugins.value = data.plugins
    commands.value = data.snapshot.commands
    pinned.value = data.snapshot.pinned as PinnedItem[]
    recent.value = data.snapshot.recent as HistoryItem[]
  }

  async function refreshLists(): Promise<void> {
    const data = await api.history()
    pinned.value = data.pinned as PinnedItem[]
    recent.value = data.items as HistoryItem[]
  }

  /** 输入（debounce 80ms，requirements §7.6） */
  function scheduleSearch(query: string): void {
    lastQuery = query
    if (debounceTimer) window.clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(() => {
      void runSearch(lastQuery)
    }, 80)
  }

  async function runSearch(query: string, attempt = 0): Promise<void> {
    const seq = ++searchSeq
    searching.value = true
    try {
      const data = await api.search(query)
      if (seq !== searchSeq) return // 丢弃过期响应
      response.value = data
    } catch {
      // 内核未就绪 / 请求被打断时保持旧结果（不闪空白），但**必须重试一次**：
      // 一次性失败留在界面上的就是「query 与 response 不匹配」（空输入却显示上次查询的结果，
      // 表现为空态），而它不会自愈 —— 用户只能自己敲一下输入框。
      if (attempt < 1 && seq === searchSeq) {
        window.setTimeout(() => {
          if (seq === searchSeq) void runSearch(query, attempt + 1)
        }, 200)
      }
    } finally {
      if (seq === searchSeq) searching.value = false
    }
  }

  /** SSE 事件 → 数据刷新（由 App.vue 统一订阅后分发） */
  function handleEvent(event: string, payload: unknown): void {
    if (event === 'registry/changed' || event === 'plugin/state') {
      void loadConfig().catch(() => undefined)
      void runSearch(lastQuery).catch(() => undefined)
    } else if (event === 'config/changed') {
      // 设置页改外观时走这条：payload 直接带新配置，不必再往返一次 /api/bootstrap
      const cfg = (payload as { config?: Config } | null)?.config
      if (cfg) config.value = cfg
    } else if (event === 'history/changed' || event === 'pinned/changed') {
      void refreshLists().catch(() => undefined)
      void runSearch(lastQuery).catch(() => undefined)
    } else if (event === 'search/results') {
      const data = payload as SearchResponse
      if (data && typeof data.token === 'number' && data.token >= (response.value?.token ?? 0)) {
        response.value = data
      }
    }
  }

  return {
    bootstrap,
    config,
    plugins,
    commands,
    pinned,
    recent,
    response,
    searching,
    connected,
    hotkeyIssue,
    results,
    pinnedResults,
    recentResults,
    pluginResults,
    init,
    loadConfig,
    refreshLists,
    scheduleSearch,
    runSearch,
    handleEvent,
    get lastQuery() {
      return lastQuery
    },
  }
})
