'use strict'
/**
 * steamGrid.cjs — Detects Steam shortcuts on Linux/SteamOS and installs custom
 * artwork (Hero background, Library poster, Capsule banner, and Logo) directly
 * into Steam's userdata/<id>/config/grid/ folder. Also exports copies to ~/Pictures/OLK-Plus-Steam-Art/
 * so the user can easily select them manually in Steam Big Picture or Desktop mode.
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const zlib = require('node:zlib')
const log = require('./logger.cjs')

/** Valve CRC32 for non-Steam shortcut AppIDs */
function steamCrc32(str) {
  return zlib.crc32(Buffer.from(str, 'utf8'))
}

function calculateSteamAppIds(exe, appName) {
  const combined = (exe || '') + (appName || '')
  const crc = steamCrc32(combined)
  const appId32 = (crc | 0x80000000) >>> 0
  const appId64 = (BigInt(appId32) << 32n) | 0x02000000n
  const appIdSigned = appId32 | 0
  return {
    combined,
    appId32: String(appId32),
    appId64: appId64.toString(),
    appIdSigned: String(appIdSigned)
  }
}

/** Parses Valve binary VDF format (shortcuts.vdf) */
function parseBinaryVdf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) return null
  let offset = 0

  function readNullTerminatedString() {
    const start = offset
    while (offset < buf.length && buf[offset] !== 0) {
      offset++
    }
    const str = buf.toString('utf8', start, offset)
    offset++ // skip trailing 0x00
    return str
  }

  function readObject() {
    const obj = {}
    while (offset < buf.length) {
      const type = buf[offset++]
      if (type === 0x08) break // end of object
      const key = readNullTerminatedString()
      if (type === 0x00) { // sub-object
        obj[key] = readObject()
      } else if (type === 0x01) { // string
        obj[key] = readNullTerminatedString()
      } else if (type === 0x02) { // int32
        if (offset + 4 <= buf.length) {
          obj[key] = buf.readInt32LE(offset)
          offset += 4
        }
      } else if (type === 0x07) { // int64
        if (offset + 8 <= buf.length) {
          obj[key] = buf.readBigInt64LE(offset)
          offset += 8
        }
      }
    }
    return obj
  }

  try {
    return readObject()
  } catch (err) {
    log.warn('could not parse binary VDF', err?.message)
    return null
  }
}

/** Finds all Steam userdata directories on the system */
function findSteamUserdataDirs() {
  const home = os.homedir()
  const roots = [
    path.join(home, '.local/share/Steam/userdata'),
    path.join(home, '.steam/steam/userdata'),
    path.join(home, '.steam/root/userdata'),
    path.join(home, '.var/app/com.valvesoftware.Steam/data/Steam/userdata'),
    '/home/deck/.local/share/Steam/userdata',
    '/home/deck/.steam/steam/userdata'
  ]
  const userDirs = new Set()
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue
      const realRoot = fs.realpathSync(root)
      for (const entry of fs.readdirSync(realRoot)) {
        if (!/^\d+$/.test(entry)) continue
        const userDir = path.join(realRoot, entry)
        if (fs.statSync(userDir).isDirectory()) {
          userDirs.add(userDir)
        }
      }
    } catch {}
  }
  return Array.from(userDirs)
}

/** Check if shortcut belongs to OLK Plus / WoW / Soder / Launcher */
function isMatchingShortcut(shortcut) {
  if (!shortcut || typeof shortcut !== 'object') return false
  const name = String(shortcut.AppName || '').toLowerCase()
  const exe = String(shortcut.Exe || '').toLowerCase()
  const matchPattern = /olk|classic\s*\+?|classicplus|soder|launcher|wow/i
  return matchPattern.test(name) || matchPattern.test(exe)
}

/**
 * Installs grid artwork into Steam and exports pictures to ~/Pictures/OLK-Plus-Steam-Art
 */
