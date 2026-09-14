/**
 * 插件页调用信封的去重。
 *
 * 背景：`@launcher/api` 为了兼容旧宿主，每次调用会发**两条** postMessage ——
 * 原生信封（`__launcher: 1`）和平铺旧桥信封（去掉 `ctx.` 前缀的 method，同一个 id）。
 * 底座 UI 两条都会收到，也都转发了：结果是每次调用都多打一次 /api/bridge，
 * 而平铺那条的 method（如 `hostUi.getSearchContent`）内核并不认识 ⇒ 必然 NOT_FOUND，
 * 审计里凭空多出一条失败记录。
 *
 * 裁决规则：**原生信封是唯一裁决者**，随后到达的同 id 平铺副本直接丢弃。
 * 只发平铺的插件（不经过这个 SDK 的老插件）不受影响 —— 它没有原生信封，永远不会被去重。
 */

/** 记住多少个「已见过的原生 id」；超了按先进先出淘汰（一次调用只有两条消息，200 足够宽松） */
const DEFAULT_LIMIT = 200

export interface CallDedupe {
  /** 返回 true = 这条平铺旧桥调用是重复的，应当丢弃 */
  isDuplicate(id: number, isNative: boolean): boolean
}

export function createCallDedupe(limit = DEFAULT_LIMIT): CallDedupe {
  const seen = new Set<number>()
  const order: number[] = []

  return {
    isDuplicate(id: number, isNative: boolean): boolean {
      if (isNative) {
        if (!seen.has(id)) {
          seen.add(id)
          order.push(id)
          if (order.length > limit) {
            const oldest = order.shift()
            if (oldest !== undefined) seen.delete(oldest)
          }
        }
        return false
      }
      return seen.has(id)
    },
  }
}
