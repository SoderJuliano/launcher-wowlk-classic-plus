'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpDir } = require('./helpers.cjs')
const {
  parseOsRelease,
  buildLinuxVulkanInstallCommand,
  detectVulkan,
  detectElfArch,
  detectLinuxPerformance,
  ensurePicomUnredirect
} = require('../electron/core/PlatformService.cjs')
const {
  LauncherSelfUpdater,
  replaceFileSafely,
  cleanAppImageEnv,
  resolveWritableAppImagePath
} = require('../electron/core/LauncherSelfUpdater.cjs')
const {
  applyRealmlist,
  resolveTargetResolution
} = require('../electron/core/realmlist.cjs')
const {
  prepareLinuxGraphics,
  prepareWindowsGraphics,
  OLK_RESHADE_MARKER
} = require('../electron/core/GraphicsManager.cjs')

test('PlatformService: parseOsRelease and Linux Vulkan install commands for Archcraft/Ubuntu/Fedora', () => {
  const archcraft = parseOsRelease('NAME="Archcraft"\nID=archcraft\nID_LIKE=arch\nPRETTY_NAME="Archcraft Linux"\n')
  assert.equal(archcraft.family, 'arch')
  assert.equal(archcraft.prettyName, 'Archcraft Linux')

  const cmdAmd = buildLinuxVulkanInstallCommand('arch', ['amd'])
  assert.match(cmdAmd, /vulkan-radeon/)
  assert.match(cmdAmd, /lib32-vulkan-radeon/)
  assert.match(cmdAmd, /lib32-vulkan-icd-loader/)

  const cmdIntel = buildLinuxVulkanInstallCommand('debian', ['intel'])
  assert.match(cmdIntel, /mesa-vulkan-drivers:i386/)
  assert.match(cmdIntel, /libvulkan1:i386/)

  const cmdFedora = buildLinuxVulkanInstallCommand('fedora', ['amd'])
  assert.match(cmdFedora, /mesa-vulkan-drivers\.i686/)
})

