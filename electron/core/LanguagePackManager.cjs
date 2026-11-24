'use strict'
/**
 * LanguagePackManager — 100% global, composable, fully reversible game language overlay (e.g. ptBR).
 *
 * Works identically on EVERY client (standard global wow32 AND Supporter overlay, past or future versions)
 * without duplicating channels or modifying Data/patch-Z.MPQ:
 *   - .olk-lang/files/<path>       : global language files (e.g. Data/patch-V.MPQ with 54 DBCs + UI Lua)
 *   - .olk-lang/spells/<sha>.json.gz: global Spell.dbc string dictionary (composed locally onto active Spell.dbc -> Data/patch-~.MPQ)
 *   - .olk-lang/backups/<path>     : backups if any file existed beforehand (also restores legacy patch-Z backups cleanly)
 *   - .olk-lang/active.json        : { language, version, sourceSha256, composedSha256, entries }
 *
 * Switching back to English (enUS) simply removes the overlay files and clears Cache/WDB.
 */
const fs = require('node:fs')
const path = require('node:path')
const { LauncherError } = require('./errors.cjs')
const { resolveInside } = require('./pathSafety.cjs')
const { sha256File } = require('./hashing.cjs')
const { PROTECTED } = require('./UpdateManager.cjs')
const { composeSpellLanguageMpq } = require('./mpqDbcComposer.cjs')
const log = require('./logger.cjs')

const ROOT_DIR = '.olk-lang'

class LanguagePackManager {
  constructor({ config, downloader }) {
    this.config = config
    this.downloader = downloader
  }

