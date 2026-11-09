'use strict'
const path = require('node:path')
const { app, BrowserWindow, ipcMain, shell, safeStorage, dialog, screen } = require('electron')
const log = require('./core/logger.cjs')
const { toPlain, LauncherError } = require('./core/errors.cjs')
const { assertSafeUrl } = require('./core/pathSafety.cjs')
const { ConfigurationManager } = require('./core/ConfigurationManager.cjs')
const { ApiClient } = require('./core/ApiClient.cjs')
const { AuthenticationService } = require('./core/AuthenticationService.cjs')
const { ManifestService } = require('./core/ManifestService.cjs')
const { DownloadManager } = require('./core/DownloadManager.cjs')
const { InstallationManager } = require('./core/InstallationManager.cjs')
const { UpdateManager } = require('./core/UpdateManager.cjs')
const { GameLauncher } = require('./core/GameLauncher.cjs')
const { LauncherSelfUpdater } = require('./core/LauncherSelfUpdater.cjs')
const { LauncherController } = require('./core/LauncherController.cjs')

// Isolated data dir for automated end-to-end runs.
if (process.env.OLK_USER_DATA) app.setPath('userData', process.env.OLK_USER_DATA)

const VERSION = app.getVersion()
const isDev = !app.isPackaged && !!process.env.OLK_DEV_SERVER

if (!app.requestSingleInstanceLock()) app.quit()

let win = null
let controller = null

function createServices() {
  const dataDir = app.getPath('userData')
  log.init(path.join(dataDir, 'logs'))
  log.info(`OLK Plus Launcher ${VERSION} on ${process.platform}/${process.arch}`)
  const config = new ConfigurationManager({ defaultsFile: path.join(__dirname, '..', 'config', 'defaults.json'), dataDir })
  const api = new ApiClient({ config, launcherVersion: VERSION })
  const auth = new AuthenticationService({ api, dataDir, secureStore: safeStorage, platform: process.platform, launcherVersion: VERSION })
  const manifests = new ManifestService({ api, auth, launcherVersion: VERSION, config })
  const downloader = new DownloadManager()
  const installer = new InstallationManager({ config })
  const updater = new UpdateManager({ config, installer, downloader })
  const game = new GameLauncher({ config, installer })
  const selfUpdater = new LauncherSelfUpdater({ config, api, manifests, downloader, launcherVersion: VERSION })
  controller = new LauncherController({
    config, api, auth, manifests, downloader, installer, updater, game, selfUpdater,
    emit: (channel, payload) => {
      win?.webContents.send(`olk:${channel}`, payload)
      if (channel === 'game-exit') {
        try { win?.show(); if (win?.isMinimized()) win.restore(); win?.focus() } catch {}
      }
    }
  })
}

function createWindow() {
  let targetW = 1180
  let targetH = 720
  let minW = 860
  let minH = 500

  try {
    const primary = screen.getPrimaryDisplay()
    const work = primary.workAreaSize || primary.size
    if (work && work.width && work.height) {
      // In SteamOS Desktop Mode (800p) or compact displays, keep height well clear of the taskbar
      const maxAllowedH = work.height <= 850 ? Math.min(600, work.height - 50) : 720
      const maxAllowedW = work.width <= 1300 ? Math.min(1080, work.width - 40) : 1180
      targetW = Math.max(860, maxAllowedW)
      targetH = Math.max(480, maxAllowedH)
      minW = Math.min(840, work.width)
      minH = Math.min(480, work.height)
    }
  } catch (err) {
    log.warn('could not determine workAreaSize', err?.message)
  }

  win = new BrowserWindow({
    width: targetW,
    height: targetH,
    minWidth: minW,
    minHeight: minH,
    center: true,
    frame: false,
    backgroundColor: '#060b12',
    show: false,
    title: 'OLK Plus Launcher',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })
  win.once('ready-to-show', () => win.show())
  // No navigation away from the app, no popups: external links go to the system browser.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (isDev) win.loadURL(process.env.OLK_DEV_SERVER)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

/** Wraps handlers so errors cross IPC as { ok:false, error:{code,message} }. */
function handle(channel, fn) {
  ipcMain.handle(`olk:${channel}`, async (event, ...args) => {
    if (event.senderFrame?.url && !/^(file:|http:\/\/localhost)/.test(event.senderFrame.url)) return { ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } }
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err) {
      return { ok: false, error: toPlain(err) }
    }
  })
}

function registerIpc() {
  handle('state', () => controller.snapshot())
  handle('login', (creds) => controller.login({ username: creds?.username, password: creds?.password, remember: !!creds?.remember }))
  handle('savePasswordForAutoLogin', (pwd) => controller.savePasswordForAutoLogin(String(pwd)))
  handle('logout', () => controller.logout())
  handle('checkApi', () => controller.checkApi())
  handle('selectClient', (id) => controller.updateSettings({ selectedClient: String(id) }))
  handle('install', (id) => controller.install(String(id)))
  handle('update', (id) => controller.update(String(id)))
  handle('repair', (id) => controller.update(String(id), { repair: true }))
  handle('cancel', () => controller.cancel())
  handle('play', async (id) => {
    const res = await controller.play(String(id))
    try { win?.minimize() } catch {}
    return res
  })
  handle('installWine', () => controller.installWine())
  handle('detectWineCandidates', () => controller.detectWineCandidates())
  handle('resetWinePrefix', () => controller.resetWinePrefix())
  handle('clearError', (id) => controller.clearError(String(id)))
  handle('saveSettings', (patch) => controller.updateSettings(patch))
  handle('openGameFolder', async (id) => {
    const dir = controller.config.clientDir(String(id))
    const err = await shell.openPath(require('node:fs').existsSync(dir) ? dir : controller.config.get().installDir)
    if (err) throw new LauncherError('OPEN_FAILED', err)
  })
  handle('openLogs', () => shell.openPath(path.dirname(log.file)))
  handle('openWebsite', () => {
    const url = controller.config.get().websiteUrl
    if (!url) throw new LauncherError('NOT_CONFIGURED', 'Website URL is not configured.')
    assertSafeUrl(url, { allowHttpLocalhost: false })
    return shell.openExternal(url)
  })
  handle('locate', async (id) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Select the folder where the game is installed (the one with Wow.exe)',
      properties: ['openDirectory']
    })
    if (r.canceled || !r.filePaths[0]) return null
    return controller.locate(String(id), r.filePaths[0])
  })
  handle('pickFolder', async (title) => {
    const r = await dialog.showOpenDialog(win, { title: String(title || 'Select folder'), properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('pickFile', async (title) => {
    const r = await dialog.showOpenDialog(win, { title: String(title || 'Select file'), properties: ['openFile'] })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('window', (action) => {
    if (action === 'minimize') win.minimize()
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
    else if (action === 'close') win.close()
  })
  handle('version', () => VERSION)
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })
app.on('window-all-closed', () => {
  controller?.stopPeriodicCheck?.()
  controller?.cancel()
  app.quit()
})

app.whenReady().then(async () => {
  createServices()
  registerIpc()
  createWindow()
  controller.init().catch((err) => log.error('init failed', err))
})
