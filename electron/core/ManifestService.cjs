'use strict'
/**
 * ManifestService — fetches GET /launcher/v1/manifest/{client} from the Pikachu API and
 * validates it strictly. A manifest that fails ANY rule is rejected as a whole.
 * Format: docs/UPDATE_SYSTEM.md
 */
const { LauncherError } = require('./errors.cjs')
const { normalizeRelative, assertSafeUrl } = require('./pathSafety.cjs')
const { isSha256 } = require('./hashing.cjs')

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const MAX_FILES = 50_000

function cmpVersion(a, b) {
  const pa = String(a).split(/[-+]/)[0].split('.').map(Number)
  const pb = String(b).split(/[-+]/)[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  return 0
}

function fail(msg) { throw new LauncherError('MANIFEST_INVALID', `Invalid manifest: ${msg}`) }

/** Returns a normalised copy of the manifest or throws MANIFEST_INVALID. */
function validateManifest(m, expectedClient) {
  if (!m || typeof m !== 'object') fail('not an object')
  if (m.schema_version !== 1) fail(`unsupported schema_version ${m.schema_version}`)
  if (m.client !== expectedClient) fail(`client is "${m.client}", expected "${expectedClient}"`)
  if (!['x86', 'x64', 'arm64'].includes(m.architecture)) fail('architecture')
  if (!SEMVER.test(m.version || '')) fail('version must be semver (x.y.z)')
  if (m.min_launcher_version !== undefined && !SEMVER.test(m.min_launcher_version)) fail('min_launcher_version')
  if (m.executable !== undefined) normalizeRelative(m.executable)
  if (m.realmlist !== undefined && !/^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(m.realmlist)) fail('realmlist')
  if (!Array.isArray(m.files) || m.files.length > MAX_FILES) fail('files must be an array')
  if (!Array.isArray(m.deleted_files ?? [])) fail('deleted_files must be an array')

  const seen = new Set()
  const files = m.files.map((f, i) => {
    if (!f || typeof f !== 'object') fail(`files[${i}]`)
    const p = normalizeRelative(f.path)
    if (/^\.olk/i.test(p)) fail(`${p} is a reserved launcher path`)
    const key = p.toLowerCase() // Windows is case-insensitive
    if (seen.has(key)) fail(`duplicate path ${p}`)
    seen.add(key)
    if (!Number.isSafeInteger(f.size) || f.size < 0) fail(`files[${i}].size`)
    if (!isSha256(f.sha256)) fail(`files[${i}].sha256`)
    assertSafeUrl(f.url)
    return { path: p, size: f.size, sha256: f.sha256.toLowerCase(), url: f.url }
  })
  const deleted = (m.deleted_files ?? []).map((p) => {
    const n = normalizeRelative(p)
    if (/^\.olk/i.test(n)) fail(`${n} is a reserved launcher path`)
    if (seen.has(n.toLowerCase())) fail(`${n} is both in files and deleted_files`)
    return n
  })
  let base = null
  if (m.base_package) {
    const b = m.base_package
    if (typeof b.url !== 'string' || !b.url) fail('base_package.url')
    if (b.size !== undefined && (!Number.isSafeInteger(b.size) || b.size < 0)) fail('base_package.size')
    if (b.sha256 !== undefined && b.sha256 !== '' && !isSha256(b.sha256)) fail('base_package.sha256')
    if (b.root !== undefined && typeof b.root !== 'string') fail('base_package.root')
    base = { url: b.url, size: b.size || 0, sha256: b.sha256 || '', root: b.root, version: b.version ?? null }
  }
  return {
    schema_version: 1,
    client: m.client,
    architecture: m.architecture,
    version: m.version,
    min_launcher_version: m.min_launcher_version ?? null,
    executable: m.executable ?? null,
    realmlist: m.realmlist ?? null,
    base_package: base,
    files,
    deleted_files: deleted
  }
}

class ManifestService {
  constructor({ api, auth, launcherVersion, config, fetchImpl }) {
    this.api = api
    this.auth = auth
    this.launcherVersion = launcherVersion
    this.config = config
    this.fetchImpl = fetchImpl || globalThis.fetch
  }

  /**
   * Source order: Pikachu `GET /manifest/{client}` when the launcher API is online,
   * otherwise the static `clients.<id>.manifestUrl` (any HTTPS JSON file — no server code needed).
   */
  async fetch(clientId) {
    const staticUrl = this.config?.client(clientId).manifestUrl
    const apiOnline = this.api.lastStatus?.state === 'online'
    let raw
    if (apiOnline || !staticUrl) {
      const token = this.auth.isAuthenticated() || this.auth.session ? await this.auth.accessToken() : undefined
      raw = await this.api.request('GET', `/manifest/${encodeURIComponent(clientId)}`, { token })
    } else {
      raw = await this.#fetchStatic(staticUrl)
    }
    const m = validateManifest(raw, clientId)
    if (m.min_launcher_version && cmpVersion(this.launcherVersion, m.min_launcher_version) < 0) {
      throw new LauncherError('LAUNCHER_OUTDATED', `This launcher (${this.launcherVersion}) is too old. Version ${m.min_launcher_version} or newer is required.`)
    }
    return m
  }

  /**
   * Fetches the launcher self-update manifest.
   * Public endpoint, no auth required. Returns null if not published yet.
   */
  async fetchLauncherManifest() {
    try {
      const raw = await this.api.request('GET', '/manifest/launcher')
      return raw
    } catch (err) {
      if (err.status === 404 || err.code === 'HTTP_404') return null
      throw err
    }
  }

  async #fetchStatic(url) {
    assertSafeUrl(url)
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 20_000)
    try {
      const res = await this.fetchImpl(url, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'OLKPlusLauncher' }, signal: ctrl.signal })
      if (!res.ok) throw new LauncherError(`HTTP_${res.status}`, `Could not load the update manifest (HTTP ${res.status}).`)
      return await res.json()
    } catch (err) {
      if (err instanceof LauncherError) throw err
      throw new LauncherError('MANIFEST_UNREACHABLE', 'Could not reach the update server.')
    } finally { clearTimeout(t) }
  }
}

module.exports = { ManifestService, validateManifest, cmpVersion }
