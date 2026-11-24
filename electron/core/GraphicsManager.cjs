'use strict'
/**
 * GraphicsManager — sandboxed post-processing filters (F11 toggle) and DXVK control
 * for both Linux (vkBasalt 64-bit WoW64 & 32-bit Vulkan layers) and Windows (ReShade 32-bit Vulkan layer).
 *
 * Guarantees that the 6-stage WoW Forever Cinematic & Vibrant preset
 * (CAS + SMAA + Curves + Clarity + Colourfulness + FakeHDR, toggleKey = F11)
 * works out-of-the-box without relying on /opt/reshade or system-installed vkBasalt/ReShade.
 */
const fs = require('node:fs')
const path = require('node:path')
const platform = require('./PlatformService.cjs')
const { isSteamDeck } = require('./realmlist.cjs')
const log = require('./logger.cjs')

const BUNDLED_ROOT = path.join(__dirname, '..', 'bin', 'graphics')
const OLK_RESHADE_MARKER = '; OLK-MANAGED'

function appendEnvList(existing, value, sep) {
  const parts = String(existing || '').split(sep).filter(Boolean)
  if (!parts.includes(value)) parts.push(value)
  return parts.join(sep)
}

/**
 * Copies a file using readFileSync + writeFileSync so it is 100% safe when reading from
 * inside an Electron app.asar archive on both Linux and Windows.
 */
function copyFileIfDifferent(src, dest, mode = null) {
  if (!fs.existsSync(src)) return false
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  let needsCopy = true
  try {
    const s1 = fs.statSync(src)
    const s2 = fs.statSync(dest)
    if (s1.size === s2.size) needsCopy = false
  } catch {}
  if (needsCopy) {
    const buf = fs.readFileSync(src)
    fs.writeFileSync(dest, buf)
  }
  if (mode !== null) {
    try { fs.chmodSync(dest, mode) } catch {}
  }
  return true
}

function syncDirMissing(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return
  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name)
    const dest = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      syncDirMissing(src, dest)
    } else if (entry.isFile() && !fs.existsSync(dest)) {
      fs.writeFileSync(dest, fs.readFileSync(src))
    }
  }
}

function buildVkBasaltConf(shadersDir, texturesDir) {
  return [
    '# ==============================================================================',
    '# OLK Plus Launcher — vkBasalt Configuration (auto-generated, sandboxed paths)',
    '# Pipeline: AMD FidelityFX CAS + SMAA Ultra + Curves + Clarity + Colourfulness + FakeHDR',
    '# Toggle in-game: F11',
    '# ==============================================================================',
    '',
    'effects = cas:smaa:curves:clarity:color:hdr',
    '',
    'casSharpness = 0.45',
    '',
    'smaaEdgeDetection = luma',
    'smaaThreshold = 0.05',
    'smaaMaxSearchSteps = 16',
    'smaaMaxSearchStepsDiagonal = 8',
    'smaaCornerRounding = 25',
    '',
    `curves = ${path.join(shadersDir, 'SweetFX', 'Curves.fx')}`,
    'Contrast = 0.180',
    'Formula = 1',
    'Mode = 2',
    '',
    `clarity = ${path.join(shadersDir, 'AstrayFX', 'Clarity.fx')}`,
    'ClarityStrength = 0.35',
    'ClarityDarkIntensity = 0.05',
    'ClarityRadius = 3',
    '',
    `color = ${path.join(shadersDir, 'Colourfulness.fx')}`,
    'colourfulness = 0.40',
    'lim_luma = 0.70',
    '',
    `hdr = ${path.join(shadersDir, 'SweetFX', 'FakeHDR.fx')}`,
    'HDRPower = 1.15',
    'radius1 = 0.793',
    'radius2 = 0.870',
    '',
    `reshadeIncludePath = ${shadersDir}`,
    `reshadeTexturePath = ${texturesDir}`,
    '',
    'toggleKey = F11',
    'enableOnLaunch = True',
    ''
  ].join('\n')
}

