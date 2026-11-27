'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { passHash, buildHandoff } = require('../electron/core/gameHandoff.cjs')
const { GameLauncher } = require('../electron/core/GameLauncher.cjs')
const { tmpDir, makeConfig } = require('./helpers.cjs')

test('pass_hash is SHA1(UPPER(user):UPPER(pass)) in upper hex, the WoW login hash', () => {
  const expected = crypto.createHash('sha1').update('JULIANO:SENHA123').digest('hex').toUpperCase()
  assert.equal(passHash('juliano', 'senha123'), expected)
  assert.match(passHash('a', 'b'), /^[0-9A-F]{40}$/)
})

test('handoff carries api with prefix, ticket, upper account and never the password', () => {
  const h = buildHandoff({ apiBase: 'https://x.ngrok-free.dev/', prefix: '/launcher/v1', ticket: 'T', username: 'juliano', password: 'segredo' })
  assert.deepEqual(Object.keys(h), ['v', 'api', 'ticket', 'account', 'pass_hash'])
  assert.equal(h.api, 'https://x.ngrok-free.dev/launcher/v1')
  assert.equal(h.account, 'JULIANO')
  assert.ok(!JSON.stringify(h).toLowerCase().includes('segredo'))
  assert.throws(() => buildHandoff({ apiBase: 'https://x', ticket: 'T', username: 'j', password: '' }), { code: 'RELOGIN_REQUIRED' })
  assert.throws(() => buildHandoff({ apiBase: 'http://x', ticket: 'T', username: 'j', password: 'p' }), { code: 'API_NOT_CONFIGURED' })
  assert.throws(() => buildHandoff({ apiBase: 'https://x', ticket: '', username: 'j', password: 'p' }))
})

function nativeSetup() {
  const data = tmpDir()
  const config = makeConfig(data)
  config.defaults.clients.wow64.executable = 'soder-nextgen-mmo'
  const dir = config.clientDir('wow64')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'soder-nextgen-mmo'), '#!/bin/sh\n')
  const installer = { verify: () => ({ installed: true, missing: [] }), ensureRealmlist: () => assert.fail('no realmlist for wow64') }
  return { config, installer, dir }
}

test('64-bit client runs natively (no Wine) and gets the handoff line on stdin', async () => {
  const { config, installer, dir } = nativeSetup()
  const out = path.join(dir, 'stdin.txt')
  const calls = []
  const spawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return spawn(process.execPath, ['-e', `process.stdin.pipe(require('fs').createWriteStream(${JSON.stringify(out)}))`], { stdio: opts.stdio })
  }
  const launcher = new GameLauncher({ config, installer, spawnImpl, platformName: 'linux' })
  const handoff = { v: 1, api: 'https://h/launcher/v1', ticket: 'TK', account: 'A', pass_hash: 'F'.repeat(40) }
  const exited = new Promise((r) => launcher.launch('wow64', { onExit: r, handoff }))
  await exited
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, path.join(dir, 'soder-nextgen-mmo'))
  assert.deepEqual(calls[0].args, [])
  assert.equal(calls[0].opts.stdio[0], 'pipe')
  assert.equal(calls[0].opts.env.WINEPREFIX, process.env.WINEPREFIX)
  assert.equal(fs.readFileSync(out, 'utf8'), JSON.stringify(handoff) + '\n')
})

test('64-bit client is never started without a ticket', async () => {
  const { config, installer } = nativeSetup()
  const launcher = new GameLauncher({ config, installer, spawnImpl: () => assert.fail('spawned'), platformName: 'linux' })
  await assert.rejects(launcher.launch('wow64', {}), { code: 'LAUNCH_FAILED' })
})

test('Windows: the 64-bit client is soder-nextgen-mmo.exe, started directly with the handoff on stdin', async () => {
  const path = require('node:path')
  const fs = require('node:fs')
  const { ConfigurationManager } = require('../electron/core/ConfigurationManager.cjs')
  const data = tmpDir()
  const config = new ConfigurationManager({ defaultsFile: path.join(__dirname, '..', 'config', 'defaults.json'), dataDir: data, platformName: 'win32' })
  assert.equal(config.client('wow64').executable, 'soder-nextgen-mmo.exe')
  assert.equal(config.client('wow32').executable, 'Wow.exe')
  const dir = config.clientDir('wow64')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'soder-nextgen-mmo.exe'), 'MZ')
  const calls = []
  const spawnImpl = (cmd, args, opts) => { calls.push({ cmd, opts }); return spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>{})'], { stdio: opts.stdio }) }
  const installer = { verify: () => ({ installed: true, missing: [] }), ensureRealmlist: () => {} }
  const launcher = new GameLauncher({ config, installer, spawnImpl, platformName: 'win32' })
  const exited = new Promise((r) => launcher.launch('wow64', { onExit: r, handoff: { v: 1 } }))
  await exited
  assert.equal(calls[0].cmd, path.join(dir, 'soder-nextgen-mmo.exe'))
  assert.equal(calls[0].opts.stdio[0], 'pipe')
})

test('the 64-bit manifest is per OS: wow64 on Linux, wow64win on Windows', async () => {
  const path = require('node:path')
  const { ConfigurationManager } = require('../electron/core/ConfigurationManager.cjs')
  const { ManifestService } = require('../electron/core/ManifestService.cjs')
  const mk = (platformName) => new ConfigurationManager({ defaultsFile: path.join(__dirname, '..', 'config', 'defaults.json'), dataDir: tmpDir(), platformName })
  for (const [plat, expected] of [['linux', '/manifest/wow64'], ['win32', '/manifest/wow64win']]) {
    const asked = []
    const api = { lastStatus: { state: 'online' }, request: async (m, p) => { asked.push(p); return { schema_version: 1, client: 'wow64', architecture: 'x64', version: '0.1.0', files: [] } } }
    const ms = new ManifestService({ api, auth: { isAuthenticated: () => false }, launcherVersion: '0.1.55', config: mk(plat) })
    const m = await ms.fetch('wow64')
    assert.equal(asked[0], expected)
    assert.equal(m.client, 'wow64')
    const api32 = { lastStatus: { state: 'online' }, request: async (m, p) => { asked.push(p); return { schema_version: 1, client: 'wow32', architecture: 'x86', version: '1.0.0', files: [] } } }
    await new ManifestService({ api: api32, auth: { isAuthenticated: () => false }, launcherVersion: '0.1.55', config: mk(plat) }).fetch('wow32')
    assert.equal(asked[1], '/manifest/wow32') // the 32-bit keeps its single manifest
  }
})
