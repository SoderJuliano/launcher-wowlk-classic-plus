'use strict'
// Linux-only: real Wow.exe (32-bit) through GameLauncher → Wine. Kills it after N seconds.
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
const { execSync } = require('node:child_process')
const { makeConfig, makeZip, realisticEntries } = require('../helpers.cjs')
const { InstallationManager } = require('../../electron/core/InstallationManager.cjs')
const { GameLauncher } = require('../../electron/core/GameLauncher.cjs')
;(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'olk-wow-'))
  const config = makeConfig(data)
  const installer = new InstallationManager({ config })
  // Real client root files (Wow.exe + its DLLs) copied from an actual install into tests/manual/realroot/.
  const rootDir = path.join(__dirname, 'realroot')
  const real = fs.readdirSync(rootDir).map((f) => ({ name: `ChromieCraft_3.3.5a/${f}`, data: fs.readFileSync(path.join(rootDir, f)) }))
  const entries = [...realisticEntries().filter((e) => !e.name.endsWith('Wow.exe')), ...real]
  await makeZip(path.join(data, 'p.zip'), entries)
  await installer.installFromZip({ id: 'wow32', zipPath: path.join(data, 'p.zip') })
  let exit = null
  const info = await new GameLauncher({ config, installer }).launch('wow32', { onExit: (c) => (exit = c) })
  const keep = setInterval(() => {}, 1000)
  await new Promise((r) => setTimeout(r, 20000))
  const procs = execSync('ps -eo comm,args | grep -i "wow.exe" | grep -v grep || true').toString().trim()
  console.log('spawned via', info.command, '| exit after 20s:', exit, '| Wow.exe process:', procs ? 'RUNNING' : 'not found')
  console.log(procs.split('\n').slice(0, 2).join('\n'))
  clearInterval(keep)
  try { execSync(`WINEPREFIX=${path.join(data, 'wineprefix')} wineserver -k`) } catch {}
  process.exit(0)
})().catch((e) => { console.error('FAILED', e.code, e.message); process.exit(1) })
