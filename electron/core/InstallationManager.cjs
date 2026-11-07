'use strict'
/**
 * InstallationManager — turns the downloaded base ZIP into a ready-to-play client.
 *
 *  1. Checks free disk space (uncompressed size from the ZIP central directory).
 *  2. Extracts into "<installDir>/.staging-<client>" — never directly into the live folder.
 *     Each entry: path validated (no traversal / absolute / symlinks), CRC-32 verified.
 *  3. Strips the package root folder (e.g. "ChromieCraft_3.3.5a/").
 *  4. Validates required files, applies the realmlist.
 *  5. Reinstall: moves the player's WTF/Account and Screenshots into the new install.
 *  6. Swaps staging → "<installDir>/<client>" and writes the install state file.
 * An interrupted install leaves the previous installation untouched.
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const yauzl = require('yauzl')
const { LauncherError } = require('./errors.cjs')
const { normalizeRelative, resolveInside } = require('./pathSafety.cjs')
const { applyRealmlist, detectLocales } = require('./realmlist.cjs')
const { freeBytes } = require('./PlatformService.cjs')
const log = require('./logger.cjs')

const STATE_FILE = '.olk-install.json'
const PRESERVE_ON_REINSTALL = ['WTF/Account', 'Screenshots']

const openZip = (file) => new Promise((resolve, reject) =>
  yauzl.open(file, { lazyEntries: true, autoClose: false, strictFileNames: false, validateEntrySizes: true }, (err, zip) => (err ? reject(new LauncherError('ZIP_INVALID', `The game package is not a valid ZIP: ${err.message}`)) : resolve(zip))))

/** Reads the central directory only: [{ name, size, crc32, isDir, isSymlink }]. */
async function listZip(file) {
  const zip = await openZip(file)
  const entries = []
  await new Promise((resolve, reject) => {
    zip.on('entry', (e) => {
      const mode = (e.externalFileAttributes >>> 16) & 0o170000
      entries.push({ name: e.fileName, size: e.uncompressedSize, crc32: e.crc32, isDir: e.fileName.endsWith('/'), isSymlink: mode === 0o120000, entry: e })
      zip.readEntry()
    })
    zip.on('end', resolve)
    // yauzl itself rejects "../" and absolute names — surface that as an unsafe package.
    zip.on('error', (e) => reject(/relative path|absolute path|invalid characters/i.test(e.message) ? new LauncherError('UNSAFE_PATH', `Unsafe file name in package: ${e.message}`) : new LauncherError('ZIP_INVALID', `The game package is damaged: ${e.message}`)))
    zip.readEntry()
  })
  return { zip, entries }
}

function stripRoot(name, root) {
  const n = name.replace(/\\/g, '/')
  if (root) return n.startsWith(root) ? n.slice(root.length) : null
  return n
}

class InstallationManager {
  /** @param {{ config: import('./ConfigurationManager.cjs').ConfigurationManager }} deps */
  constructor({ config }) {
    this.config = config
  }

  statePath(id) { return path.join(this.config.clientDir(id), STATE_FILE) }

  readState(id) {
    try { return JSON.parse(fs.readFileSync(this.statePath(id), 'utf8')) } catch { return null }
  }

