/**
 * 发布 tag 约定（docs/release-channels.md §1）：
 *
 *   kernel/<x.y.z>              内核
 *   app/<x.y.z>                 App 自更新
 *   plugins/<id>/<x.y.z>        单个插件（增量发布）
 *   plugins/all[/<label>]       全部非 essential 插件
 *
 * 客户端只认固定 tag（kernel-latest / plugins-latest / app-latest）；
 * 这些一次性 tag 只负责触发 workflow。
 */
const SEMVER = /^\d+\.\d+\.\d+$/
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*$/

export function parseReleaseTag(ref) {
  const parts = String(ref ?? '').split('/')
  if (parts[0] === 'kernel' || parts[0] === 'app') {
    if (parts.length !== 2 || !SEMVER.test(parts[1])) {
      return { error: `${parts[0]} tag 必须写成 ${parts[0]}/<x.y.z>` }
    }
    return { channel: parts[0], version: parts[1], plugins: null }
  }
  if (parts[0] === 'plugins') {
    if (parts[1] === 'all') return { channel: 'plugins', version: parts[2] ?? null, plugins: [] }
    if (parts.length !== 3 || !SEMVER.test(parts[2])) {
      return { error: '插件 tag 必须写成 plugins/<id>/<x.y.z>（或 plugins/all[/<label>]）' }
    }
    if (!PLUGIN_ID.test(parts[1])) return { error: `插件 id 不合法：${parts[1]}` }
    return { channel: 'plugins', version: parts[2], plugins: [parts[1]] }
  }
  return { error: `未知发布 tag：${ref || '(空)'}（只认 kernel/*、app/*、plugins/*）` }
}

export function tagFor(channel, version, pluginId = '') {
  if (channel === 'kernel' || channel === 'app') return `${channel}/${version}`
  return `plugins/${pluginId}/${version}`
}
