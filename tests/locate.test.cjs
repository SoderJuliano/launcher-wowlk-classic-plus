'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { InstallationManager } = require('../electron/core/InstallationManager.cjs')
const { UpdateManager } = require('../electron/core/UpdateManager.cjs')
const { DownloadManager } = require('../electron/core/DownloadManager.cjs')
const { ManifestService } = require('../electron/core/ManifestService.cjs')
const { LauncherController } = require('../electron/core/LauncherController.cjs')
const { readRealmlist } = require('../electron/core/realmlist.cjs')
const { sha, tmpDir, makeConfig, serve } = require('./helpers.cjs')

/** Writes an already-extracted client like the player's "ChromieCraft_3.3.5a" folder. */
function writeClient(root) {
  const files = {
    'Wow.exe': 'MZ exe',
    'Data/common.MPQ': Buffer.alloc(100, 1),
    'Data/enUS/locale-enUS.MPQ': Buffer.alloc(50, 2),
    'Data/enUS/realmlist.wtf': 'set realmlist 100.102.36.27\r\n',
    'WTF/Config.wtf': 'SET realmList "100.102.36.27"\r\n'
  }
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), data)
  }
}

function controllerFor(config, extra = {}) {
  const installer = new InstallationManager({ config })
  const game = { isRunning: () => false }
  const api = { lastStatus: { state: 'incompatible' } }
  const auth = { isAuthenticated: () => false, session: null, user: null }
  const manifests = new ManifestService({ api, auth, launcherVersion: '0.1.0', config })
  const updater = new UpdateManager({ config, installer, downloader: new DownloadManager() })
  return { installer, ctl: new LauncherController({ config, api, auth, manifests, downloader: new DownloadManager(), installer, updater, game, ...extra }) }
}

test('locating the game folder adopts it in place (parent folder also works)', async () => {
  const data = tmpDir()
  const config = makeConfig(data)
  const parent = tmpDir('wow-soder-configurado-')
  const gameDir = path.join(parent, 'ChromieCraft_3.3.5a')
  writeClient(gameDir)
  const { ctl, installer } = controllerFor(config)

  const st = await ctl.locate('wow32', parent) // user picked the parent folder
  assert.equal(st.installed, true)
  assert.equal(st.button, 'PLAY')
  assert.equal(st.located, true)
  assert.equal(config.clientDir('wow32'), gameDir)
  assert.ok(!fs.existsSync(path.join(config.get().installDir, 'wow32')), 'nothing copied')
  assert.equal(readRealmlist(gameDir, 'enUS'), config.get().realmlist)
  assert.equal(installer.readState('wow32').source, 'existing-folder')
})

test('a folder without the game is refused with a clear message', async () => {
  const data = tmpDir()
  const config = makeConfig(data)
  const notGame = tmpDir('random-')
  fs.writeFileSync(path.join(notGame, 'readme.txt'), 'hi')
  const { ctl } = controllerFor(config)
  await assert.rejects(ctl.locate('wow32', notGame), { code: 'NOT_A_GAME_FOLDER' })
  assert.equal(config.client('wow32').path, undefined)
})

test('patches from a static manifest URL are applied to the located folder', async () => {
  const data = tmpDir()
  const config = makeConfig(data)
  const gameDir = path.join(tmpDir('wow-'), 'ChromieCraft_3.3.5a')
  writeClient(gameDir)
  const patch = Buffer.from('new patch content')
  const srv = await serve({ '/wow32/Data/patch-5.MPQ': { body: patch } })
  srv.manifest = {
    schema_version: 1, client: 'wow32', architecture: 'x86', version: '1.0.1',
    files: [{ path: 'Data/patch-5.MPQ', size: patch.length, sha256: sha(patch), url: `${srv.base}/wow32/Data/patch-5.MPQ` }],
    deleted_files: []
  }
  const mSrv = await serve({ '/manifests/wow32.json': { body: JSON.stringify(srv.manifest), type: 'application/json' } })
  config.update({ 'clients.wow32.manifestUrl': `${mSrv.base}/manifests/wow32.json` })
  const { ctl } = controllerFor(config)
  try {
    await ctl.locate('wow32', gameDir)
    assert.equal(ctl.clientState('wow32').button, 'UPDATE', 'manifest read without the launcher API')
    await ctl.update('wow32')
    assert.ok(fs.readFileSync(path.join(gameDir, 'Data', 'patch-5.MPQ')).equals(patch))
    const s = ctl.clientState('wow32')
    assert.equal(s.version, '1.0.1')
    assert.equal(s.button, 'PLAY')
  } finally { await srv.close(); await mSrv.close() }
})
