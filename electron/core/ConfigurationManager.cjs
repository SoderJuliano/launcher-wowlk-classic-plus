'use strict'
/**
 * ConfigurationManager — factory defaults (config/defaults.json) deep-merged with the
 * user's settings.json in the app data folder. Everything is editable at runtime;
 * no value requires recompiling the launcher.
 */
const fs = require('node:fs')
const path = require('node:path')
const { LauncherError } = require('./errors.cjs')
const { assertSafeUrl } = require('./pathSafety.cjs')

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v
  return out
}

/** Only these keys can be changed from the UI (the rest is factory/manifest data). */
const EDITABLE = ['api.baseUrl', 'api.discovery.enabled', 'realmlist', 'locale', 'selectedClient', 'installDir', 'wine.path', 'wine.prefix', 'clients.wow32.basePackage.url', 'clients.wow64.basePackage.url', 'clients.wow32.path', 'clients.wow64.path', 'clients.wow32.manifestUrl', 'clients.wow64.manifestUrl', 'websiteUrl']

class ConfigurationManager {
  /**
   * @param {{ defaultsFile: string, dataDir: string }} opts
   */
  constructor({ defaultsFile, dataDir }) {
    this.dataDir = dataDir
    this.file = path.join(dataDir, 'settings.json')
    this.defaults = JSON.parse(fs.readFileSync(defaultsFile, 'utf8'))
    delete this.defaults.$comment
    this.defaults.installDir = path.join(dataDir, 'games')
    this.user = this.#readUser()
  }

  #readUser() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { return {} }
  }

  get() { return deepMerge(this.defaults, this.user) }

  client(id) {
    const c = this.get().clients[id]
    if (!c) throw new LauncherError('UNKNOWN_CLIENT', `Unknown client: ${id}`)
    return { id, ...c }
  }

  /** Install folder of a client: an adopted existing folder (clients.<id>.path) or <installDir>/<id>. */
  clientDir(id) {
    const c = this.client(id)
    return c.path ? path.resolve(c.path) : path.join(this.get().installDir, id)
  }

  /** Applies a flat patch like { 'wine.path': '/usr/bin/wine' } after validating it. */
  update(patch) {
    const next = structuredClone(this.user)
    for (const [key, value] of Object.entries(patch || {})) {
      if (!EDITABLE.includes(key)) throw new LauncherError('CONFIG_INVALID', `Setting not editable: ${key}`)
      this.#validate(key, value)
      const segs = key.split('.')
      let node = next
      for (const s of segs.slice(0, -1)) node = node[s] = isObj(node[s]) ? node[s] : {}
      if (value === null || value === '') delete node[segs.at(-1)]
      else node[segs.at(-1)] = value
    }
    fs.mkdirSync(this.dataDir, { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    fs.renameSync(tmp, this.file)
    this.user = next
    return this.get()
  }

  #validate(key, value) {
    if (value === null || value === '') return
    if (key.endsWith('Url') || key.endsWith('.url') || key === 'api.baseUrl' || key.endsWith('.manifestUrl')) {
      if (typeof value !== 'string') throw new LauncherError('CONFIG_INVALID', `${key} must be a URL`)
      assertSafeUrl(value)
    }
    if (key === 'realmlist' && !/^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(value)) {
      throw new LauncherError('CONFIG_INVALID', 'Realmlist must be host or host:port')
    }
    if (key === 'locale' && !/^[a-z]{2}[A-Z]{2}$/.test(value)) throw new LauncherError('CONFIG_INVALID', 'Locale must look like enUS')
    if (key === 'selectedClient') this.client(value)
    if ((key === 'installDir' || key.startsWith('wine.') || /^clients\.[a-z0-9]+\.path$/.test(key)) && (typeof value !== 'string' || !path.isAbsolute(value))) {
      throw new LauncherError('CONFIG_INVALID', `${key} must be an absolute path`)
    }
    if (key === 'api.discovery.enabled' && typeof value !== 'boolean') throw new LauncherError('CONFIG_INVALID', `${key} must be true/false`)
  }
}

module.exports = { ConfigurationManager, deepMerge }