test('PlatformService: detectVulkan handles 64-bit WoW64 Archcraft (no lib32 needed), legacy 32-bit Wine, and Windows vulkan-1.dll', () => {
  const root = tmpDir()
  const icdDir = path.join(root, 'icd.d')
  fs.mkdirSync(icdDir, { recursive: true })
  // Only lavapipe (software) installed, no hardware ICD
  fs.writeFileSync(path.join(icdDir, 'lvp_icd.x86_64.json'), JSON.stringify({ ICD: { library_path: '/usr/lib/libvulkan_lvp.so' } }))

  // Legacy 32-bit Wine requires 32-bit Vulkan + multilib hint on Archcraft
  const missing32 = detectVulkan('linux', {
    distro: { id: 'archcraft', family: 'arch', prettyName: 'Archcraft Linux' },
    gpus: ['amd'],
    wineArch: 'x86',
    loader64Paths: [path.join(root, 'missing64')],
    loader32Paths: [path.join(root, 'missing32')],
    icdDirs: [icdDir],
    vkBasaltOpts: { lib64Paths: [path.join(root, 'nope')], lib32Paths: [path.join(root, 'nope')], layerDirs: [path.join(root, 'nope')] }
  })
  assert.equal(missing32.supported, false)
  assert.equal(missing32.softwareOnly, true)
  assert.equal(missing32.multilibHint, true)
  assert.match(missing32.installCommand, /lib32-vulkan-radeon/)

  // Modern 64-bit WoW64 Wine on Archcraft missing Vulkan suggests ONLY 64-bit packages (no broken lib32-* without multilib)
  const missing64 = detectVulkan('linux', {
    distro: { id: 'archcraft', family: 'arch', prettyName: 'Archcraft Linux' },
    gpus: ['amd'],
    wineArch: 'x64',
    loader64Paths: [path.join(root, 'missing64')],
    loader32Paths: [path.join(root, 'missing32')],
    icdDirs: [icdDir],
    vkBasaltOpts: { lib64Paths: [path.join(root, 'nope')], lib32Paths: [path.join(root, 'nope')], layerDirs: [path.join(root, 'nope')] }
  })
  assert.equal(missing64.supported, false)
  assert.equal(missing64.multilibHint, false)
  assert.match(missing64.installCommand, /vulkan-radeon/)
  assert.ok(!/lib32-/.test(missing64.installCommand), '64-bit WoW64 install command must not require lib32-*')

  // Archcraft with ONLY 64-bit Vulkan + 64-bit WoW64 Wine (NO lib32 at all) -> MUST be supported (no false warning!)
  const fakeLoader64 = path.join(root, 'libvulkan64.so.1')
  const fakeLib64Dir = path.join(root, 'lib64')
  const archIcdDir = path.join(root, 'arch-icd')
  fs.mkdirSync(fakeLib64Dir, { recursive: true })
  fs.mkdirSync(archIcdDir, { recursive: true })
  fs.writeFileSync(fakeLoader64, 'elf64')
  fs.writeFileSync(path.join(fakeLib64Dir, 'libvulkan_radeon.so'), 'elf64')
  fs.writeFileSync(path.join(archIcdDir, 'radeon_icd.json'), JSON.stringify({ ICD: { library_path: 'libvulkan_radeon.so' } }))
  const archcraftOk = detectVulkan('linux', {
    distro: { id: 'archcraft', family: 'arch', prettyName: 'Archcraft Linux' },
    gpus: ['amd'],
    wineArch: 'x64',
    loader64Paths: [fakeLoader64],
    loader32Paths: [path.join(root, 'missing32')],
    icdDirs: [archIcdDir],
    lib64Dirs: [fakeLib64Dir],
    lib32Dirs: [path.join(root, 'empty32')],
    vkBasaltOpts: { lib64Paths: [path.join(root, 'nope')], lib32Paths: [path.join(root, 'nope')], layerDirs: [path.join(root, 'nope')] }
  })
  assert.equal(archcraftOk.supported, true)
  assert.equal(archcraftOk.installCommand, null)
  assert.equal(archcraftOk.needs32, false)

  // Legacy 32-bit Wine with unified ICD requires lib32 library present
  const fakeLoader32 = path.join(root, 'libvulkan32.so.1')
  const fakeLib32Dir = path.join(root, 'lib32')
  fs.mkdirSync(fakeLib32Dir, { recursive: true })
  fs.writeFileSync(fakeLoader32, 'elf32')
  assert.equal(detectVulkan('linux', {
    distro: { id: 'arch', family: 'arch', prettyName: 'Arch Linux' },
    gpus: ['amd'],
    wineArch: 'x86',
    loader64Paths: [fakeLoader64],
    loader32Paths: [fakeLoader32],
    icdDirs: [archIcdDir],
    lib64Dirs: [fakeLib64Dir],
    lib32Dirs: [fakeLib32Dir],
    vkBasaltOpts: { lib64Paths: [path.join(root, 'nope')], lib32Paths: [path.join(root, 'nope')], layerDirs: [path.join(root, 'nope')] }
  }).supported, false)
  fs.writeFileSync(path.join(fakeLib32Dir, 'libvulkan_radeon.so'), 'elf32')
  assert.equal(detectVulkan('linux', {
    distro: { id: 'arch', family: 'arch', prettyName: 'Arch Linux' },
    gpus: ['amd'],
    wineArch: 'x86',
    loader64Paths: [fakeLoader64],
    loader32Paths: [fakeLoader32],
    icdDirs: [archIcdDir],
    lib64Dirs: [fakeLib64Dir],
    lib32Dirs: [fakeLib32Dir],
    vkBasaltOpts: { lib64Paths: [path.join(root, 'nope')], lib32Paths: [path.join(root, 'nope')], layerDirs: [path.join(root, 'nope')] }
  }).supported, true)

  // Real ELF detection on bundled libvkbasalt binaries
  assert.equal(detectElfArch(path.join(__dirname, '..', 'electron', 'bin', 'graphics', 'linux', 'libvkbasalt_x86_64.so')), 'x64')
  assert.equal(detectElfArch(path.join(__dirname, '..', 'electron', 'bin', 'graphics', 'linux', 'libvkbasalt_x86.so')), 'x86')

  // Windows detection
  const winRoot = path.join(root, 'Windows')
  fs.mkdirSync(path.join(winRoot, 'SysWOW64'), { recursive: true })
  assert.equal(detectVulkan('win32', { systemRoot: winRoot }).supported, false)
  fs.writeFileSync(path.join(winRoot, 'SysWOW64', 'vulkan-1.dll'), 'pe')
  assert.equal(detectVulkan('win32', { systemRoot: winRoot }).supported, true)
})

