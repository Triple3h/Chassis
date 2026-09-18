/**
 * 能力清单（唯一真源）。
 * 新增能力只能是 minor 变更：内核能力表、SDK、文档三处一起改（plugin-spec §8）。
 */

export const CAPABILITIES = [
  'hostUi',
  'storage',
  'clipboard.read',
  'clipboard.write',
  'clipboard.watch',
  'shell.open',
  'exec.spawn',
  'notify.show',
  'screenshot',
  'quicklink',
] as const

export type Capability = (typeof CAPABILITIES)[number]

const CAPABILITY_SET: ReadonlySet<string> = new Set(CAPABILITIES)

export function isKnownCapability(name: string): name is Capability {
  return CAPABILITY_SET.has(name)
}

/** 安装时需要向用户展示并可由用户拒绝的高风险能力（plugin-spec §8 规则 3） */
export const HIGH_RISK_CAPABILITIES: ReadonlySet<string> = new Set([
  'exec.spawn',
  'clipboard.read',
  'clipboard.watch',
  'shell.open',
  'screenshot',
])

/** 服务名 → 所需能力（内核装配期裁剪用，也用于审计里的 capability 字段） */
export const SERVICE_CAPABILITY: Readonly<Record<string, Capability>> = {
  storage: 'storage',
  hostUi: 'hostUi',
  clipboard: 'clipboard.write',
  shell: 'shell.open',
  exec: 'exec.spawn',
  notify: 'notify.show',
  screenshot: 'screenshot',
  quicklink: 'quicklink',
}
