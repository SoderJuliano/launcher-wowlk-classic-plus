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

test('Linux input bridge: USB headset is not a gamepad, real pads are', () => {
  const { isGamepadCaps } = require('../electron/core/GameLauncher.cjs')
  // THI Headphone Captain 780 (4c4a:4455): media keys + ABS_VOLUME/ABS_MISC. It used to match "EV_KEY + EV_ABS".
  assert.equal(isGamepadCaps({ ev: '1b', key: '1000000018000 7800000000 8e000000000000 0', abs: '10100000000' }), false)
  // Keyboard, and a device with sticks but no gamepad buttons.
  assert.equal(isGamepadCaps({ ev: '120013', key: '1000000000007 ff9f207ac14057ff febeffdfffefffff fffffffffffffffe', abs: '' }), false)
  assert.equal(isGamepadCaps({ ev: '1b', key: '1000000018000 7800000000 8e000000000000 0', abs: '3' }), false)
  // Xbox-style pad (BTN_SOUTH..BTN_THUMBR) and a generic DirectInput pad (BTN_TRIGGER..).
  assert.equal(isGamepadCaps({ ev: '20000b', key: '7cdb000000000000 0 0 0 0', abs: '3003f' }), true)
  assert.equal(isGamepadCaps({ ev: '1b', key: 'fff00000000 0 0 0 0', abs: '30027' }), true)
})

test('Steam Deck HID parser: Left/Right sticks preserve +up/-down polarity and D-pad never alters sticks', () => {
  const { parseSteamDeckHidReport } = require('../electron/core/GameLauncher.cjs')
  const state = { btn: new Uint8Array(16), lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, active: false }
  const pkt = Buffer.alloc(64)
  pkt[0] = 0x01
  pkt[2] = 0x09
  // Push left stick full UP (+32767) and right stick full DOWN (-32768), with D-Pad Up pressed (b9 & 0x01).
  pkt[9] = 0x01
  pkt.writeInt16LE(0, 48)
  pkt.writeInt16LE(32767, 50)
  pkt.writeInt16LE(0, 52)
  pkt.writeInt16LE(-32768, 54)

  assert.equal(parseSteamDeckHidReport(pkt, 64, state), true)
  assert.equal(state.ly, 1.0)
  assert.equal(state.ry, -1.0)
  assert.equal(state.lx, 0)
  assert.equal(state.rx, 0)
  assert.equal(state.btn[10], 1) // D-Pad Up
  assert.equal(state.btn[11], 0)
})
