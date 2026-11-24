'use strict'
/**
 * Realmlist and video/quality defaults configuration for the 3.3.5a client:
 *   Data/<locale>/realmlist.wtf   ← the file the client reads
 *   Data/realmlist.wtf            ← legacy copy shipped in the package (kept in sync)
 *   WTF/Config.wtf                ← `SET realmList "..."` + resolution & visual defaults
 */
const fs = require('node:fs')
const path = require('node:path')
const { LauncherError } = require('./errors.cjs')

const REALM_RE = /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/
const RES_RE = /^(\d{3,4})x(\d{3,4})$/
const PACKAGE_DEFAULT_RES = '2560x1080'

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

function setCvar(text, key, value) {
  const line = `SET ${key} "${value}"`
  const re = new RegExp(`^SET ${key} .*$`, 'im')
  return re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, '')}${text ? '\r\n' : ''}${line}\r\n`
}

function setCvarIfMissing(text, key, value) {
  const re = new RegExp(`^SET ${key} `, 'im')
  if (re.test(text)) return text
  return `${text.replace(/\s*$/, '')}${text ? '\r\n' : ''}SET ${key} "${value}"\r\n`
}

function getCvar(text, key) {
  const m = new RegExp(`^SET ${key} "([^"]*)"`, 'im').exec(text)
  return m ? m[1] : null
}

/**
 * Decides whether `gxResolution` in Config.wtf should be updated to match the primary monitor.
 * Fixes the common 3.3.5a bug where the package ships with "2560x1080" hardcoded: on 1920x1080
 * or smaller screens the game rejects 2560x1080 and falls back to 800x600 / 1024x768.
 */
function resolveTargetResolution(currentRes, displaySize, { resolutionMode = 'auto', customResolution = '' } = {}) {
  if (resolutionMode === 'manual') return null
  if (resolutionMode === 'custom' && RES_RE.test(String(customResolution || '').trim())) {
    return String(customResolution).trim()
  }
  if (!displaySize || !displaySize.width || !displaySize.height) return null
  const w = Math.round(Number(displaySize.width))
  const h = Math.round(Number(displaySize.height))
  if (w < 800 || h < 600) return null
  const nativeRes = `${w}x${h}`
  if (!currentRes || !RES_RE.test(currentRes)) return nativeRes
  if (currentRes === PACKAGE_DEFAULT_RES && nativeRes !== PACKAGE_DEFAULT_RES) return nativeRes
  const [, cwStr, chStr] = RES_RE.exec(currentRes)
  const cw = Number(cwStr)
  const ch = Number(chStr)
  if (cw > w || ch > h) return nativeRes
  return null
}

function applyRealmlist(gameDir, realmlist, preferredLocale, accountName, password, options = {}) {
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
  text = setCvar(text, 'realmList', realmlist)
  const locale = locales.includes(preferredLocale) ? preferredLocale : locales[0]
  text = setCvarIfMissing(text, 'locale', locale)
  if (accountName) {
    text = setCvar(text, 'accountName', accountName)
    text = setCvarIfMissing(text, 'accounttype', 'LK')
  }
  if (password) {
    const escaped = String(password).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    text = setCvar(text, 'accountList', `AUTOLOGIN:${escaped}`)
  }

  // Previne vídeos de introdução (tela preta no Wine/Steam Deck) e bypassa termos já aceitos
  const commonOpts = [
    ['movie', '0'],
    ['expansionMovie', '0'],
    ['playIntroMovie', '0'],
    ['movieSubtitle', '0'],
    ['readTOS', '1'],
    ['readEULA', '1'],
    ['readTerminationWithoutNotice', '1'],
    ['readScanning', '1'],
    ['readContest', '1'],
    ['scriptErrors', '0']
  ]
  for (const [k, v] of commonOpts) text = setCvar(text, k, v)

  // Qualidade visual padrão do servidor (só aplica se o CVar ainda não existir, preservando escolha do jogador)
  const qualityDefaults = [
    ['shadowLevel', '3'],
    ['extShadowQuality', '3'],
    ['specular', '1'],
    ['pixelShaders', '1'],
    ['ffxGlow', '1'],
    ['textureFilteringMode', '5'],
    ['projectedTextures', '1'],
    ['waterDetail', '2'],
    ['farclip', '1277'],
    ['horizonfarclip', '2112'],
    ['groundEffectDist', '140'],
    ['groundEffectDensity', '64'],
    ['objectFade', '0']
  ]
  for (const [k, v] of qualityDefaults) text = setCvarIfMissing(text, k, v)

  // Steam Deck (Modo Desktop e Modo Jogo): sempre janela 1280x800.
  if (isSteamDeck()) {
    for (const k of ['windowResizeLock', 'gxWindow', 'gxMaximize', 'gxResolution', 'scriptErrors']) {
      text = text.replace(new RegExp(`^SET ${k} .*\\r?\\n?`, 'gim'), '')
    }
    const deckOpts = [
      ['gxResolution', '1280x800'],
      ['gxWindow', '1'],
      ['gxMaximize', '0'],
      ['gxVSync', '0'],
      ['gxTripleBuffer', '0'],
      ['gxFixLag', '0'],
      ['gxCursor', '1'],
      ['gxMultisample', '1'],
      ['maxFPS', '60'],
      ['maxFPSBk', '30'],
      ['timingMethod', '0'],
      ['scriptErrors', '0'],
      ['Sound_EnableSoundWhenGameIsInBG', '1']
    ]
    for (const [k, v] of deckOpts) text = setCvar(text, k, v)
  } else {
    const currentRes = getCvar(text, 'gxResolution')
    const targetRes = resolveTargetResolution(currentRes, options.displaySize, {
      resolutionMode: options.resolutionMode,
      customResolution: options.customResolution
    })
    if (targetRes) {
      text = setCvar(text, 'gxResolution', targetRes)
      text = setCvar(text, 'gxWindow', '1')
      text = setCvar(text, 'gxMaximize', '1')
      text = setCvar(text, 'windowResizeLock', '0')
    }
    if ((options.platformName || process.platform) === 'linux') {
      const curCursor = getCvar(text, 'gxCursor')
      if (!curCursor || curCursor === '0') {
        text = setCvar(text, 'gxCursor', '1')
      }
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

module.exports = {
  applyRealmlist,
  readRealmlist,
  detectLocales,
  isSteamDeck,
  resolveTargetResolution,
  REALM_RE,
  RES_RE
}
