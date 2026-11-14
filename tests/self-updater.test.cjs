'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpDir, makeConfig, makeZip, realisticEntries } = require('./helpers.cjs')
const { InstallationManager } = require('../electron/core/InstallationManager.cjs')
const { GameLauncher } = require('../electron/core/GameLauncher.cjs')
const { LauncherSelfUpdater } = require('../electron/core/LauncherSelfUpdater.cjs')

test('auto-login sets accountName in Config.wtf and passes password to digita.exe', async () => {
  const data = tmpDir()
  const config = makeConfig(data)
  const installer = new InstallationManager({ config })
  const zip = path.join(data, 'pkg.zip')
  await makeZip(zip, realisticEntries())
  await installer.installFromZip({ id: 'wow32', zipPath: zip })
  const dir = config.clientDir('wow32')

  // Create a dummy digita.exe so launcher finds it
  fs.writeFileSync(path.join(dir, 'digita.exe'), 'dummy')

  const spawned = []
  const spawnImpl = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts })
    const { spawn } = require('node:child_process')
    return spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })
  }

  const launcher = new GameLauncher({ config, installer, spawnImpl, platformName: 'win32' })
  await launcher.launch('wow32', { credentials: { username: 'arthas', password: 'frostmourne123' } })

  // Verify Config.wtf has accountName and accountList AUTOLOGIN
  const cfgPath = path.join(dir, 'WTF', 'Config.wtf')
  const cfgContent = fs.readFileSync(cfgPath, 'utf8')
  assert.match(cfgContent, /SET accountName "arthas"/)
  assert.match(cfgContent, /SET accountList "AUTOLOGIN:frostmourne123"/)

  // Verify Interface/GlueXML/AccountLogin.lua was deployed
  assert.ok(fs.existsSync(path.join(dir, 'Interface', 'GlueXML', 'AccountLogin.lua')))

  // Verify digita.exe was spawned with the password
  const digitaCall = spawned.find(s => s.cmd.endsWith('digita.exe'))
  assert.ok(digitaCall, 'digita.exe should be spawned')
  assert.deepEqual(digitaCall.args, ['frostmourne123'])
})

test('LauncherSelfUpdater: detects newer version and downloads update', async () => {
  const data = tmpDir()
  const config = makeConfig(data)

  const fakeManifest = {
    version: '0.2.0',
    linux: { url: 'https://example.com/update.AppImage', size: 123 },
    win32: { url: 'https://example.com/update.exe', size: 123 }
  }

  const manifests = {
    fetchLauncherManifest: async () => fakeManifest
  }

  let downloaded = false
  const downloader = {
    download: async (opts) => {
      downloaded = true
      fs.writeFileSync(opts.dest, 'fake update payload')
    }
  }

  const updater = new LauncherSelfUpdater({
    config,
    api: {},
    manifests,
    downloader,
    launcherVersion: '0.1.1'
  })

  let progressReported = false
  const result = await updater.checkAndApplyUpdate({
    onProgress: () => { progressReported = true }
  })

  assert.equal(result.updateAvailable, true)
  assert.equal(result.devMode, true) // running in non-packaged mode
  assert.equal(downloaded, true)
  assert.equal(progressReported, true)
})

test('AuthenticationService preserves password across refresh and restore', async () => {
  const data = tmpDir()
  const fakeStore = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s, 'utf8'),
    decryptString: (b) => b.toString('utf8')
  }
  let refreshCount = 0
  const fakeApi = {
    request: async (method, path, opts) => {
      if (path === '/auth/login') {
        return { access_token: 'acc-1', expires_in: 900, refresh_token: 'ref-1', refresh_expires_in: 86400, user: { id: 1, username: 'TESTUSER' } }
      }
      if (path === '/auth/refresh') {
        refreshCount++
        return { access_token: `acc-${refreshCount}`, expires_in: 900, refresh_token: `ref-${refreshCount}`, user: { id: 1, username: 'TESTUSER' } }
      }
      throw new Error(`Unexpected path: ${path}`)
    }
  }

  const { AuthenticationService } = require('../electron/core/AuthenticationService.cjs')
  const auth = new AuthenticationService({ api: fakeApi, dataDir: data, secureStore: fakeStore, platform: 'linux', launcherVersion: '0.1.3' })
  await auth.login({ username: 'TESTUSER', password: 'SecretPassword123', remember: true })
  assert.equal(auth.password, 'SecretPassword123')

  // Refresh token should keep the password in memory and disk
  await auth.refresh()
  assert.equal(auth.password, 'SecretPassword123')

  // Restore in a fresh AuthenticationService instance
  const auth2 = new AuthenticationService({ api: fakeApi, dataDir: data, secureStore: fakeStore, platform: 'linux', launcherVersion: '0.1.3' })
  const user = await auth2.restore()
  assert.equal(user.username, 'TESTUSER')
  assert.equal(auth2.password, 'SecretPassword123')
})

