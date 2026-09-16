import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { manifestPlugin } from '../shared/build/manifest-plugin.mjs'
import { devFsAllow, sharedAliases } from '../shared/build/vite-shared.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root,
  base: './',
  plugins: [vue(), tailwindcss(), manifestPlugin({ root })],
  resolve: { alias: sharedAliases(root) },
  server: {
    fs: { allow: devFsAllow(root) },
  },
  worker: { format: 'es' },
  build: {
    outDir: path.resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    // zxing 的 wasm 约 1MB，必须作为独立文件输出而不是内联
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 4096,
  },
})
