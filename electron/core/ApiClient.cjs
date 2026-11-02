'use strict'
/**
 * ApiClient — talks to the Pikachu API (never to Abra API for auth).
 *
 * Base URL resolution, in order:
 *   1. settings `api.baseUrl` (manual override)
 *   2. discovery: GET Abra API notifications `key=ngrockurl` → last item's `content`
 *      (same rule as Pikachu's fetchTunnelUrl): trim, strip trailing "/", must start with http.
 * The discovered URL is confirmed with GET {base}{prefix}/health before use.
 */
const { LauncherError } = require('./errors.cjs')
const { assertSafeUrl } = require('./pathSafety.cjs')
const log = require('./logger.cjs')

const DEFAULT_HEADERS = {
  Accept: 'application/json',
  'ngrok-skip-browser-warning': 'true',
  'User-Agent': 'OLKPlusLauncher'
}

function cleanTunnelUrl(raw) {
  const s = String(raw ?? '').trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(s) ? s : null
}

class ApiClient {
  /**
   * @param {{ config: import('./ConfigurationManager.cjs').ConfigurationManager, launcherVersion: string, fetchImpl?: typeof fetch }} deps
   */
  constructor({ config, launcherVersion, fetchImpl }) {
    this.config = config
    this.launcherVersion = launcherVersion
    this.fetch = fetchImpl || globalThis.fetch
    this.baseUrl = null
    this.lastStatus = { state: 'unknown', baseUrl: null, checkedAt: null, error: null }
  }

  #timeout() { return this.config.get().api.timeoutMs || 15000 }

  async #raw(url, init = {}, timeoutMs = this.#timeout()) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      return await this.fetch(url, { ...init, headers: { ...DEFAULT_HEADERS, ...init.headers }, signal: ctrl.signal })
    } catch (err) {
      if (err?.name === 'AbortError') throw new LauncherError('API_TIMEOUT', 'The server took too long to answer.')
      throw new LauncherError('API_UNREACHABLE', 'Could not reach the server. Check your connection.')
    } finally {
      clearTimeout(timer)
    }
  }

  /** Discovers the current Pikachu tunnel URL through Abra API. */
  async discover() {
    const { discovery } = this.config.get().api
    const res = await this.#raw(discovery.url, { headers: { 'Cache-Control': 'no-cache' } })
    if (!res.ok) throw new LauncherError('DISCOVERY_FAILED', `Server discovery failed (${res.status}).`)
    const list = await res.json().catch(() => null)
    const last = Array.isArray(list) ? list[list.length - 1] : null
    const url = cleanTunnelUrl(last?.content)
    if (!url) throw new LauncherError('DISCOVERY_FAILED', 'Server discovery returned no valid URL.')
    return url
  }

  /** Resolves (and caches) the API base URL, confirming it answers /health. */
  async resolveBase({ force = false } = {}) {
    if (this.baseUrl && !force) return this.baseUrl
    const cfg = this.config.get().api
    const candidate = cfg.baseUrl || (cfg.discovery.enabled ? await this.discover() : null)
    if (!candidate) throw new LauncherError('API_NOT_CONFIGURED', 'No server URL configured.')
    assertSafeUrl(candidate)
    this.baseUrl = candidate.replace(/\/+$/, '')
    return this.baseUrl
  }

  /** GET /health — sets lastStatus for the UI's connection indicator. */
  async health() {
    const checkedAt = new Date().toISOString()
    try {
      const base = await this.resolveBase({ force: true })
      const body = await this.request('GET', '/health', { retryDiscovery: false })
      const ok = body && body.service === 'pikachu'
      this.lastStatus = ok
        ? { state: 'online', baseUrl: base, checkedAt, error: null, apiVersion: body.api_version ?? null, maintenance: !!body.maintenance }
        : { state: 'incompatible', baseUrl: base, checkedAt, error: 'Server does not implement the launcher API yet.' }
    } catch (err) {
      const pending = err.code === 'HTTP_404'
      this.lastStatus = {
        state: pending ? 'incompatible' : 'offline',
        baseUrl: this.baseUrl,
        checkedAt,
        error: pending ? 'Server is online but the launcher API (/launcher/v1) is not available yet.' : err.message
      }
    }
    return this.lastStatus
  }

  /**
   * JSON request against {base}{prefix}{path}. Maps the error envelope
   * { "error": { "code": "...", "message": "..." } } to LauncherError.
   */
  async request(method, path, { body, token, retryDiscovery = true } = {}) {
    const base = await this.resolveBase()
    const url = `${base}${this.config.get().api.pathPrefix}${path}`
    const headers = { 'X-Launcher-Version': this.launcherVersion }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`
    let res
    try {
      res = await this.#raw(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    } catch (err) {
      // Tunnel URLs rotate: rediscover once and retry.
      if (retryDiscovery && !this.config.get().api.baseUrl && this.config.get().api.discovery.enabled) {
        log.warn(`API unreachable at ${base}, rediscovering`)
        await this.resolveBase({ force: true })
        return this.request(method, path, { body, token, retryDiscovery: false })
      }
      throw err
    }
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { /* non-JSON (e.g. ngrok HTML) */ }
    if (res.ok) {
      if (data === null && text) throw new LauncherError('API_BAD_RESPONSE', 'The server sent an invalid response.')
      return data
    }
    const code = data?.error?.code || `HTTP_${res.status}`
    const message = data?.error?.message || defaultMessage(res.status)
    const err = new LauncherError(code, message)
    err.status = res.status
    if (res.headers.get('retry-after')) err.retryAfter = Number(res.headers.get('retry-after'))
    throw err
  }
}

function defaultMessage(status) {
  if (status === 401) return 'Invalid username or password.'
  if (status === 403) return 'This account cannot log in.'
  if (status === 404) return 'The server does not support this launcher feature yet.'
  if (status === 426) return 'This launcher version is too old. Please update it.'
  if (status === 429) return 'Too many attempts. Please wait and try again.'
  if (status === 503) return 'The server is under maintenance.'
  if (status >= 500) return 'The server had a problem. Try again later.'
  return `Unexpected server response (${status}).`
}

module.exports = { ApiClient, cleanTunnelUrl }
