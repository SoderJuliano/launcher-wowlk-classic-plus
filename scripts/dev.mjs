// npm run dev — Vite dev server for the renderer + Electron pointing at it.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const electron = require('electron')

const vite = spawn(process.execPath, [require.resolve('vite/bin/vite.js'), '--port', '5199', '--strictPort'], { stdio: 'inherit' })
for (let i = 0; i < 60; i++) {
  try { if ((await fetch('http://localhost:5199')).ok) break } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 300))
}
const app = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, OLK_DEV_SERVER: 'http://localhost:5199' } })
app.on('exit', (code) => { vite.kill(); process.exit(code ?? 0) })
