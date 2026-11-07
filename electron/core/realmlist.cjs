'use strict'
/**
 * Realmlist configuration for the 3.3.5a client. Verified against the real package:
 *   Data/<locale>/realmlist.wtf   ← the file the client reads
 *   Data/realmlist.wtf            ← legacy copy shipped in the package (kept in sync)
 *   WTF/Config.wtf                ← `SET realmList "..."` (kept in sync so it never overrides)
 */
const fs = require('node:fs')
const path = require('node:path')
const { LauncherError } = require('./errors.cjs')

const REALM_RE = /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/

/** Locale folders inside Data/ look like "enUS", "ptBR"… */
function detectLocales(gameDir) {
  try {
    return fs.readdirSync(path.join(gameDir, 'Data'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[a-z]{2}[A-Z]{2}$/.test(d.name))
      .map((d) => d.name)
  } catch { return [] }
}

function writeAtomic(file, content) {
  const tmp = `${file}.olk-tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}

function applyRealmlist(gameDir, realmlist, preferredLocale, accountName) {
  if (!REALM_RE.test(realmlist || '')) throw new LauncherError('CONFIG_INVALID', `Invalid realmlist: ${realmlist}`)
  const locales = detectLocales(gameDir)
  if (!locales.length) throw new LauncherError('INSTALL_INVALID', 'No locale folder found in Data/.')
  const line = `set realmlist ${realmlist}\r\n`
  const written = []
  for (const loc of locales) {
    const f = path.join(gameDir, 'Data', loc, 'realmlist.wtf')
    writeAtomic(f, line)
    written.push(`Data/${loc}/realmlist.wtf`)
  }
  const legacy = path.join(gameDir, 'Data', 'realmlist.wtf')
  if (fs.existsSync(legacy)) { writeAtomic(legacy, line); written.push('Data/realmlist.wtf') }

  const cfg = path.join(gameDir, 'WTF', 'Config.wtf')
  fs.mkdirSync(path.dirname(cfg), { recursive: true })
  let text = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'latin1') : ''
  const setLine = `SET realmList "${realmlist}"`
  text = /^SET realmList .*$/im.test(text) ? text.replace(/^SET realmList .*$/im, setLine) : `${text.replace(/\s*$/, '')}${text ? '\r\n' : ''}${setLine}\r\n`
  const locale = locales.includes(preferredLocale) ? preferredLocale : locales[0]
  if (!/^SET locale /im.test(text)) text += `SET locale "${locale}"\r\n`
  if (accountName) {
    const accLine = `SET accountName "${accountName}"`
    text = /^SET accountName .*$/im.test(text) ? text.replace(/^SET accountName .*$/im, accLine) : `${text.replace(/\s*$/, '')}${text ? '\r\n' : ''}${accLine}\r\n`
    if (!/^SET accounttype /im.test(text)) text += `SET accounttype "LK"\r\n`
  }
  writeAtomic(cfg, text)
  written.push('WTF/Config.wtf')
  return { locale, locales, files: written }
}

function readRealmlist(gameDir, locale) {
  try {
    const t = fs.readFileSync(path.join(gameDir, 'Data', locale, 'realmlist.wtf'), 'latin1')
    return /set\s+realmlist\s+(\S+)/i.exec(t)?.[1] ?? null
  } catch { return null }
}

module.exports = { applyRealmlist, readRealmlist, detectLocales, REALM_RE }
