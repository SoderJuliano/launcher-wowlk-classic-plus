'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { ApiClient } = require('../electron/core/ApiClient.cjs')
const { AuthenticationService } = require('../electron/core/AuthenticationService.cjs')
const { ManifestService } = require('../electron/core/ManifestService.cjs')
const { tmpDir, makeConfig, serve } = require('./helpers.cjs')

/** Fake OS keystore (the real one is Electron safeStorage). */
const fakeStore = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s).toString('base64').split('').reverse().join('')),
  decryptString: (b) => Buffer.from(b.toString().split('').reverse().join(''), 'base64').toString()
}

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }

/** Minimal Pikachu implementing docs/API_CONTRACT.md. */
function pikachuRoutes(state) {
  const P = '/launcher/v1'
  const read = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d ? JSON.parse(d) : null)) })
  return {
    [`${P}/health`]: (req, res) => json(res, 200, { service: 'pikachu', api_version: 1, maintenance: false, time: new Date().toISOString() }),
    [`${P}/auth/login`]: async (req, res) => {
      const b = await read(req)
      state.loginBodies.push(b)
      if (req.headers['content-type'] !== 'application/json') return json(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'json only' } })
      if (b.username === 'LOCKED') return json(res, 403, { error: { code: 'ACCOUNT_LOCKED', message: 'This account is locked. Verify your e-mail first.' } })
      if (b.username !== 'ARTHAS' || b.password !== 'Frostmourne1') return json(res, 401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' } })
      json(res, 200, { access_token: 'acc-1', token_type: 'Bearer', expires_in: state.expiresIn, refresh_token: 'ref-1', refresh_expires_in: 2592000, user: { id: 7, username: 'ARTHAS', email_verified: true } })
    },
    [`${P}/auth/refresh`]: async (req, res) => {
      const b = await read(req)
      state.refreshes++
      if (b.refresh_token !== 'ref-1' && b.refresh_token !== 'ref-2') return json(res, 401, { error: { code: 'INVALID_REFRESH_TOKEN', message: 'Session expired.' } })
      json(res, 200, { access_token: `acc-r${state.refreshes}`, token_type: 'Bearer', expires_in: 900, refresh_token: 'ref-2', refresh_expires_in: 2592000, user: { id: 7, username: 'ARTHAS' } })
    },
    [`${P}/auth/logout`]: (req, res) => { state.logouts.push(req.headers.authorization); res.writeHead(204); res.end() },
    [`${P}/manifest/wow32`]: (req, res) => {
      if (!/^Bearer acc-/.test(req.headers.authorization || '')) return json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Login required' } })
      json(res, 200, { schema_version: 1, client: 'wow32', architecture: 'x86', version: '1.0.0', min_launcher_version: state.minLauncher, files: [], deleted_files: [] })
    }
  }
}

async function setup({ expiresIn = 900, minLauncher = '0.1.0' } = {}) {
  const state = { loginBodies: [], refreshes: 0, logouts: [], expiresIn, minLauncher }
  const pika = await serve(pikachuRoutes(state))
  const abra = await serve({
    '/notifications/retrieve': (req, res) => json(res, 200, [
      { id: '1', content: 'https://old-tunnel.ngrok-free.dev', title: 'url' },
      { id: '2', content: `  ${pika.base}/  `, title: 'url' }
    ])
  })
  const data = tmpDir()
  const config = makeConfig(data)
  config.defaults.api.discovery.url = `${abra.base}/notifications/retrieve?key=ngrockurl`
  let t = 1_000_000
  const now = () => t
  const api = new ApiClient({ config, launcherVersion: '0.1.0' })
  const auth = new AuthenticationService({ api, dataDir: data, secureStore: fakeStore, platform: 'linux', launcherVersion: '0.1.0', now })
  return { state, pika, abra, data, config, api, auth, now, advance: (ms) => (t += ms), close: async () => { await pika.close(); await abra.close() } }
}

test('discovers the Pikachu URL from the LAST Abra notification and checks /health', async () => {
  const s = await setup()
  try {
    const st = await s.api.health()
    assert.equal(st.state, 'online')
    assert.equal(st.baseUrl, s.pika.base)
  } finally { await s.close() }
})

