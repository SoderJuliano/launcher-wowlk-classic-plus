'use strict'
/**
 * LauncherController — the only object the IPC layer talks to.
 * Runs one long task at a time (install / update / repair) and publishes progress.
 *
 * Main button state per client:
 *   INSTALL → DOWNLOADING → INSTALLING → (UPDATING) → PLAY        (ERROR on failure)
 *   UPDATE when the manifest has a newer version, RUNNING while the game is open.
 */
const fs = require('node:fs')
const path = require('node:path')
const { LauncherError, toPlain } = require('./errors.cjs')
const platform = require('./PlatformService.cjs')
const log = require('./logger.cjs')

class LauncherController {
  constructor({ config, api, auth, manifests, downloader, installer, updater, game, selfUpdater, emit }) {
    Object.assign(this, { config, api, auth, manifests, downloader, installer, updater, game, selfUpdater })
    this.emit = emit || (() => {})
    this.task = null // { id, kind, phase, done, total, file, bytesPerSec, controller }
    this.launcherUpdate = null
    this.lastError = {} // clientId -> { code, message }
    this.manifestCache = {} // clientId -> { manifest, fetchedAt } | { error }
    this.wine = null
    this.periodicTimer = null
  }

  /* ───────────── state ───────────── */

  async init() {
    this.wine = await platform.detectWine(this.config.get().wine.path)
    await this.api.health()
    if (this.api.lastStatus.state === 'online') {
      try {
        const updateResult = await this.selfUpdater?.checkAndApplyUpdate({
          onProgress: (p) => {
            this.launcherUpdate = p
            this.#publish()
          }
        })
        if (updateResult?.relaunching) return
      } catch (err) {
        log.warn('launcher self-update check failed', toPlain(err))
      } finally {
        this.launcherUpdate = null
        this.#publish()
      }
      await this.auth.restore()
    }
    await this.refreshManifests()
    this.startPeriodicCheck()
    this.#publish()
  }

  /** "Locate installed game": adopt an existing folder chosen by the player (no copy). */
  async locate(id, dir) {
    if (this.task) throw new LauncherError('BUSY', 'Wait for the current operation to finish.')
    if (!this.config.client(id).available) throw new LauncherError('CLIENT_UNAVAILABLE', 'This client is not available yet.')
    const { dir: gameDir } = this.installer.adopt(id, dir)
    this.config.update({ [`clients.${id}.path`]: gameDir })
    delete this.lastError[id]
    await this.refreshManifests()
    this.#publish()
    return this.clientState(id)
  }

  clientState(id) {
    const c = this.config.client(id)
    const v = this.installer.verify(id)
    const m = this.manifestCache[id]?.manifest
    const updateAvailable = !!(v.installed && m && v.state?.version !== m.version)
    let button = 'INSTALL'
    if (!c.available) button = 'UNAVAILABLE'
    else if (this.task?.id === id) button = { download: 'DOWNLOADING', extract: 'INSTALLING', verify: 'VERIFYING', update: 'UPDATING' }[this.task.stage] || 'INSTALLING'
    else if (this.game.isRunning(id)) button = 'RUNNING'
    else if (this.lastError[id]) button = 'ERROR'
    else if (v.installed) button = updateAvailable ? 'UPDATE' : 'PLAY'
    else if (v.state) button = 'REPAIR'
    return {
      id,
      name: c.name,
      architecture: c.architecture,
      available: c.available,
      installed: v.installed,
      missing: v.missing,
      version: v.state?.version ?? null,
      latestVersion: m?.version ?? null,
      updateAvailable,
      installDir: this.config.clientDir(id),
      hasPackageSource: !!(m?.base_package?.url || c.basePackage?.url),
      located: !!c.path,
      running: this.game.isRunning(id),
      button,
      error: this.lastError[id] ?? null
    }
  }

