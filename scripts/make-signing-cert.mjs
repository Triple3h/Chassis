#!/usr/bin/env node
/**
 * 创建（或复用）本机自签名「代码签名」证书，供 scripts/pack-local-app.mjs 给 Chassis.app 签名。
 *
 * 为什么不用 ad-hoc（`codesign --sign -`）：
 *   ad-hoc 签名的身份 = 二进制哈希（cdhash），每次重新打包都变 ⇒ macOS 的 TCC 授权
 *   （辅助功能 / 屏幕录制 / 通知 / 自动化）对不上旧记录，表现为「明明授权过，换包后又弹」。
 *   用固定证书签名后，TCC 认的是「bundle id + 证书」，跨重新打包稳定，一次授权长期有效。
 *
 * 用法：node scripts/make-signing-cert.mjs [--force]
 *   过程中会出现两次授权交互：
 *     1) 本脚本里「security 想要修改证书信任设置」→ 输入登录密码 / Touch ID
 *     2) 下一次打包签名时「codesign 想要使用密钥」→ 选「始终允许」（一次即可）
 *   --force  已有同名证书时也重建（会生成新身份 ⇒ TCC 授权需要重新给一次）
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CN = 'Chassis Local Signing'
const KEYCHAIN = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db')
const force = process.argv.includes('--force')

const line = (text) => process.stdout.write(`${text}\n`)

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts })
}

function findIdentity() {
  try {
    const out = run('security', ['find-identity', '-v', '-p', 'codesigning'])
    const match = out.match(new RegExp(`"([^"]*${CN}[^"]*)"`))
    return match ? match[1] : null
  } catch {
    return null
  }
}

const existing = findIdentity()
if (existing && !force) {
  line(`✓ 已有可用签名身份：${existing}`)
  line('  （要重建就加 --force —— 注意重建等于换身份，TCC 授权要重新给一次）')
  process.exit(0)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chassis-signing-'))
const cnf = path.join(tmp, 'openssl.cnf')
const key = path.join(tmp, 'key.pem')
const crt = path.join(tmp, 'cert.pem')

try {
  // 系统自带 openssl 是 LibreSSL，不认 `-addext`（OpenSSL 1.1.1+ 的写法），用配置文件
  fs.writeFileSync(
    cnf,
    `[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_codesign

[dn]
CN = ${CN}
O = Chassis

[v3_codesign]
basicConstraints = critical,CA:true
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
`,
  )

  line('▶ 生成自签名证书（有效期 10 年）')
  run(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '3650', '-config', cnf, '-extensions', 'v3_codesign'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )

  // 不用 p12：LibreSSL 导出的 p12（无论 3DES 还是 AES、空密码还是带密码）在 macOS 上
  // 一律报 `MAC verification failed during PKCS12 import`。分开导入 PEM 最稳，也最简。
  line('▶ 导入登录钥匙串（预授权给 codesign，避免每次签名弹访问密钥的框）')
  run('security', ['import', crt, '-k', KEYCHAIN, '-T', '/usr/bin/codesign'])
  run('security', ['import', key, '-k', KEYCHAIN, '-T', '/usr/bin/codesign'])

  line('▶ 设置信任为「代码签名」根（会弹系统授权框：输入登录密码 / Touch ID）')
  run('security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', '-k', KEYCHAIN, crt])
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

const identity = findIdentity()
if (identity) {
  line('')
  line(`✓ 完成：${identity}`)
  line('  下一步：node scripts/pack-local-app.mjs（打包会自动改用这个身份签名）')
  line('  注意：从 ad-hoc 换成证书后，系统设置里的旧授权条目要删掉、重新授权一次')
} else {
  line('')
  line('✗ 证书生成了但没被认可（信任设置可能没生效）')
  line('  兜底：改用「钥匙串访问 → 证书助理 → 创建证书」手动创建 ——')
  line(`  名称填 "${CN}"，身份类型选「自签名根证书」，证书类型选「代码签名」`)
  process.exit(1)
}
