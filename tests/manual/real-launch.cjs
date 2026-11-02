'use strict'
// Manual E2E: launches the real installed client for N seconds, then kills it.
const path = require('node:path')
const { execSync } = require('node:child_process')
const { ConfigurationManager } = require('../../electron/core/ConfigurationManager.cjs')
const { InstallationManager } = require('../../electron/core/InstallationManager.cjs')
const { GameLauncher } = require('../../electron/core/GameLauncher.cjs')
;(async () => {
  const [dataDir, secs = '10'] = process.argv.slice(2)
  const config = new ConfigurationManager({ defaultsFile: path.join(__dirname, '../../config/defaults.json'), dataDir })
  const launcher = new GameLauncher({ config, installer: new InstallationManager({ config }) })
  let exitCode = 'still running'
  const info = await launcher.launch('wow32', { onExit: (c) => (exitCode = c) })
  console.log('started', info)
  try { await launcher.launch('wow32') } catch (e) { console.log('second launch blocked:', e.code) }
  await new Promise((r) => setTimeout(r, Number(secs) * 1000))
  const alive = execSync(`tasklist /FI "PID eq ${info.pid}" /NH`).toString()
  console.log(`after ${secs}s:`, exitCode, '|', alive.trim().split(/\s+/).slice(0, 2).join(' '))
  if (launcher.isRunning('wow32')) execSync(`taskkill /PID ${info.pid} /F`)
  process.exit(0)
})().catch((e) => { console.error('FAILED', e.code, e.message); process.exit(1) })
