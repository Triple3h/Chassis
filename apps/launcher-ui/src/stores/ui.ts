import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../lib/api'
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
  /** 扁平行索引（跨分组连续） */
  const selected = ref(0)
  const expandedPinned = ref(false)
  const expandedRecent = ref(false)
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
    if (pluginView.value) closePluginView()
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

  function clampSelection(rowCount: number): void {
    if (rowCount <= 0) {
      selected.value = 0
      return
    }
    if (selected.value < 0) selected.value = 0
    if (selected.value >= rowCount) selected.value = rowCount - 1
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
    }
  }

  return {
    query,
    selected,
    expandedPinned,
    expandedRecent,
    detailOpen,
    actionsOpen,
    actionsAnchor,
    pluginView,
    footer,
    pluginLoading,
    toast,
    inPluginView,
    setQuery,
    openPluginView,
    closePluginView,
    showToast,
    clampSelection,
    pinPayload,
  }
})
