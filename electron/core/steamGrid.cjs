'use strict'
/**
 * steamGrid.cjs — Detects Steam shortcuts on Linux/SteamOS and installs custom
 * artwork (Hero background 1920x620, Library poster 600x900, Capsule banner 460x215,
 * and transparent Logo) directly into Steam's userdata/<id>/config/grid/ folder.
 * 
 * Works 100% AUTOMATICALLY without requiring any mouse clicks or manual configuration.
 * Also exports copies to ~/Pictures/OLK-Plus-Steam-Art/ as an extra backup.
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

/**
 * Generates all possible 32-bit and 64-bit ID variants that Steam (Big Picture,
 * Desktop UI, Steam Deck Gamescope) uses to look up grid images.
 */
function getAllIdsForShortcut(item) {
  const idSet = new Set()

  // 1. Raw appid from shortcuts.vdf (signed int32 or unsigned)
  if (item && item.appid != null) {
    const rawId = Number(item.appid)
    idSet.add(String(rawId))
    const u32 = (rawId >>> 0)
    idSet.add(String(u32))
    const u64 = (BigInt(u32) << 32n) | 0x02000000n
    idSet.add(u64.toString())
    idSet.add(BigInt.asIntN(64, u64).toString())
  }

  // 2. Compute CRC with various string quoting / path variations
  const exeRaw = String(item?.Exe || '')
  const exeClean = exeRaw.replace(/^["']|["']$/g, '').trim()
  const exeQuoted = `"${exeClean}"`
  const name = String(item?.AppName || '').trim()

  const variations = [
    exeRaw + name,
    exeClean + name,
    exeQuoted + name,
    exeRaw,
    exeClean
  ]

  for (const v of variations) {
    if (!v) continue
    const crc = steamCrc32(v)
    const u32 = (crc | 0x80000000) >>> 0
    const s32 = u32 | 0
    const u64 = (BigInt(u32) << 32n) | 0x02000000n
    const s64 = BigInt.asIntN(64, u64)
    idSet.add(String(u32))
    idSet.add(String(s32))
    idSet.add(u64.toString())
    idSet.add(s64.toString())
  }

  idSet.delete('0')
  idSet.delete('')
  return Array.from(idSet)
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

/** Serializes shortcuts object into Valve binary VDF format */
function serializeBinaryVdf(shortcuts) {
  const chunks = []
  const writeByte = (b) => chunks.push(Buffer.from([b]))
  const writeString = (s) => chunks.push(Buffer.from(String(s) + '\0', 'utf8'))
  const writeInt32 = (n) => {
    const b = Buffer.alloc(4)
    b.writeInt32LE(n | 0, 0)
    chunks.push(b)
  }

  writeByte(0x00)
  writeString('shortcuts')

  const keys = Object.keys(shortcuts)
  for (let i = 0; i < keys.length; i++) {
    const item = shortcuts[keys[i]]
    writeByte(0x00)
    writeString(String(i))
    for (const [k, v] of Object.entries(item)) {
      if (typeof v === 'string') {
        writeByte(0x01)
        writeString(k)
        writeString(v)
      } else if (typeof v === 'number') {
        writeByte(0x02)
        writeString(k)
        writeInt32(v)
      }
    }
    writeByte(0x08)
  }
  writeByte(0x08)
  writeByte(0x08)
  return Buffer.concat(chunks)
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
  const matchPattern = /olk|classic\s*\+?|classicplus|soder|launcher|wow|warcraft|chromie/i
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
    '        ARTE DA STEAM / STEAM DECK (OLK PLUS LAUNCHER)',
    '========================================================================',
    'Estas imagens são aplicadas AUTOMATICAMENTE pelo launcher no seu Steam Deck.',
    'Nenhum clique ou configuração manual é necessário no console!',
    '',
    'Arquivos incluídos neste kit:',
    '1. 01_fundo_bigpicture_1920x620.jpg (Plano de fundo Widescreen do Big Picture)',
    '2. 02_poster_biblioteca_600x900.jpg (Capa vertical estilo pôster da Biblioteca)',
    '3. 03_banner_horizontal_460x215.jpg (Banner horizontal de jogos recentes)',
    '4. 04_logo_transparente.png         (Logotipo sobre o fundo)',
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
  const appImagePath = process.env.APPIMAGE || process.execPath || ''

  for (const userDir of userDirs) {
    const configDir = path.join(userDir, 'config')
    const gridDir = path.join(configDir, 'grid')
    const shortcutsFile = path.join(configDir, 'shortcuts.vdf')

    try {
      fs.mkdirSync(gridDir, { recursive: true })
      let shortcuts = {}
      let hasExistingVdf = false

      if (fs.existsSync(shortcutsFile)) {
        const buf = fs.readFileSync(shortcutsFile)
        const data = parseBinaryVdf(buf)
        if (data?.shortcuts) {
          shortcuts = data.shortcuts
          hasExistingVdf = true
        }
      }

      // Check if shortcut already exists in shortcuts.vdf
      let matchedCount = 0
      for (const idx of Object.keys(shortcuts)) {
        const item = shortcuts[idx]
        if (!isMatchingShortcut(item)) continue

        matchedCount++
        const ids = getAllIdsForShortcut(item)

        for (const id of ids) {
          try {
            fs.copyFileSync(heroSrc, path.join(gridDir, `${id}_hero.jpg`))
            fs.copyFileSync(heroSrc, path.join(gridDir, `${id}_hero.png`))
            fs.copyFileSync(posterSrc, path.join(gridDir, `${id}p.jpg`))
            fs.copyFileSync(posterSrc, path.join(gridDir, `${id}p.png`))
            fs.copyFileSync(capsuleSrc, path.join(gridDir, `${id}.jpg`))
            fs.copyFileSync(capsuleSrc, path.join(gridDir, `${id}.png`))
            if (fs.existsSync(logoSrc)) {
              fs.copyFileSync(logoSrc, path.join(gridDir, `${id}_logo.png`))
              fs.copyFileSync(logoSrc, path.join(gridDir, `${id}_icon.png`))
            }
          } catch {}
        }

        results.matchedShortcuts.push({
          userDir,
          appName: item.AppName,
          exe: item.Exe,
          appId: item.appid,
          idsCount: ids.length
        })
        results.installedInSteam.push(gridDir)
      }

      // If no matching shortcut exists in shortcuts.vdf and we know our AppImage path, add it!
      if (matchedCount === 0 && appImagePath && appImagePath.endsWith('.AppImage')) {
        const nextIdx = String(Object.keys(shortcuts).length)
        const crc = steamCrc32(`"${appImagePath}"OLK Plus Launcher`)
        const appId32 = (crc | 0x80000000) >>> 0
        const appIdSigned = appId32 | 0

        const newShortcut = {
          appid: appIdSigned,
          AppName: 'OLK Plus Launcher',
          Exe: `"${appImagePath}"`,
          StartDir: `"${path.dirname(appImagePath)}"`,
          icon: path.join(gridDir, `${appIdSigned}_icon.png`),
          ShortcutPath: '',
          LaunchOptions: '',
          IsHidden: 0,
          AllowDesktopConfig: 1,
          AllowOverlay: 1,
          OpenVR: 0,
          Devkit: 0,
          DevkitGameID: '',
          DevkitOverrideAppId: 0,
          LastPlayTime: 0,
          FlatpakAppID: ''
        }

        shortcuts[nextIdx] = newShortcut
        try {
          const newVdfBuf = serializeBinaryVdf(shortcuts)
          fs.writeFileSync(shortcutsFile, newVdfBuf)
          log.info(`Auto-registered OLK Plus Launcher shortcut in ${shortcutsFile}`)
        } catch (vdfErr) {
          log.warn('could not auto-write shortcuts.vdf', vdfErr?.message)
        }

        // Install grid files for this new shortcut
        const ids = getAllIdsForShortcut(newShortcut)
        for (const id of ids) {
          try {
            fs.copyFileSync(heroSrc, path.join(gridDir, `${id}_hero.jpg`))
            fs.copyFileSync(heroSrc, path.join(gridDir, `${id}_hero.png`))
            fs.copyFileSync(posterSrc, path.join(gridDir, `${id}p.jpg`))
            fs.copyFileSync(posterSrc, path.join(gridDir, `${id}p.png`))
            fs.copyFileSync(capsuleSrc, path.join(gridDir, `${id}.jpg`))
            fs.copyFileSync(capsuleSrc, path.join(gridDir, `${id}.png`))
            if (fs.existsSync(logoSrc)) {
              fs.copyFileSync(logoSrc, path.join(gridDir, `${id}_logo.png`))
              fs.copyFileSync(logoSrc, path.join(gridDir, `${id}_icon.png`))
            }
          } catch {}
        }

        results.matchedShortcuts.push({
          userDir,
          appName: newShortcut.AppName,
          exe: newShortcut.Exe,
          appId: newShortcut.appid,
          idsCount: ids.length,
          autoCreated: true
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
  getAllIdsForShortcut,
  parseBinaryVdf,
  serializeBinaryVdf,
  findSteamUserdataDirs,
  isMatchingShortcut,
  installSteamGridArtwork
}
