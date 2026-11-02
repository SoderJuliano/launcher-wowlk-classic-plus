'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { InstallationManager } = require('../electron/core/InstallationManager.cjs')
const { UpdateManager } = require('../electron/core/UpdateManager.cjs')
const { DownloadManager } = require('../electron/core/DownloadManager.cjs')
const { validateManifest } = require('../electron/core/ManifestService.cjs')
const { readRealmlist } = require('../electron/core/realmlist.cjs')
const { sha, tmpDir, makeConfig, makeZip, realisticEntries, serve } = require('./helpers.cjs')

async function installed() {
  const data = tmpDir()
  const config = makeConfig(data)
  const installer = new InstallationManager({ config })
  const zip = path.join(data, 'pkg.zip')
  await makeZip(zip, realisticEntries())
  await installer.installFromZip({ id: 'wow32', zipPath: zip, version: '1.0.0' })
  return { data, config, installer, dir: config.clientDir('wow32') }
}

test('installs the package: strips root folder, validates and configures realmlist everywhere', async () => {
  const { dir, installer } = await installed()
  assert.ok(fs.existsSync(path.join(dir, 'Wow.exe')))
  assert.ok(!fs.existsSync(path.join(dir, 'ChromieCraft_3.3.5a')))
  assert.equal(readRealmlist(dir, 'enUS'), 'ru2esxz6.free.tryportwarp.cc:16943')
  assert.match(fs.readFileSync(path.join(dir, 'Data', 'realmlist.wtf'), 'latin1'), /^set realmlist ru2esxz6\.free\.tryportwarp\.cc:16943/)
  const cfg = fs.readFileSync(path.join(dir, 'WTF', 'Config.wtf'), 'latin1')
  assert.match(cfg, /SET realmList "ru2esxz6\.free\.tryportwarp\.cc:16943"/)
  assert.match(cfg, /SET gxApi "d3d9"/, 'other settings preserved')
  assert.equal((cfg.match(/realmList/g) || []).length, 1)
  const v = installer.verify('wow32')
  assert.equal(v.installed, true)
  assert.equal(v.state.version, '1.0.0')
})

test('missing required files → not installed (no PLAY)', async () => {
  const data = tmpDir()
  const config = makeConfig(data)
  const installer = new InstallationManager({ config })
  const zip = path.join(data, 'bad.zip')
  await makeZip(zip, realisticEntries().filter((e) => !e.name.endsWith('common.MPQ')))
  await assert.rejects(installer.installFromZip({ id: 'wow32', zipPath: zip }), { code: 'INSTALL_INVALID' })
  assert.equal(installer.verify('wow32').installed, false)
  assert.ok(!fs.existsSync(config.clientDir('wow32')), 'failed install must not create the live folder')
})

test('a ZIP with path traversal or symlinks is refused and writes nothing outside', async () => {
  const data = tmpDir()
  const config = makeConfig(data)
  config.defaults.clients.wow32.packageRoot = ''
  const installer = new InstallationManager({ config })
  const zip = path.join(data, 'evil.zip')
  // yazl refuses "../" names, so patch the bytes after building with a same-length placeholder.
  await makeZip(zip, [{ name: 'Wow.exe', data: 'x' }, { name: 'XX/evil.txt', data: 'pwned' }])
  const buf = fs.readFileSync(zip)
  fs.writeFileSync(zip, Buffer.from(buf.toString('latin1').replaceAll('XX/evil.txt', '../evil.txt'), 'latin1'))
  await assert.rejects(installer.installFromZip({ id: 'wow32', zipPath: zip }), (e) => ['UNSAFE_PATH', 'ZIP_INVALID'].includes(e.code))
  assert.ok(!fs.existsSync(path.join(config.get().installDir, 'evil.txt')))
  assert.ok(!fs.existsSync(path.join(data, 'evil.txt')))

  const zip2 = path.join(data, 'link.zip')
  await makeZip(zip2, [{ name: 'Wow.exe', data: 'x' }, { name: 'link', data: '/etc/passwd', mode: 0o120777 }])
  await assert.rejects(installer.installFromZip({ id: 'wow32', zipPath: zip2 }), { code: 'UNSAFE_PATH' })
})

test('a corrupted ZIP fails the CRC check', async () => {
  const data = tmpDir()
  const config = makeConfig(data)
  const installer = new InstallationManager({ config })
  const zip = path.join(data, 'crc.zip')
  await makeZip(zip, realisticEntries().map((e) => ({ ...e, compress: false })))
  const buf = fs.readFileSync(zip)
  const i = buf.indexOf(Buffer.alloc(64, 1)) // inside Data/common.MPQ (stored)
  buf[i + 10] = 9
  fs.writeFileSync(zip, buf)
  await assert.rejects(installer.installFromZip({ id: 'wow32', zipPath: zip }), { code: 'CHECKSUM_MISMATCH' })
  assert.equal(installer.verify('wow32').installed, false)
})

