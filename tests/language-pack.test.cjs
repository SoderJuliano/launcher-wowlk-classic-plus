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

  it('re-applies language pack when active Data/patch-Z.MPQ was overwritten on disk', async () => {
    const { config, gameDir } = makeEnv()
    const baseBytes = Buffer.from('BASE-PATCH-Z-ENUS-CONTENT')
    const ptBytes = Buffer.from('VARIANT-PATCH-Z-PTBR-CONTENT')
    const patchZ = path.join(gameDir, 'Data', 'patch-Z.MPQ')
    fs.writeFileSync(patchZ, baseBytes)

    const downloader = { async download({ dest }) { fs.writeFileSync(dest, ptBytes) } }
    const manifest = validateLanguageManifest({
      schema_version: 1,
      client: 'wow32',
      language: 'ptBR',
      version: '1.0.1',
      variants: {
        [sha(baseBytes)]: {
          path: 'Data/patch-Z.MPQ',
          size: ptBytes.length,
          sha256: sha(ptBytes),
          url: 'https://cdn.example.com/lang/wow32/ptBR/v1.0.1/patch-Z.ptBR.MPQ'
        }
      },
      files: []
    }, 'wow32', 'ptBR')

    const mgr = new LanguagePackManager({ config, downloader })
    await mgr.sync('wow32', manifest)
    await mgr.activate('wow32', manifest)
    assert.equal(sha(fs.readFileSync(patchZ)), sha(ptBytes))

    // Simulate external overwrite of Data/patch-Z.MPQ back to base while active.json still exists
    fs.writeFileSync(patchZ, baseBytes)
    const reactivated = await mgr.activate('wow32', manifest)
    assert.equal(reactivated.alreadyActive, undefined)
    assert.equal(reactivated.applied, 1)
    assert.equal(sha(fs.readFileSync(patchZ)), sha(ptBytes))
  })

  it('LauncherController.play() verifies live manifests before launch and blocks outdated launcher', async () => {
    const { LauncherController } = require('../electron/core/LauncherController.cjs')
    const { LauncherError } = require('../electron/core/errors.cjs')
    const { config } = makeEnv()

    let launchCalled = false
    let updateCalled = false
    let mode = 'newer'
    const ctrl = new LauncherController({
      config,
      api: { lastStatus: { state: 'online' }, request: async () => ({}) },
      auth: { isAuthenticated: () => false, user: null, password: null },
      manifests: {
        fetch: async () => {
          if (mode === 'outdated') throw new LauncherError('LAUNCHER_OUTDATED', 'Launcher too old')
          return { version: '1.0.59', files: [], deleted_files: [] }
        }
      },
      installer: { verify: () => ({ installed: true, state: { version: '1.0.58' }, missing: [] }) },
      game: { isRunning: () => false, launch: async () => { launchCalled = true; return { pid: 1 } } }
    })
    ctrl.update = async (id) => { updateCalled = true; return id }

    // 1. Live manifest reports newer client version -> triggers update before play
    await ctrl.play('wow32')
    assert.equal(updateCalled, true)
    assert.equal(launchCalled, false)

    // 2. Live manifest reports LAUNCHER_OUTDATED -> refuses to launch
    mode = 'outdated'
    await assert.rejects(() => ctrl.play('wow32'), { code: 'LAUNCHER_OUTDATED' })
    assert.equal(launchCalled, false)
  })

  it('composes a single global language pack (patch-V + spell_patch -> patch-~.MPQ) over ANY client without touching patch-Z.MPQ', async () => {
    const zlib = require('node:zlib')
    const { createMpqArchive, extractFileFromMpq } = require('../electron/core/mpqDbcComposer.cjs')
    const { config, gameDir } = makeEnv()

    // Helper: construct a minimal valid 234-field WDBC Spell.dbc with 1 spell (id=133, visualId=customVisual)
    function makeSpellDbc(visualId, nameEn) {
      const fc = 234
      const rs = fc * 4
      const strBuf = Buffer.from(`\0${nameEn}\0`, 'utf8')
      const hdr = Buffer.alloc(20)
      hdr.write('WDBC', 0, 'ascii')
      hdr.writeUInt32LE(1, 4)
      hdr.writeUInt32LE(fc, 8)
      hdr.writeUInt32LE(rs, 12)
      hdr.writeUInt32LE(strBuf.length, 16)
      const row = Buffer.alloc(rs)
      row.writeUInt32LE(133, 0)         // spellId
      row.writeUInt32LE(visualId, 131 * 4) // SpellVisualID[0]
      row.writeUInt32LE(1, 136 * 4)    // Name_lang[0] -> offset 1
      row.writeUInt32LE(0x10101ff, 152 * 4) // Name_lang flags
      return Buffer.concat([hdr, row, strBuf])
    }

    const patchZPath = path.join(gameDir, 'Data', 'patch-Z.MPQ')
    const patchVBytes = Buffer.from('GLOBAL-PATCH-V-54-DBCS-AND-LUA')
    const spellGzBytes = zlib.gzipSync(Buffer.from(JSON.stringify({
      schema_version: 1,
      language: 'ptBR',
      locstring_fields: [136, 153, 170, 187],
      spells: { '133': ['Bola de Fogo', 'Grau 1'] }
    })))

    // Start with standard Global patch-Z.MPQ (visualId = 100)
    createMpqArchive(patchZPath, [{ name: 'DBFilesClient\\Spell.dbc', data: makeSpellDbc(100, 'Fireball') }])
    const globalZSha = sha(fs.readFileSync(patchZPath))

    const downloader = {
      downloads: 0,
      async download({ url, dest }) {
        this.downloads++
        fs.writeFileSync(dest, url.endsWith('.gz') ? spellGzBytes : patchVBytes)
      }
    }

    const manifest = validateLanguageManifest({
      schema_version: 1,
      client: 'wow32',
      language: 'ptBR',
      version: '2.0.0',
      files: [{ path: 'Data/patch-V.MPQ', size: patchVBytes.length, sha256: sha(patchVBytes), url: 'https://cdn.example.com/patch-V.MPQ' }],
      spell_patch: {
        target_mpq: 'Data/patch-~.MPQ',
        source_mpq: 'Data/patch-Z.MPQ',
        size: spellGzBytes.length,
        sha256: sha(spellGzBytes),
        url: 'https://cdn.example.com/spell-strings-ptBR.json.gz'
      },
      variants: {}
    }, 'wow32', 'ptBR')

    const mgr = new LanguagePackManager({ config, downloader })
    const s = await mgr.sync('wow32', manifest)
    assert.equal(s.composable, true)
    assert.equal(s.downloaded, 2)

    // Activate on Global client: patch-Z untouched, patch-V and patch-~ created with visualId=100 + PT-BR name
    const a1 = await mgr.activate('wow32', manifest)
    assert.equal(a1.applied, 2)
    assert.equal(sha(fs.readFileSync(patchZPath)), globalZSha, 'Data/patch-Z.MPQ must NEVER be modified')
    const dbc1 = extractFileFromMpq(path.join(gameDir, 'Data', 'patch-~.MPQ'), 'DBFilesClient\\Spell.dbc')
    assert.equal(dbc1.readUInt32LE(20 + 131 * 4), 100, 'Global SpellVisualID preserved')
    const nameOff1 = dbc1.readUInt32LE(20 + 136 * 4)
    const strStart1 = 20 + 234 * 4
    assert.equal(dbc1.toString('utf8', strStart1 + nameOff1, dbc1.indexOf(0, strStart1 + nameOff1)), 'Bola de Fogo')

    // Now simulate Supporter overlay updating Data/patch-Z.MPQ (visualId = 26241) -> same global PT-BR recomposes with 0 downloads!
    createMpqArchive(patchZPath, [{ name: 'DBFilesClient\\Spell.dbc', data: makeSpellDbc(26241, 'Fireball') }])
    const a2 = await mgr.activate('wow32', manifest)
    assert.equal(a2.applied, 2)
    assert.equal(downloader.downloads, 2, 'no extra download needed when supporter updates patch-Z')
    const dbc2 = extractFileFromMpq(path.join(gameDir, 'Data', 'patch-~.MPQ'), 'DBFilesClient\\Spell.dbc')
    assert.equal(dbc2.readUInt32LE(20 + 131 * 4), 26241, 'Supporter SpellVisualID preserved')
    const nameOff2 = dbc2.readUInt32LE(20 + 136 * 4)
    const strStart2 = 20 + 234 * 4
    assert.equal(dbc2.toString('utf8', strStart2 + nameOff2, dbc2.indexOf(0, strStart2 + nameOff2)), 'Bola de Fogo')

    // Deactivate removes patch-V and patch-~ cleanly
    mgr.deactivate('wow32')
    assert.equal(fs.existsSync(path.join(gameDir, 'Data', 'patch-V.MPQ')), false)
    assert.equal(fs.existsSync(path.join(gameDir, 'Data', 'patch-~.MPQ')), false)
  })
})
