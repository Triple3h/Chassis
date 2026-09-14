import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 发布到 dist 的清单字段，只保留宿主运行需要的部分。
 * `apiVersion` / `capabilities` 是启动台的硬要求（plugin-spec §3.1）：
 * 少一个就 `MANIFEST_INVALID`、少声明能力就 `CAPABILITY_UNKNOWN`，两个宿主都读这份清单。
 */
const MANIFEST_KEYS = [
  'name',
  'title',
  'author',
  'version',
  'description',
  'categories',
  'commands',
  'icon',
  'homepage',
  'license',
  'keywords',
  'apiVersion',
  'capabilities',
]

/**
 * 构建后把精简过的 package.json 写进 dist，
 * 让 dist 本身就是一个可直接放进 `<如快安装目录>/extensions/` 的插件目录。
 */
export function manifestPlugin({ root }) {
  return {
    name: 'sofast:emit-manifest',
    apply: 'build',
    writeBundle() {
      const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'))
      const manifest = { type: 'module' }
      for (const key of MANIFEST_KEYS) {
        if (pkg[key] !== undefined) manifest[key] = pkg[key]
      }
      const dist = path.join(root, 'dist')
      mkdirSync(dist, { recursive: true })
      writeFileSync(path.join(dist, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    },
  }
}