test('AuthenticationService machine fallback on SteamOS Game Mode (isEncryptionAvailable returns false)', async () => {
  const data = tmpDir()
  const noKeyringStore = {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('Keyring unavailable') },
    decryptString: () => { throw new Error('Keyring unavailable') }
  }
  const fakeApi = {
    request: async (method, path) => {
      if (path === '/auth/login') return { access_token: 'acc-deck', expires_in: 900, refresh_token: 'ref-deck', user: { id: 2, username: 'DECKUSER' } }
      if (path === '/auth/refresh') return { access_token: 'acc-deck-ref', expires_in: 900, refresh_token: 'ref-deck-2', user: { id: 2, username: 'DECKUSER' } }
      throw new Error(`Unexpected path: ${path}`)
    }
  }

  const { AuthenticationService } = require('../electron/core/AuthenticationService.cjs')
  const auth = new AuthenticationService({ api: fakeApi, dataDir: data, secureStore: noKeyringStore, platform: 'linux', launcherVersion: '0.1.4' })
  await auth.login({ username: 'DECKUSER', password: 'DeckPassword!', remember: true })
  assert.equal(auth.password, 'DeckPassword!')

  // Check file exists on disk and is encrypted (not plain text)
  const raw = fs.readFileSync(path.join(data, 'session.bin'))
  assert.ok(!raw.toString().includes('DeckPassword!'), 'file should be encrypted')
  assert.ok(!raw.toString().includes('ref-deck'), 'refresh token should be encrypted')

  // Restore in a new instance with no keyring available
  const auth2 = new AuthenticationService({ api: fakeApi, dataDir: data, secureStore: noKeyringStore, platform: 'linux', launcherVersion: '0.1.4' })
  const user = await auth2.restore()
  assert.equal(user.username, 'DECKUSER')
  assert.equal(auth2.password, 'DeckPassword!')
  assert.ok(auth2.isAuthenticated())
})

test('AuthenticationService migrates legacy safeStorage session to machine fallback across Desktop -> Gaming Mode', async () => {
  const data = tmpDir()
  const legacyStore = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`LEGACY_KEYRING:${s}`, 'utf8'),
    decryptString: (b) => {
      const s = b.toString('utf8')
      if (!s.startsWith('LEGACY_KEYRING:')) throw new Error('Not legacy keyring data')
      return s.slice('LEGACY_KEYRING:'.length)
    }
  }
  const noKeyringStore = {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('Keyring unavailable in Gaming Mode') },
    decryptString: () => { throw new Error('Keyring unavailable in Gaming Mode') }
  }
  const fakeApi = {
    request: async (method, path) => {
      if (path === '/auth/refresh') return { access_token: 'acc-migrated', expires_in: 900, refresh_token: 'ref-migrated-2', user: { id: 3, username: 'MIGRATED' } }
      throw new Error(`Unexpected path: ${path}`)
    }
  }

  // Simula arquivo antigo gerado no Desktop Mode com safeStorage
  const payload = JSON.stringify({ refreshToken: 'ref-migrated', user: { id: 3, username: 'MIGRATED' }, password: 'MigratedSecret!' })
  fs.writeFileSync(path.join(data, 'session.bin'), legacyStore.encryptString(payload))

  const { AuthenticationService } = require('../electron/core/AuthenticationService.cjs')
  // 1. Abre no Desktop Mode: restaura e auto-migra para fallbackEncrypt
  const authDesktop = new AuthenticationService({ api: fakeApi, dataDir: data, secureStore: legacyStore, platform: 'linux', launcherVersion: '0.1.5' })
  const userDesktop = await authDesktop.restore()
  assert.equal(userDesktop.username, 'MIGRATED')
  assert.equal(authDesktop.password, 'MigratedSecret!')

  // O arquivo agora deve ter sido migrado e começar com SLKP_ENC1
  const migratedBytes = fs.readFileSync(path.join(data, 'session.bin'))
  assert.equal(migratedBytes.subarray(0, 9).toString('utf8'), 'SLKP_ENC1')

  // 2. Abre no Gaming Mode (sem keyring): restaura com sucesso graças à migração
  const authGameMode = new AuthenticationService({ api: fakeApi, dataDir: data, secureStore: noKeyringStore, platform: 'linux', launcherVersion: '0.1.5' })
  const userGameMode = await authGameMode.restore()
  assert.equal(userGameMode.username, 'MIGRATED')
  assert.equal(authGameMode.password, 'MigratedSecret!')
  assert.ok(authGameMode.isAuthenticated())
})

