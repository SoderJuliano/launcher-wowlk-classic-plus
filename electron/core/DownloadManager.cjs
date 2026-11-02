'use strict'
/**
 * DownloadManager — single-file HTTP(S) downloads with:
 *   - temporary "<dest>.part" file + "<dest>.part.json" metadata (resume with Range when possible)
 *   - progress (bytes, total, speed), cancellation (AbortSignal), stall timeout
 *   - size + SHA-256 verification BEFORE the file is renamed into place
 *   - Google Drive large-file confirmation pages
 */
const fs = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { LauncherError } = require('./errors.cjs')
const { assertSafeUrl } = require('./pathSafety.cjs')
const drive = require('./googleDrive.cjs')
const { sha256File } = require('./hashing.cjs')
const log = require('./logger.cjs')

const STALL_MS = 60_000
const MAX_DRIVE_HOPS = 3

class DownloadManager {
  constructor({ fetchImpl } = {}) {
    this.fetch = fetchImpl || globalThis.fetch
  }

  /** A shared Drive FOLDER link resolves to the .zip inside it (the most recent listing entry). */
  async resolveDriveFolder(url) {
    const id = drive.extractFolderId(url)
    if (!id) throw new LauncherError('DRIVE_FOLDER', 'Invalid Google Drive folder link.')
    let html
    try {
      const res = await this.fetch(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}`, { headers: { 'User-Agent': 'OLKPlusLauncher' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      html = await res.text()
    } catch (err) {
      throw new LauncherError('NETWORK', `Could not open the Google Drive folder: ${err.message}`)
    }
    const zips = drive.parseFolderListing(html).filter((f) => /\.zip$/i.test(f.name))
    if (!zips.length) throw new LauncherError('DRIVE_FOLDER_EMPTY', 'No .zip file is publicly visible in the Google Drive folder yet.')
    log.info(`drive folder resolved to ${zips[0].name}`)
    return drive.directDownloadUrl(zips[0].id)
  }

  /** Converts share links to a direct URL and validates the scheme. */
  normalizeUrl(url) {
    if (drive.isDriveFolder(url)) {
      throw new LauncherError('DRIVE_FOLDER', 'This is a Google Drive FOLDER link. Use the link of the ZIP file itself.')
    }
    const id = drive.isDriveUrl(url) || !/^https?:/i.test(url) ? drive.extractFileId(url) : null
    const finalUrl = id ? drive.directDownloadUrl(id) : url
    assertSafeUrl(finalUrl)
    return finalUrl
  }

  /**
   * @param {{ url: string, dest: string, size?: number, sha256?: string, signal?: AbortSignal,
   *           onProgress?: (p: {received:number,total:number|null,bytesPerSec:number}) => void }} job
   * @returns {Promise<{ path: string, size: number, sha256: string|null }>}
   */
  async download({ url, dest, size, sha256, signal, onProgress }) {
    const startUrl = drive.isDriveFolder(url) ? await this.resolveDriveFolder(url) : this.normalizeUrl(url)
    const part = `${dest}.part`
    const metaFile = `${part}.json`
    fs.mkdirSync(path.dirname(dest), { recursive: true })

    let meta = readJson(metaFile)
    if (!meta || meta.url !== url) {
      safeUnlink(part)
      meta = { url, etag: null, total: null }
    }
    let have = fileSize(part)

    let target = startUrl
    let res
    for (let hop = 0; ; hop++) {
      const headers = {}
      if (have > 0) {
        headers.Range = `bytes=${have}-`
        if (meta.etag) headers['If-Range'] = meta.etag
      }
      res = await this.#fetch(target, headers, signal)
      const type = res.headers.get('content-type') || ''
      if (drive.isDriveUrl(target) && type.includes('text/html')) {
        if (hop >= MAX_DRIVE_HOPS) throw new LauncherError('DRIVE_UNEXPECTED', 'Google Drive kept returning a web page.')
        target = drive.parseInterstitial(await res.text())
        log.info('google drive interstitial followed')
        continue
      }
      break
    }

    if (res.status === 416 && meta.total && have >= meta.total) {
      // Already complete on disk.
    } else if (res.status === 206) {
      const range = parseContentRange(res.headers.get('content-range'))
      if (!range || range.start !== have) { safeUnlink(part); have = 0; throw new LauncherError('DOWNLOAD_RESUME_MISMATCH', 'Resume failed; please retry.') }
      meta.total = range.total
      await this.#stream(res, part, true, have, meta.total, signal, onProgress)
    } else if (res.ok) {
      have = 0
      const len = Number(res.headers.get('content-length')) || null
      meta = { url, etag: res.headers.get('etag'), total: len }
      writeJson(metaFile, meta)
      await this.#stream(res, part, false, 0, len, signal, onProgress)
    } else {
      throw new LauncherError(`HTTP_${res.status}`, `Download failed (HTTP ${res.status}).`)
    }

    // ── Verification before the file becomes visible ──
    const got = fileSize(part)
    const expectedSize = size || meta.total
    if (expectedSize && got !== expectedSize) {
      throw new LauncherError('DOWNLOAD_INCOMPLETE', `Download incomplete (${got} of ${expectedSize} bytes). It will resume on retry.`)
    }
    // Hash only when the publisher gave us one (hashing a 35 GB ZIP twice is wasteful).
    const digest = sha256 ? await sha256File(part, { signal }) : null
    if (sha256 && digest.toLowerCase() !== sha256.toLowerCase()) {
      safeUnlink(part); safeUnlink(metaFile)
      throw new LauncherError('CHECKSUM_MISMATCH', `File failed SHA-256 verification: ${path.basename(dest)}`)
    }
    fs.renameSync(part, dest)
    safeUnlink(metaFile)
    return { path: dest, size: got, sha256: digest }
  }

  async #fetch(url, headers, signal) {
    try {
      return await this.fetch(url, { headers: { 'User-Agent': 'OLKPlusLauncher', ...headers }, redirect: 'follow', signal })
    } catch (err) {
      if (signal?.aborted) throw new LauncherError('CANCELLED', 'Download cancelled.')
      throw new LauncherError('NETWORK', `Network error: ${err.message}`)
    }
  }

  async #stream(res, part, append, already, total, signal, onProgress) {
    if (!res.body) throw new LauncherError('NETWORK', 'Empty response body.')
    let received = already
    let lastEmit = 0
    let windowStart = Date.now()
    let windowBytes = 0
    let speed = 0
    let stallTimer
    const ctrl = new AbortController()
    const onAbort = () => ctrl.abort()
    signal?.addEventListener('abort', onAbort)
    const resetStall = () => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => ctrl.abort(new LauncherError('NETWORK_STALLED', 'Download stalled.')), STALL_MS)
    }
    resetStall()
    const body = Readable.fromWeb(res.body)
    body.on('data', (chunk) => {
      received += chunk.length
      windowBytes += chunk.length
      resetStall()
      const now = Date.now()
      if (now - windowStart >= 1000) { speed = windowBytes / ((now - windowStart) / 1000); windowStart = now; windowBytes = 0 }
      if (now - lastEmit > 200) { lastEmit = now; onProgress?.({ received, total, bytesPerSec: speed }) }
    })
    try {
      await pipeline(body, fs.createWriteStream(part, { flags: append ? 'a' : 'w' }), { signal: ctrl.signal })
      onProgress?.({ received, total, bytesPerSec: speed })
    } catch (err) {
      if (signal?.aborted) throw new LauncherError('CANCELLED', 'Download cancelled. Progress was kept.')
      if (ctrl.signal.reason instanceof LauncherError) throw ctrl.signal.reason
      throw new LauncherError('NETWORK', `Connection lost: ${err.message}. Progress was kept.`)
    } finally {
      clearTimeout(stallTimer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

function parseContentRange(h) {
  const m = /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(h || '')
  return m ? { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) } : null
}
const fileSize = (f) => { try { return fs.statSync(f).size } catch { return 0 } }
const safeUnlink = (f) => { try { fs.unlinkSync(f) } catch { /* ok */ } }
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v))

module.exports = { DownloadManager, parseContentRange }
