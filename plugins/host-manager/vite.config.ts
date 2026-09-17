import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { manifestPlugin } from '../../scripts/lib/manifest-plugin.mjs'
import { devFsAllow, pluginAliases } from '../../scripts/lib/vite-plugin-vue.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root,
  base: './',
  plugins: [vue(), tailwindcss(), manifestPlugin({ root })],
  resolve: { alias: pluginAliases(root) },
  server: {
    fs: { allow: devFsAllow(root) },
  },
  worker: { format: 'es' },
  build: {
    outDir: path.resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 4096,
  },
})