test('LauncherController play() triggers update first if updateAvailable is true', async () => {
  const { LauncherController } = require('../electron/core/LauncherController.cjs')
  let updateCalled = false
  let launchCalled = false

  const fakeInstaller = {
    verify: () => ({ installed: true, state: { version: '1.0.0' } }),
    ensureRealmlist: () => {}
  }
  const fakeConfig = {
    get: () => ({ clients: { wow32: { available: true } }, selectedClient: 'wow32', wine: {} }),
    client: () => ({ available: true, name: 'WoW', architecture: 'x86' }),
    clientDir: () => '/fake/dir'
  }
  const fakeGame = {
    isRunning: () => false,
    launch: async () => { launchCalled = true }
  }
  const fakeUpdater = {}
  const fakeController = new LauncherController({
    config: fakeConfig,
    api: { lastStatus: { state: 'online' } },
    auth: { user: { username: 'test' }, password: 'pwd', isAuthenticated: () => true },
    manifests: {},
    downloader: {},
    installer: fakeInstaller,
    updater: fakeUpdater,
    game: fakeGame
  })

  // Manifest cache with a higher version
  fakeController.manifestCache['wow32'] = { manifest: { version: '1.0.1' } }
  assert.equal(fakeController.clientState('wow32').updateAvailable, true)

  // Mock update method
  fakeController.update = async (id) => { updateCalled = true; return id }

  await fakeController.play('wow32')
  assert.equal(updateCalled, true, 'update should have been called first')
  assert.equal(launchCalled, false, 'game should NOT have launched directly')
})

test('PlatformService cleanEnvForSystemBinary strips gameoverlayrenderer and wineVersion is fast', async () => {
  const { cleanEnvForSystemBinary, wineVersion } = require('../electron/core/PlatformService.cjs')
  const dirtyEnv = {
    LD_PRELOAD: '/home/deck/.local/share/Steam/ubuntu12_32/gameoverlayrenderer.so:/opt/other/lib.so:/home/deck/.local/share/Steam/ubuntu12_64/gameoverlayrenderer.so:steam-chat.so',
    PATH: '/usr/bin:/bin'
  }
  const cleaned = cleanEnvForSystemBinary(dirtyEnv)
  assert.equal(cleaned.LD_PRELOAD, '/opt/other/lib.so')

  const dirtyAllSteam = {
    LD_PRELOAD: '/home/deck/.local/share/Steam/ubuntu12_32/gameoverlayrenderer.so'
  }
  const cleanedAllSteam = cleanEnvForSystemBinary(dirtyAllSteam)
  assert.equal(cleanedAllSteam.LD_PRELOAD, undefined)

  const t0 = Date.now()
  const res = await wineVersion('/non/existent/path/wine')
  assert.equal(res, null)
  assert.ok(Date.now() - t0 < 50, 'non existent path should return null almost immediately')
})

