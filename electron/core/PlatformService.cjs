'use strict'
/**
 * PlatformService — OS detection, Wine discovery on Linux, disk space.
 * No Electron imports here so it stays unit-testable.
 */
const fs = require('node:fs')
const os = require('node:os')
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

/** Entrada de PATH/LD_LIBRARY_PATH que o cliente Steam injeta ao rodar um atalho não-Steam. */
function isSteamRuntimePath(p) {
  return /steam-runtime|\/ubuntu12_(32|64)(\/|$)|\/steamrt|SteamLinuxRuntime/i.test(p)
}

/**
 * Ambiente para rodar Wine (ou qualquer binário do sistema) a partir do launcher.
 * O Modo Desktop funciona porque o launcher herda o ambiente limpo da sessão. No Modo Jogo o
 * launcher é filho do cliente Steam e herda LD_PRELOAD (overlay) e LD_LIBRARY_PATH/PATH do
 * "steam-runtime" (bibliotecas antigas de 2012). O Wine e o DXVK do jogo não foram feitos para
 * elas. Aqui o ambiente do Modo Jogo fica igual ao do Modo Desktop.
 */
function cleanEnvForSystemBinary(baseEnv = process.env) {
  const env = { ...baseEnv }
  const appDir = process.env.APPDIR
  for (const key of ['LD_LIBRARY_PATH', 'PATH']) {
    if (!env[key]) continue
    env[key] = env[key].split(':').filter((p) => p && !isSteamRuntimePath(p)).join(':')
    if (!env[key] && key === 'LD_LIBRARY_PATH') delete env[key]
  }
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
  // Remove bibliotecas de overlay do Steam que causam travamento em processos de linha de comando ou filhos do Wine
  if (env.LD_PRELOAD) {
    env.LD_PRELOAD = env.LD_PRELOAD
      .split(':')
      .filter((p) => p && !p.includes('gameoverlayrenderer') && !p.includes('steam-chat') && !p.includes('.mount_') && (!appDir || !p.startsWith(appDir)))
      .join(':')
    if (!env.LD_PRELOAD) delete env.LD_PRELOAD
  }
  return env
}

function wineVersion(winePath, timeoutMs = 2000) {
  if (!winePath) return Promise.resolve(null)
  try {
    if (!fs.existsSync(winePath)) return Promise.resolve(null)
    const st = fs.statSync(winePath)
    if (!st.isFile()) return Promise.resolve(null)
  } catch {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    const env = cleanEnvForSystemBinary({ ...process.env, WINEDEBUG: '-all' })
    execFile(winePath, ['--version'], { env, timeout: timeoutMs }, (err, stdout, stderr) => {
      const out = (stdout || stderr || '').trim()
      if (out && /wine|proton/i.test(out)) return resolve(out.split('\n')[0])
      resolve(err ? null : (out || 'wine'))
    })
  })
}

