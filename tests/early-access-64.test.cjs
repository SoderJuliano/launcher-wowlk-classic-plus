'use strict'
// 64-bit early access (27/11/2026): only accounts in wowlk_site.wowsixtyfordev, toggle on by itself once.
const test = require('node:test')
const assert = require('node:assert/strict')
const { InstallationManager } = require('../electron/core/InstallationManager.cjs')
const { DownloadManager } = require('../electron/core/DownloadManager.cjs')
const { LauncherController } = require('../electron/core/LauncherController.cjs')
const { tmpDir, makeConfig } = require('./helpers.cjs')

function setup(member) {
  const config = makeConfig(tmpDir())
  const calls = []
  const api = {
    lastStatus: { state: 'incompatible' }, // no manifest fetches in the test
    request: async (method, path, opts) => {
      calls.push(`${method} ${opts?.prefix ?? ''}${path}`)
      if (path === '/client64/me') return { supporter: member.value, since: null, donations: member.value ? 1 : 0 }
      if (path === '/me') return { supporter: false, since: null, donations: 0 }
      return {}
    }
  }
  const auth = { isAuthenticated: () => true, session: {}, user: { username: 'juliano' }, accessToken: async () => 'tok' }
  const installer = new InstallationManager({ config })
  const ctl = new LauncherController({ config, api, auth, manifests: {}, downloader: new DownloadManager(), installer, updater: {}, game: { isRunning: () => false } })
  return { config, ctl, calls }
}

test('without 64-bit early access the 64-bit client stays "Coming soon"', async () => {
  const member = { value: false }
  const { ctl, calls } = setup(member)
  await ctl.refreshSupporter()
  assert.ok(calls.includes('GET /donation/v1/client64/me'))
  const st = ctl.clientState('wow64')
  assert.equal(st.available, false)
  assert.equal(st.button, 'UNAVAILABLE')
  assert.equal(st.supporterContentEnabled, false)
  await assert.rejects(ctl.setSupporterContentEnabled('wow64', true), { code: 'NOT_SUPPORTER' })
})

test('a member gets the toggle on by itself once; turning it off goes back to "Coming soon" and stays off', async () => {
  const member = { value: true }
  const { ctl, config } = setup(member)
  await ctl.refreshSupporter()
  let st = ctl.clientState('wow64')
  assert.equal(st.supporterContentEnabled, true)
  assert.equal(st.available, true)
  assert.equal(st.button, 'INSTALL') // shown as "Download" for early-access clients

  await ctl.setSupporterContentEnabled('wow64', false)
  st = ctl.clientState('wow64')
  assert.equal(st.button, 'UNAVAILABLE')
  await ctl.refreshSupporter() // next check must not force it back on
  assert.equal(ctl.clientState('wow64').supporterContentEnabled, false)
  assert.deepEqual(config.client('wow64').earlyAccessAutoEnabledFor, ['JULIANO'])

  await ctl.setSupporterContentEnabled('wow64', true)
  assert.equal(ctl.clientState('wow64').available, true)
})

test('the 32-bit client is not affected by 64-bit early access', async () => {
  const { ctl } = setup({ value: true })
  await ctl.refreshSupporter()
  assert.equal(ctl.clientState('wow32').available, true)
  assert.equal(ctl.clientState('wow32').earlyAccess, false)
  assert.equal(ctl.snapshot().earlyAccess64.member, true)
})