test('PlatformService detectWine ignores Proton steamapps runners and realmlist forces windowed mode', async () => {
  const { detectWine } = require('../electron/core/PlatformService.cjs')
  const { applyRealmlist } = require('../electron/core/realmlist.cjs')
  const os = require('node:os')
  const fs = require('node:fs')
  const path = require('node:path')

  // 1. detectWine must ignore configuredPath pointing to Steam Proton
  const fakeProtonPath = '/home/deck/.local/share/Steam/steamapps/common/Proton 9.0 (Beta)/dist/bin/wine'
  const det = await detectWine(fakeProtonPath, 'linux', [])
  assert.notEqual(det.path, fakeProtonPath, 'Proton steamapps path must never be selected by detectWine')

  // 2. applyRealmlist forces gxWindow "1" and gxMaximize "0" and scriptErrors "0"
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'olk-realmlist-test-'))
  try {
    fs.mkdirSync(path.join(tmpDir, 'Data', 'enUS'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'WTF'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'WTF', 'Config.wtf'), 'SET gxMaximize "1"\r\nSET gxWindow "0"\r\nSET scriptErrors "1"\r\nSET windowResizeLock "1"\r\n')
    const savedDeck = process.env.SteamDeck
    process.env.SteamDeck = '1' // a janela 1280x800 só é imposta no Steam Deck
    try {
      applyRealmlist(tmpDir, '127.0.0.1:3724', 'enUS', 'ADMIN')
    } finally {
      if (savedDeck === undefined) delete process.env.SteamDeck; else process.env.SteamDeck = savedDeck
    }
    const finalWtf = fs.readFileSync(path.join(tmpDir, 'WTF', 'Config.wtf'), 'utf8')
    assert.match(finalWtf, /SET gxWindow "1"/, 'gxWindow must be 1')
    assert.match(finalWtf, /SET gxMaximize "0"/, 'gxMaximize must be 0')
    assert.match(finalWtf, /SET scriptErrors "0"/, 'scriptErrors must be 0')
    assert.ok(!finalWtf.includes('SET gxMaximize "1"'), 'gxMaximize 1 must not remain')
    assert.ok(!finalWtf.includes('SET gxWindow "0"'), 'gxWindow 0 must not remain')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('cleanEnvForSystemBinary makes the Game Mode environment equal to Desktop Mode (no steam-runtime libs)', () => {
  const { cleanEnvForSystemBinary } = require('../electron/core/PlatformService.cjs')
  const rt = '/home/deck/.local/share/Steam/ubuntu12_32/steam-runtime'
  const cleaned = cleanEnvForSystemBinary({
    LD_LIBRARY_PATH: `${rt}/pinned_libs_32:${rt}/pinned_libs_64:/usr/lib:/usr/lib32:${rt}/lib/i386-linux-gnu:${rt}/usr/lib/x86_64-linux-gnu:/home/deck/.local/share/Steam/ubuntu12_64`,
    PATH: `${rt}/amd64/bin:${rt}/amd64/usr/bin:/usr/bin:/bin`,
    LD_PRELOAD: '/home/deck/.local/share/Steam/ubuntu12_32/gameoverlayrenderer.so:/home/deck/.local/share/Steam/ubuntu12_64/gameoverlayrenderer.so',
    SteamGameId: '123456', DISPLAY: ':1'
  })
  assert.equal(cleaned.LD_LIBRARY_PATH, '/usr/lib:/usr/lib32')
  assert.equal(cleaned.PATH, '/usr/bin:/bin')
  assert.equal(cleaned.LD_PRELOAD, undefined)
  assert.equal(cleaned.SteamGameId, '123456', 'Steam identity must stay: gamescope uses it to show the window')
  assert.equal(cleaned.DISPLAY, ':1')
  assert.equal(cleanEnvForSystemBinary({ LD_LIBRARY_PATH: `${rt}/lib/i386-linux-gnu` }).LD_LIBRARY_PATH, undefined)
})

test('detectWine keeps the launcher own Wine even when "--version" does not answer', async () => {
  const { detectWine } = require('../electron/core/PlatformService.cjs')
  const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olk-wine-'))
  try {
    const internal = path.join(dir, 'runtime', 'wine', 'bin', 'wine')
    fs.mkdirSync(path.dirname(internal), { recursive: true })
    fs.writeFileSync(internal, '#!/bin/sh\nexit 1\n', { mode: 0o755 }) // prints nothing, fails
    const det = await detectWine(null, 'linux', [internal])
    assert.equal(det.found, true)
    assert.equal(det.path, internal)
    assert.equal(det.isInternal, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
