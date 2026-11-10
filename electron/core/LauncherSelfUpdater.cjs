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
const { isSteamDeck } = require('./realmlist.cjs')
const { cleanEnvForSystemBinary } = require('./PlatformService.cjs')
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
    // Já entregamos a sessão para a versão nova (filho): este processo antigo não verifica mais nada.
    if (this.handedOff) return { updateAvailable: false, relaunching: true }
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

      // Steam Deck / Big Picture / Modo Jogo: o Steam acompanha ESTE processo. Se ele sair
      // (app.relaunch + exit), o Steam encerra a sessão e o novo launcher abre fora do Gamescope
      // (tela preta, launcher nunca aparece). Então mantemos este processo vivo e escondido,
      // rodando a versão nova como FILHO, e só saímos quando o filho sair.
      if (isSteamDeck()) {
        this.#relaunchAsChild(runningAppImage)
        return { updateAvailable: true, relaunching: true, version: manifest.version }
      }

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

  /** Roda o AppImage novo como filho deste processo (que fica escondido) — ver comentário acima. */
  #relaunchAsChild(appImagePath) {
    this.handedOff = true
    const env = cleanEnvForSystemBinary({ ...process.env })
    for (const k of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete env[k]
    try { this.app.releaseSingleInstanceLock?.() } catch {}
    try {
      const { BrowserWindow } = require('electron')
      for (const w of BrowserWindow.getAllWindows()) { try { w.hide() } catch {} }
    } catch {}
    let child
    try {
      child = spawn(appImagePath, [], { env, stdio: 'inherit', detached: false })
    } catch (err) {
      log.warn(`could not start updated launcher as child (${err.message}); falling back to relaunch`)
      this.app.relaunch({ execPath: appImagePath })
      this.app.exit(0)
      return
    }
    const forward = (sig) => () => { try { child.kill(sig) } catch {} }
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.prependListener(sig, forward(sig))
    child.once('error', (err) => {
      log.warn(`updated launcher failed to start: ${err.message}`)
      this.app.exit(1)
    })
    child.once('exit', (code) => {
      log.info(`updated launcher (child) exited with code ${code}; closing parent`)
      this.app.exit(code ?? 0)
    })
    log.info(`updated launcher started as child pid ${child.pid} (Steam Deck session kept alive)`)
  }
}

module.exports = { LauncherSelfUpdater }
