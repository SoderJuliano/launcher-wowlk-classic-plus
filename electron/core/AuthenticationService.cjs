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
const crypto = require('node:crypto')
const os = require('node:os')
const { LauncherError } = require('./errors.cjs')
const log = require('./logger.cjs')

const REFRESH_MARGIN_MS = 60_000
const FALLBACK_MAGIC = Buffer.from('SLKP_ENC1') // Soder Launcher KeyStore Profile

function getMachineKey() {
  let seed = ''
  try { seed = fs.readFileSync('/etc/machine-id', 'utf8').trim() } catch {}
  if (!seed) {
    try { seed = fs.readFileSync('/var/lib/dbus/machine-id', 'utf8').trim() } catch {}
  }
  if (!seed) {
    try { seed = `${os.hostname()}-${os.userInfo().username}` } catch { seed = os.hostname() }
  }
  return crypto.scryptSync(seed, 'soder-launcher-salt-2026', 32)
}

function fallbackEncrypt(plaintext) {
  const key = getMachineKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([FALLBACK_MAGIC, iv, tag, encrypted])
}

function fallbackDecrypt(buf) {
  if (buf.length < FALLBACK_MAGIC.length + 12 + 16) throw new Error('Invalid encrypted buffer')
  const magic = buf.subarray(0, FALLBACK_MAGIC.length)
  if (!magic.equals(FALLBACK_MAGIC)) throw new Error('Magic mismatch')
  const iv = buf.subarray(FALLBACK_MAGIC.length, FALLBACK_MAGIC.length + 12)
  const tag = buf.subarray(FALLBACK_MAGIC.length + 12, FALLBACK_MAGIC.length + 28)
  const ciphertext = buf.subarray(FALLBACK_MAGIC.length + 28)
  const key = getMachineKey()
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8')
}

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

  savePasswordForAutoLogin(password) {
    if (!this.session) return false
    this.session.password = String(password)
    this.#persist()
    log.info(`saved password for auto-login for user ${this.session.user?.username}`)
    return true
  }

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
      const data = fs.readFileSync(this.file)
      let decryptedText = null
      let needsMigration = false
      if (data.length >= FALLBACK_MAGIC.length && data.subarray(0, FALLBACK_MAGIC.length).equals(FALLBACK_MAGIC)) {
        decryptedText = fallbackDecrypt(data)
      } else if (this.secure?.isEncryptionAvailable && this.secure.isEncryptionAvailable()) {
        try {
          decryptedText = this.secure.decryptString(data)
          needsMigration = true
        } catch {
          try { decryptedText = fallbackDecrypt(data) } catch {}
        }
      } else {
        try {
          decryptedText = fallbackDecrypt(data)
        } catch {
          return null
        }
      }
      if (!decryptedText) return null
      const saved = JSON.parse(decryptedText)
      const savedPwd = saved.password || null
      if (!savedPwd) {
        log.info('saved session lacks password for game auto-login, prompting normal login')
        this.#forgetDisk()
        return null
      }
      this.session = { accessToken: '', expiresAt: 0, refreshToken: saved.refreshToken, refreshExpiresAt: saved.refreshExpiresAt, user: saved.user, password: savedPwd }
      try {
        await this.refresh()
      } catch (e) {
        if (e.code === 'SESSION_EXPIRED' || e.code === 'INVALID_REFRESH_TOKEN') {
          this.session = null
          this.#forgetDisk()
          return null
        }
      }
      if (savedPwd && this.session) this.session.password = savedPwd
      if (needsMigration && this.session) {
        try { this.#persist() } catch {}
      }
      return this.session?.user || null
    } catch (err) {
      log.warn('session restore failed', { code: err.code, message: err.message })
      if (err.code === 'SESSION_EXPIRED' || err instanceof SyntaxError) this.#forgetDisk()
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
    if (!this.session?.refreshToken) return
    const payload = JSON.stringify({
      refreshToken: this.session.refreshToken,
      refreshExpiresAt: this.session.refreshExpiresAt,
      user: this.session.user,
      password: this.session.password || undefined
    })
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    let buf
    // No Linux (especialmente Steam Deck com alternância Desktop KDE / Gaming Mode Gamescope),
    // o safeStorage do Electron usa KWallet/libsecret que só existe no Desktop KDE e falha no Gaming Mode.
    // Usar AES-256-GCM atrelado ao /etc/machine-id garante persistência unificada entre os modos.
    if (this.platform === 'linux') {
      buf = fallbackEncrypt(payload)
    } else if (this.secure?.isEncryptionAvailable && this.secure.isEncryptionAvailable()) {
      try {
        buf = this.secure.encryptString(payload)
      } catch (err) {
        log.warn('safeStorage encryption failed, using machine fallback', err.message)
        buf = fallbackEncrypt(payload)
      }
    } else {
      buf = fallbackEncrypt(payload)
    }
    fs.writeFileSync(this.file, buf, { mode: 0o600 })
  }

  #forgetDisk() {
    try { fs.unlinkSync(this.file) } catch { /* not there */ }
  }
}

module.exports = { AuthenticationService }