test('a server without the launcher API is reported as incompatible, not online', async () => {
  const pika = await serve({})
  const data = tmpDir()
  const config = makeConfig(data)
  config.update({ 'api.baseUrl': pika.base })
  try {
    const st = await new ApiClient({ config, launcherVersion: '0.1.0' }).health()
    assert.equal(st.state, 'incompatible')
  } finally { await pika.close() }
})

test('login: success, payload, generic error for wrong password, locked account', async () => {
  const s = await setup()
  try {
    await assert.rejects(s.auth.login({ username: 'ARTHAS', password: 'nope' }), { code: 'INVALID_CREDENTIALS' })
    await assert.rejects(s.auth.login({ username: 'LOCKED', password: 'x' }), { code: 'ACCOUNT_LOCKED' })
    await assert.rejects(s.auth.login({ username: '', password: 'x' }), { code: 'VALIDATION' })
    const user = await s.auth.login({ username: ' ARTHAS ', password: 'Frostmourne1', remember: false })
    assert.equal(user.username, 'ARTHAS')
    assert.equal(s.state.loginBodies.at(-1).username, 'ARTHAS')
    assert.equal(s.state.loginBodies.at(-1).client.platform, 'linux')
    assert.ok(!fs.existsSync(path.join(s.data, 'session.bin')), 'not remembered → nothing on disk')
  } finally { await s.close() }
})

test('remember me: only an encrypted refresh token is stored; password never touches disk', async () => {
  const s = await setup()
  try {
    await s.auth.login({ username: 'ARTHAS', password: 'Frostmourne1', remember: true })
    const raw = fs.readFileSync(path.join(s.data, 'session.bin')).toString()
    assert.ok(!raw.includes('Frostmourne1') && !raw.includes('ref-1'), 'stored encrypted')
    assert.ok(!JSON.stringify(s.config.get()).includes('Frostmourne1'))

    // New process: restore from disk → refresh.
    const auth2 = new AuthenticationService({ api: s.api, dataDir: s.data, secureStore: fakeStore, platform: 'linux', launcherVersion: '0.1.0', now: s.now })
    const user = await auth2.restore()
    assert.equal(user.username, 'ARTHAS')
    assert.ok(auth2.isAuthenticated())
  } finally { await s.close() }
})

test('access token is refreshed automatically before it expires; logout clears everything', async () => {
  const s = await setup({ expiresIn: 120 })
  try {
    await s.auth.login({ username: 'ARTHAS', password: 'Frostmourne1', remember: true })
    assert.equal(await s.auth.accessToken(), 'acc-1')
    s.advance(90_000) // within the 60 s refresh margin
    assert.equal(await s.auth.accessToken(), 'acc-r1')
    assert.equal(s.state.refreshes, 1)
    await s.auth.logout()
    assert.equal(s.state.logouts[0], 'Bearer acc-r1')
    assert.ok(!fs.existsSync(path.join(s.data, 'session.bin')))
    await assert.rejects(s.auth.accessToken(), { code: 'NOT_AUTHENTICATED' })
  } finally { await s.close() }
})

test('manifest is fetched with the bearer token; an old launcher is refused', async () => {
  const s = await setup({ minLauncher: '9.0.0' })
  try {
    await s.auth.login({ username: 'ARTHAS', password: 'Frostmourne1' })
    const svc = new ManifestService({ api: s.api, auth: s.auth, launcherVersion: '0.1.0' })
    await assert.rejects(svc.fetch('wow32'), { code: 'LAUNCHER_OUTDATED' })
    s.state.minLauncher = '0.1.0'
    assert.equal((await svc.fetch('wow32')).version, '1.0.0')
  } finally { await s.close() }
})

test('unreachable API is reported clearly (offline / timeout)', async () => {
  const data = tmpDir()
  const config = makeConfig(data)
  config.update({ 'api.baseUrl': 'http://127.0.0.1:1' })
  const st = await new ApiClient({ config, launcherVersion: '0.1.0' }).health()
  assert.equal(st.state, 'offline')
  assert.match(st.error, /reach/i)
})