function buildWindowsReShadeIni(gameDir = null) {
  const winJoin = (base, ...segs) => {
    const cleanBase = String(base).replace(/[\\/]+$/, '')
    return [cleanBase, ...segs].join('\\')
  }
  const effectsPath = gameDir ? `${winJoin(gameDir, 'reshade-shaders', 'shaders')}\\**` : '.\\reshade-shaders\\shaders\\**'
  const texturesPath = gameDir ? `${winJoin(gameDir, 'reshade-shaders', 'textures')}\\**` : '.\\reshade-shaders\\textures\\**'
  const presetPath = gameDir ? winJoin(gameDir, 'ReShadePreset.ini') : '.\\ReShadePreset.ini'
  return [
    OLK_RESHADE_MARKER,
    '[GENERAL]',
    `EffectSearchPaths=${effectsPath}`,
    `TextureSearchPaths=${texturesPath}`,
    `PresetPath=${presetPath}`,
    'PresetTransitionDelay=0',
    'PerformanceMode=1',
    'NoReloadOnInit=0',
    'SkipLoadingDisabledEffects=1',
    '',
    '[INPUT]',
    'ForceShortcutModifiers=0',
    'InputProcessing=2',
    'KeyEffects=122,0,0,0',
    'KeyOverlay=36,0,0,0',
    'KeyReload=0,0,0,0',
    '',
    '[OVERLAY]',
    'ShowClock=0',
    'ShowFPS=0',
    'ShowFrameTime=0',
    'ShowScreenshotMessage=0',
    'TutorialProgress=4',
    ''
  ].join('\r\n')
}

function buildVkBasaltLayerManifest(libPath, libraryArch = null) {
  const layer = {
    name: 'VK_LAYER_VKBASALT_post_processing',
    type: 'GLOBAL',
    library_path: libPath,
    api_version: '1.3.223',
    implementation_version: '1',
    description: 'a post processing layer',
    functions: {
      vkGetInstanceProcAddr: 'vkBasalt_GetInstanceProcAddr',
      vkGetDeviceProcAddr: 'vkBasalt_GetDeviceProcAddr'
    },
    enable_environment: {
      ENABLE_VKBASALT: '1'
    },
    disable_environment: {
      DISABLE_VKBASALT: '1'
    }
  }
  if (libraryArch) {
    layer.library_arch = String(libraryArch)
  }
  return {
    file_format_version: libraryArch ? '1.2.1' : '1.0.0',
    layer
  }
}

/** Ensures the minimal preset shaders, textures and ReShadePreset.ini exist in <gameDir>. */
function ensurePresetShaders(gameDir, bundledRoot = BUNDLED_ROOT) {
  const shadersDest = path.join(gameDir, 'reshade-shaders', 'shaders')
  const texturesDest = path.join(gameDir, 'reshade-shaders', 'textures')
  syncDirMissing(path.join(bundledRoot, 'shaders'), shadersDest)
  syncDirMissing(path.join(bundledRoot, 'textures'), texturesDest)
  const presetSrc = path.join(bundledRoot, 'ReShadePreset.ini')
  const presetDest = path.join(gameDir, 'ReShadePreset.ini')
  if (fs.existsSync(presetSrc) && !fs.existsSync(presetDest)) {
    try { fs.writeFileSync(presetDest, fs.readFileSync(presetSrc)) } catch {}
  }
  return { shadersDest, texturesDest, presetDest }
}

/** Resolves whether post-processing filters should be active (null = auto: ON on desktop, OFF on Steam Deck). */
function shouldEnableFilters(graphicsCfg = {}, deck = isSteamDeck()) {
  if (graphicsCfg.useDxvk === false) return false
  if (typeof graphicsCfg.filtersEnabled === 'boolean') return graphicsCfg.filtersEnabled
  return !deck
}

/**
 * Prepares Linux graphics environment (DXVK + sandboxed vkBasalt F11 filters).
 * Supports both 64-bit WoW64 Wine (Arch/Archcraft/modern distros) and legacy 32-bit Wine.
 * Mutates `env` in place and returns a summary object for logging/testing.
 */