test('PlatformService: detectLinuxPerformance & ensurePicomUnredirect safely patch picom v12 and v11 configs', () => {
  const root = tmpDir()
  const procRoot = path.join(root, 'proc')
  const picomProc = path.join(procRoot, '4242')
  const home = path.join(root, 'home')
  const cfgDir = path.join(home, '.config')
  const modDir = path.join(root, 'modules', '6.18.0-arch', 'kernel', 'drivers', 'misc')
  fs.mkdirSync(picomProc, { recursive: true })
  fs.mkdirSync(cfgDir, { recursive: true })
  fs.mkdirSync(modDir, { recursive: true })
  fs.writeFileSync(path.join(picomProc, 'comm'), 'picom\n')
  const picomConf = path.join(cfgDir, 'picom.conf')
  fs.writeFileSync(path.join(picomProc, 'cmdline'), `picom\0--config\0${picomConf}\0`)
  fs.writeFileSync(path.join(modDir, 'ntsync.ko.zst'), 'mod')

  // Picom v12 rules block
  fs.writeFileSync(picomConf, 'vsync = true;\nrules: (\n  { match = "focused"; opacity = 1.0; },\n)\n')
  const perf = detectLinuxPerformance({
    platform: 'linux',
    procRoot,
    home,
    ntsyncDev: path.join(root, 'no-ntsync'),
    modulesRoot: path.join(root, 'modules'),
    kernelRelease: '6.18.0-arch'
  })
  assert.equal(perf.ntsync.loaded, false)
  assert.equal(perf.ntsync.moduleAvailable, true)
  assert.equal(perf.picom.running, true)
  assert.equal(perf.picom.configPath, picomConf)
  assert.equal(perf.picom.hasRulesBlock, true)
  assert.equal(perf.picom.hasWowUnredir, false)

  const res = ensurePicomUnredirect({ perf, signal: false })
  assert.equal(res.applied, true)
  assert.equal(res.strategy, 'rules-unredir')
  assert.ok(fs.existsSync(`${picomConf}.olk-backup`))
  const updated = fs.readFileSync(picomConf, 'utf8')
  assert.match(updated, /class_g = 'Wow\.exe' \|\| class_g = 'wow\.exe'/)
  assert.match(updated, /unredir = true/)

  // Second run is idempotent
  const res2 = ensurePicomUnredirect({
    platform: 'linux', procRoot, home, ntsyncDev: path.join(root, 'no-ntsync'),
    modulesRoot: path.join(root, 'modules'), kernelRelease: '6.18.0-arch', signal: false
  })
  assert.equal(res2.applied, false)
  assert.equal(res2.reason, 'already-configured')

  // Picom v11 unredir-if-possible = false
  const v11Conf = path.join(cfgDir, 'picom-v11.conf')
  fs.writeFileSync(v11Conf, 'vsync = true;\nunredir-if-possible = false;\n')
  const v11Res = ensurePicomUnredirect({
    perf: { picom: { running: true, pid: null, configPath: v11Conf, hasWowUnredir: false, hasRulesBlock: false } },
    signal: false
  })
  assert.equal(v11Res.applied, true)
  assert.equal(v11Res.strategy, 'unredir-if-possible')
  assert.match(fs.readFileSync(v11Conf, 'utf8'), /unredir-if-possible = true;/)
})