  writeState(id, state) {
    const f = this.statePath(id)
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(state, null, 2))
    fs.renameSync(`${f}.tmp`, f)
  }

  requiredFiles(id, locale) {
    const c = this.config.client(id)
    return (c.requiredFiles || []).map((f) => f.replaceAll('{locale}', locale))
  }

  /** Checks the installed files. Returns { installed, missing, locale }. */
  verify(id) {
    const dir = this.config.clientDir(id)
    const state = this.readState(id)
    if (!state || !fs.existsSync(dir)) return { installed: false, missing: [], state: null }
    const locale = state.locale || this.config.get().locale
    const required = [...this.requiredFiles(id, locale), this.config.client(id).executable].filter(Boolean)
    const missing = required.filter((rel) => {
      try { return !fs.statSync(resolveInside(dir, rel)).isFile() } catch { return true }
    })
    return { installed: missing.length === 0, missing, state }
  }

  /**
   * Checks whether `dir` (or a single sub-folder of it, e.g. "ChromieCraft_3.3.5a") contains
   * a usable client. Returns { ok, dir, missing, locale }.
   */
  detect(id, dir) {
    const client = this.config.client(id)
    const tryDir = (d) => {
      const locales = detectLocales(d)
      const locale = locales.includes(this.config.get().locale) ? this.config.get().locale : locales[0] || this.config.get().locale
      const required = [...this.requiredFiles(id, locale), client.executable].filter(Boolean)
      const missing = required.filter((rel) => { try { return !fs.statSync(resolveInside(d, rel)).isFile() } catch { return true } })
      return { ok: missing.length === 0, dir: d, missing, locale }
    }
    const direct = tryDir(dir)
    if (direct.ok) return direct
    try {
      const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      for (const s of subs) {
        const r = tryDir(path.join(dir, s.name))
        if (r.ok) return r
      }
    } catch { /* unreadable */ }
    return direct
  }

  /**
   * Adopts an existing client folder in place (no copy): validates it, writes the install
   * state and the realmlist. Updates then patch that folder directly.
   */
  adopt(id, dir) {
    const r = this.detect(id, dir)
    if (!r.ok) throw new LauncherError('NOT_A_GAME_FOLDER', `This folder does not contain the game client. Missing: ${r.missing.slice(0, 4).join(', ')}${r.missing.length > 4 ? '…' : ''}`)
    const cfg = this.config.get()
    const statePath = path.join(r.dir, STATE_FILE)
    let state = null
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch { /* first adoption */ }
    const realm = applyRealmlist(r.dir, cfg.realmlist, r.locale)
    state = {
      client: id,
      architecture: this.config.client(id).architecture,
      version: state?.version ?? null,
      source: state?.source ?? 'existing-folder',
      locale: realm.locale,
      realmlist: cfg.realmlist,
      installedAt: state?.installedAt ?? new Date().toISOString(),
      adoptedAt: new Date().toISOString()
    }
    fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2))
    fs.renameSync(`${statePath}.tmp`, statePath)
    log.info(`adopted existing ${id} install at ${r.dir}`)
    return { dir: r.dir, state }
  }

  /**
   * @param {{ id: string, zipPath: string, version?: string|null, signal?: AbortSignal,
   *           onProgress?: (p: {phase:string, done:number, total:number, file?:string}) => void }} job
   */
  async installFromZip({ id, zipPath, version = null, signal, onProgress }) {
    const client = this.config.client(id)
    const cfg = this.config.get()
    const finalDir = this.config.clientDir(id)
    const staging = path.join(cfg.installDir, `.staging-${id}`)

    onProgress?.({ phase: 'checking', done: 0, total: 1 })
    const { zip, entries } = await listZip(zipPath)
    // Package root: configured value, or auto-detected when every entry lives under one folder.
    const names = entries.map((e) => e.name.replace(/\\/g, '/'))
    const tops = new Set(names.map((n) => n.split('/')[0]))
    const single = tops.size === 1 && names.some((n) => n.includes('/')) ? `${[...tops][0]}/` : ''
    const root = client.packageRoot && names.every((n) => n.startsWith(client.packageRoot)) ? client.packageRoot : single
    try {
      const files = []
      for (const e of entries) {
        const rel = stripRoot(e.name, root)
        if (rel === null) throw new LauncherError('ZIP_UNEXPECTED_LAYOUT', `Unexpected file outside "${root}": ${e.name}`)
        if (!rel || e.isDir) continue
        if (e.isSymlink) throw new LauncherError('UNSAFE_PATH', `Symbolic links are not allowed: ${e.name}`)
        files.push({ ...e, rel: normalizeRelative(rel) })
      }
      const total = files.reduce((n, f) => n + f.size, 0)
      const free = await freeBytes(cfg.installDir)
      if (free !== null && free < total * 1.02 + 512 * 1024 * 1024) {
        throw new LauncherError('DISK_FULL', `Not enough disk space: ${gb(total)} GB needed, ${gb(free)} GB free.`)
      }

      await fs.promises.rm(staging, { recursive: true, force: true })
      fs.mkdirSync(staging, { recursive: true })
      let done = 0
      for (const f of files) {
        if (signal?.aborted) throw new LauncherError('CANCELLED', 'Installation cancelled.')
        const target = resolveInside(staging, f.rel)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        await extractEntry(zip, f.entry, target, signal, (n) => {
          done += n
          onProgress?.({ phase: 'extracting', done, total, file: f.rel })
        })
      }
      zip.close()

      onProgress?.({ phase: 'validating', done: total, total })
      const locales = detectLocales(staging)
      const locale = locales.includes(cfg.locale) ? cfg.locale : locales[0]
      const missing = [...this.requiredFiles(id, locale || cfg.locale), client.executable].filter((rel) => !fs.existsSync(resolveInside(staging, rel)))
      if (missing.length) throw new LauncherError('INSTALL_INVALID', `The game package is incomplete. Missing: ${missing.join(', ')}`)

      const realm = applyRealmlist(staging, cfg.realmlist, cfg.locale)

      // Reinstall: keep the player's own data.
      if (fs.existsSync(finalDir)) {
        for (const rel of PRESERVE_ON_REINSTALL) {
          const from = resolveInside(finalDir, rel)
          if (!fs.existsSync(from)) continue
          const to = resolveInside(staging, rel)
          await fs.promises.rm(to, { recursive: true, force: true })
          fs.mkdirSync(path.dirname(to), { recursive: true })
          fs.renameSync(from, to)
        }
      }

      const state = {
        client: id,
        architecture: client.architecture,
        version,
        source: 'base-package',
        locale: realm.locale,
        realmlist: cfg.realmlist,
        installedAt: new Date().toISOString(),
        files: files.length,
        bytes: total
      }
      fs.writeFileSync(path.join(staging, STATE_FILE), JSON.stringify(state, null, 2))

      onProgress?.({ phase: 'finalizing', done: total, total })
      const old = `${finalDir}.old-${Date.now()}`
      if (fs.existsSync(finalDir)) fs.renameSync(finalDir, old)
      fs.renameSync(staging, finalDir)
      if (fs.existsSync(old)) fs.promises.rm(old, { recursive: true, force: true }).catch((e) => log.warn('old install cleanup failed', e.message))
      log.info(`installed ${id} (${files.length} files, ${gb(total)} GB)`)
      return state
    } catch (err) {
      try { zip.close() } catch { /* already closed */ }
      throw err
    }
  }

  /** Re-applies the realmlist (called before every launch so config changes propagate). */
  ensureRealmlist(id, accountName) {
    const cfg = this.config.get()
    const dir = this.config.clientDir(id)
    const state = this.readState(id)
    const r = applyRealmlist(dir, cfg.realmlist, state?.locale || cfg.locale, accountName)
    if (state && state.realmlist !== cfg.realmlist) this.writeState(id, { ...state, realmlist: cfg.realmlist })
    return r
  }
}

