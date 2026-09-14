import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // 产物由内核静态托管，资源路径必须相对
  base: './',
  plugins: [vue(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 3333,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // macOS WKWebView 保守目标
    target: 'safari16',
    sourcemap: false,
  },
})