test('LauncherSelfUpdater: cleanAppImageEnv, writable fallback, and anti-loop guard', async () => {
  const cleaned = cleanAppImageEnv({
    APPIMAGE: '/tmp/old.AppImage',
    APPDIR: '/tmp/.mount_OLK123',
    ARGV0: '/tmp/old.AppImage',
    PATH: '/tmp/.mount_OLK123/usr/bin:/usr/bin:/bin',
    LD_LIBRARY_PATH: '/tmp/.mount_OLK123/usr/lib:/usr/lib',
    HOME: '/home/test'
  })
  assert.equal(cleaned.APPIMAGE, undefined)
  assert.equal(cleaned.APPDIR, undefined)
  assert.equal(cleaned.PATH, '/usr/bin:/bin')
  assert.equal(cleaned.LD_LIBRARY_PATH, '/usr/lib')
  assert.equal(cleaned.HOME, '/home/test')

  // Read-only / non-existent parent migrates to ~/Applications
  const fakeHome = tmpDir()
  const migrated = resolveWritableAppImagePath('/nonexistent-readonly-dir/OLK.AppImage', fakeHome)
  assert.equal(migrated.migrated, true)
  assert.equal(migrated.path, path.join(fakeHome, 'Applications', 'OLK-Plus-Launcher.AppImage'))

  // replaceFileSafely replaces content and sets mode
  const dir = tmpDir()
  const src = path.join(dir, 'src.AppImage')
  const dst = path.join(dir, 'dst.AppImage')
  fs.writeFileSync(src, 'new-binary')
  fs.writeFileSync(dst, 'old-binary')
  replaceFileSafely(src, dst)
  assert.equal(fs.readFileSync(dst, 'utf8'), 'new-binary')

  // Anti-loop protection: after 2 attempts for the same version within window, skips downloading
  const data = tmpDir()
  let downloads = 0
  const updater = new LauncherSelfUpdater({
    config: { dataDir: data },
    api: {},
    manifests: {
      fetchLauncherManifest: async () => ({
        version: '0.2.0',
        linux: { url: 'https://example.com/OLK-0.2.0.AppImage', size: 10 }
      })
    },
    downloader: {
      download: async (opts) => {
        downloads++
        fs.writeFileSync(opts.dest, '0123456789')
      }
    },
    launcherVersion: '0.1.47',
    appInstance: { isPackaged: true, exit: () => {} },
    platformName: 'linux'
  })

  // Pre-seed 2 recent attempts for 0.2.0
  const tempDir = path.join(data, 'temp')
  fs.mkdirSync(tempDir, { recursive: true })
  fs.writeFileSync(path.join(tempDir, 'self-update-attempt.json'), JSON.stringify({ version: '0.2.0', count: 2, at: Date.now() }))

  const res = await updater.checkAndApplyUpdate()
  assert.equal(res.skippedLoop, true)
  assert.equal(downloads, 0, 'must not re-download when loop guard triggers')
  assert.equal(res.manualUrl, 'https://example.com/OLK-0.2.0.AppImage')
})