function extractEntry(zip, entry, target, signal, onBytes) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, rs) => {
      if (err) return reject(new LauncherError('ZIP_INVALID', `Cannot read ${entry.fileName}: ${err.message}`))
      let crc = 0
      const out = fs.createWriteStream(target)
      const abort = () => rs.destroy(new LauncherError('CANCELLED', 'Installation cancelled.'))
      signal?.addEventListener('abort', abort, { once: true })
      rs.on('data', (chunk) => { crc = zlib.crc32(chunk, crc); onBytes(chunk.length) })
      rs.on('error', (e) => { out.destroy(); reject(e instanceof LauncherError ? e : new LauncherError('ZIP_INVALID', `Corrupted data in ${entry.fileName}: ${e.message}`)) })
      out.on('error', (e) => reject(new LauncherError(e.code === 'ENOSPC' ? 'DISK_FULL' : 'WRITE_FAILED', `Cannot write ${entry.fileName}: ${e.message}`)))
      out.on('finish', () => {
        signal?.removeEventListener('abort', abort)
        if ((crc >>> 0) !== (entry.crc32 >>> 0)) return reject(new LauncherError('CHECKSUM_MISMATCH', `CRC check failed for ${entry.fileName}. The package is corrupted.`))
        resolve()
      })
      rs.pipe(out)
    })
  })
}

const gb = (n) => (n / 1024 ** 3).toFixed(1)

module.exports = { InstallationManager, listZip, STATE_FILE }