  snapshot() {
    const cfg = this.config.get()
    return {
      platform: platform.describe(),
      wine: this.wine,
      api: this.api.lastStatus,
      user: this.auth.user,
      authenticated: this.auth.isAuthenticated(),
      selectedClient: cfg.selectedClient,
      launcherUpdate: this.launcherUpdate,
      clients: Object.keys(cfg.clients).map((id) => this.clientState(id)),
      task: this.task && { id: this.task.id, kind: this.task.kind, stage: this.task.stage, phase: this.task.phase, done: this.task.done, total: this.task.total, file: this.task.file, bytesPerSec: this.task.bytesPerSec },
      settings: {
        apiBaseUrl: cfg.api.baseUrl,
        discoveryEnabled: cfg.api.discovery.enabled,
        realmlist: cfg.realmlist,
        locale: cfg.locale,
        installDir: cfg.installDir,
        winePath: cfg.wine.path,
        winePrefix: cfg.wine.prefix,
        websiteUrl: cfg.websiteUrl,
        wow32PackageUrl: cfg.clients.wow32?.basePackage?.url || '',
        wow32ManifestUrl: cfg.clients.wow32?.manifestUrl || '',
        wow64PackageUrl: cfg.clients.wow64?.basePackage?.url || ''
      },
      logFile: log.file
    }
  }

  #publish() { this.emit('state', this.snapshot()) }

  /* ───────────── auth ───────────── */

  async login(creds) {
    const user = await this.auth.login(creds)
    for (const id of Object.keys(this.config.get().clients)) {
      if (this.installer.verify(id).installed) this.installer.ensureRealmlist(id, user.username)
    }
    await this.refreshManifests()
    this.#publish()
    return user
  }

  async logout() {
    await this.auth.logout()
    this.manifestCache = {}
    this.#publish()
  }

  async checkApi() {
    await this.api.health()
    this.#publish()
    return this.api.lastStatus
  }

  /** Fetches manifests for every available client. Absence of the endpoint is not fatal. */
  async refreshManifests() {
    for (const id of Object.keys(this.config.get().clients)) {
      const c = this.config.client(id)
      if (!c.available) continue
      if (this.api.lastStatus.state !== 'online' && !c.manifestUrl) continue
      try {
        this.manifestCache[id] = { manifest: await this.manifests.fetch(id), fetchedAt: Date.now() }
      } catch (err) {
        this.manifestCache[id] = { error: toPlain(err) }
        if (err.code === 'LAUNCHER_OUTDATED') this.lastError[id] = toPlain(err)
        log.warn(`manifest ${id} unavailable`, toPlain(err))
      }
    }
  }

  /* ───────────── tasks ───────────── */

