'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const { ConfigurationManager } = require('../electron/core/ConfigurationManager.cjs')
const { validateLanguageManifest } = require('../electron/core/ManifestService.cjs')
const { LanguagePackManager } = require('../electron/core/LanguagePackManager.cjs')

const DEFAULTS = path.join(__dirname, '..', 'config', 'defaults.json')
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olk-lang-test-'))
  const config = new ConfigurationManager({ defaultsFile: DEFAULTS, dataDir: path.join(tmp, 'data') })
  const gameDir = config.clientDir('wow32')
  fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true })
  fs.mkdirSync(path.join(gameDir, 'Cache', 'WDB', 'enUS'), { recursive: true })
  return { tmp, config, gameDir }
}

describe('LanguagePackManager & gameLanguage config', () => {
  it('validates gameLanguage setting without touching locale', () => {
    const { config } = makeEnv()
    assert.equal(config.get().locale, 'enUS')
    assert.equal(config.get().gameLanguage, 'enUS')
    config.update({ gameLanguage: 'ptBR' })
    assert.equal(config.get().gameLanguage, 'ptBR')
    assert.equal(config.get().locale, 'enUS')
    assert.throws(() => config.update({ gameLanguage: 'frFR' }), /enUS or ptBR/)
  })

  it('alternates EN -> PT-BR -> EN restoring exact original SHA-256 and clearing Cache/WDB', async () => {
    const { config, gameDir } = makeEnv()
    const baseBytes = Buffer.from('BASE-PATCH-Z-ENUS-CONTENT')
    const ptBytes = Buffer.from('VARIANT-PATCH-Z-PTBR-CONTENT')
    const patchZ = path.join(gameDir, 'Data', 'patch-Z.MPQ')
    fs.writeFileSync(patchZ, baseBytes)
    const wdbFile = path.join(gameDir, 'Cache', 'WDB', 'enUS', 'creaturecache.wdb')
    fs.writeFileSync(wdbFile, 'cached')

    const downloader = {
      downloads: 0,
      async download({ dest }) {
        this.downloads++
        fs.writeFileSync(dest, ptBytes)
      }
    }

    const manifest = validateLanguageManifest({
      schema_version: 1,
      client: 'wow32',
      language: 'ptBR',
      version: '1.0.0',
      variants: {
        [sha(baseBytes)]: {
          path: 'Data/patch-Z.MPQ',
          size: ptBytes.length,
          sha256: sha(ptBytes),
          url: 'https://cdn.example.com/lang/wow32/ptBR/v1.0.0/patch-Z.ptBR.MPQ'
        }
      },
      files: []
    }, 'wow32', 'ptBR')

    const mgr = new LanguagePackManager({ config, downloader })
    const syncRes = await mgr.sync('wow32', manifest)
    assert.equal(syncRes.variantMatched, true)
    assert.equal(syncRes.downloaded, 1)

    const actRes = await mgr.activate('wow32', manifest)
    assert.equal(actRes.applied, 1)
    assert.equal(mgr.isActive('wow32'), true)
    assert.equal(sha(fs.readFileSync(patchZ)), sha(ptBytes))
    assert.equal(fs.existsSync(wdbFile), false, 'Cache/WDB must be cleared on activate')

    // Second sync should hit cache without downloading again
    const syncAgain = await mgr.sync('wow32', manifest)
    assert.equal(syncAgain.downloaded, 0)
    assert.equal(downloader.downloads, 1)

    // Deactivate restores original EN bytes byte-for-byte
    fs.mkdirSync(path.dirname(wdbFile), { recursive: true })
    fs.writeFileSync(wdbFile, 'cached-pt')
    const deact = mgr.deactivate('wow32')
    assert.equal(deact.reverted, 1)
    assert.equal(mgr.isActive('wow32'), false)
    assert.equal(sha(fs.readFileSync(patchZ)), sha(baseBytes))
    assert.equal(fs.existsSync(wdbFile), false, 'Cache/WDB must be cleared on deactivate')
  })

  it('does not fail or block when no variant matches the current base patch-Z', async () => {
    const { config, gameDir } = makeEnv()
    const unknownBase = Buffer.from('NEW-DEV-PATCH-Z-WITHOUT-PTBR-YET')
    const patchZ = path.join(gameDir, 'Data', 'patch-Z.MPQ')
    fs.writeFileSync(patchZ, unknownBase)

    const downloader = { async download() { throw new Error('should not download') } }
    const manifest = validateLanguageManifest({
      schema_version: 1,
      client: 'wow32',
      language: 'ptBR',
      version: '1.0.0',
      variants: {
        [sha(Buffer.from('OTHER'))]: {
          path: 'Data/patch-Z.MPQ',
          size: 5,
          sha256: sha(Buffer.from('PTBR!')),
          url: 'https://cdn.example.com/patch.MPQ'
        }
      },
      files: []
    }, 'wow32', 'ptBR')

    const mgr = new LanguagePackManager({ config, downloader })
    const s = await mgr.sync('wow32', manifest)
    assert.equal(s.variantMatched, false)
    assert.equal(s.downloaded, 0)
    const a = await mgr.activate('wow32', manifest)
    assert.equal(a.applied, 0)
    assert.equal(a.missingVariant, true)
    assert.equal(sha(fs.readFileSync(patchZ)), sha(unknownBase))
  })
})