  #paths(clientId) {
    const gameDir = this.config.clientDir(clientId)
    const root = path.join(gameDir, ROOT_DIR)
    return {
      gameDir,
      root,
      variantsDir: path.join(root, 'variants'),
      spellsDir: path.join(root, 'spells'),
      filesDir: path.join(root, 'files'),
      backupsDir: path.join(root, 'backups'),
      activeFile: path.join(root, 'active.json')
    }
  }

  readActive(clientId) {
    try {
      return JSON.parse(fs.readFileSync(this.#paths(clientId).activeFile, 'utf8'))
    } catch {
      return null
    }
  }

  isActive(clientId) {
    return !!this.readActive(clientId)
  }

  /** Finds the active source MPQ containing Spell.dbc (prefers Data/patch-Z.MPQ, falls back to Data/patch-4.MPQ). */
  #resolveSpellSourceMpq(gameDir, preferredRel = 'Data/patch-Z.MPQ') {
    const candidates = [preferredRel, 'Data/patch-Z.MPQ', 'Data/patch-4.MPQ']
    for (const rel of candidates) {
      try {
        const full = resolveInside(gameDir, rel)
        if (fs.existsSync(full)) return { rel, full }
      } catch { /* ignore */ }
    }
    return null
  }

  /** Returns the SHA-256 of the underlying base file (Data/patch-Z.MPQ), used both for spell_patch change detection and legacy manifests. */
  async currentBaseSha256(clientId, targetPath = 'Data/patch-Z.MPQ', { signal } = {}) {
    const p = this.#paths(clientId)
    const active = this.readActive(clientId)
    // Legacy active.json replaced Data/patch-Z.MPQ directly; new composable mode never touches it.
    if (active?.baseSha256 && !active?.spellPatch && active.entries?.some((e) => e.path.toLowerCase() === targetPath.toLowerCase())) {
      return active.baseSha256
    }
    const src = this.#resolveSpellSourceMpq(p.gameDir, targetPath)
    if (!src) return null
    return (await sha256File(src.full, { signal })).toLowerCase()
  }

  /** Resolves legacy variant if manifest has no spell_patch/files; for composable global manifests always returns composable=true. */
  async resolveVariant(clientId, manifest, { signal } = {}) {
    if (!manifest) return { baseSha: null, variant: null, composable: false }
    const composable = !!(manifest.spell_patch || (manifest.files && manifest.files.length > 0))
    const sourceRel = manifest.spell_patch?.source_mpq || manifest.target_path || 'Data/patch-Z.MPQ'
    const baseSha = await this.currentBaseSha256(clientId, sourceRel, { signal })
    const variant = !composable && baseSha && manifest.variants ? manifest.variants[baseSha] || null : null
    return { baseSha, variant, composable }
  }

  /** Downloads missing/stale global language files and spell string dictionary into .olk-lang/ without touching game files. */
  async sync(clientId, manifest, { signal, onProgress } = {}) {
    if (!manifest) return { version: null, baseSha: null, variantMatched: false, downloaded: 0 }
    const p = this.#paths(clientId)
    fs.mkdirSync(p.variantsDir, { recursive: true })
    fs.mkdirSync(p.spellsDir, { recursive: true })
    fs.mkdirSync(p.filesDir, { recursive: true })

    onProgress?.({ phase: 'verifying', done: 0, total: 1, file: `Language pack (${manifest.language})` })
    const { baseSha, variant, composable } = await this.resolveVariant(clientId, manifest, { signal })
    const safeFiles = (manifest.files || []).filter((f) => !PROTECTED.some((re) => re.test(f.path)))
    const sp = manifest.spell_patch || null

    const queue = []
    let checked = 0
    const totalToCheck = safeFiles.length + (sp ? 1 : 0) + (variant ? 1 : 0)

    for (const f of safeFiles) {
      if (signal?.aborted) throw new LauncherError('CANCELLED', 'Language pack check cancelled.')
      const dest = resolveInside(p.filesDir, f.path)
      let ok = false
      try {
        const st = fs.statSync(dest)
        if (st.isFile() && st.size === f.size) {
          ok = (await sha256File(dest, { signal })) === f.sha256
        }
      } catch { /* missing */ }
      if (!ok) queue.push({ ...f, dest, displayPath: `${f.path} (${manifest.language})` })
      onProgress?.({ phase: 'verifying', done: ++checked, total: Math.max(1, totalToCheck), file: f.path })
    }

    if (sp) {
      if (signal?.aborted) throw new LauncherError('CANCELLED', 'Language pack check cancelled.')
      const dest = path.join(p.spellsDir, `${sp.sha256}.json.gz`)
      let ok = false
      try {
        const st = fs.statSync(dest)
        if (st.isFile() && st.size === sp.size) {
          ok = (await sha256File(dest, { signal })) === sp.sha256
        }
      } catch { /* missing */ }
      if (!ok) queue.push({ ...sp, dest, displayPath: `Spell translations (${manifest.language})` })
      onProgress?.({ phase: 'verifying', done: ++checked, total: Math.max(1, totalToCheck), file: 'Spell.dbc strings' })
    }

    if (variant) {
      if (signal?.aborted) throw new LauncherError('CANCELLED', 'Language pack check cancelled.')
      const dest = path.join(p.variantsDir, `${variant.sha256}.bin`)
      let ok = false
      try {
        const st = fs.statSync(dest)
        if (st.isFile() && st.size === variant.size) {
          ok = (await sha256File(dest, { signal })) === variant.sha256
        }
      } catch { /* missing */ }
      if (!ok) queue.push({ ...variant, dest, displayPath: `${variant.path} (${manifest.language})` })
      onProgress?.({ phase: 'verifying', done: ++checked, total: Math.max(1, totalToCheck), file: variant.path })
    }

    const totalBytes = queue.reduce((n, f) => n + f.size, 0)
    let doneBytes = 0
    for (const item of queue) {
      fs.mkdirSync(path.dirname(item.dest), { recursive: true })
      await this.downloader.download({
        url: item.url,
        dest: item.dest,
        size: item.size,
        sha256: item.sha256,
        signal,
        onProgress: (prog) => onProgress?.({
          phase: 'downloading',
          done: doneBytes + prog.received,
          total: totalBytes,
          file: item.displayPath,
          bytesPerSec: prog.bytesPerSec
        })
      })
      doneBytes += item.size
    }

    const matched = composable || !!variant
    log.info(`language pack ${manifest.language} synced for ${clientId} v${manifest.version} (composable=${composable}, downloaded=${queue.length})`)
    return { version: manifest.version, baseSha, variantMatched: matched, composable, downloaded: queue.length }
  }

  /**
   * Applies the cached global language pack into <gameDir>:
   *   1. Copies global files (e.g. Data/patch-V.MPQ)
   *   2. Composes Data/patch-~.MPQ locally from the active Spell.dbc + spell-strings-<lang>.json.gz
   *      preserving 100% of non-string fields from whichever client layer is active (global OR supporter).
   */
  async activate(clientId, manifest, { signal } = {}) {
    if (!manifest) return { applied: 0, missingVariant: true }
    const p = this.#paths(clientId)
    const active = this.readActive(clientId)
    const { baseSha, variant, composable } = await this.resolveVariant(clientId, manifest, { signal })
    const sp = manifest.spell_patch || null

    if (active) {
      let hashesOk = true
      if (composable) {
        if (sp && active.composedSha256) {
          try {
            const t = resolveInside(p.gameDir, sp.target_mpq)
            hashesOk = fs.existsSync(t) && (await sha256File(t, { signal })) === active.composedSha256
          } catch { hashesOk = false }
        }
        if (hashesOk && Array.isArray(manifest.files)) {
          for (const f of manifest.files) {
            try {
              const t = resolveInside(p.gameDir, f.path)
              if (!fs.existsSync(t) || (await sha256File(t, { signal })) !== f.sha256) {
                hashesOk = false
                break
              }
            } catch { hashesOk = false; break }
          }
        }
      } else if (variant) {
        try {
          const target = resolveInside(p.gameDir, variant.path)
          hashesOk = fs.existsSync(target) && (await sha256File(target, { signal })) === variant.sha256
        } catch { hashesOk = false }
      }

      if (
        active.language === manifest.language &&
        active.version === manifest.version &&
        active.baseSha256 === baseSha &&
        !!active.spellPatch === !!sp &&
        hashesOk &&
        this.#allActivePresent(p.gameDir, active.entries)
      ) {
        return { applied: active.entries.length, alreadyActive: true, missingVariant: false }
      }
      this.deactivate(clientId)
    }

    const toApply = []
    for (const f of manifest.files || []) {
      if (PROTECTED.some((re) => re.test(f.path))) continue
      const cached = resolveInside(p.filesDir, f.path)
      if (fs.existsSync(cached)) toApply.push({ path: f.path, cached })
    }
    if (variant && !PROTECTED.some((re) => re.test(variant.path))) {
      const cached = path.join(p.variantsDir, `${variant.sha256}.bin`)
      if (fs.existsSync(cached)) toApply.push({ path: variant.path, cached })
    }

    const spellGzPath = sp ? path.join(p.spellsDir, `${sp.sha256}.json.gz`) : null
    const canComposeSpell = !!(sp && spellGzPath && fs.existsSync(spellGzPath) && !PROTECTED.some((re) => re.test(sp.target_mpq)))

    if (!toApply.length && !canComposeSpell) {
      log.warn(`language pack ${manifest.language} has no cached files to activate for ${clientId}`)
      return { applied: 0, missingVariant: !composable }
    }

    fs.mkdirSync(p.backupsDir, { recursive: true })
    const applied = []
    let composedSha256 = null
    try {
      for (const item of toApply) {
        const target = resolveInside(p.gameDir, item.path)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        let hadOriginal = false
        if (fs.existsSync(target)) {
          const bak = resolveInside(p.backupsDir, item.path)
          fs.mkdirSync(path.dirname(bak), { recursive: true })
          fs.renameSync(target, bak)
          hadOriginal = true
        }
        fs.copyFileSync(item.cached, target)
        applied.push({ path: item.path, hadOriginal })
      }

      if (canComposeSpell) {
        const src = this.#resolveSpellSourceMpq(p.gameDir, sp.source_mpq)
        if (!src) {
          throw new LauncherError('LANG_ACTIVATE_FAILED', `Base MPQ (${sp.source_mpq}) not found to compose ${manifest.language} spells.`)
        }
        const target = resolveInside(p.gameDir, sp.target_mpq)
        let hadOriginal = false
        if (fs.existsSync(target)) {
          const bak = resolveInside(p.backupsDir, sp.target_mpq)
          fs.mkdirSync(path.dirname(bak), { recursive: true })
          fs.renameSync(target, bak)
          hadOriginal = true
        }
        const res = composeSpellLanguageMpq({
          sourceMpqPath: src.full,
          spellPatchGzPath: spellGzPath,
          outputMpqPath: target
        })
        composedSha256 = (await sha256File(target, { signal })).toLowerCase()
        applied.push({ path: sp.target_mpq, hadOriginal })
        log.info(`composed ${sp.target_mpq} (${manifest.language}): ${res.translatedRows}/${res.recordCount} spells from ${src.rel} (${res.archiveSize} B)`)
      }

      this.#clearWdbCache(p.gameDir)
      this.#writeJsonAtomic(p.activeFile, {
        language: manifest.language,
        version: manifest.version,
        baseSha256: baseSha,
        spellPatch: !!canComposeSpell,
        composedSha256,
        activatedAt: new Date().toISOString(),
        entries: applied
      })
      log.info(`language pack ${manifest.language} activated for ${clientId} v${manifest.version} (${applied.length} files)`)
      return { applied: applied.length, missingVariant: false }
    } catch (err) {
      log.error(`language pack activation failed for ${clientId}, rolling back`, err)
      this.#revertEntries(p, applied)
      throw err instanceof LauncherError ? err : new LauncherError(
        err.code === 'EBUSY' || err.code === 'EPERM' ? 'FILES_IN_USE' : 'LANG_ACTIVATE_FAILED',
        err.code === 'EBUSY' || err.code === 'EPERM' ? 'Game files are in use. Close the game and try again.' : `Failed to activate language pack: ${err.message}`
      )
    }
  }

  /** Reverts any active language pack so <gameDir> is restored to English and clears Cache/WDB. */
  deactivate(clientId) {
    const p = this.#paths(clientId)
    const active = this.readActive(clientId)
    if (!active || !Array.isArray(active.entries)) return { reverted: 0 }

    this.#revertEntries(p, active.entries)
    try { fs.rmSync(p.activeFile, { force: true }) } catch { /* ignore */ }
    try { fs.rmSync(p.backupsDir, { recursive: true, force: true }) } catch { /* ignore */ }
    this.#clearWdbCache(p.gameDir)
    log.info(`language pack deactivated for ${clientId} (${active.entries.length} files reverted)`)
    return { reverted: active.entries.length }
  }

  #clearWdbCache(gameDir) {
    try {
      const wdb = path.join(gameDir, 'Cache', 'WDB')
      if (fs.existsSync(wdb)) fs.rmSync(wdb, { recursive: true, force: true })
    } catch (err) {
      log.warn('failed to clear Cache/WDB', err.message)
    }
  }

  #revertEntries(p, entries) {
    for (const entry of [...entries].reverse()) {
      try {
        const target = resolveInside(p.gameDir, entry.path)
        if (fs.existsSync(target)) fs.rmSync(target, { force: true })
        if (entry.hadOriginal) {
          const bak = resolveInside(p.backupsDir, entry.path)
          if (fs.existsSync(bak)) {
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.renameSync(bak, target)
          }
        }
      } catch (err) {
        log.warn(`failed to revert language file ${entry.path}`, err.message)
      }
    }
  }

  #allActivePresent(gameDir, entries) {
    if (!Array.isArray(entries)) return false
    return entries.every((e) => {
      try { return fs.existsSync(resolveInside(gameDir, e.path)) } catch { return false }
    })
  }

  #writeJsonAtomic(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
    fs.renameSync(tmp, file)
  }
}

module.exports = { LanguagePackManager }
