'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { InstallationManager } = require('../electron/core/InstallationManager.cjs')
const { GameLauncher } = require('../electron/core/GameLauncher.cjs')
const { readRealmlist } = require('../electron/core/realmlist.cjs')
const { tmpDir, makeConfig, makeZip, realisticEntries } = require('./helpers.cjs')

async function installedClient() {
  const data = tmpDir()
  const config = makeConfig(data)
  const installer = new InstallationManager({ config })
  const zip = path.join(data, 'pkg.zip')
  await makeZip(zip, realisticEntries())
  await installer.installFromZip({ id: 'wow32', zipPath: zip })
  return { data, config, installer, dir: config.clientDir('wow32') }
}

test('refuses to launch when not installed', async () => {
  const data = tmpDir()
  const config = makeConfig(data)
  const launcher = new GameLauncher({ config, installer: new InstallationManager({ config }) })
  await assert.rejects(launcher.launch('wow32'), { code: 'NOT_INSTALLED' })
})

test('launch uses the game folder as cwd, re-applies realmlist and blocks a second instance', async () => {
  const { config, installer, dir } = await installedClient()
  // Simulate a user editing realmlist by hand; launch must restore the configured one.
  fs.writeFileSync(path.join(dir, 'Data', 'enUS', 'realmlist.wtf'), 'set realmlist evil.example\r\n')
  const calls = []
  const spawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { ...opts, stdio: 'ignore' })
  }
  const launcher = new GameLauncher({ config, installer, spawnImpl, platformName: 'win32' })
  const exited = new Promise((r) => launcher.launch('wow32', { onExit: r }).then((info) => assert.ok(info.pid > 0)))
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(calls[0].cmd, path.join(dir, 'Wow.exe'))
  assert.equal(calls[0].opts.cwd, dir)
  assert.equal(readRealmlist(dir, 'enUS'), config.get().realmlist)
  assert.equal(launcher.isRunning('wow32'), true)
  await assert.rejects(launcher.launch('wow32'), { code: 'ALREADY_RUNNING' })
  await exited
  assert.equal(launcher.isRunning('wow32'), false)
})

test('Linux path: requires Wine and runs the exe through it with a dedicated prefix', async () => {
  const { config, installer, dir } = await installedClient()
  config.update({ 'wine.path': process.execPath }) // any executable answering "--version" stands in for wine
  const calls = []
  const spawnImpl = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' }) }
  fs.mkdirSync(path.join(config.dataDir, 'wineprefix', 'drive_c'), { recursive: true }) // prefix already initialised
  const launcher = new GameLauncher({ config, installer, spawnImpl, platformName: 'linux' })
  await launcher.launch('wow32')
  assert.equal(calls[0].cmd, process.execPath)
  assert.deepEqual(calls[0].args, [path.join(dir, 'Wow.exe')])
  assert.equal(calls[0].opts.cwd, dir)
  assert.ok(calls[0].opts.env.WINEPREFIX.endsWith('wineprefix'))
  assert.match(calls[0].opts.env.WINEDLLOVERRIDES, /d3d9/)
})

test('Linux path: uses internal wine runner fallback when available', async () => {
  const { config, installer, dir } = await installedClient()
  config.update({ 'wine.path': '' })
  const internalWineDir = path.join(config.dataDir, 'runtime', 'wine', 'bin')
  fs.mkdirSync(internalWineDir, { recursive: true })
  const mockWine = path.join(internalWineDir, 'wine')
  // Copy current node executable to stand in for internal wine binary
  fs.copyFileSync(process.execPath, mockWine)
  fs.chmodSync(mockWine, 0o755)

  const calls = []
  const spawnImpl = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' }) }
  fs.mkdirSync(path.join(config.dataDir, 'wineprefix', 'drive_c'), { recursive: true })
  const launcher = new GameLauncher({ config, installer, spawnImpl, platformName: 'linux' })
  await launcher.launch('wow32')
  assert.equal(calls[0].cmd, mockWine)
  assert.ok(calls[0].opts.env.PATH.includes(internalWineDir))
})

test('Linux path: Wine runner executes directly with game executable', async () => {
  const { config, installer, dir } = await installedClient()
  const wineRoot = path.join(config.dataDir, 'custom-wine')
  const wineBin = path.join(wineRoot, 'bin')
  fs.mkdirSync(wineBin, { recursive: true })
  const mockWine = path.join(wineBin, 'wine')
  fs.copyFileSync(process.execPath, mockWine)
  fs.chmodSync(mockWine, 0o755)

  config.update({ 'wine.path': mockWine })
  fs.mkdirSync(path.join(config.dataDir, 'wineprefix', 'drive_c'), { recursive: true })
  const calls = []
  const spawnImpl = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' }) }
  const launcher = new GameLauncher({ config, installer, spawnImpl, platformName: 'linux' })
  await launcher.launch('wow32')
  assert.equal(calls[0].cmd, mockWine)
  assert.deepEqual(calls[0].args, [path.join(dir, 'Wow.exe')])
  assert.ok(calls[0].opts.env.WINEPREFIX)
  assert.equal(calls[0].opts.env.WINEDLLOVERRIDES, 'winedbg.exe=d;d3d9,dxgi=n,b')
})

test('real process start on this OS (copy of a system binary as Wow.exe)', { skip: process.platform !== 'win32' && 'Windows-only smoke test' }, async () => {
  const { config, installer, dir } = await installedClient()
  fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'whoami.exe'), path.join(dir, 'Wow.exe'))
  const launcher = new GameLauncher({ config, installer })
  const code = await new Promise((resolve, reject) => launcher.launch('wow32', { onExit: resolve }).catch(reject))
  assert.equal(code, 0)
})
