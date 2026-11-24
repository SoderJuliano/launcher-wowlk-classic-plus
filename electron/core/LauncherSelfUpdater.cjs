'use strict'
/**
 * LauncherSelfUpdater — manifest-driven self-updater for OLK Plus Launcher.
 * Checks /manifest/launcher on startup. If a newer semver is found:
 *  - Linux (AppImage): downloads new AppImage, replaces target safely even across partitions
 *    (copy to sibling temp + atomic rename; falls back to ~/Applications if read-only),
 *    and relaunches with a clean environment (without stale APPDIR/APPIMAGE vars).
 *  - Windows (NSIS): downloads new installer .exe, runs a detached helper script that waits
 *    for the launcher to exit, executes the silent NSIS installer, and relaunches the launcher.
 *  - Anti-loop protection: persists recent attempts per target version and refuses to loop
 *    endlessly if replacement or relaunch fails.
 *  - Dev mode: downloads and verifies, logs readiness, does not replace source files.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { cmpVersion } = require('./ManifestService.cjs')
const log = require('./logger.cjs')

const MAX_ATTEMPTS_PER_VERSION = 2
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000

/**
 * Safely replaces `targetPath` with `sourcePath`, even when `sourcePath` and `targetPath`
 * reside on different filesystems (prevents EXDEV on Linux when AppImage is outside $HOME).
 */
function replaceFileSafely(sourcePath, targetPath, { mode = 0o755 } = {}) {
  fs.chmodSync(sourcePath, mode)
  try {
    fs.renameSync(sourcePath, targetPath)
    return targetPath
  } catch (err) {
    if (err.code !== 'EXDEV') throw err
  }
  // Cross-device fallback: copy into a hidden sibling file in the same directory, then atomically rename.
  const targetDir = path.dirname(targetPath)
  const siblingTmp = path.join(targetDir, `.${path.basename(targetPath)}.olk-new-${process.pid}`)
  try {
    fs.copyFileSync(sourcePath, siblingTmp)
    fs.chmodSync(siblingTmp, mode)
    fs.renameSync(siblingTmp, targetPath)
    try { fs.unlinkSync(sourcePath) } catch {}
    return targetPath
  } catch (err) {
    try { fs.unlinkSync(siblingTmp) } catch {}
    throw err
  }
}

/** Builds a clean env for spawning the updated AppImage so it doesn't inherit the old squashfs mount. */
function cleanAppImageEnv(baseEnv = process.env) {
  const env = { ...baseEnv }
  const oldAppDir = env.APPDIR
  for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete env[k]
  if (oldAppDir) {
    for (const k of ['PATH', 'LD_LIBRARY_PATH', 'LD_PRELOAD']) {
      if (!env[k]) continue
      env[k] = env[k]
        .split(':')
        .filter((p) => p && !p.startsWith(oldAppDir) && !p.includes('.mount_'))
        .join(':')
      if (!env[k]) delete env[k]
    }
  }
  return env
}

/**
 * Resolves a writable destination for the updated AppImage.
 * Uses the running AppImage path when writable; otherwise migrates to ~/Applications.
 */
function resolveWritableAppImagePath(runningAppImage, homeDir = os.homedir()) {
  if (runningAppImage) {
    try {
      fs.accessSync(path.dirname(runningAppImage), fs.constants.W_OK)
      return { path: runningAppImage, migrated: false }
    } catch { /* directory is read-only or inaccessible */ }
  }
  const appsDir = path.join(homeDir, 'Applications')
  fs.mkdirSync(appsDir, { recursive: true })
  return { path: path.join(appsDir, 'OLK-Plus-Launcher.AppImage'), migrated: true }
}

