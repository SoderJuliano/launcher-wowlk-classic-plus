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

function isSteamDeck() {
  if (process.env.STEAM_DECK === '1' || process.env.SteamDeck === '1' || process.env.SteamOS === '1') return true
  if (process.env.XDG_CURRENT_DESKTOP === 'gamescope' || !!process.env.GAMESCOPE_WAYLAND_DISPLAY) return true
  if (process.env.USER === 'deck' || fs.existsSync('/home/deck')) return true
  for (const p of ['/sys/devices/virtual/dmi/id/product_name', '/sys/class/dmi/id/product_name']) {
    try {
      if (fs.existsSync(p)) {
        const prod = fs.readFileSync(p, 'utf8')
        if (/Jupiter|Galileo/i.test(prod)) return true
      }
    } catch {}
  }
  return false
}

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

function applyRealmlist(gameDir, realmlist, preferredLocale, accountName, password) {
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
    if (password) {
      const escaped = String(password).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const listLine = `SET accountList "AUTOLOGIN:${escaped}"`
      text = /^SET accountList .*$/im.test(text) ? text.replace(/^SET accountList .*$/im, listLine) : `${text.replace(/\s*$/, '')}${text ? '\r\n' : ''}${listLine}\r\n`
    }
  }
  // Previne vídeos de introdução (tela preta no Wine/Steam Deck) e bypassa termos já aceitos
  const commonOpts = [
    ['movie', '0'],
    ['expansionMovie', '0'],
    ['movieSubtitle', '0'],
    ['readTOS', '1'],
    ['readEULA', '1'],
    ['readTerminationWithoutNotice', '1'],
    ['readScanning', '1'],
    ['readContest', '1'],
    ['scriptErrors', '0']
  ]
  for (const [k, v] of commonOpts) {
    const line = `SET ${k} "${v}"`
    const re = new RegExp(`^SET ${k} .*$`, 'im')
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, '')}${text ? '\r\n' : ''}${line}\r\n`
  }

  if (isSteamDeck()) {
    const deckOpts = [
      ['gxResolution', '1280x800'],
      ['gxWindow', '1'],
      ['gxMaximize', '1'],
      ['windowResizeLock', '1'],
      ['gxCursor', '1'],
      ['gxMultisample', '0'],
      ['timingMethod', '0']
    ]
    for (const [k, v] of deckOpts) {
      const line = `SET ${k} "${v}"`
      const re = new RegExp(`^SET ${k} .*$`, 'im')
      text = re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, '')}${text ? '\r\n' : ''}${line}\r\n`
    }
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

module.exports = { applyRealmlist, readRealmlist, detectLocales, isSteamDeck, REALM_RE }
