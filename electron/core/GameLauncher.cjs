'use strict'
/**
 * GameLauncher — starts the installed client.
 *  Windows: runs <game>/<executable> directly, cwd = game folder.
 *  Linux/macOS: runs it through Wine with a dedicated WINEPREFIX (no terminal needed).
 * Refuses to start a second copy of the same client while one is running.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFile } = require('node:child_process')
const { LauncherError } = require('./errors.cjs')
const { resolveInside } = require('./pathSafety.cjs')
const platform = require('./PlatformService.cjs')
const log = require('./logger.cjs')

class GameLauncher {
  constructor({ config, installer, spawnImpl, platformName }) {
    this.config = config
    this.installer = installer
    this.spawn = spawnImpl || spawn
    this.platform = platformName || platform.platform
    this.running = new Map() // clientId -> ChildProcess
  }

  isRunning(id) { return this.running.has(id) }

  #wineboot(winePath, env) {
    return new Promise((resolve, reject) => {
      log.info('initialising wine prefix', env.WINEPREFIX)
      execFile(winePath, ['wineboot', '--init'], { env: { ...env, WINEDLLOVERRIDES: 'mscoree,mshtml=' }, timeout: 300_000 }, (err) => {
        if (err && !fs.existsSync(path.join(env.WINEPREFIX, 'drive_c'))) return reject(new LauncherError('WINE_PREFIX_FAILED', `Could not prepare the Wine prefix: ${err.message}`))
        resolve()
      })
    })
  }

  /**
   * SoderPad.exe turns a controller into keys for the 3.3.5a client on Windows.
   * On Linux / Steam Deck, Steam Input provides native controller emulation;
   * running SoderPad under Wine causes axis conflicts, mouse locking, and vkBasalt F11 stalls.
   */
  #startControllerReader(dir, command, env) {
    if (this.platform !== 'win32') return
    let reader = path.join(dir, 'SoderPad.exe')
    if (!fs.existsSync(reader)) {
      const bundled = path.join(__dirname, '..', 'bin', 'SoderPad.exe')
      if (fs.existsSync(bundled)) {
        try { fs.copyFileSync(bundled, reader) } catch (e) { log.warn('could not copy bundled SoderPad.exe', e.message) }
      }
    }
    if (!fs.existsSync(reader)) return
    try {
      const proc = this.spawn(reader, [], {
        cwd: dir, env, detached: true, stdio: 'ignore', windowsHide: true,
      })
      proc.once('error', (err) => log.warn(`controller reader did not start: ${err.message}`))
      proc.unref()
    } catch (err) {
      log.warn(`controller reader did not start: ${err.message}`)
    }
  }

  /**
   * digita.exe types the player's password and hits Enter when the WoW login window appears.
   * Enables seamless single sign-on from the launcher into the 3.3.5a client.
   */
  #startAutoLogin(dir, command, env, password) {
    if (!password) return
    let helper = path.join(dir, 'digita.exe')
    if (!fs.existsSync(helper)) {
      const bundled = path.join(__dirname, '..', 'bin', 'digita.exe')
      if (fs.existsSync(bundled)) {
        try { fs.copyFileSync(bundled, helper) } catch (e) { log.warn('could not copy bundled digita.exe', e.message) }
      }
    }
    if (!fs.existsSync(helper)) return
    try {
      const wine = this.platform !== 'win32'
      const proc = this.spawn(wine ? command : helper, wine ? [helper, password] : [password], {
        cwd: dir, env, detached: true, stdio: 'ignore', windowsHide: true,
      })
      proc.once('error', (err) => log.warn(`autologin did not start: ${err.message}`))
      proc.unref()
    } catch (err) {
      log.warn(`autologin did not start: ${err.message}`)
    }
  }

  /** @returns {Promise<{ pid: number, command: string }>} */
  async launch(id, { onExit, onStatus, credentials } = {}) {
    if (this.running.has(id)) throw new LauncherError('ALREADY_RUNNING', 'The game is already running.')
    const client = this.config.client(id)
    const v = this.installer.verify(id)
    if (!v.installed) throw new LauncherError('NOT_INSTALLED', v.missing.length ? `Installation is incomplete (${v.missing.join(', ')}). Use Repair.` : 'The game is not installed.')
    this.installer.ensureRealmlist(id, credentials?.username)

    const dir = this.config.clientDir(id)
    const exe = resolveInside(dir, client.executable)
    let command = exe
    let args = []
    const env = { ...process.env }

    if (this.platform !== 'win32') {
      const cfg = this.config.get()
      const internalWine = path.join(this.config.dataDir, 'runtime', 'wine', 'bin', 'wine')
      const wine = await platform.detectWine(cfg.wine.path, this.platform, [internalWine])
      if (!wine.found) throw new LauncherError('WINE_MISSING', 'Wine is required to run the game on this system. Install it (e.g. "sudo pacman -S wine" or "sudo apt install wine") or set its path in Settings.')
      const prefix = cfg.wine.prefix || path.join(this.config.dataDir, 'wineprefix')
      fs.mkdirSync(prefix, { recursive: true })
      command = wine.path
      args = [exe]

      const wineBinDir = path.dirname(wine.path)
      const wineRootDir = path.dirname(wineBinDir)
      const wineLibDir = path.join(wineRootDir, 'lib')
      env.PATH = `${wineBinDir}:${env.PATH || ''}`
      env.LD_LIBRARY_PATH = `${wineLibDir}:${env.LD_LIBRARY_PATH || ''}`
      env.WINEPREFIX = prefix
      env.WINEDEBUG = env.WINEDEBUG || '-all'
      if (client.architecture === 'x86') env.WINEARCH = env.WINEARCH || 'win64' // modern Wine runs 32-bit apps in a win64 prefix (WoW64)
      // The package ships DXVK (d3d9.dll/dxgi.dll): make Wine prefer them.
      env.WINEDLLOVERRIDES = env.WINEDLLOVERRIDES || 'd3d9,dxgi=n,b'
      // First run: create the prefix before starting the game (racing wineboot breaks RpcSs).
      if (!fs.existsSync(path.join(prefix, 'drive_c'))) {
        onStatus?.('Preparing Wine (first run, this can take a minute)…')
        await this.#wineboot(wine.path, env)
      }
    }

    log.info(`launching ${id}: ${command} ${args.join(' ')}`)
    const child = await new Promise((resolve, reject) => {
      let proc
      try {
        proc = this.spawn(command, args, { cwd: dir, env, detached: true, stdio: 'ignore', windowsHide: false })
      } catch (err) {
        return reject(new LauncherError('LAUNCH_FAILED', `Could not start the game: ${err.message}`))
      }
      proc.once('error', (err) => reject(new LauncherError('LAUNCH_FAILED', `Could not start the game: ${err.message}`)))
      proc.once('spawn', () => resolve(proc))
    })
    this.running.set(id, child)
    child.once('exit', (code) => {
      this.running.delete(id)
      log.info(`${id} exited with code ${code}`)
      onExit?.(code)
    })
    child.unref()
    if (this.platform !== 'win32') {
      try { this.spawn('pkill', ['-9', '-f', 'SoderPad.exe'], { stdio: 'ignore' }) } catch {}
      const stalePad = path.join(dir, 'SoderPad.exe')
      if (fs.existsSync(stalePad)) {
        try { fs.unlinkSync(stalePad) } catch {}
      }
    }
    this.#startControllerReader(dir, command, env)
    this.#startAutoLogin(dir, command, env, credentials?.password)
    return { pid: child.pid, command: path.basename(command) }
  }
}

module.exports = { GameLauncher }
