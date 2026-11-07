'use strict'
/**
 * LauncherSelfUpdater — manifest-driven self-updater for OLK Plus Launcher.
 * Checks /manifest/launcher on startup. If a newer semver is found:
 *  - Linux (AppImage): downloads new AppImage, chmods 0755, atomically replaces itself, relaunches.
 *  - Windows (NSIS): downloads new installer .exe, runs it, exits.
 *  - Dev mode: downloads and verifies, logs readiness, does not replace source files.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { cmpVersion } = require('./ManifestService.cjs')
const log = require('./logger.cjs')

class LauncherSelfUpdater {
  /**
   * @param {{ config: import('./ConfigurationManager.cjs').ConfigurationManager,
   *           api: import('./ApiClient.cjs').ApiClient,
   *           manifests: import('./ManifestService.cjs').ManifestService,
   *           downloader: import('./DownloadManager.cjs').DownloadManager,
   *           launcherVersion?: string,
   *           appInstance?: any }} deps
   */
  constructor({ config, api, manifests, downloader, launcherVersion, appInstance }) {
    this.config = config
    this.api = api
    this.manifests = manifests
    this.downloader = downloader
    try {
      this.app = appInstance || require('electron').app
    } catch {
      this.app = appInstance || null
    }
    this.launcherVersion = launcherVersion || this.app?.getVersion?.() || '0.1.0'
  }

  /**
   * @param {{ onProgress?: (p: { phase: string, done: number, total: number, version: string, bytesPerSec?: number }) => void, signal?: AbortSignal }} opts
   * @returns {Promise<{ updateAvailable: boolean, relaunching?: boolean, version?: string, devMode?: boolean }>}
   */
  async checkAndApplyUpdate({ onProgress, signal } = {}) {
    let manifest
    try {
      manifest = await this.manifests.fetchLauncherManifest()
    } catch (err) {
      log.warn('could not fetch launcher manifest', { message: err.message, code: err.code })
      return { updateAvailable: false }
    }

    if (!manifest || !manifest.version) return { updateAvailable: false }

    const isNewer = cmpVersion(manifest.version, this.launcherVersion) > 0
    if (!isNewer) {
      log.info(`launcher is up to date (${this.launcherVersion})`)
      return { updateAvailable: false }
    }

    log.info(`launcher update available: ${this.launcherVersion} -> ${manifest.version}`)

    const platformKey = process.platform === 'win32' ? 'win32' : (process.platform === 'darwin' ? 'mac' : 'linux')
    const target = manifest.platforms?.[platformKey] || manifest[platformKey]
    if (!target || !target.url) {
      log.warn(`no launcher build found in manifest for platform "${platformKey}"`)
      return { updateAvailable: false }
    }

    const dataDir = this.config.dataDir
    const tempDir = path.join(dataDir, 'temp')
    fs.mkdirSync(tempDir, { recursive: true })

    const ext = platformKey === 'win32' ? '.exe' : (platformKey === 'mac' ? '.dmg' : '.AppImage')
    const tempDest = path.join(tempDir, `olk-launcher-update-${manifest.version}${ext}`)

    onProgress?.({ phase: 'downloading', done: 0, total: target.size || 0, version: manifest.version })

    await this.downloader.download({
      url: target.url,
      dest: tempDest,
      size: target.size || undefined,
      sha256: target.sha256 || undefined,
      signal,
      onProgress: (p) => {
        onProgress?.({
          phase: 'downloading',
          done: p.received || p.done || 0,
          total: p.total || target.size || 0,
          version: manifest.version,
          bytesPerSec: p.bytesPerSec
        })
      }
    })

    log.info(`launcher update downloaded to ${tempDest}`)

    // If running in development / unpackaged mode:
    if (!this.app || !this.app.isPackaged) {
      log.info(`running in dev mode: update ${manifest.version} downloaded, skipping auto-replace`)
      return { updateAvailable: true, devMode: true, version: manifest.version }
    }

    // Production Linux AppImage self-replace
    if (process.platform === 'linux') {
      const runningAppImage = process.env.APPIMAGE
      if (!runningAppImage || !fs.existsSync(runningAppImage)) {
        log.warn('APPIMAGE environment variable not found or file does not exist; skipping in-place replace')
        return { updateAvailable: true, version: manifest.version }
      }

      fs.chmodSync(tempDest, 0o755)
      // Atomic replace on Linux: replaces running file inode entry cleanly
      fs.renameSync(tempDest, runningAppImage)
      log.info(`launcher updated to ${manifest.version}, relaunching ${runningAppImage}...`)

      this.app.relaunch({ execPath: runningAppImage })
      this.app.exit(0)
      return { updateAvailable: true, relaunching: true, version: manifest.version }
    }

    // Production Windows NSIS installer
    if (process.platform === 'win32') {
      log.info(`running windows installer for ${manifest.version}...`)
      spawn(tempDest, ['/S'], { detached: true, stdio: 'ignore' })
      this.app.exit(0)
      return { updateAvailable: true, relaunching: true, version: manifest.version }
    }

    return { updateAvailable: true, version: manifest.version }
  }
}

module.exports = { LauncherSelfUpdater }