  #begin(id, kind) {
    if (this.task) throw new LauncherError('BUSY', 'Another operation is already running.')
    if (!this.config.client(id).available) throw new LauncherError('CLIENT_UNAVAILABLE', 'This client is not available yet.')
    if (this.game.isRunning(id)) throw new LauncherError('ALREADY_RUNNING', 'Close the game first.')
    delete this.lastError[id]
    this.task = { id, kind, stage: 'download', phase: 'starting', done: 0, total: 0, controller: new AbortController() }
    this.#publish()
    return this.task
  }

  #progress = (stage) => (p) => {
    if (!this.task) return
    Object.assign(this.task, { stage, phase: p.phase ?? stage, done: p.done ?? p.received ?? 0, total: p.total ?? 0, file: p.file ?? null, bytesPerSec: p.bytesPerSec ?? null })
    this.emit('progress', { id: this.task.id, kind: this.task.kind, stage, phase: this.task.phase, done: this.task.done, total: this.task.total, file: this.task.file, bytesPerSec: this.task.bytesPerSec })
  }

  async #run(id, kind, fn) {
    const task = this.#begin(id, kind)
    try {
      await fn(task.controller.signal)
    } catch (err) {
      const plain = toPlain(err)
      if (plain.code !== 'CANCELLED') this.lastError[id] = plain
      log.error(`${kind} ${id} failed`, plain)
      throw err
    } finally {
      this.task = null
      this.#publish()
    }
    return this.clientState(id)
  }

  cancel() {
    this.task?.controller.abort()
  }

  /** Full install / reinstall from the base package. */
  install(id) {
    return this.#run(id, 'install', async (signal) => {
      const cfg = this.config.get()
      const m = this.manifestCache[id]?.manifest
      const pkg = m?.base_package?.url ? m.base_package : this.config.client(id).basePackage
      if (!pkg?.url) throw new LauncherError('PACKAGE_NOT_CONFIGURED', 'The game package link is not configured yet. Set it in Settings → Game package.')
      const zip = path.join(cfg.installDir, 'downloads', `${id}.zip`)
      // A fresh install never touches a folder the player located manually.
      if (this.config.client(id).path) this.config.update({ [`clients.${id}.path`]: null })

      await this.downloader.download({ url: pkg.url, dest: zip, size: pkg.size || undefined, sha256: pkg.sha256 || undefined, signal, onProgress: this.#progress('download') })
      await this.installer.installFromZip({
        id,
        zipPath: zip,
        version: m?.base_package?.version ?? null,
        signal,
        onProgress: this.#progress('extract')
      })
      fs.promises.rm(zip, { force: true }).catch(() => {})

      if (m) await this.#update(id, m, signal)
      return this.clientState(id)
    })
  }

  /** Incremental update (or repair: same thing, it re-checks every listed file). */
  update(id, { repair = false } = {}) {
    return this.#run(id, repair ? 'repair' : 'update', async (signal) => {
      const m = this.manifestCache[id]?.manifest ?? (await this.manifests.fetch(id))
      this.manifestCache[id] = { manifest: m, fetchedAt: Date.now() }
      await this.#update(id, m, signal, { ignoreCache: repair })
      this.installer.ensureRealmlist(id)
      return this.clientState(id)
    })
  }

  async #update(id, manifest, signal, { ignoreCache = false } = {}) {
    if (manifest.realmlist && manifest.realmlist !== this.config.get().realmlist) this.config.update({ realmlist: manifest.realmlist })
    if (this.task) this.task.stage = 'verify'
    const plan = await this.updater.plan(id, manifest, { signal, ignoreCache, onProgress: this.#progress('verify') })
    if (plan.upToDate) return
    await this.updater.apply(id, manifest, plan, { signal, onProgress: this.#progress('update') })
  }

  async play(id) {
    if (this.task) throw new LauncherError('BUSY', 'Wait for the current operation to finish.')
    delete this.lastError[id]
    const state = this.clientState(id)
    if (state.updateAvailable) {
      log.info(`update required before play for ${id}`)
      return this.update(id)
    }
    try {
      const credentials = { username: this.auth.user?.username, password: this.auth.password }
      const r = await this.game.launch(id, { onExit: () => this.#publish(), credentials })
      this.#publish()
      return r
    } catch (err) {
      this.lastError[id] = toPlain(err)
      this.#publish()
      throw err
    }
  }

  startPeriodicCheck(intervalMs = 120_000) {
    if (this.periodicTimer) clearInterval(this.periodicTimer)
    this.periodicTimer = setInterval(() => {
      this.checkPeriodicUpdates().catch((err) => log.warn('periodic check error', toPlain(err)))
    }, intervalMs)
    this.periodicTimer.unref?.()
  }

  stopPeriodicCheck() {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer)
      this.periodicTimer = null
    }
  }

  async checkPeriodicUpdates() {
    if (this.task) return
    const clientIds = Object.keys(this.config.get().clients)
    if (clientIds.some((id) => this.game.isRunning(id))) return

    if (this.api.lastStatus?.state !== 'online') {
      try { await this.api.health() } catch { /* silent */ }
    }

    if (this.api.lastStatus?.state === 'online') {
      try {
        const updateResult = await this.selfUpdater?.checkAndApplyUpdate({
          onProgress: (p) => {
            this.launcherUpdate = p
            this.#publish()
          }
        })
        if (updateResult?.relaunching) return
      } catch (err) {
        log.warn('periodic launcher update check failed', toPlain(err))
      } finally {
        if (this.launcherUpdate) {
          this.launcherUpdate = null
          this.#publish()
        }
      }

      try {
        await this.refreshManifests()
      } catch (err) {
        log.warn('periodic manifest refresh failed', toPlain(err))
      }
    } else {
      try {
        await this.refreshManifests()
      } catch { /* silent */ }
    }

    this.#publish()
  }

  async updateSettings(patch) {
    const before = this.config.get()
    this.config.update(patch)
    const after = this.config.get()
    if (before.api.baseUrl !== after.api.baseUrl || before.api.discovery.enabled !== after.api.discovery.enabled) {
      this.api.baseUrl = null
      await this.api.health()
    }
    if (patch['wine.path'] !== undefined) this.wine = await platform.detectWine(after.wine.path)
    // Push a new realmlist into installed clients right away.
    if (patch.realmlist) for (const id of Object.keys(after.clients)) if (this.installer.verify(id).installed) this.installer.ensureRealmlist(id)
    this.#publish()
    return this.snapshot()
  }

  clearError(id) { delete this.lastError[id]; this.#publish() }
}

module.exports = { LauncherController }
