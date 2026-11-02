import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Renderer only. Loaded from file:// in production, so asset paths must be relative.
export default defineConfig({
  root: '.',
  base: './',
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome130' },
  server: { port: 5199, strictPort: true }
})