function installSteamGridArtwork(assetsDir = path.join(__dirname, '..', 'assets', 'steam-grid')) {
  const heroSrc = path.join(assetsDir, 'hero_1920x620.jpg')
  const posterSrc = path.join(assetsDir, 'poster_600x900.jpg')
  const capsuleSrc = path.join(assetsDir, 'capsule_460x215.jpg')
  const logoSrc = path.join(assetsDir, 'logo.png')

  if (!fs.existsSync(heroSrc) || !fs.existsSync(posterSrc) || !fs.existsSync(capsuleSrc)) {
    log.warn('Steam grid source assets missing at', assetsDir)
    return { ok: false, error: 'ASSETS_MISSING' }
  }

  const results = {
    exportedTo: [],
    installedInSteam: [],
    matchedShortcuts: []
  }

  // 1. Export friendly files to user's Pictures / Imagens folder
  const home = os.homedir()
  const targetFolders = [
    path.join(home, 'Pictures', 'OLK-Plus-Steam-Art'),
    path.join(home, 'Imagens', 'OLK-Plus-Steam-Art')
  ]
  if (process.env.USER !== 'deck' && fs.existsSync('/home/deck/Pictures')) {
    targetFolders.push('/home/deck/Pictures/OLK-Plus-Steam-Art')
  }

  const readmeContent = [
    '========================================================================',
    '        COMO COLOCAR O PLANO DE FUNDO NO STEAM / STEAM DECK',
    '========================================================================',
    '',
    'O OLK Plus Launcher tenta aplicar estas imagens automaticamente no Steam.',
    'Se você preferir definir ou personalizar manualmente no Steam (Desktop ou Big Picture):',
    '',
    '1. PLANO DE FUNDO (Hero / Big Picture):',
    '   - Na sua Biblioteca do Steam, abra o atalho do "OLK Plus Launcher".',
    '   - Clique com o BOTÃO DIREITO na área preta do fundo.',
    '   - Selecione: "Definir plano de fundo personalizado".',
    '   - Escolha o arquivo: 01_fundo_bigpicture_1920x620.jpg',
    '',
    '2. LOGOTIPO TRANSPARENTE (Logo):',
    '   - Clique com o botão direito no fundo -> "Definir logotipo personalizado".',
    '   - Escolha o arquivo: 04_logo_transparente.png',
    '',
    '3. CAPA VERTICAL (Pôster na Biblioteca):',
    '   - Na lista/grade de jogos da Biblioteca, clique com o botão direito na capa do jogo -> Gerenciar -> "Definir arte personalizada".',
    '   - Escolha o arquivo: 02_poster_biblioteca_600x900.jpg',
    '',
    '4. BANNER HORIZONTAL (Cápsula de Jogos Recentes):',
    '   - Escolha o arquivo: 03_banner_horizontal_460x215.jpg',
    '========================================================================',
    ''
  ].join('\n')

  for (const folder of targetFolders) {
    try {
      const parent = path.dirname(folder)
      if (!fs.existsSync(parent)) continue
      fs.mkdirSync(folder, { recursive: true })
      fs.copyFileSync(heroSrc, path.join(folder, '01_fundo_bigpicture_1920x620.jpg'))
      fs.copyFileSync(posterSrc, path.join(folder, '02_poster_biblioteca_600x900.jpg'))
      fs.copyFileSync(capsuleSrc, path.join(folder, '03_banner_horizontal_460x215.jpg'))
      if (fs.existsSync(logoSrc)) {
        fs.copyFileSync(logoSrc, path.join(folder, '04_logo_transparente.png'))
      }
      fs.writeFileSync(path.join(folder, 'COMO_USAR_NA_STEAM.txt'), readmeContent, 'utf8')
      results.exportedTo.push(folder)
    } catch (err) {
      log.warn('could not export steam art to', folder, err.message)
    }
  }

  // 2. Automatically install into Steam config/grid for all matching shortcuts
  const userDirs = findSteamUserdataDirs()
  for (const userDir of userDirs) {
    const configDir = path.join(userDir, 'config')
    const gridDir = path.join(configDir, 'grid')
    const shortcutsFile = path.join(configDir, 'shortcuts.vdf')

    try {
      if (!fs.existsSync(shortcutsFile)) continue
      const buf = fs.readFileSync(shortcutsFile)
      const data = parseBinaryVdf(buf)
      const shortcuts = data?.shortcuts || {}

      for (const idx of Object.keys(shortcuts)) {
        const item = shortcuts[idx]
        if (!isMatchingShortcut(item)) continue

        const computed = calculateSteamAppIds(item.Exe, item.AppName)
        const idSet = new Set()

        if (item.appid != null) {
          const rawId = Number(item.appid)
          idSet.add(String(rawId))
          const u32 = (rawId >>> 0)
          idSet.add(String(u32))
          idSet.add(String((BigInt(u32) << 32n) | 0x02000000n))
        }
        idSet.add(computed.appId32)
        idSet.add(computed.appId64)
        idSet.add(computed.appIdSigned)

        fs.mkdirSync(gridDir, { recursive: true })

        for (const id of idSet) {
          if (!id || id === '0') continue
          try {
            fs.copyFileSync(heroSrc, path.join(gridDir, `${id}_hero.jpg`))
            fs.copyFileSync(posterSrc, path.join(gridDir, `${id}p.jpg`))
            fs.copyFileSync(capsuleSrc, path.join(gridDir, `${id}.jpg`))
            if (fs.existsSync(logoSrc)) {
              fs.copyFileSync(logoSrc, path.join(gridDir, `${id}_logo.png`))
            }
          } catch {}
        }

        results.matchedShortcuts.push({
          userDir,
          appName: item.AppName,
          exe: item.Exe,
          appId: item.appid,
          computedAppId32: computed.appId32
        })
        results.installedInSteam.push(gridDir)
      }
    } catch (err) {
      log.warn('could not process shortcuts.vdf in', userDir, err.message)
    }
  }

  log.info(`Steam Grid artwork processed: ${results.matchedShortcuts.length} shortcuts found, exported to ${results.exportedTo.length} picture dirs`)
  return { ok: true, ...results }
}

module.exports = {
  steamCrc32,
  calculateSteamAppIds,
  parseBinaryVdf,
  findSteamUserdataDirs,
  isMatchingShortcut,
  installSteamGridArtwork
}
