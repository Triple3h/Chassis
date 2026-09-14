import type { AuditLog } from '../audit'
import type { EventBus } from '../events'
import { audited } from './audited'
import type { FooterButton, HostUiService } from './types'

export interface UiState {
  /** 启动台搜索框当前内容（UI 每次输入同步过来） */
  searchContent: string
  theme: 'light' | 'dark'
}

/** 宿主 UI 桥：读写搜索框、footer、隐藏窗口（requirements §8.6 / plugin-spec §7.2） */
export class HostUiBridge {
  readonly state: UiState = { searchContent: '', theme: 'dark' }

  constructor(
    private readonly bus: EventBus,
    private readonly audit: AuditLog,
    private readonly hide: () => Promise<void>,
  ) {}

  setQuery(query: string): void {
    this.state.searchContent = query
  }

  serviceFor(pluginId: string, sid: string): HostUiService {
    return {
      getSearchContent: async () =>
        audited(this.audit, { pluginId, channel: 'ui' }, 'ctx.hostUi.getSearchContent', 'hostUi', undefined, async () => this.state.searchContent),
      setSearchContent: async (value: string) =>
        audited(this.audit, { pluginId, channel: 'ui' }, 'ctx.hostUi.setSearchContent', 'hostUi', { value }, async () => {
          this.state.searchContent = String(value ?? '')
          this.bus.emit('ui/searchContent', { value: this.state.searchContent, sid })
          return true
        }),
      clearSearchContent: async () =>
        audited(this.audit, { pluginId, channel: 'ui' }, 'ctx.hostUi.clearSearchContent', 'hostUi', undefined, async () => {
          this.state.searchContent = ''
          this.bus.emit('ui/searchContent', { value: '', sid })
          return true
        }),
      setFooter: async (buttons: FooterButton[]) =>
        audited(this.audit, { pluginId, channel: 'ui' }, 'ctx.hostUi.setFooter', 'hostUi', { buttons }, async () => {
          this.bus.emit('ui/footer', { sid, buttons })
          return true
        }),
      hide: async () =>
        audited(this.audit, { pluginId, channel: 'ui' }, 'ctx.hostUi.hide', 'hostUi', undefined, async () => {
          this.bus.emit('ui/hide', { sid })
          await this.hide()
        }),
    }
  }
}
