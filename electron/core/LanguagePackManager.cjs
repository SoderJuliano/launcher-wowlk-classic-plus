'use strict'
/**
 * LanguagePackManager — isolated, fully reversible game language overlay (e.g. ptBR).
 *
 * All language pack files live in "<gameDir>/.olk-lang/":
 *   - variants/<sha256>.bin : SHA-256 verified cached variant of Data/patch-Z.MPQ (matched by base SHA-256)
 *   - files/<path>          : optional extra files (e.g. language addon)
 *   - backups/<path>        : backups of base files temporarily replaced while active
 *   - active.json           : { language, version, baseSha256, entries: [{ path, hadOriginal }] }
 *
 * English (enUS) is always the default; deactivating restores every original file byte-for-byte and clears Cache/WDB.
 */
const fs = require('node:fs')
const path = require('node:path')
const { LauncherError } = require('./errors.cjs')
const { resolveInside } = require('./pathSafety.cjs')
const { sha256File } = require('./hashing.cjs')
const { PROTECTED } = require('./UpdateManager.cjs')
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

  /** Returns the SHA-256 of the underlying base target file (e.g. Data/patch-Z.MPQ), even if currently overlaid. */
  async currentBaseSha256(clientId, targetPath = 'Data/patch-Z.MPQ', { signal } = {}) {
    const active = this.readActive(clientId)
    if (active?.baseSha256) return active.baseSha256
    const p = this.#paths(clientId)
    const target = resolveInside(p.gameDir, targetPath)
    if (!fs.existsSync(target)) return null
    return (await sha256File(target, { signal })).toLowerCase()
  }

  /** Resolves which variant in the language manifest matches the currently installed base Data/patch-Z.MPQ. */
  async resolveVariant(clientId, manifest, { signal } = {}) {
    if (!manifest) return { baseSha: null, variant: null }
    const baseSha = await this.currentBaseSha256(clientId, manifest.target_path || 'Data/patch-Z.MPQ', { signal })
    const variant = baseSha && manifest.variants ? manifest.variants[baseSha] || null : null
    return { baseSha, variant }
  }

  /** Downloads missing/stale variant and extra files into .olk-lang/ without modifying game files. */
  async sync(clientId, manifest, { signal, onProgress } = {}) {
    if (!manifest) return { version: null, baseSha: null, variantMatched: false, downloaded: 0 }
    const p = this.#paths(clientId)
    fs.mkdirSync(p.variantsDir, { recursive: true })
    fs.mkdirSync(p.filesDir, { recursive: true })

    onProgress?.({ phase: 'verifying', done: 0, total: 1, file: manifest.target_path || 'Data/patch-Z.MPQ' })
    const { baseSha, variant } = await this.resolveVariant(clientId, manifest, { signal })
    const safeFiles = (manifest.files || []).filter((f) => !PROTECTED.some((re) => re.test(f.path)))

    const queue = []
    let checked = 0
    const totalToCheck = (variant ? 1 : 0) + safeFiles.length

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
      onProgress?.({ phase: 'verifying', done: ++checked, total: totalToCheck, file: variant.path })
    }

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
      if (!ok) queue.push({ ...f, dest, displayPath: f.path })
      onProgress?.({ phase: 'verifying', done: ++checked, total: totalToCheck, file: f.path })
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

    log.info(`language pack ${manifest.language} synced for ${clientId} v${manifest.version} (variantMatched=${!!variant}, downloaded=${queue.length})`)
    return { version: manifest.version, baseSha, variantMatched: !!variant, downloaded: queue.length }
  }

  /** Applies the cached language pack into <gameDir>, backing up original files and clearing Cache/WDB. */
  async activate(clientId, manifest, { signal } = {}) {
    if (!manifest) return { applied: 0, missingVariant: true }
    const p = this.#paths(clientId)
    const active = this.readActive(clientId)

    // Determine what the underlying base SHA-256 is before activating
    const { baseSha, variant } = await this.resolveVariant(clientId, manifest, { signal })
    if (active) {
      let hashMatches = true
      if (variant) {
        try {
          const target = resolveInside(p.gameDir, variant.path)
          hashMatches = fs.existsSync(target) && (await sha256File(target, { signal })) === variant.sha256
        } catch {
          hashMatches = false
        }
      }
      if (
        active.language === manifest.language &&
        active.version === manifest.version &&
        active.baseSha256 === baseSha &&
        hashMatches &&
        this.#allActivePresent(p.gameDir, active.entries)
      ) {
        return { applied: active.entries.length, alreadyActive: true, missingVariant: !variant }
      }
      this.deactivate(clientId)
    }

    const toApply = []
    if (variant && !PROTECTED.some((re) => re.test(variant.path))) {
      const cached = path.join(p.variantsDir, `${variant.sha256}.bin`)
      if (fs.existsSync(cached)) {
        toApply.push({ path: variant.path, cached })
      }
    }
    for (const f of manifest.files || []) {
      if (PROTECTED.some((re) => re.test(f.path))) continue
      const cached = resolveInside(p.filesDir, f.path)
      if (fs.existsSync(cached)) toApply.push({ path: f.path, cached })
    }

    if (!toApply.length) {
      log.warn(`language pack ${manifest.language} has no matching cached variant for base ${baseSha || 'unknown'}`)
      return { applied: 0, missingVariant: !variant }
    }

    fs.mkdirSync(p.backupsDir, { recursive: true })
    const applied = []
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
      this.#clearWdbCache(p.gameDir)
      this.#writeJsonAtomic(p.activeFile, {
        language: manifest.language,
        version: manifest.version,
        baseSha256: baseSha,
        activatedAt: new Date().toISOString(),
        entries: applied
      })
      log.info(`language pack ${manifest.language} activated for ${clientId} v${manifest.version} (${applied.length} files)`)
      return { applied: applied.length, missingVariant: !variant }
    } catch (err) {
      log.error(`language pack activation failed for ${clientId}, rolling back`, err)
      this.#revertEntries(p, applied)
      throw err instanceof LauncherError ? err : new LauncherError(
        err.code === 'EBUSY' || err.code === 'EPERM' ? 'FILES_IN_USE' : 'LANG_ACTIVATE_FAILED',
        err.code === 'EBUSY' || err.code === 'EPERM' ? 'Game files are in use. Close the game and try again.' : `Failed to activate language pack: ${err.message}`
      )
    }
  }

  /** Reverts any active language pack so <gameDir> is restored to English (original files) and clears Cache/WDB. */
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
