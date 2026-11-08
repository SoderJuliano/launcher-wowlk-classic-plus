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

function wineVersion(winePath) {
  return new Promise((resolve) => {
    execFile(winePath, ['--version'], { timeout: 8000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()))
  })
}

function findSteamProtonWineCandidates() {
  const home = process.env.HOME || ''
  if (!home) return []
  const steamRoots = [
    path.join(home, '.local/share/Steam'),
    path.join(home, '.steam/steam'),
    path.join(home, '.steam/root'),
    path.join(home, '.var/app/com.valvesoftware.Steam/data/Steam')
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

/** Returns { needed, found, path, version, isInternal, isProton } — Wine is only needed off Windows. */
async function detectWine(configuredPath, plat = platform, extraCandidates = []) {
  if (plat === 'win32') return { needed: false, found: true, path: null, version: null }
  const extra = Array.isArray(extraCandidates) ? extraCandidates : (extraCandidates ? [extraCandidates] : [])
  const candidates = [
    configuredPath,
    ...extra,
    which('wine'),
    which('wine64'),
    '/usr/bin/wine',
    '/usr/local/bin/wine',
    '/opt/wine-staging/bin/wine',
    ...findSteamProtonWineCandidates()
  ].filter(Boolean)
  for (const c of candidates) {
    const version = await wineVersion(c)
    if (version) {
      const isInternal = c.includes('runtime/wine')
      const isProton = /proton/i.test(c)
      return { needed: true, found: true, path: c, version, isInternal, isProton }
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

module.exports = { platform, which, detectWine, freeBytes, describe }