test('realmlist: auto-fixes 2560x1080 default to native monitor resolution and sets quality CVars without overwriting user choices', () => {
  // 2560x1080 on a 1920x1080 monitor must be fixed to 1920x1080
  assert.equal(resolveTargetResolution('2560x1080', { width: 1920, height: 1080 }), '1920x1080')
  // User manually chose 1600x900 on 1920x1080 monitor -> preserve
  assert.equal(resolveTargetResolution('1600x900', { width: 1920, height: 1080 }), null)
  // Oversized resolution 3840x2160 on 1920x1080 monitor -> fix to 1920x1080
  assert.equal(resolveTargetResolution('3840x2160', { width: 1920, height: 1080 }), '1920x1080')
  // Custom resolution mode
  assert.equal(resolveTargetResolution('1920x1080', { width: 1920, height: 1080 }, { resolutionMode: 'custom', customResolution: '1280x720' }), '1280x720')
  // Manual mode never touches resolution
  assert.equal(resolveTargetResolution('2560x1080', { width: 1920, height: 1080 }, { resolutionMode: 'manual' }), null)

  const gameDir = tmpDir()
  fs.mkdirSync(path.join(gameDir, 'Data', 'enUS'), { recursive: true })
  fs.mkdirSync(path.join(gameDir, 'WTF'), { recursive: true })
  fs.writeFileSync(path.join(gameDir, 'WTF', 'Config.wtf'), 'SET gxResolution "2560x1080"\r\nSET specular "0"\r\nSET windowResizeLock "1"\r\n')

  const savedDeck = process.env.SteamDeck
  delete process.env.SteamDeck
  try {
    applyRealmlist(gameDir, '127.0.0.1:3724', 'enUS', 'ARTHAS', undefined, {
      displaySize: { width: 1920, height: 1080 },
      resolutionMode: 'auto',
      platformName: 'win32'
    })
  } finally {
    if (savedDeck !== undefined) process.env.SteamDeck = savedDeck
  }

  const wtf = fs.readFileSync(path.join(gameDir, 'WTF', 'Config.wtf'), 'utf8')
  assert.match(wtf, /SET gxResolution "1920x1080"/)
  assert.match(wtf, /SET gxWindow "1"/)
  assert.match(wtf, /SET gxMaximize "1"/)
  assert.match(wtf, /SET windowResizeLock "0"/)
  assert.match(wtf, /SET shadowLevel "3"/)
  assert.match(wtf, /SET extShadowQuality "3"/)
  assert.match(wtf, /SET ffxGlow "1"/)
  // Existing user choice specular "0" must NOT be overwritten
  assert.match(wtf, /SET specular "0"/)
})

