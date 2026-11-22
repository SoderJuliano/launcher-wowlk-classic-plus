'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { DownloadManager } = require('../electron/core/DownloadManager.cjs')
const { SupporterContentManager } = require('../electron/core/SupporterContentManager.cjs')
const { tmpDir, makeConfig, serve } = require('./helpers.cjs')

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

test('SupporterContentManager: sync, activate (with backup), deactivate (full vanilla restore), and instant re-activate', async () => {
  const data = tmpDir()
  const config = makeConfig(data)
  const gameDir = config.clientDir('wow32')
  fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true })

  // Existing vanilla file that the supporter overlay temporarily overrides
  const originalPreset = Buffer.from('VANILLA_PRESET=1\n')
  fs.writeFileSync(path.join(gameDir, 'ReShadePreset.ini'), originalPreset)

  const devMpq = Buffer.from('SUPPORTER_HD_TEXTURES_V1')
  const devPreset = Buffer.from('SUPPORTER_HDR_PRESET=1\n')

  const srv = await serve({
    '/supporter/wow32/v0.1.0/Data/patch-S.MPQ': (req, res) => { res.writeHead(200); res.end(devMpq) },
    '/supporter/wow32/v0.1.0/ReShadePreset.ini': (req, res) => { res.writeHead(200); res.end(devPreset) }
  })

  try {
    const mgr = new SupporterContentManager({ config, downloader: new DownloadManager() })
    const manifest = {
      schema_version: 1,
      client: 'wow32',
      architecture: 'x86',
      version: '0.1.0',
      files: [
        { path: 'Data/patch-S.MPQ', size: devMpq.length, sha256: sha256(devMpq), url: `${srv.base}/supporter/wow32/v0.1.0/Data/patch-S.MPQ` },
        { path: 'ReShadePreset.ini', size: devPreset.length, sha256: sha256(devPreset), url: `${srv.base}/supporter/wow32/v0.1.0/ReShadePreset.ini` }
      ],
      deleted_files: []
    }

    // 1. Sync downloads into .olk-supporter/files/ WITHOUT modifying vanilla files yet
    const synced = await mgr.sync('wow32', manifest)
    assert.equal(synced.version, '0.1.0')
    assert.equal(synced.downloaded, 2)
    assert.equal(fs.existsSync(path.join(gameDir, 'Data', 'patch-S.MPQ')), false)
    assert.equal(fs.readFileSync(path.join(gameDir, 'ReShadePreset.ini')).toString(), 'VANILLA_PRESET=1\n')
    assert.equal(mgr.isActive('wow32'), false)

    // 2. Activate (toggle ON before Play): adds patch-S.MPQ and swaps ReShadePreset.ini
    const act = mgr.activate('wow32')
    assert.equal(act.applied, 2)
    assert.equal(mgr.isActive('wow32'), true)
    assert.equal(fs.readFileSync(path.join(gameDir, 'Data', 'patch-S.MPQ')).toString(), 'SUPPORTER_HD_TEXTURES_V1')
    assert.equal(fs.readFileSync(path.join(gameDir, 'ReShadePreset.ini')).toString(), 'SUPPORTER_HDR_PRESET=1\n')

    // 3. Deactivate (toggle OFF): removes patch-S.MPQ and restores original ReShadePreset.ini
    const deact = mgr.deactivate('wow32')
    assert.equal(deact.reverted, 2)
    assert.equal(mgr.isActive('wow32'), false)
    assert.equal(fs.existsSync(path.join(gameDir, 'Data', 'patch-S.MPQ')), false)
    assert.equal(fs.readFileSync(path.join(gameDir, 'ReShadePreset.ini')).toString(), 'VANILLA_PRESET=1\n')

    // 4. Re-sync is a 0-download no-op (cache kept) and re-activate works immediately
    const resync = await mgr.sync('wow32', manifest)
    assert.equal(resync.downloaded, 0)
    const react = mgr.activate('wow32')
    assert.equal(react.applied, 2)
    assert.equal(fs.readFileSync(path.join(gameDir, 'Data', 'patch-S.MPQ')).toString(), 'SUPPORTER_HD_TEXTURES_V1')
  } finally {
    await srv.close()
  }
})
