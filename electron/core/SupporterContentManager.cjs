'use strict'
/**
 * SupporterContentManager — isolated, fully reversible early-access content overlay for supporters.
 *
 * All supporter files live in "<gameDir>/.olk-supporter/":
 *   - files/<path>    : SHA-256 verified cached copies of the supporter manifest files
 *   - backups/<path>  : backups of any base-game files temporarily replaced while active
 *   - state.json      : { version, files: [{ path, size, sha256 }], updatedAt }
 *   - active.json     : { version, entries: [{ path, hadOriginal }] } (present ONLY while active)
 *
 * When toggle is ON  → activate() backs up any colliding base file and copies cached files into <gameDir>.
 * When toggle is OFF → deactivate() removes supporter-only files and restores backed-up base files,
 *                      leaving <gameDir> 100% identical to a regular player's client.
 */
const fs = require('node:fs')
const path = require('node:path')
const { LauncherError } = require('./errors.cjs')
const { resolveInside } = require('./pathSafety.cjs')
const { sha256File } = require('./hashing.cjs')
const { PROTECTED } = require('./UpdateManager.cjs')
const log = require('./logger.cjs')

const ROOT_DIR = '.olk-supporter'

class SupporterContentManager {
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
      filesDir: path.join(root, 'files'),
      backupsDir: path.join(root, 'backups'),
      stateFile: path.join(root, 'state.json'),
      activeFile: path.join(root, 'active.json')
    }
  }

  readState(clientId) {
    try {
      return JSON.parse(fs.readFileSync(this.#paths(clientId).stateFile, 'utf8'))
    } catch {
      return null
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

  /** Downloads/updates the supporter overlay cache inside .olk-supporter/files/ without touching base files. */
  async sync(clientId, manifest, { signal, onProgress } = {}) {
    const p = this.#paths(clientId)
    fs.mkdirSync(p.filesDir, { recursive: true })

    const safeFiles = manifest.files.filter((f) => !PROTECTED.some((re) => re.test(f.path)))
    const toDownload = []
    let checked = 0
    for (const f of safeFiles) {
      if (signal?.aborted) throw new LauncherError('CANCELLED', 'Supporter content check cancelled.')
      const cached = resolveInside(p.filesDir, f.path)
      let ok = false
      try {
        const st = fs.statSync(cached)
        if (st.isFile() && st.size === f.size) {
          ok = (await sha256File(cached, { signal })) === f.sha256
        }
      } catch { /* missing */ }
      if (!ok) toDownload.push(f)
      onProgress?.({ phase: 'verifying', done: ++checked, total: safeFiles.length, file: f.path })
    }

    const totalBytes = toDownload.reduce((n, f) => n + f.size, 0)
    let doneBytes = 0
    for (const f of toDownload) {
      const dest = resolveInside(p.filesDir, f.path)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      await this.downloader.download({
        url: f.url,
        dest,
        size: f.size,
        sha256: f.sha256,
        signal,
        onProgress: (prog) => onProgress?.({
          phase: 'downloading',
          done: doneBytes + prog.received,
          total: totalBytes,
          file: f.path,
          bytesPerSec: prog.bytesPerSec
        })
      })
      doneBytes += f.size
    }

    // Remove stale files from cache that are no longer in the manifest
    const prevState = this.readState(clientId)
    if (prevState?.files) {
      const nextSet = new Set(safeFiles.map((f) => f.path.toLowerCase()))
      for (const old of prevState.files) {
        if (!nextSet.has(old.path.toLowerCase())) {
          try { fs.rmSync(resolveInside(p.filesDir, old.path), { force: true }) } catch { /* ignore */ }
        }
      }
    }

    const state = {
      version: manifest.version,
      files: safeFiles.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
      updatedAt: new Date().toISOString()
    }
    this.#writeJsonAtomic(p.stateFile, state)
    log.info(`supporter content synced for ${clientId} v${manifest.version} (${toDownload.length} downloaded, ${safeFiles.length} total)`)
    return { version: manifest.version, downloaded: toDownload.length, total: safeFiles.length }
  }

  /** Applies the cached supporter overlay into <gameDir>, backing up any overwritten base files. */
  activate(clientId) {
    const p = this.#paths(clientId)
    const state = this.readState(clientId)
    if (!state || !Array.isArray(state.files) || !state.files.length) return { applied: 0 }

    const active = this.readActive(clientId)
    if (active) {
      if (active.version === state.version && this.#allActivePresent(p.gameDir, active.entries)) {
        return { applied: active.entries.length, alreadyActive: true }
      }
      this.deactivate(clientId)
    }

    fs.mkdirSync(p.backupsDir, { recursive: true })
    const applied = []
    try {
      for (const f of state.files) {
        if (PROTECTED.some((re) => re.test(f.path))) continue
        const cached = resolveInside(p.filesDir, f.path)
        if (!fs.existsSync(cached)) {
          throw new LauncherError('SUPPORTER_CACHE_MISSING', `Cached supporter file missing: ${f.path}`)
        }
        const target = resolveInside(p.gameDir, f.path)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        let hadOriginal = false
        if (fs.existsSync(target)) {
          const bak = resolveInside(p.backupsDir, f.path)
          fs.mkdirSync(path.dirname(bak), { recursive: true })
          fs.renameSync(target, bak)
          hadOriginal = true
        }
        fs.copyFileSync(cached, target)
        applied.push({ path: f.path, hadOriginal })
      }
      this.#writeJsonAtomic(p.activeFile, {
        version: state.version,
        activatedAt: new Date().toISOString(),
        entries: applied
      })
      log.info(`supporter overlay activated for ${clientId} v${state.version} (${applied.length} files)`)
      return { applied: applied.length }
    } catch (err) {
      log.error(`supporter overlay activation failed for ${clientId}, rolling back`, err)
      this.#revertEntries(p, applied)
      throw err instanceof LauncherError ? err : new LauncherError(
        err.code === 'EBUSY' || err.code === 'EPERM' ? 'FILES_IN_USE' : 'SUPPORTER_ACTIVATE_FAILED',
        err.code === 'EBUSY' || err.code === 'EPERM' ? 'Game files are in use. Close the game and try again.' : `Failed to activate supporter content: ${err.message}`
      )
    }
  }

  /** Reverts the active supporter overlay so <gameDir> is 100% vanilla/standard. Keeps cache intact. */
  deactivate(clientId) {
    const p = this.#paths(clientId)
    const active = this.readActive(clientId)
    if (!active || !Array.isArray(active.entries)) return { reverted: 0 }

    this.#revertEntries(p, active.entries)
    try { fs.rmSync(p.activeFile, { force: true }) } catch { /* ignore */ }
    try { fs.rmSync(p.backupsDir, { recursive: true, force: true }) } catch { /* ignore */ }
    log.info(`supporter overlay deactivated for ${clientId} (${active.entries.length} files reverted)`)
    return { reverted: active.entries.length }
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
        log.warn(`failed to revert supporter file ${entry.path}`, err.message)
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

module.exports = { SupporterContentManager }
