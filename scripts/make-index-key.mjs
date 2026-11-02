#!/usr/bin/env node
/**
 * 生成 npm 索引签名密钥（ed25519）。
 *
 * 用法：node scripts/make-index-key.mjs
 *
 * 输出三行：
 *   INDEX_SIGNING_KEY=…  私钥（base64 PKCS#8）→ GitHub secret，只存 CI
 *   INDEX_PUBKEY=…       公钥（base64 原始 32 字节）→ 编译进 internal-store（客户端验签）
 *   INDEX_KEY_ID=…       公钥指纹前缀，写进索引封装，便于轮换
 *
 * 私钥只打印这一次；丢了就换新密钥（客户端要同步更新公钥），不要提交进仓库。
 * 为什么 npm 通道必须签名：索引是信任根，npm/npmmirror 是第三方通道，
 * 「GitHub + TLS」的前提不再成立 —— 见 docs/plugin-spec.md 附录 C。
 */
import crypto from 'node:crypto'

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' })
const spki = publicKey.export({ format: 'der', type: 'spki' })
const raw = spki.subarray(spki.length - 32)
const keyId = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)

console.log('# 私钥：存成 GitHub secret INDEX_SIGNING_KEY（不要进仓库）')
console.log(`INDEX_SIGNING_KEY=${pkcs8.toString('base64')}`)
console.log('# 公钥：阶段二贴进 plugins/internal-store/src/lib.rs')
console.log(`INDEX_PUBKEY=${raw.toString('base64')}`)
console.log(`INDEX_KEY_ID=${keyId}`)
