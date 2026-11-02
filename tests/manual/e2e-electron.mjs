// E2E: starts the real Electron app, drives it through window.olk (the same bridge the UI uses).
// node tests/manual/e2e-electron.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { makeZip, realisticEntries, serve } = require('../helpers.cjs')
const electron = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'olk-e2e-'))
const entries = realisticEntries().map((e) => e.name.endsWith('Wow.exe') ? { ...e, data: fs.readFileSync(path.join(process.env.SystemRoot, 'System32', 'whoami.exe')) } : e)
for (const f of ['common-2.MPQ', 'expansion.MPQ', 'lichking.MPQ', 'patch.MPQ']) entries.push({ name: `ChromieCraft_3.3.5a/Data/${f}`, data: Buffer.alloc(1024, 3) })
const zipFile = path.join(data, 'pkg.zip')
await makeZip(zipFile, entries)
const srv = await serve({ '/wow32.zip': { body: fs.readFileSync(zipFile) } })
const port = 9400 + Math.floor(Math.random() * 300)
const app = spawn(electron, ['.', `--remote-debugging-port=${port}`], { cwd: process.cwd(), env: { ...process.env, OLK_USER_DATA: data }, stdio: 'ignore' })

let target
for (let i = 0; i < 60 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page') } catch {} ; if (!target) await sleep(300) }
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0; const pend = new Map()
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); pend.delete(m.id) })
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80 }); fs.writeFileSync(path.join(os.tmpdir(), `e2e-${name}.jpg`), Buffer.from(r.result.data, 'base64')) }

await sleep(4000)
const s0 = await ev('olk.state()')
console.log('api state (real discovery):', JSON.stringify(s0.data.api))
console.log('initial button:', s0.data.clients[0].button, '| wow64:', s0.data.clients[1].button)
console.log('login (real server):', JSON.stringify(await ev(`olk.login({username:'X',password:'y'})`)))
await ev(`document.querySelector('.login__skip button')?.click()`)
console.log('save bad realmlist:', JSON.stringify((await ev(`olk.saveSettings({realmlist:'bad realm!'})`)).error))
console.log('save package url:', (await ev(`olk.saveSettings({'clients.wow32.basePackage.url':'${srv.base}/wow32.zip'})`)).ok)
await sleep(300); await shot('before-install')
const inst = await ev(`olk.install('wow32')`)
console.log('install:', inst.ok, inst.ok ? inst.data.button : JSON.stringify(inst.error))
await sleep(500); await shot('installed')
const play = await ev(`olk.play('wow32')`)
console.log('play:', JSON.stringify(play))
await sleep(1500)
const s1 = await ev('olk.state()')
console.log('after play button:', s1.data.clients[0].button, '| installed:', s1.data.clients[0].installed)
console.log('realmlist file:', JSON.stringify(fs.readFileSync(path.join(data, 'games', 'wow32', 'Data', 'enUS', 'realmlist.wtf'), 'latin1')))
console.log('log file has no secrets:', !/password|"y"/.test(fs.readFileSync(path.join(data, 'logs', 'launcher.log'), 'utf8')))
app.kill(); await srv.close(); process.exit(0)
