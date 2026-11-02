'use strict'
/**
 * UpdateManager — incremental, file-level updates driven by the manifest.
 *
 *  plan():  compare manifest files with local files (size first, then SHA-256 with a
 *           size+mtime cache so unchanged files are never re-hashed or re-downloaded).
 *  apply(): download every needed file to "<game>/.olk-update/staging/<path>" (SHA-256
 *           verified), then swap them in with rename (old copies kept in .olk-update/backup
 *           until the whole batch succeeds → rollback on failure), then delete ONLY the
 *           paths listed in deleted_files, then record the new version.
 */
const fs = require('node:fs')
const path = require('node:path')
const { LauncherError } = require('./errors.cjs')
const { resolveInside } = require('./pathSafety.cjs')
const { sha256File } = require('./hashing.cjs')
const log = require('./logger.cjs')

const WORK_DIR = '.olk-update'
const HASH_CACHE = '.olk-hashes.json'
/** Player data the manifest can never delete or overwrite through deleted_files. */
const PROTECTED = [/^wtf\/account(\/|$)/i, /^screenshots(\/|$)/i, /^\.olk/i]

class UpdateManager {
  constructor({ config, installer, downloader }) {
    this.config = config
    this.installer = installer
    this.downloader = downloader
  }

  #cachePath(dir) { return path.join(dir, HASH_CACHE) }
  #readCache(dir) { try { return JSON.parse(fs.readFileSync(this.#cachePath(dir), 'utf8')) } catch { return {} } }
  #writeCache(dir, c) { fs.writeFileSync(this.#cachePath(dir), JSON.stringify(c)) }

  /** @returns {Promise<{ toDownload: object[], toDelete: string[], downloadBytes: number, upToDate: boolean }>} */
  async plan(id, manifest, { signal, onProgress, ignoreCache = false } = {}) {
    const dir = this.config.clientDir(id)
    const cache = this.#readCache(dir)
    const toDownload = []
    let checked = 0
    for (const f of manifest.files) {
      if (signal?.aborted) throw new LauncherError('CANCELLED', 'Update check cancelled.')
      const local = resolveInside(dir, f.path)
      let st = null
      try { st = fs.statSync(local) } catch { /* missing */ }
      if (!st || !st.isFile() || st.size !== f.size) {
        toDownload.push(f)
      } else {
        const key = f.path.toLowerCase()
        const c = cache[key]
        let hash = !ignoreCache && c && c.size === st.size && c.mtimeMs === st.mtimeMs ? c.sha256 : null
        if (!hash) {
          hash = await sha256File(local, { signal })
          cache[key] = { size: st.size, mtimeMs: st.mtimeMs, sha256: hash }
        }
        if (hash !== f.sha256) toDownload.push(f)
      }
      onProgress?.({ phase: 'verifying', done: ++checked, total: manifest.files.length, file: f.path })
    }
    this.#writeCache(dir, cache)
    const toDelete = manifest.deleted_files.filter((p) => !PROTECTED.some((re) => re.test(p)) && fs.existsSync(resolveInside(dir, p)))
    const state = this.installer.readState(id)
    return {
      toDownload,
      toDelete,
      downloadBytes: toDownload.reduce((n, f) => n + f.size, 0),
      upToDate: !toDownload.length && !toDelete.length && state?.version === manifest.version
    }
  }

  async apply(id, manifest, plan, { signal, onProgress } = {}) {
    const dir = this.config.clientDir(id)
    const work = path.join(dir, WORK_DIR)
    const staging = path.join(work, 'staging')
    const backup = path.join(work, 'backup')
    fs.mkdirSync(staging, { recursive: true })

    // 1) Download (resumable, verified) — nothing in the game folder changes yet.
    const total = plan.downloadBytes
    let doneBytes = 0
    for (const f of plan.toDownload) {
      const tmp = resolveInside(staging, f.path)
      if (fs.existsSync(tmp) && fs.statSync(tmp).size === f.size && (await sha256File(tmp, { signal })) === f.sha256) {
        doneBytes += f.size
        continue // already fetched in an interrupted run
      }
      await this.downloader.download({
        url: f.url, dest: tmp, size: f.size, sha256: f.sha256, signal,
        onProgress: (p) => onProgress?.({ phase: 'downloading', done: doneBytes + p.received, total, file: f.path, bytesPerSec: p.bytesPerSec })
      })
      doneBytes += f.size
    }

    // 2) Swap in with rollback.
    onProgress?.({ phase: 'installing', done: total, total })
    await fs.promises.rm(backup, { recursive: true, force: true })
    const swapped = []
    try {
      for (const f of plan.toDownload) {
        const target = resolveInside(dir, f.path)
        const tmp = resolveInside(staging, f.path)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        if (fs.existsSync(target)) {
          const bak = resolveInside(backup, f.path)
          fs.mkdirSync(path.dirname(bak), { recursive: true })
          fs.renameSync(target, bak)
          swapped.push({ target, bak })
        } else swapped.push({ target, bak: null })
        fs.renameSync(tmp, target)
      }
    } catch (err) {
      log.error('update swap failed, rolling back', err)
      for (const s of swapped.reverse()) {
        try { if (fs.existsSync(s.target)) fs.unlinkSync(s.target); if (s.bak) fs.renameSync(s.bak, s.target) } catch (e) { log.error('rollback step failed', e) }
      }
      throw new LauncherError(err.code === 'EBUSY' || err.code === 'EPERM' ? 'FILES_IN_USE' : 'UPDATE_FAILED', err.code === 'EBUSY' || err.code === 'EPERM' ? 'Game files are in use. Close the game and try again.' : `Update failed: ${err.message}`)
    }

    // 3) Explicit deletions only.
    for (const rel of plan.toDelete) {
      try { await fs.promises.rm(resolveInside(dir, rel), { recursive: true, force: true }) } catch (e) { log.warn(`could not delete ${rel}`, e.message) }
    }

    // 4) Record hashes + version, clean up.
    const cache = this.#readCache(dir)
    for (const f of plan.toDownload) {
      const st = fs.statSync(resolveInside(dir, f.path))
      cache[f.path.toLowerCase()] = { size: st.size, mtimeMs: st.mtimeMs, sha256: f.sha256 }
    }
    for (const rel of plan.toDelete) delete cache[rel.toLowerCase()]
    this.#writeCache(dir, cache)
    const state = this.installer.readState(id) || { client: id }
    this.installer.writeState(id, { ...state, version: manifest.version, updatedAt: new Date().toISOString() })
    await fs.promises.rm(work, { recursive: true, force: true })
    log.info(`updated ${id} to ${manifest.version}: ${plan.toDownload.length} files, ${plan.toDelete.length} deleted`)
    return { version: manifest.version, downloaded: plan.toDownload.length, deleted: plan.toDelete.length }
  }
}

module.exports = { UpdateManager, PROTECTED }
