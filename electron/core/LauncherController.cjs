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
const { shouldEnableFilters } = require('./GraphicsManager.cjs')
const log = require('./logger.cjs')

class LauncherController {
  constructor({ config, api, auth, manifests, downloader, installer, updater, supporterContent, languagePack, game, selfUpdater, emit }) {
    Object.assign(this, { config, api, auth, manifests, downloader, installer, updater, supporterContent, languagePack, game, selfUpdater })
    this.emit = emit || (() => {})
    this.task = null // { id, kind, phase, done, total, file, bytesPerSec, controller }
    this.launcherUpdate = null
    this.launcherUpdateError = null
    this.lastError = {} // clientId -> { code, message }
    this.languageWarning = {} // clientId -> { language, baseSha, message }
    this.manifestCache = {} // clientId -> { manifest, fetchedAt } | { error }
    this.supporterManifestCache = {} // clientId -> { manifest, fetchedAt }
    this.languageManifestCache = {} // `${clientId}:${lang}` -> { manifest, fetchedAt }
    this.supporter = null // { supporter: boolean, since: string | null, donations: number } | null
    this.supporterCheckedAt = 0
    this.initialized = false
    this.wine = null
    this.vulkan = null
    this.linuxPerf = null
    this.periodicTimer = null
  }

  /* ───────────── state ───────────── */

  internalWinePath() {
    return path.join(this.config.dataDir, 'runtime', 'wine', 'bin', 'wine')
  }