function isExecutableFile(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile() } catch { return false }
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
  const seenRoots = new Set()
  const validRoots = []
  for (const r of steamRoots) {
    try {
      if (fs.existsSync(r)) {
        const real = fs.realpathSync(r)
        if (!seenRoots.has(real)) {
          seenRoots.add(real)
          validRoots.push(real)
        }
      }
    } catch {}
  }

  const seenCandidates = new Set()
  const found = []
  for (const root of validRoots) {
    for (const sub of ['compatibilitytools.d', 'steamapps/common']) {
      const p = path.join(root, sub)
      try {
        if (!fs.existsSync(p)) continue
        const dirs = fs.readdirSync(p)
        dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
        for (const dir of dirs) {
          if (!/proton|wine/i.test(dir)) continue
          for (const rel of ['dist/bin/wine', 'files/bin/wine', 'bin/wine']) {
            const winePath = path.join(p, dir, rel)
            try {
              if (!seenCandidates.has(winePath) && fs.existsSync(winePath) && fs.statSync(winePath).isFile()) {
                seenCandidates.add(winePath)
                found.push(winePath)
              }
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
  const seen = new Set()
  const found = []
  for (const base of runnerDirs) {
    try {
      if (!fs.existsSync(base)) continue
      for (const dir of fs.readdirSync(base)) {
        for (const rel of ['bin/wine', 'files/bin/wine', 'dist/bin/wine']) {
          const w = path.join(base, dir, rel)
          try {
            if (!seen.has(w) && fs.existsSync(w) && fs.statSync(w).isFile()) {
              seen.add(w)
              found.push(w)
            }
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

  // 1. Caminho configurado explicitamente (se não for binário do Proton bruto da Steam)
  if (configuredPath && !/steamapps.*proton/i.test(configuredPath) && !/proton.*dist\/bin\/wine/i.test(configuredPath)) {
    try {
      if (fs.existsSync(configuredPath)) {
        const ver = await wineVersion(configuredPath)
        if (ver) {
          const isProton = /proton/i.test(configuredPath)
          const protonScript = isProton ? findProtonScript(configuredPath) : null
          const isInternal = configuredPath.includes('runtime/wine')
          return { needed: true, found: true, path: configuredPath, version: ver, isInternal, isProton, protonScript }
        }
      }
    } catch {}
  }

  // 2. Extra candidates (ex: runtime interno do launcher)
  const extras = Array.isArray(extraCandidates) ? extraCandidates : (extraCandidates ? [extraCandidates] : [])
  for (const extra of extras) {
    if (extra && !/steamapps.*proton/i.test(extra)) {
      try {
        if (fs.existsSync(extra)) {
          const isInternal = extra.includes('runtime/wine')
          // O Wine que o próprio launcher baixou vale mesmo se o "--version" não responder a tempo
          // (primeira execução depois de ligar, cartão SD lento). Antes, um timeout aqui fazia a
          // detecção cair em outro Wine — no Deck, no binário cru do Proton, que trava.
          const ver = (await wineVersion(extra, isInternal ? 6000 : 2000)) || (isInternal && isExecutableFile(extra) ? 'wine (interno)' : null)
          if (ver) {
            const isProton = /proton/i.test(extra)
            const protonScript = isProton ? findProtonScript(extra) : null
            return { needed: true, found: true, path: extra, version: ver, isInternal, isProton, protonScript }
          }
        }
      } catch {}
    }
  }

  // 3. Wine do sistema (distro nativa)
  const sysCandidates = [
    which('wine'),
    which('wine64'),
    '/usr/bin/wine',
    '/usr/bin/wine64',
    '/usr/local/bin/wine',
    '/opt/wine-staging/bin/wine',
    '/opt/wine/bin/wine'
  ].filter(Boolean)
  const seenSys = new Set()
  for (const sc of sysCandidates) {
    if (seenSys.has(sc)) continue
    seenSys.add(sc)
    try {
      if (fs.existsSync(sc)) {
        const ver = await wineVersion(sc)
        if (ver) {
          return { needed: true, found: true, path: sc, version: ver, isInternal: false, isProton: false, protonScript: null }
        }
      }
    } catch {}
  }

  // 4. Runners de terceiros padrão (Lutris, Bottles) - NUNCA Proton da Steam por padrão
  // (binários do Proton dist/bin/wine sem o runtime container da Valve travam o wineserver no SteamOS)
  const thirdPartyCandidates = findThirdPartyWineCandidates().filter((p) => !/steamapps.*proton/i.test(p) && !/proton.*dist\/bin\/wine/i.test(p))
  const seenTP = new Set()
  for (const tc of thirdPartyCandidates) {
    if (seenTP.has(tc) || seenSys.has(tc)) continue
    seenTP.add(tc)
    try {
      if (fs.existsSync(tc)) {
        const ver = await wineVersion(tc)
        if (ver) {
          return { needed: true, found: true, path: tc, version: ver, isInternal: false, isProton: false, protonScript: null }
        }
      }
    } catch {}
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

function parseOsRelease(content) {
  const map = {}
  for (const raw of String(content || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const idx = line.indexOf('=')
    const k = line.slice(0, idx).trim()
    const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
    map[k] = v
  }
  const id = (map.ID || '').toLowerCase()
  const idLike = (map.ID_LIKE || '').toLowerCase()
  const combined = `${id} ${idLike}`
  let family = 'unknown'
  if (id === 'steamos') family = 'steamos'
  else if (/\b(arch|archcraft|manjaro|endeavouros|garuda|cachyos|artix)\b/.test(combined)) family = 'arch'
  else if (/\b(debian|ubuntu|pop|linuxmint|elementary|zorin|kali)\b/.test(combined)) family = 'debian'
  else if (/\b(fedora|rhel|centos|nobara|bazzite|rocky|almalinux)\b/.test(combined)) family = 'fedora'
  else if (/\b(opensuse|suse|sles)\b/.test(combined)) family = 'opensuse'
  return { id: id || 'linux', idLike, prettyName: map.PRETTY_NAME || map.NAME || 'Linux', family }
}

function detectDistro(osReleasePath = '/etc/os-release') {
  try {
    return parseOsRelease(fs.readFileSync(osReleasePath, 'utf8'))
  } catch {
    return { id: 'linux', idLike: '', prettyName: 'Linux', family: 'unknown' }
  }
}

function detectGpuVendors(drmRoot = '/sys/class/drm') {
  const vendors = new Set()
  try {
    for (const entry of fs.readdirSync(drmRoot)) {
      if (!/^card\d+$/.test(entry)) continue
      try {
        const raw = fs.readFileSync(path.join(drmRoot, entry, 'device', 'vendor'), 'utf8').trim().toLowerCase()
        if (raw === '0x1002') vendors.add('amd')
        else if (raw === '0x8086') vendors.add('intel')
        else if (raw === '0x10de') vendors.add('nvidia')
      } catch {}
    }
  } catch {}
  return [...vendors]
}

/**
 * Reads the ELF class byte (offset 4) of a Linux binary/shared library.
 * Returns 'x64' (ELFCLASS64), 'x86' (ELFCLASS32), or null if not an ELF file / unreadable.
 */
function detectElfArch(filePath) {
  if (!filePath) return null
  let fd = null
  try {
    const resolved = fs.realpathSync(filePath)
    fd = fs.openSync(resolved, 'r')
    const buf = Buffer.alloc(5)
    const n = fs.readSync(fd, buf, 0, 5, 0)
    if (n >= 5 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
      if (buf[4] === 2) return 'x64'
      if (buf[4] === 1) return 'x86'
    }
  } catch {} finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
  }
  return null
}

function detectSystemVkBasalt(opts = {}) {
  const lib64Paths = opts.lib64Paths || [
    '/usr/lib/libvkbasalt.so',
    '/usr/lib64/libvkbasalt.so',
    '/usr/lib/x86_64-linux-gnu/libvkbasalt.so'
  ]
  const lib32Paths = opts.lib32Paths || [
    '/usr/lib32/libvkbasalt.so',
    '/usr/lib/i386-linux-gnu/libvkbasalt.so'
  ]
  const layerDirs = opts.layerDirs || [
    '/usr/share/vulkan/implicit_layer.d',
    '/etc/vulkan/implicit_layer.d',
    '/usr/local/share/vulkan/implicit_layer.d'
  ]
  const matchesArch = (p, expected) => {
    try {
      if (!fs.existsSync(p)) return false
      const arch = detectElfArch(p)
      // If it's an actual ELF file, require matching class; if tiny test mock, accept by path list.
      return !arch || arch === expected
    } catch { return false }
  }
  const hasLib64 = lib64Paths.some((p) => matchesArch(p, 'x64'))
  const hasLib32 = lib32Paths.some((p) => matchesArch(p, 'x86'))

  let layerJson64 = null
  let layerJson32 = null
  for (const d of layerDirs) {
    for (const name of ['vkBasalt.json', 'vkBasalt.x86_64.json']) {
      const full = path.join(d, name)
      try {
        if (!layerJson64 && fs.existsSync(full)) layerJson64 = full
      } catch {}
    }
    for (const name of ['vkBasalt.x86.json', 'vkBasalt.json']) {
      const full = path.join(d, name)
      try {
        if (!layerJson32 && fs.existsSync(full)) layerJson32 = full
      } catch {}
    }
  }

  const installed64 = !!(hasLib64 && layerJson64)
  const installed32 = !!(hasLib32 && layerJson32)
  const wantedArch = opts.arch === 'x64' || opts.arch === 'x86' ? opts.arch : null
  const installed = wantedArch === 'x64'
    ? installed64
    : wantedArch === 'x86'
      ? installed32
      : (installed64 || installed32)

  return {
    installed,
    installed64,
    installed32,
    hasLib64,
    hasLib32,
    layerJson: wantedArch === 'x86' ? layerJson32 : (layerJson64 || layerJson32),
    layerJson64,
    layerJson32
  }
}

function buildLinuxVulkanInstallCommand(family, gpus, { needs32 = true } = {}) {
  const list = gpus && gpus.length ? gpus : ['amd', 'intel']
  if (family === 'arch') {
    const pkgs = new Set(['vulkan-icd-loader'])
    if (needs32) pkgs.add('lib32-vulkan-icd-loader')
    for (const g of list) {
      if (g === 'amd') {
        pkgs.add('vulkan-radeon')
        if (needs32) pkgs.add('lib32-vulkan-radeon')
      } else if (g === 'intel') {
        pkgs.add('vulkan-intel')
        if (needs32) pkgs.add('lib32-vulkan-intel')
      } else if (g === 'nvidia') {
        pkgs.add('nvidia-utils')
        if (needs32) pkgs.add('lib32-nvidia-utils')
      }
    }
    return `sudo pacman -S --needed ${[...pkgs].join(' ')}`
  }
  if (family === 'debian') {
    const pkgs = new Set(['libvulkan1'])
    if (needs32) pkgs.add('libvulkan1:i386')
    if (list.includes('amd') || list.includes('intel')) {
      pkgs.add('mesa-vulkan-drivers')
      if (needs32) pkgs.add('mesa-vulkan-drivers:i386')
    }
    if (list.includes('nvidia')) {
      pkgs.add('nvidia-vulkan-icd')
      if (needs32) pkgs.add('nvidia-vulkan-icd:i386')
    }
    return needs32
      ? `sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install -y ${[...pkgs].join(' ')}`
      : `sudo apt update && sudo apt install -y ${[...pkgs].join(' ')}`
  }
  if (family === 'fedora') {
    const pkgs = new Set(['vulkan-loader'])
    if (needs32) pkgs.add('vulkan-loader.i686')
    if (list.includes('amd') || list.includes('intel')) {
      pkgs.add('mesa-vulkan-drivers')
      if (needs32) pkgs.add('mesa-vulkan-drivers.i686')
    }
    if (list.includes('nvidia') && needs32) {
      pkgs.add('xorg-x11-drv-nvidia-libs.i686')
    }
    return `sudo dnf install -y ${[...pkgs].join(' ')}`
  }
  if (family === 'opensuse') {
    return needs32
      ? 'sudo zypper install -y libvulkan1 libvulkan1-32bit Mesa-vulkan-device-select Mesa-vulkan-device-select-32bit'
      : 'sudo zypper install -y libvulkan1 Mesa-vulkan-device-select'
  }
  return null
}

/**
 * Detects whether Vulkan is available on Linux or Windows for the active Wine / game runtime.
 * On modern 64-bit WoW64 Wine (Arch/Archcraft/Garuda/Wine 9+/10+/11+), 32-bit Wow.exe runs
 * inside a 64-bit Linux process and uses 64-bit Vulkan — 32-bit lib32-* drivers are NOT needed.
 * Only legacy 32-bit Wine binaries (ELFCLASS32) require 32-bit Vulkan drivers.
 * Fast filesystem-only checks (no blocking subprocesses).
 */
function detectVulkan(plat = platform, opts = {}) {
  if (plat === 'win32') {
    const sysRoot = opts.systemRoot || process.env.SystemRoot || 'C:\\Windows'
    const loader64 = path.join(sysRoot, 'System32', 'vulkan-1.dll')
    const loader32 = path.join(sysRoot, 'SysWOW64', 'vulkan-1.dll')
    const hasLoader64 = fs.existsSync(loader64)
    const hasLoader32 = fs.existsSync(loader32)
    const supported = hasLoader32 || hasLoader64
    const missingReasons = supported ? [] : ['Driver de vídeo com suporte a Vulkan (vulkan-1.dll) não encontrado no Windows.']
    return {
      platform: plat,
      supported,
      hasLoader64,
      hasLoader32,
      hasIcd: supported,
      hasIcd64: hasLoader64,
      hasIcd32: hasLoader32,
      wineArch: null,
      needs32: true,
      softwareOnly: false,
      icds: [],
      gpus: [],
      distro: null,
      vkBasaltSystem: false,
      missingReasons,
      installCommand: null,
      multilibHint: false,
      docsUrl: 'https://vulkan.lunarg.com/sdk/home',
      driverLinks: [
        { label: 'Drivers AMD', url: 'https://www.amd.com/en/support/download/drivers.html' },
        { label: 'Drivers NVIDIA', url: 'https://www.nvidia.com/Download/index.aspx' },
        { label: 'Drivers Intel', url: 'https://www.intel.com/content/www/us/en/download-center/home.html' }
      ]
    }
  }

  if (plat !== 'linux') {
    return {
      platform: plat,
      supported: true,
      hasLoader64: true,
      hasLoader32: true,
      hasIcd: true,
      hasIcd64: true,
      hasIcd32: true,
      wineArch: null,
      needs32: false,
      softwareOnly: false,
      icds: [],
      gpus: [],
      distro: null,
      vkBasaltSystem: false,
      missingReasons: [],
      installCommand: null,
      multilibHint: false,
      docsUrl: 'https://www.vulkan.org/',
      driverLinks: []
    }
  }

  const distro = opts.distro || detectDistro(opts.osReleasePath)
  const gpus = opts.gpus || detectGpuVendors(opts.drmRoot)
  const wineArch = opts.wineArch || (opts.winePath ? detectElfArch(opts.winePath) : null)
  const loader64Paths = opts.loader64Paths || [
    '/usr/lib/libvulkan.so.1',
    '/usr/lib64/libvulkan.so.1',
    '/usr/lib/x86_64-linux-gnu/libvulkan.so.1'
  ]
  const loader32Paths = opts.loader32Paths || [
    '/usr/lib32/libvulkan.so.1',
    '/usr/lib/i386-linux-gnu/libvulkan.so.1'
  ]
  const icdDirs = opts.icdDirs || ['/usr/share/vulkan/icd.d', '/etc/vulkan/icd.d', '/usr/local/share/vulkan/icd.d']

  const hasLoader64 = loader64Paths.some((p) => fs.existsSync(p))
  const hasLoader32 = loader32Paths.some((p) => fs.existsSync(p))
  const icds = []
  const hwIcds = []
  const hwIcds64 = []
  const hwIcds32 = []
  const swIcds = []

  const lib64Dirs = opts.lib64Dirs || ['/usr/lib', '/usr/lib64', '/usr/lib/x86_64-linux-gnu']
  const lib32Dirs = opts.lib32Dirs || ['/usr/lib32', '/usr/lib/i386-linux-gnu']
  const hasNvidia32Lib = (opts.nvidia32Paths || [
    '/usr/lib32/libGLX_nvidia.so.0',
    '/usr/lib/i386-linux-gnu/libGLX_nvidia.so.0'
  ]).some((p) => fs.existsSync(p))

  for (const dir of icdDirs) {
    try {
      if (!fs.existsSync(dir)) continue
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) continue
        icds.push(file)
        const isSoftware = /lvp|lavapipe|swiftshader/i.test(file)
        if (isSoftware) {
          swIcds.push(file)
          continue
        }
        hwIcds.push(file)
        const nameIs32Only = /(?:^|[._-])(i686|i386|x86)(?:[._-]|$)/i.test(file)
        const nameIs64 = /(?:^|[._-])(x86_64|amd64|64)(?:[._-]|$)/i.test(file)
        let is32 = nameIs32Only
        let is64 = nameIs64
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
          const libPath = String(parsed?.ICD?.library_path || '').trim()
          if (/\/lib32\/|i386-linux-gnu|i686/i.test(libPath)) {
            is32 = true
          } else if (/\/lib64\/|x86_64-linux-gnu|\/usr\/lib\/libvulkan/i.test(libPath)) {
            is64 = true
          } else if (libPath && !libPath.includes('/')) {
            // Modern Mesa / NVIDIA unified ICDs use a bare soname (e.g. "libvulkan_radeon.so")
            // resolved by the dynamic linker for each architecture.
            if (lib32Dirs.some((d32) => fs.existsSync(path.join(d32, libPath)))) is32 = true
            if (lib64Dirs.some((d64) => fs.existsSync(path.join(d64, libPath)))) is64 = true
            if (!is32 && !is64 && !nameIs32Only && !opts.lib64Dirs) is64 = true
          } else if (libPath && fs.existsSync(libPath)) {
            const elf = detectElfArch(libPath)
            if (elf === 'x64') is64 = true
            else if (elf === 'x86') is32 = true
            else if (!nameIs32Only) is64 = true
          } else if (!nameIs32Only) {
            is64 = true
          }
          if (!is32 && /nvidia/i.test(file) && hasNvidia32Lib) {
            is32 = true
          }
        } catch {
          if (!nameIs32Only) is64 = true
        }
        if (is32) hwIcds32.push(file)
        if (is64) hwIcds64.push(file)
      }
    } catch {}
  }

  const hasIcd = hwIcds.length > 0
  const hasIcd64 = hwIcds64.length > 0
  const hasIcd32 = hwIcds32.length > 0
  const softwareOnly = !hasIcd && swIcds.length > 0

  // Modern 64-bit WoW64 Wine (including Arch/Archcraft /usr/bin/wine and our bundled x64 wine runner)
  // calls 64-bit Vulkan directly. Only require 32-bit Vulkan when running a 32-bit Wine binary or explicitly requested.
  const needs32 = opts.require32 === true || wineArch === 'x86'
  const supported = needs32
    ? (hasLoader32 && hasIcd && hasIcd32)
    : (hasLoader64 && hasIcd64)

  const missingReasons = []
  if (!hasIcd) {
    missingReasons.push(softwareOnly
      ? 'Apenas driver Vulkan por software (Lavapipe) encontrado — falta driver Vulkan de GPU.'
      : 'Nenhum driver Vulkan (ICD) de GPU instalado.')
  } else if (needs32) {
    if (!hasLoader32) missingReasons.push('Biblioteca Vulkan 32-bit (libvulkan.so.1) não encontrada (necessária para este Wine 32-bit).')
    if (!hasIcd32) missingReasons.push('Driver Vulkan 32-bit da GPU não encontrado (necessário para DXVK neste Wine 32-bit).')
  } else {
    if (!hasLoader64) missingReasons.push('Biblioteca Vulkan 64-bit (libvulkan.so.1) não encontrada.')
    if (!hasIcd64) missingReasons.push('Driver Vulkan 64-bit da GPU não encontrado.')
  }

  const vkBasalt = detectSystemVkBasalt({ ...(opts.vkBasaltOpts || {}), arch: wineArch || 'x64' })
  const installCommand = supported ? null : buildLinuxVulkanInstallCommand(distro.family, gpus, { needs32 })
  const docsUrl = distro.family === 'arch'
    ? 'https://wiki.archlinux.org/title/Vulkan'
    : 'https://github.com/lutris/docs/blob/master/InstallingDrivers.md'

  return {
    platform: plat,
    supported,
    hasLoader64,
    hasLoader32,
    hasIcd,
    hasIcd64,
    hasIcd32,
    wineArch,
    needs32,
    softwareOnly,
    icds,
    gpus,
    distro,
    vkBasaltSystem: vkBasalt.installed,
    missingReasons,
    installCommand,
    multilibHint: distro.family === 'arch' && !supported && needs32,
    docsUrl,
    driverLinks: []
  }
}

/**
 * Inspects Linux desktop performance conditions that commonly cause stutter on Arch/Archcraft:
 *  - /dev/ntsync availability vs installed ntsync.ko* kernel module
 *  - running picom X11 compositor and whether Wow.exe has an unredirect rule
 * Fast filesystem-only checks (no blocking subprocesses).
 */
function detectLinuxPerformance(opts = {}) {
  const plat = opts.platform || platform
  if (plat !== 'linux') {
    return { platform: plat, ntsync: { loaded: false, moduleAvailable: false, enableCommand: null }, picom: { running: false, pid: null, configPath: null, hasWowUnredir: false, hasRulesBlock: false } }
  }

  const ntsyncDev = opts.ntsyncDev || '/dev/ntsync'
  let ntsyncLoaded = false
  try {
    fs.accessSync(ntsyncDev, fs.constants.R_OK | fs.constants.W_OK)
    ntsyncLoaded = true
  } catch {
    try { ntsyncLoaded = fs.existsSync(ntsyncDev) } catch {}
  }

  const kernelRelease = opts.kernelRelease || os.release()
  const modulesRoot = opts.modulesRoot || '/lib/modules'
  const modDir = path.join(modulesRoot, kernelRelease, 'kernel', 'drivers', 'misc')
  const moduleAvailable = ['ntsync.ko', 'ntsync.ko.zst', 'ntsync.ko.xz', 'ntsync.ko.gz'].some((f) => {
    try { return fs.existsSync(path.join(modDir, f)) } catch { return false }
  })

  // Detect running picom process from /proc without spawning ps/pgrep
  const procRoot = opts.procRoot || '/proc'
  const home = opts.home || process.env.HOME || ''
  let picomRunning = false
  let picomPid = null
  let cmdlineConfigPath = null
  try {
    for (const entry of fs.readdirSync(procRoot)) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const comm = fs.readFileSync(path.join(procRoot, entry, 'comm'), 'utf8').trim()
        if (comm !== 'picom') continue
        picomRunning = true
        picomPid = Number(entry)
        try {
          const rawCmd = fs.readFileSync(path.join(procRoot, entry, 'cmdline'), 'utf8')
          const argv = rawCmd.split('\0').filter(Boolean)
          for (let i = 0; i < argv.length; i++) {
            if ((argv[i] === '--config' || argv[i] === '-c') && argv[i + 1]) {
              cmdlineConfigPath = argv[i + 1]
              break
            }
            if (argv[i].startsWith('--config=')) {
              cmdlineConfigPath = argv[i].slice('--config='.length)
              break
            }
          }
        } catch {}
        break
      } catch {}
    }
  } catch {}

  let configPath = null
  if (picomRunning) {
    const candidates = [
      cmdlineConfigPath,
      home && path.join(home, '.config', 'picom.conf'),
      home && path.join(home, '.config', 'picom', 'picom.conf'),
      home && path.join(home, '.config', 'openbox', 'picom.conf'),
      home && path.join(home, '.config', 'bspwm', 'picom.conf'),
      home && path.join(home, '.config', 'i3', 'picom.conf')
    ].filter(Boolean)
    for (const c of candidates) {
      try {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) {
          configPath = c
          break
        }
      } catch {}
    }
  }

  let hasWowUnredir = false
  let hasRulesBlock = false
  if (configPath) {
    try {
      const text = fs.readFileSync(configPath, 'utf8')
      hasRulesBlock = /(?:^|\n)\s*rules\s*[:=]\s*\(/m.test(text)
      hasWowUnredir = /OLK-PLUS-UNREDIR/i.test(text) || (/wow\.exe/i.test(text) && /unredir/i.test(text))
    } catch {}
  }

  return {
    platform: plat,
    ntsync: {
      loaded: ntsyncLoaded,
      moduleAvailable,
      enableCommand: 'sudo modprobe ntsync && echo ntsync | sudo tee /etc/modules-load.d/ntsync.conf'
    },
    picom: {
      running: picomRunning,
      pid: picomPid,
      configPath,
      hasWowUnredir,
      hasRulesBlock
    }
  }
}

/**
 * Automatically adds a safe, reversible Wow.exe unredirect rule to the active picom config
 * when picom is running on Desktop Linux (e.g. Archcraft Openbox/bspwm/i3).
 * Creates a one-time .olk-backup before editing and reloads picom via SIGUSR1.
 */
function ensurePicomUnredirect(opts = {}) {
  const perf = opts.perf || detectLinuxPerformance(opts)
  if (!perf.picom?.running || !perf.picom.configPath) {
    return { applied: false, reason: 'not-running' }
  }
  if (perf.picom.hasWowUnredir) {
    return { applied: false, reason: 'already-configured', configPath: perf.picom.configPath }
  }
  const cfgPath = perf.picom.configPath
  try {
    fs.accessSync(cfgPath, fs.constants.R_OK | fs.constants.W_OK)
    const original = fs.readFileSync(cfgPath, 'utf8')
    const backupPath = `${cfgPath}.olk-backup`
    if (!fs.existsSync(backupPath)) {
      fs.writeFileSync(backupPath, original, 'utf8')
    }

    let updated = original
    let strategy = null
    const rulesRe = /((?:^|\n)\s*rules\s*[:=]\s*\([ \t]*\r?\n?)/m
    if (rulesRe.test(original)) {
      const ruleLine = `  { match = "class_g = 'Wow.exe' || class_g = 'wow.exe'"; unredir = true; }, # OLK-PLUS-UNREDIR\n`
      updated = original.replace(rulesRe, `$1${ruleLine}`)
      strategy = 'rules-unredir'
    } else if (/^([ \t]*unredir-if-possible\s*=\s*)false([ \t]*;?)/im.test(original)) {
      updated = original.replace(/^([ \t]*unredir-if-possible\s*=\s*)false([ \t]*;?)/im, '$1true$2 # OLK-PLUS-UNREDIR')
      strategy = 'unredir-if-possible'
    } else if (/^[ \t]*unredir-if-possible\s*=\s*true/im.test(original)) {
      return { applied: false, reason: 'unredir-already-true', configPath: cfgPath }
    } else {
      updated = `${original.replace(/\s*$/, '')}\nunredir-if-possible = true; # OLK-PLUS-UNREDIR\n`
      strategy = 'append-unredir-if-possible'
    }

    if (updated !== original) {
      const tmp = `${cfgPath}.olk-tmp`
      fs.writeFileSync(tmp, updated, 'utf8')
      fs.renameSync(tmp, cfgPath)
      if (perf.picom.pid && opts.signal !== false) {
        try { process.kill(perf.picom.pid, 'SIGUSR1') } catch {}
      }
      return { applied: true, strategy, configPath: cfgPath, backupPath }
    }
    return { applied: false, reason: 'unchanged', configPath: cfgPath }
  } catch (err) {
    return { applied: false, reason: 'error', error: err.message, configPath: cfgPath }
  }
}

/**
 * Loads the ntsync kernel module and persists it in /etc/modules-load.d/ntsync.conf using pkexec.
 * Shows the desktop's native Polkit authentication prompt.
 */
function enableLinuxNtsync() {
  if (platform !== 'linux') return Promise.resolve({ ok: false, error: 'Disponível apenas no Linux.' })
  const pkexec = which('pkexec')
  if (!pkexec) {
    return Promise.resolve({
      ok: false,
      error: 'pkexec não encontrado. Execute o comando no terminal com sudo.'
    })
  }
  return new Promise((resolve) => {
    const env = cleanEnvForSystemBinary({ ...process.env })
    execFile(
      pkexec,
      ['/bin/sh', '-c', 'modprobe ntsync && mkdir -p /etc/modules-load.d && printf "ntsync\\n" > /etc/modules-load.d/ntsync.conf'],
      { env, timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').trim()
          return resolve({ ok: false, error: msg || 'Não foi possível ativar NTsync.' })
        }
        resolve({ ok: fs.existsSync('/dev/ntsync') })
      }
    )
  })
}

module.exports = {
  platform,
  which,
  isExecutableFile,
  isSteamRuntimePath,
  wineVersion,
  detectWine,
  detectAllWineCandidates,
  findProtonScript,
  cleanEnvForSystemBinary,
  freeBytes,
  describe,
  parseOsRelease,
  detectDistro,
  detectGpuVendors,
  detectElfArch,
  detectSystemVkBasalt,
  buildLinuxVulkanInstallCommand,
  detectVulkan,
  detectLinuxPerformance,
  ensurePicomUnredirect,
  enableLinuxNtsync
}
