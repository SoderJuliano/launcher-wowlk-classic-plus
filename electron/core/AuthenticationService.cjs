'use strict'
/**
 * AuthenticationService — login / refresh / logout against the Pikachu API.
 *
 * - The password is only held in memory for the duration of the login request.
 * - "Keep me signed in" stores ONLY the refresh token, encrypted with the OS keystore
 *   (Electron safeStorage: DPAPI on Windows, libsecret/kwallet on Linux, Keychain on macOS).
 *   If no keystore is available, the session is kept in memory only.
 */
const fs = require('node:fs')
const path = require('node:path')
const { LauncherError } = require('./errors.cjs')
const log = require('./logger.cjs')

const REFRESH_MARGIN_MS = 60_000

class AuthenticationService {
  /**
   * @param {{ api: import('./ApiClient.cjs').ApiClient, dataDir: string,
   *           secureStore: { isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string },
   *           platform: string, launcherVersion: string, now?: () => number }} deps
   */
  constructor({ api, dataDir, secureStore, platform, launcherVersion, now }) {
    this.api = api
    this.file = path.join(dataDir, 'session.bin')
    this.secure = secureStore
    this.platform = platform
    this.launcherVersion = launcherVersion
    this.now = now || Date.now
    this.session = null // { accessToken, expiresAt, refreshToken, refreshExpiresAt, user }
  }

  get user() { return this.session?.user ?? null }
  get password() { return this.session?.password ?? null }
  isAuthenticated() { return !!this.session && this.session.expiresAt > this.now() }

  #fromResponse(r) {
    if (!r || typeof r.access_token !== 'string' || !r.user || typeof r.user.username !== 'string') {
      throw new LauncherError('API_BAD_RESPONSE', 'Unexpected login response from the server.')
    }
    const t = this.now()
    return {
      accessToken: r.access_token,
      expiresAt: t + Math.max(30, Number(r.expires_in) || 900) * 1000,
      refreshToken: typeof r.refresh_token === 'string' ? r.refresh_token : null,
      refreshExpiresAt: r.refresh_expires_in ? t + Number(r.refresh_expires_in) * 1000 : null,
      user: { id: r.user.id, username: r.user.username, email_verified: r.user.email_verified ?? null }
    }
  }

  async login({ username, password, remember }) {
    const u = String(username ?? '').trim()
    if (!u || !password) throw new LauncherError('VALIDATION', 'Enter your username and password.')
    if (u.length > 32 || String(password).length > 64) throw new LauncherError('VALIDATION', 'Username or password is too long.')
    const res = await this.api.request('POST', '/auth/login', {
      body: {
        username: u,
        password: String(password),
        client: { launcher_version: this.launcherVersion, platform: this.platform }
      }
    })
    this.session = this.#fromResponse(res)
    this.session.password = String(password)
    if (remember) this.#persist()
    else this.#forgetDisk()
    log.info(`login ok for ${this.session.user.username}`)
    return this.session.user
  }

  /** Returns a valid access token, refreshing it when close to expiry. */
  async accessToken() {
    if (!this.session) throw new LauncherError('NOT_AUTHENTICATED', 'Please log in.')
    if (this.session.expiresAt - this.now() > REFRESH_MARGIN_MS) return this.session.accessToken
    await this.refresh()
    return this.session.accessToken
  }

  async refresh() {
    const rt = this.session?.refreshToken
    if (!rt || (this.session.refreshExpiresAt && this.session.refreshExpiresAt < this.now())) {
      this.session = null
      this.#forgetDisk()
      throw new LauncherError('SESSION_EXPIRED', 'Your session expired. Please log in again.')
    }
    try {
      const prevPassword = this.session?.password
      const res = await this.api.request('POST', '/auth/refresh', { body: { refresh_token: rt } })
      const remembered = fs.existsSync(this.file)
      this.session = this.#fromResponse({ ...res, refresh_token: res.refresh_token ?? rt })
      if (prevPassword) this.session.password = prevPassword
      if (remembered) this.#persist()
    } catch (err) {
      if (err.status === 401 || err.code === 'INVALID_REFRESH_TOKEN' || err.code === 'SESSION_EXPIRED') {
        this.session = null
        this.#forgetDisk()
        throw new LauncherError('SESSION_EXPIRED', 'Your session expired. Please log in again.')
      }
      throw err
    }
  }

  /** Restores a remembered session at startup (refreshes immediately). */
  async restore() {
    if (!fs.existsSync(this.file)) return null
    try {
      if (!this.secure.isEncryptionAvailable()) return null
      const saved = JSON.parse(this.secure.decryptString(fs.readFileSync(this.file)))
      const savedPwd = saved.password || null
      this.session = { accessToken: '', expiresAt: 0, refreshToken: saved.refreshToken, refreshExpiresAt: saved.refreshExpiresAt, user: saved.user, password: savedPwd }
      await this.refresh()
      if (savedPwd && this.session) this.session.password = savedPwd
      return this.session.user
    } catch (err) {
      log.warn('session restore failed', { code: err.code, message: err.message })
      if (err.code === 'SESSION_EXPIRED' || err instanceof SyntaxError) this.#forgetDisk()
      // Network errors keep the file so the user is signed in next time.
      if (err.code !== 'SESSION_EXPIRED') this.session = null
      return null
    }
  }

  async logout() {
    const token = this.session?.accessToken
    const rt = this.session?.refreshToken
    this.session = null
    this.#forgetDisk()
    if (token) {
      try { await this.api.request('POST', '/auth/logout', { token, body: { refresh_token: rt } }) } catch (err) { log.warn('logout call failed', err.code) }
    }
  }

  #persist() {
    if (!this.session?.refreshToken || !this.secure.isEncryptionAvailable()) return
    const payload = JSON.stringify({
      refreshToken: this.session.refreshToken,
      refreshExpiresAt: this.session.refreshExpiresAt,
      user: this.session.user,
      password: this.session.password || undefined
    })
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, this.secure.encryptString(payload), { mode: 0o600 })
  }

  #forgetDisk() {
    try { fs.unlinkSync(this.file) } catch { /* not there */ }
  }
}

module.exports = { AuthenticationService }