test('GraphicsManager: Linux sandboxed vkBasalt (64-bit WoW64 & 32-bit) and Windows sandboxed ReShade (F11 toggle)', () => {
  const gameDir = tmpDir()
  const dataDir = tmpDir()

  // 1a. Linux 64-bit WoW64 Wine without system vkBasalt -> deploys 64-bit libvkbasalt + implicit layer manifest
  const linuxEnv64 = {}
  const linuxRes64 = prepareLinuxGraphics({
    gameDir,
    dataDir,
    env: linuxEnv64,
    graphicsCfg: { filtersEnabled: true, useDxvk: true },
    systemVkBasalt: { installed: false },
    deck: false,
    wineArch: 'x64'
  })
  assert.equal(linuxRes64.filtersActive, true)
  assert.equal(linuxRes64.mode, 'bundled-vkbasalt')
  assert.equal(linuxRes64.arch, 'x64')
  assert.equal(linuxEnv64.ENABLE_VKBASALT, '1')
  assert.equal(linuxEnv64.VK_LAYER_PATH, undefined, 'must not clobber VK_LAYER_PATH')
  assert.ok(fs.existsSync(linuxEnv64.VKBASALT_CONFIG_FILE))
  const conf = fs.readFileSync(linuxEnv64.VKBASALT_CONFIG_FILE, 'utf8')
  assert.match(conf, /toggleKey = F11/)
  assert.ok(!conf.includes('/opt/reshade'), 'vkBasalt conf must never depend on /opt/reshade')
  assert.ok(conf.includes(path.join(gameDir, 'reshade-shaders', 'shaders')))
  assert.ok(linuxEnv64.VK_ADD_IMPLICIT_LAYER_PATH.includes(linuxRes64.implicitLayerDir))
  assert.ok(linuxEnv64.XDG_DATA_DIRS.includes(path.join(dataDir, 'runtime', 'vkbasalt', 'x64')))
  assert.ok(fs.existsSync(path.join(dataDir, 'runtime', 'vkbasalt', 'libvkbasalt_x86_64.so')))
  const manifest64 = JSON.parse(fs.readFileSync(path.join(linuxRes64.implicitLayerDir, 'vkBasalt.x86_64.json'), 'utf8'))
  assert.equal(manifest64.layer.library_path, path.join(dataDir, 'runtime', 'vkbasalt', 'libvkbasalt_x86_64.so'))

  // 1b. Linux 32-bit Wine without system vkBasalt -> deploys 32-bit libvkbasalt + x86 implicit layer manifest
  const linuxEnv32 = {}
  const linuxRes32 = prepareLinuxGraphics({
    gameDir,
    dataDir,
    env: linuxEnv32,
    graphicsCfg: { filtersEnabled: true, useDxvk: true },
    systemVkBasalt: { installed: false },
    deck: false,
    wineArch: 'x86'
  })
  assert.equal(linuxRes32.filtersActive, true)
  assert.equal(linuxRes32.arch, 'x86')
  const manifest32 = JSON.parse(fs.readFileSync(path.join(linuxRes32.implicitLayerDir, 'vkBasalt.x86.json'), 'utf8'))
  assert.equal(manifest32.layer.library_path, path.join(dataDir, 'runtime', 'vkbasalt', 'libvkbasalt_x86.so'))

  // 2. Linux DXVK disabled fallback -> WineD3D builtin
  const linuxFallbackEnv = {}
  const fallbackRes = prepareLinuxGraphics({
    gameDir,
    dataDir,
    env: linuxFallbackEnv,
    graphicsCfg: { filtersEnabled: true, useDxvk: false },
    deck: false
  })
  assert.equal(fallbackRes.mode, 'wined3d')
  assert.equal(linuxFallbackEnv.WINEDLLOVERRIDES, 'winedbg.exe=d;d3d9,dxgi=b')
  assert.equal(linuxFallbackEnv.ENABLE_VKBASALT, '0')

  // 3. Windows with ReShade enabled -> deploys ReShade32.dll + ReShade32.json + ReShade.ini (F11 = 122) + RESHADE_BASE_PATH_OVERRIDE
  const winGameDir = tmpDir()
  fs.writeFileSync(path.join(winGameDir, 'd3d9_orig.dll'), 'dxvk-dll')
  const winEnv = {}
  const winRes = prepareWindowsGraphics({
    gameDir: winGameDir,
    dataDir,
    env: winEnv,
    graphicsCfg: { filtersEnabled: true, useDxvk: true }
  })
  assert.equal(winRes.filtersActive, true)
  assert.equal(winRes.mode, 'bundled-reshade')
  assert.equal(winEnv.RESHADE_BASE_PATH_OVERRIDE, winGameDir)
  assert.match(winEnv.VK_INSTANCE_LAYERS, /VK_LAYER_reshade/)
  assert.ok(winEnv.VK_ADD_IMPLICIT_LAYER_PATH.includes(winRes.runtimeDir))
  assert.ok(fs.existsSync(path.join(dataDir, 'runtime', 'reshade', 'ReShade32.dll')))
  assert.ok(fs.existsSync(path.join(dataDir, 'runtime', 'reshade', 'ReShade32.json')))
  assert.ok(fs.existsSync(path.join(dataDir, 'runtime', 'reshade', 'ReShade.ini')))
  const ini = fs.readFileSync(path.join(winGameDir, 'ReShade.ini'), 'utf8')
  assert.ok(ini.startsWith(OLK_RESHADE_MARKER))
  assert.match(ini, /KeyEffects=122,0,0,0/)
  assert.match(ini, /ReShadePreset\.ini/)

  // 4. Windows DXVK disabled -> moves d3d9_orig.dll out of the way, restores when re-enabled
  const winNoDxvkEnv = {}
  prepareWindowsGraphics({ gameDir: winGameDir, dataDir, env: winNoDxvkEnv, graphicsCfg: { filtersEnabled: true, useDxvk: false } })
  assert.equal(fs.existsSync(path.join(winGameDir, 'd3d9_orig.dll')), false)
  assert.equal(fs.existsSync(path.join(winGameDir, 'd3d9_orig.dll.dxvk-disabled')), true)
  assert.equal(winNoDxvkEnv.DISABLE_VK_LAYER_reshade_1, '1')

  prepareWindowsGraphics({ gameDir: winGameDir, dataDir, env: {}, graphicsCfg: { filtersEnabled: false, useDxvk: true } })
  assert.equal(fs.existsSync(path.join(winGameDir, 'd3d9_orig.dll')), true)
})