class LauncherSelfUpdater {
  /**
   * @param {{ config: import('./ConfigurationManager.cjs').ConfigurationManager,
   *           api: import('./ApiClient.cjs').ApiClient,
   *           manifests: import('./ManifestService.cjs').ManifestService,
   *           downloader: import('./DownloadManager.cjs').DownloadManager,
   *           launcherVersion?: string,
   *           appInstance?: any,
   *           spawnImpl?: typeof spawn,
   *           platformName?: string }} deps
   */
  constructor({ config, api, manifests, downloader, launcherVersion, appInstance, spawnImpl, platformName }) {
    this.config = config
    this.api = api
    this.manifests = manifests
    this.downloader = downloader
    this.spawn = spawnImpl || spawn
    this.platform = platformName || process.platform
    try {
      this.app = appInstance || require('electron').app
    } catch {
      this.app = appInstance || null
    }
    this.launcherVersion = launcherVersion || this.app?.getVersion?.() || '0.1.0'
    this.failedVersions = new Set()
    this.lastError = null
  }

  #attemptFile() {
    return path.join(this.config.dataDir, 'temp', 'self-update-attempt.json')
  }

  #readAttempt() {
    try { return JSON.parse(fs.readFileSync(this.#attemptFile(), 'utf8')) } catch { return null }
  }

  #recordAttempt(version) {
    const file = this.#attemptFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const now = Date.now()
    const prev = this.#readAttempt()
    const count = prev && prev.version === version && (now - prev.at) < ATTEMPT_WINDOW_MS ? (prev.count || 0) + 1 : 1
    try { fs.writeFileSync(file, JSON.stringify({ version, count, at: now })) } catch {}
    return count
  }

  #clearAttemptIfUpToDate(currentVersion) {
    const prev = this.#readAttempt()
    if (prev && cmpVersion(currentVersion, prev.version) >= 0) {
      try { fs.unlinkSync(this.#attemptFile()) } catch {}
    }
  }

  #isLoopBlocked(version) {
    if (this.failedVersions.has(version)) return true
    const prev = this.#readAttempt()
    if (prev && prev.version === version && (Date.now() - prev.at) < ATTEMPT_WINDOW_MS && prev.count >= MAX_ATTEMPTS_PER_VERSION) {
      return true
    }
    return false
  }

  /**
   * @param {{ onProgress?: (p: { phase: string, done: number, total: number, version: string, bytesPerSec?: number }) => void, signal?: AbortSignal, force?: boolean }} opts
   * @returns {Promise<{ updateAvailable: boolean, relaunching?: boolean, version?: string, devMode?: boolean, skippedLoop?: boolean, manualUrl?: string, error?: string }>}
   */
  async checkAndApplyUpdate({ onProgress, signal, force = false } = {}) {
    this.#clearAttemptIfUpToDate(this.launcherVersion)

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
      this.lastError = null
      return { updateAvailable: false }
    }

    const platformKey = this.platform === 'win32' ? 'win32' : (this.platform === 'darwin' ? 'mac' : 'linux')
    const target = manifest.platforms?.[platformKey] || manifest[platformKey]
    if (!target || !target.url) {
      log.warn(`no launcher build found in manifest for platform "${platformKey}"`)
      return { updateAvailable: false }
    }

    if (!force && this.#isLoopBlocked(manifest.version)) {
      const msg = this.lastError?.message || `Auto-update para v${manifest.version} já foi tentado sem concluir. Baixe a nova versão manualmente ou mova o AppImage para ~/Applications.`
      this.lastError = { version: manifest.version, message: msg, manualUrl: target.url }
      log.warn(`skipping self-update loop for ${manifest.version}`)
      return { updateAvailable: true, skippedLoop: true, version: manifest.version, manualUrl: target.url, error: msg }
    }

    log.info(`launcher update available: ${this.launcherVersion} -> ${manifest.version}`)

    const dataDir = this.config.dataDir
    const tempDir = path.join(dataDir, 'temp')
    fs.mkdirSync(tempDir, { recursive: true })

    const ext = platformKey === 'win32' ? '.exe' : (platformKey === 'mac' ? '.dmg' : '.AppImage')
    const tempDest = path.join(tempDir, `olk-launcher-update-${manifest.version}${ext}`)

    onProgress?.({ phase: 'downloading', done: 0, total: target.size || 0, version: manifest.version })

    try {
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
    } catch (err) {
      this.failedVersions.add(manifest.version)
      this.lastError = { version: manifest.version, message: err.message, manualUrl: target.url }
      throw err
    }

    log.info(`launcher update downloaded to ${tempDest}`)

    // If running in development / unpackaged mode:
    if (!this.app || !this.app.isPackaged) {
      log.info(`running in dev mode: update ${manifest.version} downloaded, skipping auto-replace`)
      return { updateAvailable: true, devMode: true, version: manifest.version }
    }

    this.#recordAttempt(manifest.version)

    // Production Linux AppImage self-replace
    if (this.platform === 'linux') {
      const runningAppImage = process.env.APPIMAGE
      if (!runningAppImage || !fs.existsSync(runningAppImage)) {
        const msg = 'Variável APPIMAGE não encontrada; não foi possível substituir automaticamente.'
        this.failedVersions.add(manifest.version)
        this.lastError = { version: manifest.version, message: msg, manualUrl: target.url }
        log.warn(msg)
        return { updateAvailable: true, version: manifest.version, manualUrl: target.url, error: msg }
      }

      try {
        const destInfo = resolveWritableAppImagePath(runningAppImage)
        replaceFileSafely(tempDest, destInfo.path, { mode: 0o755 })
        log.info(`launcher updated to ${manifest.version}${destInfo.migrated ? ' (migrated to writable ~/Applications)' : ''}, relaunching ${destInfo.path}...`)

        const cleanEnv = cleanAppImageEnv(process.env)
        const child = this.spawn(destInfo.path, [], {
          cwd: path.dirname(destInfo.path),
          env: cleanEnv,
          detached: true,
          stdio: 'ignore'
        })
        child.unref?.()
        this.app.exit(0)
        return { updateAvailable: true, relaunching: true, version: manifest.version, execPath: destInfo.path, migrated: destInfo.migrated }
      } catch (err) {
        this.failedVersions.add(manifest.version)
        this.lastError = { version: manifest.version, message: `Falha ao substituir AppImage: ${err.message}`, manualUrl: target.url }
        log.error('Linux AppImage self-replace failed', err)
        return { updateAvailable: true, version: manifest.version, manualUrl: target.url, error: this.lastError.message }
      }
    }

    // Production Windows NSIS installer: wait for current PID to exit, run silent setup, then relaunch.
    if (this.platform === 'win32') {
      try {
        const currentExe = process.execPath
        const helperCmd = path.join(tempDir, `apply-update-${manifest.version}.cmd`)
        const esc = (s) => String(s).replace(/"/g, '""')
        const script = [
          '@echo off',
          'setlocal',
          'timeout /t 2 /nobreak >nul',
          `start "" /wait "${esc(tempDest)}" /S`,
          `if exist "${esc(currentExe)}" start "" "${esc(currentExe)}"`,
          `del /f /q "${esc(tempDest)}" >nul 2>&1`,
          'del /f /q "%~f0" >nul 2>&1',
          ''
        ].join('\r\n')
        fs.writeFileSync(helperCmd, script, 'utf8')
        log.info(`running windows installer for ${manifest.version} via helper script...`)
        const child = this.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', helperCmd], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        })
        child.unref?.()
        this.app.exit(0)
        return { updateAvailable: true, relaunching: true, version: manifest.version }
      } catch (err) {
        this.failedVersions.add(manifest.version)
        this.lastError = { version: manifest.version, message: `Falha ao iniciar instalador Windows: ${err.message}`, manualUrl: target.url }
        log.error('Windows self-update launch failed', err)
        return { updateAvailable: true, version: manifest.version, manualUrl: target.url, error: this.lastError.message }
      }
    }

    return { updateAvailable: true, version: manifest.version }
  }
}

module.exports = {
  LauncherSelfUpdater,
  replaceFileSafely,
  cleanAppImageEnv,
  resolveWritableAppImagePath
}
