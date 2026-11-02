/**
 * npm 更新通道的纯逻辑：包名 / tarball URL / artifact manifest / 索引改写 / 签名。
 *
 * 网络与 `npm` 调用在 `scripts/publish-npm.mjs` —— 这里不碰磁盘和网络，便于单测。
 * 通道约定见 `docs/release-channels.md` §7；索引封装见 `docs/plugin-spec.md` 附录 C。
 */
import crypto from 'node:crypto'

export const CHANNELS = ['app', 'kernel', 'plugins']

/** 发布账号的 scope（token 也只授权这个 scope）。 */
export const NPM_SCOPE = '@triple3h'

/** 客户端读取源：npmmirror 是只读镜像，发布永远去 npmjs。 */
export const NPM_READ_BASE = 'https://registry.npmmirror.com'
export const NPM_PUBLISH_REGISTRY = 'https://registry.npmjs.org'

const SEMVER = /^\d+\.\d+\.\d+$/

/**
 * 一个可下载单元一个包：
 *   app / kernel → 按平台拆（避免为装一个平台下两个平台的包）
 *   plugins      → 按插件拆（包内含该插件的各平台 zip）
 */
export function artifactPackageName(channel, target = {}) {
  if (channel === 'app' || channel === 'kernel') {
    const { platform, arch } = target
    if (!platform || !arch) throw new Error(`${channel} 包需要 platform + arch`)
    return `${NPM_SCOPE}/chassis-${channel}-${platform}-${arch}`
  }
  if (channel === 'plugins') {
    const { pluginId } = target
    if (!pluginId) throw new Error('插件包需要 pluginId')
    return `${NPM_SCOPE}/chassis-plugin-${pluginId}`
  }
  throw new Error(`未知通道：${channel}`)
}

/** 三条通道各一个索引包（互不发同一个 package，避免跨通道合并/竞争）。 */
export function indexPackageName(channel) {
  if (!CHANNELS.includes(channel)) throw new Error(`未知通道：${channel}`)
  return `${NPM_SCOPE}/chassis-index-${channel}`
}

/** scoped 包的 tarball 文件名不带 scope（`@types/node` → `node-1.2.3.tgz`）。 */
export function packageBasename(packageName) {
  const slash = packageName.indexOf('/')
  return slash >= 0 ? packageName.slice(slash + 1) : packageName
}

/** 客户端实际下载的地址（npmmirror 会 302 到 cdn.npmmirror.com）。 */
export function tarballUrl(packageName, version, base = NPM_READ_BASE) {
  return `${base}/${packageName}/-/${packageBasename(packageName)}-${version}.tgz`
}

/**
 * 索引包自身版本：`0.<yyyymmdd>.<epoch 秒>`。
 * 与产物版本无关 —— 客户端只读 `chassis.registry`，不比较它。
 */
export function indexVersion(date = new Date()) {
  const yyyymmdd = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(
    date.getUTCDate(),
  ).padStart(2, '0')}`
  return `0.${yyyymmdd}.${Math.floor(date.getTime() / 1000)}`
}

export function assetFileName(asset) {
  const pathname = new URL(asset.url).pathname
  return decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1))
}

/**
 * 把 GitHub 版索引改写成 npm 版：
 *   - `url` → npmmirror tarball，`format: 'tgz'`，`entry` = 包内 zip 名；
 *   - 原 GitHub URL 放进 `mirrors`（客户端后续版本可作兜底，旧客户端忽略未知字段）；
 *   - `sha256` / `bytes` / 门槛 / notes 全部原样保留（zip 的校验值不变）。
 *
 * 返回改写后的索引与「本次索引涉及的全部包」（含没有本地产物的包 —— 索引必须覆盖全量）。
 */
export function planRegistryForNpm(channel, registry) {
  const out = structuredClone(registry)
  const packages = new Map()

  const add = (packageName, version, asset, extra = {}) => {
    if (!SEMVER.test(version ?? '')) throw new Error(`${packageName} 的版本不是 semver：${version}`)
    const file = assetFileName(asset)
    if (!file.endsWith('.zip')) throw new Error(`资产不是 zip：${asset.url}`)
    const current = packages.get(packageName) ?? { packageName, version, assets: [] }
    if (current.version !== version) {
      throw new Error(`${packageName} 版本不一致：${current.version} vs ${version}`)
    }
    const original = asset.url
    asset.url = tarballUrl(packageName, version)
    asset.format = 'tgz'
    asset.entry = file
    asset.mirrors = [original]
    current.assets.push({ ...extra, file })
    packages.set(packageName, current)
  }

  if (channel === 'app' || channel === 'kernel') {
    const entry = out[channel]
    if (!entry?.version) throw new Error(`索引里没有 ${channel}.version`)
    for (const asset of entry.assets ?? []) {
      const platform = (asset.platforms ?? [])[0]
      const arch = (asset.arch ?? [])[0]
      if (!platform || !arch) throw new Error(`${channel} 资产缺少 platforms / arch`)
      add(artifactPackageName(channel, { platform, arch }), entry.version, asset, { platform, arch })
    }
    if (!entry.assets?.length) throw new Error(`索引里没有 ${channel} 资产`)
  } else {
    for (const [pluginId, entry] of Object.entries(out.plugins ?? {})) {
      for (const asset of entry.assets ?? []) {
        add(artifactPackageName('plugins', { pluginId }), entry.version, asset, { pluginId })
      }
    }
    if (!Object.keys(out.plugins ?? {}).length) throw new Error('插件索引里没有任何插件')
  }

  return { registry: out, packages: [...packages.values()] }
}

export function buildArtifactManifest({ channel, packageName, version, platform, arch }) {
  const manifest = {
    name: packageName,
    version,
    description: `Chassis ${channel} 更新产物（npm 通道）`,
    license: 'MIT',
    files: ['*.zip'],
    publishConfig: { access: 'public' },
  }
  // npm 的平台标记：macos → darwin，windows → win32；插件包含多平台，不标。
  if (platform && arch) {
    manifest.os = [platform === 'macos' ? 'darwin' : 'win32']
    manifest.cpu = [arch]
  }
  return manifest
}

export function buildIndexManifest({ channel, version, registryText, signature, keyId }) {
  return {
    name: indexPackageName(channel),
    version,
    description: `Chassis ${channel} 更新索引（npm 通道；客户端只读 registry.npmmirror.com）`,
    license: 'MIT',
    chassis: { registry: registryText, sig: signature, keyId },
    publishConfig: { access: 'public' },
  }
}

/** `INDEX_SIGNING_KEY` = ed25519 私钥的 base64（PKCS#8 DER）。 */
export function loadSigningKey(base64) {
  const text = String(base64 ?? '').trim()
  if (!text) throw new Error('缺少 INDEX_SIGNING_KEY（ed25519 私钥，base64 PKCS#8）')
  const key = crypto.createPrivateKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'pkcs8' })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('INDEX_SIGNING_KEY 必须是 ed25519 私钥')
  return key
}

/** 签名对象是 `chassis.registry` 的**原文**（不做 JSON 规范化，避免两端序列化差异）。 */
export function signRegistry(registryText, privateKey) {
  const sig = crypto.sign(null, Buffer.from(registryText, 'utf8'), privateKey)
  const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  const raw = spki.subarray(spki.length - 32)
  const keyId = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
  return { sig: sig.toString('base64'), keyId, publicKey: raw.toString('base64') }
}