function prepareLinuxGraphics({ gameDir, dataDir, env, graphicsCfg = {}, bundledRoot = BUNDLED_ROOT, systemVkBasalt = null, deck = isSteamDeck(), wineArch = null }) {
  const useDxvk = graphicsCfg.useDxvk !== false
  const filtersOn = shouldEnableFilters(graphicsCfg, deck)

  if (!useDxvk) {
    env.WINEDLLOVERRIDES = 'winedbg.exe=d;d3d9,dxgi=b'
    env.ENABLE_VKBASALT = '0'
    env.DISABLE_VKBASALT = '1'
    return { useDxvk: false, filtersActive: false, mode: 'wined3d' }
  }

  env.WINEDLLOVERRIDES = 'winedbg.exe=d;d3d9,dxgi=n,b'

  if (!filtersOn) {
    env.ENABLE_VKBASALT = '0'
    env.DISABLE_VKBASALT = '1'
    return { useDxvk: true, filtersActive: false, mode: 'dxvk' }
  }

  try {
    const { shadersDest, texturesDest } = ensurePresetShaders(gameDir, bundledRoot)
    const requiredShader = path.join(shadersDest, 'SweetFX', 'Curves.fx')
    if (!fs.existsSync(requiredShader)) {
      env.ENABLE_VKBASALT = '0'
      env.DISABLE_VKBASALT = '1'
      return { useDxvk: true, filtersActive: false, mode: 'dxvk-no-shaders' }
    }

    const confPath = path.join(gameDir, '.olk-vkbasalt.conf')
    fs.writeFileSync(confPath, buildVkBasaltConf(shadersDest, texturesDest), 'utf8')

    const targetArch = wineArch === 'x64' || wineArch === 'x86' ? wineArch : null
    const sysVk = systemVkBasalt || platform.detectSystemVkBasalt({ arch: targetArch })
    delete env.DISABLE_VKBASALT
    env.ENABLE_VKBASALT = '1'
    env.VKBASALT_CONFIG_FILE = confPath

    if (sysVk.installed) {
      log.info(`Linux graphics filters enabled via system vkBasalt (F11 toggle, arch=${targetArch || 'auto'})`, confPath)
      return { useDxvk: true, filtersActive: true, mode: 'system-vkbasalt', arch: targetArch || 'auto', confPath }
    }

    // Deploy sandboxed vkBasalt Vulkan layer(s) (both 64-bit WoW64 and 32-bit) into <dataDir>/runtime/vkbasalt
    const linuxDir = path.join(bundledRoot, 'linux')
    const srcLib64 = path.join(linuxDir, 'libvkbasalt_x86_64.so')
    const srcLib32 = fs.existsSync(path.join(linuxDir, 'libvkbasalt_x86.so'))
      ? path.join(linuxDir, 'libvkbasalt_x86.so')
      : path.join(linuxDir, 'libvkbasalt.so')
    const hasSrc64 = fs.existsSync(srcLib64)
    const hasSrc32 = fs.existsSync(srcLib32)

    if ((targetArch === 'x64' && !hasSrc64) || (targetArch === 'x86' && !hasSrc32) || (!hasSrc64 && !hasSrc32)) {
      env.ENABLE_VKBASALT = '0'
      env.DISABLE_VKBASALT = '1'
      return { useDxvk: true, filtersActive: false, mode: 'vkbasalt-missing' }
    }

    const runtimeDir = path.join(dataDir, 'runtime', 'vkbasalt')
    const destLib64 = path.join(runtimeDir, 'libvkbasalt_x86_64.so')
    const destLib32 = path.join(runtimeDir, 'libvkbasalt_x86.so')
    if (hasSrc64) copyFileIfDifferent(srcLib64, destLib64, 0o755)
    if (hasSrc32) copyFileIfDifferent(srcLib32, destLib32, 0o755)

    // Place implicit layer manifests under <xdgBase>/vulkan/implicit_layer.d so BOTH
    // modern Vulkan Loader (VK_ADD_IMPLICIT_LAYER_PATH) and older Vulkan Loaders (XDG_DATA_DIRS)
    // discover the exact matching bitness without clobbering system explicit layers.
    const slot = targetArch || 'multi'
    const xdgBaseDir = path.join(runtimeDir, slot)
    const implicitLayerDir = path.join(xdgBaseDir, 'vulkan', 'implicit_layer.d')
    fs.mkdirSync(implicitLayerDir, { recursive: true })

    if (targetArch === 'x64') {
      const destJson = path.join(implicitLayerDir, 'vkBasalt.x86_64.json')
      fs.writeFileSync(destJson, JSON.stringify(buildVkBasaltLayerManifest(destLib64, null), null, 2), 'utf8')
    } else if (targetArch === 'x86') {
      const destJson = path.join(implicitLayerDir, 'vkBasalt.x86.json')
      fs.writeFileSync(destJson, JSON.stringify(buildVkBasaltLayerManifest(destLib32, null), null, 2), 'utf8')
    } else {
      if (hasSrc64) {
        fs.writeFileSync(
          path.join(implicitLayerDir, 'vkBasalt.x86_64.json'),
          JSON.stringify(buildVkBasaltLayerManifest(destLib64, '64'), null, 2),
          'utf8'
        )
      }
      if (hasSrc32) {
        fs.writeFileSync(
          path.join(implicitLayerDir, 'vkBasalt.x86.json'),
          JSON.stringify(buildVkBasaltLayerManifest(destLib32, '32'), null, 2),
          'utf8'
        )
      }
    }

    env.VK_ADD_IMPLICIT_LAYER_PATH = appendEnvList(env.VK_ADD_IMPLICIT_LAYER_PATH, implicitLayerDir, ':')
    const baseXdg = env.XDG_DATA_DIRS || '/usr/local/share:/usr/share'
    env.XDG_DATA_DIRS = appendEnvList(baseXdg, xdgBaseDir, ':')

    log.info(`Linux graphics filters enabled via bundled vkBasalt layer (F11 toggle, arch=${slot})`, { implicitLayerDir, confPath })
    return { useDxvk: true, filtersActive: true, mode: 'bundled-vkbasalt', arch: slot, confPath, runtimeDir, implicitLayerDir }
  } catch (err) {
    log.warn('could not configure Linux vkBasalt graphics filters, falling back to plain DXVK', err.message)
    env.ENABLE_VKBASALT = '0'
    env.DISABLE_VKBASALT = '1'
    return { useDxvk: true, filtersActive: false, mode: 'dxvk-fallback' }
  }
}

