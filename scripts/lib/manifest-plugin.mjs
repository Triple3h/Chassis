import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { MANIFEST_KEYS } from './manifest-keys.mjs'

/**
 * 构建后把精简过的 package.json 写进 dist，
 * 让 dist 本身就是一个可直接安装的插件目录（`<dataRoot>/extensions/` 或出厂 bundle）。
 */
export function manifestPlugin({ root }) {
  return {
    name: 'launcher:emit-manifest',
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