test('reinstall keeps the player data (WTF/Account, Screenshots)', async () => {
  const { data, dir, installer } = await installed()
  fs.mkdirSync(path.join(dir, 'WTF', 'Account', 'ARTHAS'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'WTF', 'Account', 'ARTHAS', 'bindings-cache.wtf'), 'mine')
  const zip = path.join(data, 'pkg2.zip')
  await makeZip(zip, realisticEntries())
  await installer.installFromZip({ id: 'wow32', zipPath: zip, version: '1.0.0' })
  assert.equal(fs.readFileSync(path.join(dir, 'WTF', 'Account', 'ARTHAS', 'bindings-cache.wtf'), 'utf8'), 'mine')
})

test('incremental update: downloads only changed files, verifies, deletes only listed files, records version', async () => {
  const { dir, config, installer } = await installed()
  const newExe = Buffer.from('MZ new exe v1.0.1')
  const patch = Buffer.alloc(3000, 7)
  const srv = await serve({ '/wow32/Wow.exe': { body: newExe }, '/wow32/Data/patch-5.MPQ': { body: patch }, '/wow32/Data/common.MPQ': { body: Buffer.alloc(4096, 1) } })
  fs.writeFileSync(path.join(dir, 'Data', 'patch-old.MPQ'), 'old')
  fs.writeFileSync(path.join(dir, 'keep-me.txt'), 'not in manifest')
  const manifest = validateManifest({
    schema_version: 1, client: 'wow32', architecture: 'x86', version: '1.0.1',
    files: [
      { path: 'Wow.exe', size: newExe.length, sha256: sha(newExe), url: `${srv.base}/wow32/Wow.exe` },
      { path: 'Data/patch-5.MPQ', size: patch.length, sha256: sha(patch), url: `${srv.base}/wow32/Data/patch-5.MPQ` },
      { path: 'Data/common.MPQ', size: 4096, sha256: sha(Buffer.alloc(4096, 1)), url: `${srv.base}/wow32/Data/common.MPQ` }
    ],
    deleted_files: ['Data/patch-old.MPQ', 'WTF/Account']
  }, 'wow32')
  const updater = new UpdateManager({ config, installer, downloader: new DownloadManager() })
  try {
    const plan = await updater.plan('wow32', manifest)
    assert.deepEqual(plan.toDownload.map((f) => f.path).sort(), ['Data/patch-5.MPQ', 'Wow.exe'], 'unchanged common.MPQ is not downloaded')
    assert.deepEqual(plan.toDelete, ['Data/patch-old.MPQ'], 'protected player data is never deleted')
    await updater.apply('wow32', manifest, plan)
    assert.ok(fs.readFileSync(path.join(dir, 'Wow.exe')).equals(newExe))
    assert.ok(fs.readFileSync(path.join(dir, 'Data', 'patch-5.MPQ')).equals(patch))
    assert.ok(!fs.existsSync(path.join(dir, 'Data', 'patch-old.MPQ')))
    assert.ok(fs.existsSync(path.join(dir, 'keep-me.txt')))
    assert.ok(!fs.existsSync(path.join(dir, '.olk-update')))
    assert.equal(installer.readState('wow32').version, '1.0.1')
    assert.ok(!srv.hits.some((h) => h.path.endsWith('common.MPQ')))

    // Second run: nothing to do, nothing re-downloaded.
    const before = srv.hits.length
    const again = await updater.plan('wow32', manifest)
    assert.equal(again.upToDate, true)
    assert.equal(srv.hits.length, before)

    // A locally corrupted file is detected (repair).
    fs.writeFileSync(path.join(dir, 'Data', 'patch-5.MPQ'), Buffer.alloc(3000, 8))
    const repair = await updater.plan('wow32', manifest, { ignoreCache: true })
    assert.deepEqual(repair.toDownload.map((f) => f.path), ['Data/patch-5.MPQ'])
  } finally { await srv.close() }
})

test('update with a bad file on the server changes nothing in the game folder', async () => {
  const { dir, config, installer } = await installed()
  const good = Buffer.from('good')
  const srv = await serve({ '/a.MPQ': { body: good }, '/b.MPQ': { body: Buffer.from('tampered!') } })
  const manifest = validateManifest({
    schema_version: 1, client: 'wow32', architecture: 'x86', version: '1.0.2',
    files: [
      { path: 'Data/a.MPQ', size: good.length, sha256: sha(good), url: `${srv.base}/a.MPQ` },
      { path: 'Data/b.MPQ', size: 9, sha256: sha(Buffer.from('expected!')), url: `${srv.base}/b.MPQ` }
    ],
    deleted_files: []
  }, 'wow32')
  const updater = new UpdateManager({ config, installer, downloader: new DownloadManager() })
  try {
    const plan = await updater.plan('wow32', manifest)
    await assert.rejects(updater.apply('wow32', manifest, plan), { code: 'CHECKSUM_MISMATCH' })
    assert.ok(!fs.existsSync(path.join(dir, 'Data', 'a.MPQ')), 'nothing swapped in before every file is verified')
    assert.equal(installer.readState('wow32').version, '1.0.0')
  } finally { await srv.close() }
})
