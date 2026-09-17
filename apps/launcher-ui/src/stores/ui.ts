import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '../lib/api'
import type { ResultGroup } from '../lib/grid'
import type { RankedResult } from '../lib/types'

export interface PluginViewState {
  sid: string
  url: string
  pluginId: string
  command: string
  title: string
}

export interface FooterButtonView {
  type: 'button' | 'action-panel'
  id: string
  label: string
  icon?: string
  keys?: string[]
  title?: string
  items?: Array<{ id: string; name: string; icon?: string }>
}

export const useUiStore = defineStore('ui', () => {
  const query = ref('')
  /** 扁平条目下标（跨分区连续，与网格行模型解耦） */
  const selected = ref(0)
  /** 分区折叠状态：默认只露「一行/两行」格子，展开后全显示 */
  const expandedGroups = ref<Record<ResultGroup, boolean>>({ pinned: false, best: false, recent: false, plugins: false })
  const detailOpen = ref(false)
  const actionsOpen = ref(false)
  const actionsAnchor = ref<{ x: number; y: number }>({ x: 0, y: 0 })
  const pluginView = ref<PluginViewState | null>(null)
  const footer = ref<FooterButtonView[]>([])
  const pluginLoading = ref(false)
  const toast = ref<string | null>(null)

  const inPluginView = computed(() => pluginView.value !== null)

  function setQuery(value: string): void {
    query.value = value
    selected.value = 0
    detailOpen.value = false
    expandedGroups.value = { pinned: false, best: false, recent: false, plugins: false }
    if (pluginView.value) closePluginView()
  }

  function toggleGroup(group: ResultGroup): void {
    expandedGroups.value[group] = !expandedGroups.value[group]
  }

  function openPluginView(state: PluginViewState): void {
    pluginView.value = state
    pluginLoading.value = true
    footer.value = []
  }

  function closePluginView(): void {
    const current = pluginView.value
    pluginView.value = null
    footer.value = []
    pluginLoading.value = false
    if (current) void api.closeSession(current.sid).catch(() => undefined)
  }

  function showToast(message: string): void {
    toast.value = message
    window.setTimeout(() => {
      if (toast.value === message) toast.value = null
    }, 2000)
  }

  function clampSelection(itemCount: number): void {
    if (itemCount <= 0) {
      selected.value = 0
      return
    }
    if (selected.value < 0) selected.value = 0
    if (selected.value >= itemCount) selected.value = itemCount - 1
  }

  function pinPayload(result: RankedResult, key: string): Record<string, unknown> {
    return {
      key,
      pluginId: result.pluginId,
      command: result.command,
      title: result.item.title,
      ...(result.item.subtitle ? { subtitle: result.item.subtitle } : {}),
      ...(result.item.icon ? { icon: result.item.icon } : {}),
      ...(result.item.action && result.item.action.type === 'command' ? { args: result.item.action.args } : {}),
      // 结果项动作快照：非 command 结果项（应用 / 文件 / 网址）全靠它才能再次执行
      ...(result.item.action ? { action: result.item.action } : {}),
    }
  }

  return {
    query,
    selected,
    expandedGroups,
    detailOpen,
    actionsOpen,
    actionsAnchor,
    pluginView,
    footer,
    pluginLoading,
    toast,
    inPluginView,
    setQuery,
    toggleGroup,
    openPluginView,
    closePluginView,
    showToast,
    clampSelection,
    pinPayload,
  }
})