/**
 * Prepares Windows graphics environment (DXVK toggle + sandboxed ReShade 32-bit Vulkan layer with F11 toggle).
 * Mutates `env` in place and returns a summary object for logging/testing.
 */
function prepareWindowsGraphics({ gameDir, dataDir, env, graphicsCfg = {}, bundledRoot = BUNDLED_ROOT }) {
  const useDxvk = graphicsCfg.useDxvk !== false
  const filtersOn = shouldEnableFilters(graphicsCfg, false)

  const dxvkDll = path.join(gameDir, 'd3d9_orig.dll')
  const dxvkDisabled = path.join(gameDir, 'd3d9_orig.dll.dxvk-disabled')

  if (!useDxvk) {
    try {
      if (fs.existsSync(dxvkDll) && !fs.existsSync(dxvkDisabled)) {
        fs.renameSync(dxvkDll, dxvkDisabled)
        log.info('Disabled DXVK on Windows (d3d9_orig.dll -> d3d9_orig.dll.dxvk-disabled) for native D3D9 fallback')
      }
    } catch (err) {
      log.warn('could not disable Windows DXVK dll', err.message)
    }
    env.DISABLE_VK_LAYER_reshade_1 = '1'
    return { useDxvk: false, filtersActive: false, mode: 'native-d3d9' }
  }

  try {
    if (!fs.existsSync(dxvkDll) && fs.existsSync(dxvkDisabled)) {
      fs.renameSync(dxvkDisabled, dxvkDll)
      log.info('Restored DXVK on Windows (d3d9_orig.dll)')
    }
  } catch (err) {
    log.warn('could not restore Windows DXVK dll', err.message)
  }

  if (!filtersOn) {
    env.DISABLE_VK_LAYER_reshade_1 = '1'
    return { useDxvk: true, filtersActive: false, mode: 'dxvk' }
  }

  try {
    ensurePresetShaders(gameDir, bundledRoot)
    const srcDll = path.join(bundledRoot, 'win32', 'ReShade32.dll')
    const srcJson = path.join(bundledRoot, 'win32', 'ReShade32.json')
    if (!fs.existsSync(srcDll) || !fs.existsSync(srcJson)) {
      env.DISABLE_VK_LAYER_reshade_1 = '1'
      return { useDxvk: true, filtersActive: false, mode: 'reshade-missing' }
    }

    const runtimeDir = path.join(dataDir, 'runtime', 'reshade')
    const destDll = path.join(runtimeDir, 'ReShade32.dll')
    const destJson = path.join(runtimeDir, 'ReShade32.json')
    copyFileIfDifferent(srcDll, destDll)
    const layerManifest = JSON.parse(fs.readFileSync(srcJson, 'utf8'))
    layerManifest.layer.library_path = '.\\ReShade32.dll'
    fs.writeFileSync(destJson, JSON.stringify(layerManifest, null, 2), 'utf8')

    // Write ReShade.ini with absolute shader/preset paths to both <gameDir> (preserving manual
    // user configs) and <runtimeDir> (fallback if ReShade resolves ini next to ReShade32.dll).
    const iniContent = buildWindowsReShadeIni(gameDir)
    const iniPath = path.join(gameDir, 'ReShade.ini')
    let writeIni = !fs.existsSync(iniPath)
    if (!writeIni) {
      try {
        const cur = fs.readFileSync(iniPath, 'utf8')
        if (cur.startsWith(OLK_RESHADE_MARKER)) writeIni = true
      } catch {}
    }
    if (writeIni) {
      fs.writeFileSync(iniPath, iniContent, 'utf8')
    }
    try {
      fs.writeFileSync(path.join(runtimeDir, 'ReShade.ini'), iniContent, 'utf8')
    } catch {}

    delete env.DISABLE_VK_LAYER_reshade_1
    env.RESHADE_BASE_PATH_OVERRIDE = gameDir
    env.VK_ADD_IMPLICIT_LAYER_PATH = appendEnvList(env.VK_ADD_IMPLICIT_LAYER_PATH, runtimeDir, ';')
    env.VK_ADD_LAYER_PATH = appendEnvList(env.VK_ADD_LAYER_PATH, runtimeDir, ';')
    if (!env.VK_LAYER_PATH) env.VK_LAYER_PATH = runtimeDir
    env.VK_INSTANCE_LAYERS = appendEnvList(env.VK_INSTANCE_LAYERS, layerManifest.layer.name || 'VK_LAYER_reshade', ';')

    log.info('Windows graphics filters enabled via bundled ReShade32 Vulkan layer (F11 toggle)', { runtimeDir, iniPath })
    return { useDxvk: true, filtersActive: true, mode: 'bundled-reshade', runtimeDir, iniPath }
  } catch (err) {
    log.warn('could not configure Windows ReShade filters, falling back to plain DXVK', err.message)
    env.DISABLE_VK_LAYER_reshade_1 = '1'
    return { useDxvk: true, filtersActive: false, mode: 'dxvk-fallback' }
  }
}

module.exports = {
  BUNDLED_ROOT,
  OLK_RESHADE_MARKER,
  buildVkBasaltConf,
  buildVkBasaltLayerManifest,
  buildWindowsReShadeIni,
  ensurePresetShaders,
  shouldEnableFilters,
  prepareLinuxGraphics,
  prepareWindowsGraphics
}
