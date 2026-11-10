'use strict'
/**
 * PlatformService — OS detection, Wine discovery on Linux, disk space.
 * No Electron imports here so it stays unit-testable.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

const platform = process.platform // 'win32' | 'linux' | 'darwin'

function which(cmd) {
  const exts = platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext)
      try {
        fs.accessSync(full, fs.constants.X_OK)
        if (fs.statSync(full).isFile()) return full
      } catch { /* keep looking */ }
    }
  }
  return null
}

function cleanEnvForSystemBinary(baseEnv = process.env) {
  const env = { ...baseEnv }
  const appDir = process.env.APPDIR
  if (appDir) {
    if (env.LD_LIBRARY_PATH) {
      env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
        .split(':')
        .filter((p) => p && !p.startsWith(appDir) && !p.includes('.mount_'))
        .join(':')
    }
    if (env.PATH) {
      env.PATH = env.PATH
        .split(':')
        .filter((p) => p && !p.startsWith(appDir) && !p.includes('.mount_'))
        .join(':')
    }
  }
  return env
}

function wineVersion(winePath) {
  if (!winePath) return Promise.resolve(null)
  return new Promise((resolve) => {
    const env = cleanEnvForSystemBinary({ ...process.env, WINEDEBUG: '-all' })
    execFile(winePath, ['--version'], { env, timeout: 8000 }, (err, stdout, stderr) => {
      const out = (stdout || stderr || '').trim()
      if (out && /wine|proton/i.test(out)) return resolve(out.split('\n')[0])
      resolve(err ? null : (out || 'wine'))
    })
  })
}

function findProtonScript(winePath) {
  if (!winePath) return null
  let dir = path.dirname(winePath)
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, 'proton')
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate
      }
    } catch {}
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function findSteamProtonWineCandidates() {
  const home = process.env.HOME || ''
  if (!home) return []
  const steamRoots = [
    path.join(home, '.local/share/Steam'),
    path.join(home, '.steam/steam'),
    path.join(home, '.steam/root'),
    path.join(home, '.var/app/com.valvesoftware.Steam/data/Steam'),
    '/home/deck/.local/share/Steam',
    '/home/deck/.steam/steam'
  ]
  const found = []
  for (const root of steamRoots) {
    for (const sub of ['steamapps/common', 'compatibilitytools.d']) {
      const p = path.join(root, sub)
      try {
        if (!fs.existsSync(p)) continue
        for (const dir of fs.readdirSync(p)) {
          if (!/proton|wine/i.test(dir)) continue
          for (const rel of ['dist/bin/wine', 'files/bin/wine', 'bin/wine']) {
            const winePath = path.join(p, dir, rel)
            try {
              if (fs.existsSync(winePath) && fs.statSync(winePath).isFile()) found.push(winePath)
            } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    }
  }
  return found
}

function findThirdPartyWineCandidates() {
  const home = process.env.HOME || ''
  if (!home) return []
  const runnerDirs = [
    path.join(home, '.var/app/com.usebottles.bottles/data/bottles/runners'),
    path.join(home, '.local/share/lutris/runners/wine'),
    path.join(home, '.config/heroic/tools/wine'),
    path.join(home, '.config/heroic/tools/proton')
  ]
  const found = []
  for (const base of runnerDirs) {
    try {
      if (!fs.existsSync(base)) continue
      for (const dir of fs.readdirSync(base)) {
        for (const rel of ['bin/wine', 'files/bin/wine', 'dist/bin/wine']) {
          const w = path.join(base, dir, rel)
          try {
            if (fs.existsSync(w) && fs.statSync(w).isFile()) found.push(w)
          } catch {}
        }
      }
    } catch {}
  }
  return found
}

async function detectAllWineCandidates(configuredPath = '', extraCandidates = []) {
  if (platform === 'win32') return []
  const extra = Array.isArray(extraCandidates) ? extraCandidates : (extraCandidates ? [extraCandidates] : [])
  const standardPaths = [
    configuredPath,
    ...extra,
    which('wine'),
    which('wine64'),
    '/usr/bin/wine',
    '/usr/bin/wine64',
    '/usr/local/bin/wine',
    '/opt/wine-staging/bin/wine',
    '/opt/wine/bin/wine',
    ...findSteamProtonWineCandidates(),
    ...findThirdPartyWineCandidates()
  ].filter(Boolean)

  const unique = [...new Set(standardPaths)]
  const results = []
  for (const p of unique) {
    try {
      if (fs.existsSync(p)) {
        const ver = await wineVersion(p)
        if (ver) {
          const isProton = /proton/i.test(p)
          const protonScript = isProton ? findProtonScript(p) : null
          results.push({ path: p, version: ver, isProton, protonScript })
        }
      }
    } catch {}
  }
  return results
}

/** Returns { needed, found, path, version, isInternal, isProton, protonScript } — Wine is only needed off Windows. */
async function detectWine(configuredPath, plat = platform, extraCandidates = []) {
  if (plat === 'win32') return { needed: false, found: true, path: null, version: null }
  const extra = Array.isArray(extraCandidates) ? extraCandidates : (extraCandidates ? [extraCandidates] : [])
  const candidates = [
    configuredPath,
    ...extra,
    which('wine'),
    which('wine64'),
    '/usr/bin/wine',
    '/usr/bin/wine64',
    '/usr/local/bin/wine',
    '/opt/wine-staging/bin/wine',
    '/opt/wine/bin/wine',
    ...findSteamProtonWineCandidates(),
    ...findThirdPartyWineCandidates()
  ].filter(Boolean)
  for (const c of candidates) {
    const version = await wineVersion(c)
    if (version) {
      const isInternal = c.includes('runtime/wine')
      return { needed: true, found: true, path: c, version, isInternal, isProton: false, protonScript: null }
    }
  }
  return { needed: true, found: false, path: null, version: null }
}

async function freeBytes(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const s = await fs.promises.statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch { return null }
}

function describe() {
  return { platform, arch: process.arch, label: { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[platform] || platform }
}

module.exports = { platform, which, detectWine, detectAllWineCandidates, findProtonScript, cleanEnvForSystemBinary, freeBytes, describe }
