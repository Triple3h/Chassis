#!/usr/bin/env node
/**
 * 把本机固定签名证书导出成 p12（base64）—— 一次性配置 GitHub Secrets，
 * 让 CI 用**同一签名身份**签 App 包。
 *
 * 为什么必须同一身份：macOS 的 TCC 授权（辅助功能 / 屏幕录制 / 自动化 / 通知）按代码签名身份记账。
 * CI 默认的 ad-hoc 签名身份 = 二进制哈希，每次构建都变 ⇒ 客户端每次自更新后授权全部失配重弹。
 * 把 `Chassis Local Signing` 导入 CI（本脚本导出 → GitHub Secrets）后，自更新对授权是透明的。
 *
 * 用法：
 *   node scripts/export-signing-cert.mjs [--out <文件>] [--password <导出密码>]
 *
 * 之后：
 *   gh secret set MACOS_SIGN_P12 < <out>.base64
 *   gh secret set MACOS_SIGN_P12_PASSWORD --body '<导出密码>'
 *
 * ⚠️ 私钥是敏感材料：默认写到系统临时目录，**不要**放进仓库；配置完请删掉导出文件。
 *    证书本身由 `node scripts/make-signing-cert.mjs` 在本机钥匙串创建（免费、仅本机有效）。
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CERT_NAME = 'Chassis Local Signing'

const options = readOptions(process.argv.slice(2))
const outFile = options.out ?? path.join(os.tmpdir(), 'chassis-signing.p12')
const password = options.password ?? crypto.randomBytes(18).toString('base64url')

const identity = findIdentity()
if (!identity) {
  console.error(`✗ 钥匙串里没有找到「${CERT_NAME}」签名证书`)
  console.error('  先跑一次：node scripts/make-signing-cert.mjs（免费、仅本机有效）')
  process.exit(1)
}
console.log(`▶ 使用身份：${identity.label}`)

// 导出（p12 需要私钥：钥匙串可能弹一次访问授权框）
fs.rmSync(outFile, { force: true })
try {
  execFileSync('security', ['export', '-t', 'identities', '-f', 'pkcs12', '-P', password, '-o', outFile, CERT_NAME])
} catch (err) {
  console.error('✗ 导出失败（常见原因：点掉了钥匙串的「允许访问」弹窗，或证书名不匹配）')
  console.error(String(err.stderr ?? err.message))
  console.error(`  也可以在「钥匙串访问」里手动导出：我的证书 → ${CERT_NAME} → 导出为 .p12，然后：`)
  console.error(`  base64 -i <导出的文件>.p12 -o ${outFile}.base64`)
  process.exit(1)
}
if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
  console.error('✗ 导出文件为空：改用「钥匙串访问」手动导出后再 base64')
  process.exit(1)
}

const encoded = fs.readFileSync(outFile).toString('base64')
const base64File = `${outFile}.base64`
fs.writeFileSync(base64File, encoded)

console.log('')
console.log('✓ 导出完成（两个文件都在系统临时目录，配置完请删除）：')
console.log(`  p12：   ${outFile}`)
console.log(`  base64：${base64File}`)
console.log('')
console.log('▶ 配置到仓库 secrets（自更新通道的 CI 会用它签名）：')
console.log(`  gh secret set MACOS_SIGN_P12 < ${base64File}`)
console.log(`  gh secret set MACOS_SIGN_P12_PASSWORD --body '${password}'`)
console.log('')
console.log('▶ 核对（导入后 CI 日志里应出现同一身份）：')
console.log(`  security find-identity -v -p codesigning | grep "${CERT_NAME}"`)

function findIdentity() {
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
    const line = out.split('\n').find((item) => item.includes(CERT_NAME))
    if (!line) return null
    const label = line.split('"')[1] ?? CERT_NAME
    return { label }
  } catch {
    return null
  }
}

function readOptions(argv) {
  /** @type {Record<string, string>} */
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      result[key] = 'true'
      continue
    }
    result[key] = next
    index += 1
  }
  return result
}