  async init() {
    const savedWine = this.config.get().wine?.path
    if (savedWine && (/steamapps.*proton/i.test(savedWine) || /proton.*dist\/bin\/wine/i.test(savedWine))) {
      log.warn('Purging invalid Proton runner from settings.json:', savedWine)
      try { this.config.update({ 'wine.path': null }) } catch {}
    }
    this.wine = await platform.detectWine(this.config.get().wine?.path, platform.platform, [this.internalWinePath()])
    if (this.wine?.found && this.wine?.path && !this.config.get().wine?.path && !this.wine.isProton) {
      try { this.config.update({ 'wine.path': this.wine.path }) } catch {}
    }
    this.vulkan = platform.detectVulkan(platform.platform, { winePath: this.wine?.path })
    this.linuxPerf = platform.detectLinuxPerformance ? platform.detectLinuxPerformance() : null
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
        if (updateResult?.error) {
          this.launcherUpdateError = {
            version: updateResult.version || null,
            message: updateResult.error,
            manualUrl: updateResult.manualUrl || null
          }
        } else {
          this.launcherUpdateError = null
        }
      } catch (err) {
        log.warn('launcher self-update check failed', toPlain(err))
        if (this.selfUpdater?.lastError) {
          this.launcherUpdateError = this.selfUpdater.lastError
        }
      } finally {
        this.launcherUpdate = null
        this.#publish()
      }
    }
    await this.auth.restore()
    if (this.auth.isAuthenticated()) {
      await this.refreshSupporter()
      if (this.supporter?.supporter) {
        await this.refreshSupporterManifests()
      }
    }
    await this.refreshManifests()
    this.initialized = true
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
    const supporterEnabled = !!(c.supporterContentEnabled && this.supporter?.supporter)
    const sm = this.supporterManifestCache[id]?.manifest
    const sState = this.supporterContent?.readState(id) || null
    const supporterActive = this.supporterContent?.isActive(id) || false
    const supporterUpdateAvailable = !!(v.installed && supporterEnabled && sm && sState?.version !== sm.version)
    let button = 'INSTALL'
    if (!c.available) button = 'UNAVAILABLE'
    else if (this.task?.id === id) button = { download: 'DOWNLOADING', extract: 'INSTALLING', verify: 'VERIFYING', update: 'UPDATING' }[this.task.stage] || 'INSTALLING'
    else if (this.game.isRunning(id)) button = 'RUNNING'
    else if (this.lastError[id]) button = 'ERROR'
    else if (v.installed) button = (updateAvailable || supporterUpdateAvailable) ? 'UPDATE' : 'PLAY'
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
      supporterContentEnabled: !!c.supporterContentEnabled,
      supporterVersion: sState?.version ?? null,
      supporterLatestVersion: sm?.version ?? null,
      supporterUpdateAvailable,
      supporterActive,
      hasSupporterContent: !!sm,
      installDir: this.config.clientDir(id),
      hasPackageSource: !!(m?.base_package?.url || c.basePackage?.url),
      located: !!c.path,
      running: this.game.isRunning(id),
      button,
      error: this.lastError[id] ?? null,
      languageActive: this.languagePack?.readActive(id)?.language ?? null,
      languageWarning: this.languageWarning[id] ?? null
    }
  }

  snapshot() {
    const cfg = this.config.get()
    return {
      platform: platform.describe(),
      wine: this.wine,
      vulkan: this.vulkan,
      linuxPerf: this.linuxPerf,
      api: this.api.lastStatus,
      user: this.auth.user,
      supporter: this.supporter,
      authenticated: this.auth.isAuthenticated(),
      hasSavedPassword: !!this.auth.password,
      selectedClient: cfg.selectedClient,
      launcherUpdate: this.launcherUpdate,
      launcherUpdateError: this.launcherUpdateError,
      clients: Object.keys(cfg.clients).map((id) => this.clientState(id)),
      task: this.task && { id: this.task.id, kind: this.task.kind, stage: this.task.stage, phase: this.task.phase, done: this.task.done, total: this.task.total, file: this.task.file, bytesPerSec: this.task.bytesPerSec },
      settings: {
        apiBaseUrl: cfg.api.baseUrl,
        discoveryEnabled: cfg.api.discovery.enabled,
        realmlist: cfg.realmlist,
        locale: cfg.locale,
        gameLanguage: cfg.gameLanguage || 'enUS',
        installDir: cfg.installDir,
        winePath: cfg.wine.path,
        winePrefix: cfg.wine.prefix,
        graphicsFiltersEnabled: shouldEnableFilters(cfg.graphics || {}),
        graphicsUseDxvk: cfg.graphics?.useDxvk !== false,
        graphicsResolutionMode: cfg.graphics?.resolutionMode || 'auto',
        graphicsCustomResolution: cfg.graphics?.customResolution || '',
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
      if (this.installer.verify(id).installed) this.installer.ensureRealmlist(id, user.username, creds?.password)
    }
    await Promise.all([this.refreshSupporter(), this.refreshManifests()])
    if (this.supporter?.supporter) {
      await this.refreshSupporterManifests()
    }
    this.#publish()
    return user
  }

  savePasswordForAutoLogin(password) {
    const ok = this.auth.savePasswordForAutoLogin(password)
    if (ok) {
      for (const id of Object.keys(this.config.get().clients)) {
        if (this.installer.verify(id).installed) this.installer.ensureRealmlist(id, this.auth.user?.username, password)
      }
    }
    this.#publish()
    return ok
  }

  async logout() {
    await this.auth.logout()
    this.supporter = null
    this.manifestCache = {}
    this.supporterManifestCache = {}
    for (const id of Object.keys(this.config.get().clients)) {
      try { this.supporterContent?.deactivate(id) } catch (err) { log.warn(`logout deactivate ${id} failed`, err.message) }
    }
    this.#publish()
  }

  /** Fetches the supporter badge status for the logged-in account from Pikachu (/donation/v1/me). */
  async refreshSupporter() {
    if (!this.auth.isAuthenticated() && !this.auth.session) {
      this.supporter = null
      return null
    }
    try {
      const token = await this.auth.accessToken()
      const res = await this.api.request('GET', '/me', { token, prefix: '/donation/v1' })
      this.supporterCheckedAt = Date.now()
      this.supporter = res && typeof res.supporter === 'boolean'
        ? { supporter: res.supporter, since: res.since ?? null, donations: Number(res.donations) || 0 }
        : null
    } catch (err) {
      log.warn('supporter status unavailable', toPlain(err))
    }
    return this.supporter
  }

  async refreshSupporterIfStale(maxAgeMs = 15_000) {
    if (!this.auth.isAuthenticated() && !this.auth.session) return null
    if (Date.now() - this.supporterCheckedAt < maxAgeMs) return this.supporter
    const prev = JSON.stringify(this.supporter)
    await this.refreshSupporter()
    if (JSON.stringify(this.supporter) !== prev) this.#publish()
    return this.supporter
  }

  /** Builds the website URL, attaching a fresh independent web SSO token in #sso=... when signed in. */
  async buildWebsiteUrl(baseUrl) {
    const clean = String(baseUrl || '').trim().replace(/#.*$/, '')
    if (!clean) return clean
    if (!this.auth.isAuthenticated() && !this.auth.session) return clean
    try {
      const token = await this.auth.accessToken()
      const res = await this.api.request('POST', '/auth/web-handoff', { token })
      if (res && typeof res.refresh_token === 'string' && res.refresh_token) {
        return `${clean}#sso=${encodeURIComponent(res.refresh_token)}`
      }
    } catch (err) {
      log.warn('web SSO handoff unavailable, opening site normally', toPlain(err))
    }
    return clean
  }

  async checkApi() {
    await this.api.health()
    this.#publish()
    return this.api.lastStatus
  }

  /** Fetches supporter-exclusive dev manifests (/manifest/{client}/supporter) for enabled available clients. */
  async refreshSupporterManifests(onlyClientId = null) {
    if (!this.supporter?.supporter || (!this.auth.isAuthenticated() && !this.auth.session)) {
      this.supporterManifestCache = {}
      return
    }
    if (this.api.lastStatus?.state !== 'online') return
    const ids = onlyClientId ? [onlyClientId] : Object.keys(this.config.get().clients)
    for (const id of ids) {
      const c = this.config.client(id)
      if (!c.available || !c.supporterContentEnabled) continue
      try {
        const m = await this.manifests.fetchSupporterManifest(id)
        if (m) this.supporterManifestCache[id] = { manifest: m, fetchedAt: Date.now() }
        else delete this.supporterManifestCache[id]
      } catch (err) {
        log.warn(`supporter manifest ${id} unavailable`, toPlain(err))
      }
    }
  }

  /**
   * Toggles early-access supporter dev content ON or OFF for a specific client (wow32 or wow64).
   * When enabling: ALWAYS re-verifies supporter status directly in MariaDB (wowlk_site.donation)
   * via GET /donation/v1/me, then fetches and syncs the supporter manifest for that client.
   * When disabling: immediately reverts any active supporter overlay for that client.
   */
  async setSupporterContentEnabled(clientId, enabled) {
    if (this.task) throw new LauncherError('BUSY', 'Wait for the current operation to finish.')
    const c = this.config.client(clientId)
    if (this.game.isRunning(clientId)) {
      throw new LauncherError('ALREADY_RUNNING', 'Close the game before changing new content settings.')
    }
    const key = `clients.${clientId}.supporterContentEnabled`

    if (enabled) {
      await this.refreshSupporter()
      if (!this.supporter?.supporter) {
        this.config.update({ [key]: false })
        this.#publish()
        throw new LauncherError('NOT_SUPPORTER', 'Your account is not confirmed as a Supporter.')
      }
      this.config.update({ [key]: true })
      try { this.languagePack?.deactivate(clientId) } catch (err) { log.warn(`deactivate language ${clientId} failed`, err.message) }
      if (c.available) await this.refreshSupporterManifests(clientId)
      this.#publish()

      const st = this.clientState(clientId)
      if (st.installed && st.supporterUpdateAvailable) {
        await this.syncSupporterContent(clientId)
      }
      if (st.installed && (this.config.get().gameLanguage || 'enUS') !== 'enUS' && this.languagePack) {
        try { this.supporterContent?.activate(clientId) } catch (err) { log.warn(`activate supporter ${clientId} failed`, err.message) }
        const lang = this.config.get().gameLanguage
        const lm = await this.refreshLanguageManifest(clientId, lang)
        if (lm) {
          await this.#run(clientId, 'update', async (signal) => {
            await this.languagePack.sync(clientId, lm, { signal, onProgress: this.#progress('update') })
            await this.languagePack.activate(clientId, lm, { signal })
          })
        }
      }
    } else {
      this.config.update({ [key]: false })
      try { this.languagePack?.deactivate(clientId) } catch (err) { log.warn(`deactivate language ${clientId} failed`, err.message) }
      try { this.supporterContent?.deactivate(clientId) } catch (err) { log.warn(`deactivate supporter ${clientId} failed`, err.message) }
      const st = this.clientState(clientId)
      if (st.installed && (this.config.get().gameLanguage || 'enUS') !== 'enUS' && this.languagePack) {
        const lang = this.config.get().gameLanguage
        const lm = await this.refreshLanguageManifest(clientId, lang)
        if (lm) {
          await this.#run(clientId, 'update', async (signal) => {
            await this.languagePack.sync(clientId, lm, { signal, onProgress: this.#progress('update') })
            await this.languagePack.activate(clientId, lm, { signal })
          })
        }
      }
      this.#publish()
    }
    return this.snapshot()
  }

  async syncAccountLanguage(lang) {
    if (!this.auth.isAuthenticated() && !this.auth.session) return false
    if (this.api.lastStatus?.state !== 'online') return false
    try {
      const token = await this.auth.accessToken()
      await this.api.request('PUT', '/account/language', { token, body: { language: lang } })
      return true
    } catch (err) {
      log.warn(`account language sync (${lang}) failed`, toPlain(err))
      return false
    }
  }

  async refreshLanguageManifest(clientId, lang) {
    if (!lang || lang === 'enUS' || !this.manifests?.fetchLanguageManifest) return null
    if (this.api.lastStatus?.state !== 'online') return this.languageManifestCache[`${clientId}:${lang}`]?.manifest || null
    try {
      const m = await this.manifests.fetchLanguageManifest(clientId, lang)
      if (m) this.languageManifestCache[`${clientId}:${lang}`] = { manifest: m, fetchedAt: Date.now() }
      else delete this.languageManifestCache[`${clientId}:${lang}`]
      return m
    } catch (err) {
      log.warn(`language manifest ${clientId}/${lang} unavailable`, toPlain(err))
      return null
    }
  }

  /**
   * Switches the game language ('enUS' | 'ptBR'), syncs preference to the server,
   * and immediately downloads/applies (or reverts) the language pack for the selected installed client.
   */
  async setGameLanguage(lang) {
    if (this.task) throw new LauncherError('BUSY', 'Wait for the current operation to finish.')
    const cfg = this.config.get()
    for (const id of Object.keys(cfg.clients)) {
      if (this.game.isRunning(id)) {
        throw new LauncherError('ALREADY_RUNNING', 'Close the game before changing the game language.')
      }
    }
    this.config.update({ gameLanguage: lang })
    const serverSynced = await this.syncAccountLanguage(lang)
    const selectedId = this.config.get().selectedClient || 'wow32'

    if (lang === 'enUS') {
      for (const id of Object.keys(cfg.clients)) {
        try { this.languagePack?.deactivate(id) } catch (err) { log.warn(`deactivate language ${id} failed`, err.message) }
      }
      this.#publish()
      return { language: lang, applied: 0, serverSynced }
    }

    const st = this.clientState(selectedId)
    if (!st.installed || !this.languagePack) {
      this.#publish()
      return { language: lang, applied: 0, serverSynced, pendingInstall: !st.installed }
    }

    const supporterOn = !!(this.config.client(selectedId).supporterContentEnabled && this.supporter?.supporter)
    if (supporterOn && !this.supporterContent?.isActive(selectedId)) {
      try { this.languagePack.deactivate(selectedId) } catch {}
      try { this.supporterContent?.activate(selectedId) } catch {}
    } else if (!supporterOn && this.supporterContent?.isActive(selectedId)) {
      try { this.languagePack.deactivate(selectedId) } catch {}
      try { this.supporterContent?.deactivate(selectedId) } catch {}
    }

    let result = { applied: 0, missingVariant: true }
    await this.#run(selectedId, 'update', async (signal) => {
      const lm = await this.refreshLanguageManifest(selectedId, lang)
      if (!lm) return
      if (this.task) this.task.stage = 'verify'
      await this.languagePack.sync(selectedId, lm, {
        signal,
        onProgress: (p) => {
          if (this.task) this.task.stage = p.phase === 'downloading' ? 'update' : 'verify'
          this.#progress(p.phase === 'downloading' ? 'update' : 'verify')(p)
        }
      })
      result = await this.languagePack.activate(selectedId, lm, { signal })
    })
    return { language: lang, serverSynced, ...result }
  }

  /** Downloads/updates the supporter overlay cache for a client inside .olk-supporter/files/. */
  syncSupporterContent(id) {
    return this.#run(id, 'update', async (signal) => {
      if (!this.supporterContent) return this.clientState(id)
      const m = this.supporterManifestCache[id]?.manifest ?? (await this.manifests.fetchSupporterManifest(id))
      if (!m) return this.clientState(id)
      this.supporterManifestCache[id] = { manifest: m, fetchedAt: Date.now() }
      if (this.task) this.task.stage = 'verify'
      await this.supporterContent.sync(id, m, {
        signal,
        onProgress: (p) => {
          if (this.task) this.task.stage = p.phase === 'downloading' ? 'update' : 'verify'
          this.#progress(p.phase === 'downloading' ? 'update' : 'verify')(p)
        }
      })
      return this.clientState(id)
    })
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

      let latestManifest = m
      if (!latestManifest) {
        try {
          await this.refreshManifests()
          latestManifest = this.manifestCache[id]?.manifest
        } catch {}
      }
      if (latestManifest) await this.#update(id, latestManifest, signal)
      return this.clientState(id)
    })
  }

  /** Incremental update (or repair: same thing, it re-checks every listed file). */
  update(id, { repair = false } = {}) {
    return this.#run(id, repair ? 'repair' : 'update', async (signal) => {
      // Fixed order: undo language -> undo supporter -> official update -> sync supporter -> sync language.
      this.languagePack?.deactivate(id)
      this.supporterContent?.deactivate(id)
      const m = this.manifestCache[id]?.manifest ?? (await this.manifests.fetch(id))
      this.manifestCache[id] = { manifest: m, fetchedAt: Date.now() }
      await this.#update(id, m, signal, { ignoreCache: repair })
      this.installer.ensureRealmlist(id)
      const supporterOn = !!(this.config.client(id).supporterContentEnabled && this.supporter?.supporter && this.supporterContent)
      if (supporterOn) {
        const sm = this.supporterManifestCache[id]?.manifest ?? (await this.manifests.fetchSupporterManifest(id))
        if (sm) {
          this.supporterManifestCache[id] = { manifest: sm, fetchedAt: Date.now() }
          await this.supporterContent.sync(id, sm, { signal, onProgress: this.#progress('update') })
        }
      }
      const lang = this.config.get().gameLanguage || 'enUS'
      if (lang !== 'enUS' && this.languagePack) {
        if (supporterOn) this.supporterContent.activate(id)
        const lm = await this.refreshLanguageManifest(id, lang)
        if (lm) {
          await this.languagePack.sync(id, lm, { signal, onProgress: this.#progress('update') })
          await this.languagePack.activate(id, lm, { signal })
        }
      }
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

  /** Pre-launch version check: refreshes client/supporter manifests from API when online so Play never launches stale/incompatible versions. */
  async #preLaunchVersionCheck(id) {
    if (!this.api || !this.manifests?.fetch) return
    if (this.api.lastStatus?.state !== 'online') return
    try {
      const m = await this.manifests.fetch(id)
      this.manifestCache[id] = { manifest: m, fetchedAt: Date.now() }
    } catch (err) {
      if (err.code === 'LAUNCHER_OUTDATED') {
        this.lastError[id] = toPlain(err)
        this.#publish()
        throw err
      }
      log.warn(`pre-launch manifest check for ${id} failed (continuing with cache)`, toPlain(err))
    }
    const supporterOn = !!(this.config.client(id).supporterContentEnabled && this.supporter?.supporter)
    if (supporterOn && this.manifests.fetchSupporterManifest) {
      try {
        const sm = await this.manifests.fetchSupporterManifest(id)
        if (sm) this.supporterManifestCache[id] = { manifest: sm, fetchedAt: Date.now() }
      } catch (err) {
        log.warn(`pre-launch supporter manifest check for ${id} failed`, toPlain(err))
      }
    }
  }

  async play(id) {
    if (this.task) throw new LauncherError('BUSY', 'Wait for the current operation to finish.')
    delete this.lastError[id]
    delete this.languageWarning[id]

    // Verify live versions between launcher, client and supporter channel before starting WoW.
    await this.#preLaunchVersionCheck(id)

    const state = this.clientState(id)
    if (state.updateAvailable) {
      log.info(`update required before play for ${id} (${state.version || 'base'} -> ${state.latestVersion})`)
      return this.update(id)
    }
    const supporterOn = !!(this.config.client(id).supporterContentEnabled && this.supporter?.supporter)
    if (supporterOn && state.supporterUpdateAvailable) {
      log.info(`supporter content update required before play for ${id} (${state.supporterVersion || 'none'} -> ${state.supporterLatestVersion})`)
      // Always deactivate language overlay before updating supporter base files
      try { this.languagePack?.deactivate(id) } catch {}
      await this.syncSupporterContent(id)
    }
    if (platform.platform !== 'win32' && (!this.wine || !this.wine.found)) {
      log.info(`Wine missing on ${platform.platform}; auto-installing wine runtime fallback before launching...`)
      await this.installWine()
    }
    try {
      const lang = this.config.get().gameLanguage || 'enUS'
      const supporterCurrentlyActive = this.supporterContent?.isActive(id) || false
      // If supporter state changed or we are switching back to English, revert language overlay first.
      if (lang === 'enUS' || supporterOn !== supporterCurrentlyActive) {
        this.languagePack?.deactivate(id)
      }
      // Apply or revert supporter overlay cleanly right before launching the game.
      if (supporterOn) this.supporterContent?.activate(id)
      else this.supporterContent?.deactivate(id)

      let languageWarning = null
      if (lang !== 'enUS' && this.languagePack) {
        const lm = (await this.refreshLanguageManifest(id, lang)) ?? this.languageManifestCache[`${id}:${lang}`]?.manifest
        if (lm) {
          const activeLang = this.languagePack.readActive(id)
          const { baseSha, variant, composable } = await this.languagePack.resolveVariant(id, lm)
          if (composable || variant) {
            const needsSyncOrCompose = !activeLang
              || activeLang.language !== lang
              || activeLang.version !== lm.version
              || activeLang.baseSha256 !== baseSha
              || (!!lm.spell_patch && !activeLang.spellPatch)
            if (needsSyncOrCompose) {
              await this.#run(id, 'update', async (signal) => {
                await this.languagePack.sync(id, lm, {
                  signal,
                  onProgress: (p) => {
                    if (this.task) this.task.stage = p.phase === 'downloading' ? 'update' : 'verify'
                    this.#progress(p.phase === 'downloading' ? 'update' : 'verify')(p)
                  }
                })
                const act = await this.languagePack.activate(id, lm, { signal })
                if (act?.missingVariant || !act?.applied) {
                  languageWarning = {
                    language: lang,
                    baseSha,
                    message: `Pacote ${lang} não pôde ser aplicado para esta versão do cliente; iniciando em inglês.`
                  }
                }
              })
            } else {
              const act = await this.languagePack.activate(id, lm)
              if (act?.missingVariant || !act?.applied) {
                languageWarning = {
                  language: lang,
                  baseSha,
                  message: `Pacote ${lang} não pôde ser aplicado para esta versão do cliente; iniciando em inglês.`
                }
              }
            }
          } else {
            log.warn(`pre-launch language check: no ${lang} package available for base ${baseSha || 'unknown'} (manifest v${lm.version})`)
            languageWarning = {
              language: lang,
              baseSha,
              message: `O pacote de tradução ${lang} ainda não está disponível para esta versão do cliente; o jogo abrirá em inglês.`
            }
          }
        } else {
          languageWarning = {
            language: lang,
            baseSha: null,
            message: `Não foi possível verificar o pacote de tradução ${lang}; o jogo abrirá no idioma atual.`
          }
        }
      }
      if (languageWarning) this.languageWarning[id] = languageWarning
      else delete this.languageWarning[id]

      await this.syncAccountLanguage(lang)

      const credentials = { username: this.auth.user?.username, password: this.auth.password }
      const r = await this.game.launch(id, { onExit: () => { this.#publish(); this.emit('game-exit') }, credentials })
      this.#publish()
      return languageWarning ? { ...r, languageWarning } : r
    } catch (err) {
      this.lastError[id] = toPlain(err)
      this.#publish()
      throw err
    }
  }

  async installWine() {
    if (this.task) throw new LauncherError('BUSY', 'Wait for the current operation to finish.')
    const runtimeUrl = 'https://pub-aca87790200a4237af40519010e23d8c.r2.dev/runtimes/wine-runner-linux-x64.tar.xz'
    const runtimeSize = 114355232
    const runtimeSha256 = '0a6c7c6947b26071ab06fc4025e33efb71afbd4809438e821d149a0a6f30b540'

    const tempDir = path.join(this.config.dataDir, 'temp')
    fs.mkdirSync(tempDir, { recursive: true })
    const archiveDest = path.join(tempDir, 'wine-runner.tar.xz')
    const targetDir = path.join(this.config.dataDir, 'runtime', 'wine')

    const ctrl = new AbortController()
    this.task = {
      id: 'wine',
      kind: 'wine',
      stage: 'download',
      phase: 'downloading',
      done: 0,
      total: runtimeSize,
      file: 'Wine Runner (Linux / Steam Deck)',
      controller: ctrl
    }
    this.#publish()

    try {
      await this.downloader.download({
        url: runtimeUrl,
        dest: archiveDest,
        size: runtimeSize,
        sha256: runtimeSha256,
        signal: ctrl.signal,
        onProgress: (p) => {
          if (this.task) {
            this.task.done = p.received || p.done || 0
            this.task.total = p.total || runtimeSize
            this.task.bytesPerSec = p.bytesPerSec
            this.#publish()
          }
        }
      })

      if (this.task) {
        this.task.stage = 'extract'
        this.task.phase = 'extracting'
        this.#publish()
      }

      fs.mkdirSync(targetDir, { recursive: true })
      await new Promise((resolve, reject) => {
        const { spawn } = require('node:child_process')
        const proc = spawn('tar', ['-xJf', archiveDest, '-C', targetDir], { stdio: ['ignore', 'pipe', 'pipe'] })
        let stderr = ''
        proc.stderr?.on('data', (d) => { stderr += d })
        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`tar extraction failed with code ${code}: ${stderr}`))
        })
      })

      try { fs.unlinkSync(archiveDest) } catch { /* ignore */ }

      this.wine = await platform.detectWine(null, platform.platform, [this.internalWinePath()])
      if (this.wine?.found && this.wine?.path) {
        try { this.config.update({ 'wine.path': this.wine.path }) } catch {}
      }
      this.vulkan = platform.detectVulkan(platform.platform, { winePath: this.wine?.path })
      log.info('internal wine runtime installed successfully', this.wine)
    } catch (err) {
      log.error('failed to install wine runtime', toPlain(err))
      throw err
    } finally {
      this.task = null
      this.#publish()
    }
    return this.wine
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
        if (updateResult?.error) {
          this.launcherUpdateError = {
            version: updateResult.version || null,
            message: updateResult.error,
            manualUrl: updateResult.manualUrl || null
          }
        }
      } catch (err) {
        log.warn('periodic launcher update check failed', toPlain(err))
        if (this.selfUpdater?.lastError) this.launcherUpdateError = this.selfUpdater.lastError
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

      if (this.auth.isAuthenticated() || this.auth.session) {
        try {
          await this.refreshSupporter()
          if (this.supporter?.supporter) {
            await this.refreshSupporterManifests()
          }
        } catch (err) {
          log.warn('periodic supporter refresh failed', toPlain(err))
        }
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
    if (patch['wine.path'] !== undefined) {
      this.wine = await platform.detectWine(after.wine.path, platform.platform, [this.internalWinePath()])
      this.vulkan = platform.detectVulkan(platform.platform, { winePath: this.wine?.path })
    }
    // Push a new realmlist or video setting into installed clients right away.
    if (patch.realmlist || patch['graphics.resolutionMode'] !== undefined || patch['graphics.customResolution'] !== undefined) {
      for (const id of Object.keys(after.clients)) if (this.installer.verify(id).installed) this.installer.ensureRealmlist(id)
    }
    this.#publish()
    return this.snapshot()
  }

  async detectWineCandidates() {
    return platform.detectAllWineCandidates(this.config.get().wine?.path, [this.internalWinePath()])
  }

  recheckVulkan() {
    this.vulkan = platform.detectVulkan(platform.platform, { winePath: this.wine?.path })
    this.linuxPerf = platform.detectLinuxPerformance ? platform.detectLinuxPerformance() : null
    this.#publish()
    return this.vulkan
  }

  async enableNtsync() {
    if (!platform.enableLinuxNtsync) return { ok: false, error: 'Não suportado nesta plataforma.' }
    const res = await platform.enableLinuxNtsync()
    this.linuxPerf = platform.detectLinuxPerformance ? platform.detectLinuxPerformance() : null
    this.#publish()
    return { ...res, linuxPerf: this.linuxPerf }
  }

  async resetWinePrefix() {
    const cfg = this.config.get()
    const prefix = cfg.wine?.prefix || path.join(this.config.dataDir, 'wineprefix')
    if (fs.existsSync(prefix)) {
      try {
        fs.rmSync(prefix, { recursive: true, force: true })
        log.info('Wineprefix reset successfully:', prefix)
        return { success: true, path: prefix }
      } catch (err) {
        throw new LauncherError('RESET_FAILED', `Failed to reset wineprefix: ${err.message}`)
      }
    }
    return { success: true, path: prefix }
  }

  clearError(id) { delete this.lastError[id]; this.#publish() }
}

module.exports = { LauncherController }
