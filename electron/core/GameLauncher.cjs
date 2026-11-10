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
const { isSteamDeck } = require('./realmlist.cjs')
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
   * No Linux / SteamOS (Modo Desktop ou Gaming), o driver hid-steam suprime os eventos evdev
   * do controle integrado quando o Steam está aberto (mapeando apenas o direcional direito como mouse X11),
   * ou o Wine falha ao abrir os dispositivos XInput no container.
   * Esta ponte lê diretamente /dev/hidraw* (Valve Steam Deck 28de:1205), /dev/input/js* e /dev/input/event*
   * sem precisar de permissões root e publica o estado XInput em /dev/shm/soderpad_state.bin para o SoderPad.exe.
   */
  #startLinuxInputBridge(dir, parentChild) {
    if (this.platform === 'win32') return
    const shmPath = '/dev/shm/soderpad_state.bin'
    const fallbackPath = path.join(dir, 'soderpad_state.bin')
    const fds = new Map() // path -> { fd, type }
    const state = {
      btn: new Uint8Array(16),
      lx: 0.0, ly: 0.0, rx: 0.0, ry: 0.0,
      lt: 0, rt: 0,
      seq: 0,
      active: false,
    }
    const outBuf = Buffer.alloc(48)
    const readBuf = Buffer.alloc(256)

    const writeState = () => {
      state.seq = (state.seq + 1) >>> 0
      outBuf.fill(0)
      outBuf.writeUInt32LE(0x53504144, 0) // 'SPAD'
      outBuf.writeUInt32LE(state.seq, 4)
      outBuf.writeUInt32LE((state.active || fds.size > 0) ? 1 : 0, 8)
      for (let i = 0; i < 16; i++) {
        outBuf.writeUInt8(state.btn[i] ? 1 : 0, 12 + i)
      }
      outBuf.writeUInt8(state.lt ? 1 : 0, 28)
      outBuf.writeUInt8(state.rt ? 1 : 0, 29)
      outBuf.writeUInt16LE(0, 30) // reserved
      outBuf.writeFloatLE(state.lx, 32)
      outBuf.writeFloatLE(state.ly, 36)
      outBuf.writeFloatLE(state.rx, 40)
      outBuf.writeFloatLE(state.ry, 44)
      try { fs.writeFileSync(shmPath, outBuf) } catch {}
      try { fs.writeFileSync(fallbackPath, outBuf) } catch {}
    }

    let hasSteamDeckHid = false
    const scanDevices = () => {
      // 1. Steam Deck hidraw (28de:1205)
      try {
        const hidraws = fs.readdirSync('/sys/class/hidraw')
        for (const h of hidraws) {
          const devPath = `/dev/${h}`
          if (fds.has(devPath)) { hasSteamDeckHid = true; continue; }
          try {
            const uevent = fs.readFileSync(`/sys/class/hidraw/${h}/device/uevent`, 'utf8')
            if (/28DE:00001205|28de:1205/i.test(uevent)) {
              const fd = fs.openSync(devPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
              fds.set(devPath, { fd, type: 'steamdeck-hidraw' })
              hasSteamDeckHid = true
              log.info(`LinuxInputBridge: attached Steam Deck hidraw ${devPath}`)
            }
          } catch {}
        }
      } catch {}

      // Se o Steam Deck hidraw já foi capturado, não anexa joydev ou evdev do próprio Deck
      // para evitar que leituras duplicadas com mapeamentos conflitantes sobrescrevam o estado.
      if (!hasSteamDeckHid) {
        // 2. Linux joydev (/dev/input/js0..3)
        for (let i = 0; i < 4; i++) {
          const devPath = `/dev/input/js${i}`
          if (fds.has(devPath) || !fs.existsSync(devPath)) continue
          try {
            const fd = fs.openSync(devPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
            fds.set(devPath, { fd, type: 'joydev' })
            log.info(`LinuxInputBridge: attached joydev ${devPath}`)
          } catch {}
        }

        // 3. Linux evdev (/dev/input/event*) para gamepads
        try {
          const inputs = fs.readdirSync('/sys/class/input')
          for (const item of inputs) {
            if (!item.startsWith('event')) continue
            const devPath = `/dev/input/${item}`
            if (fds.has(devPath)) continue
            try {
              const name = fs.readFileSync(`/sys/class/input/${item}/device/name`, 'utf8').trim()
              const evCap = fs.readFileSync(`/sys/class/input/${item}/device/capabilities/ev`, 'utf8').trim()
              const evMask = parseInt(evCap, 16)
              const isPadName = /steam|deck|xbox|x-box|pad|controller|gamepad|dualshock|dualsense|8bitdo|generic\s+x-box/i.test(name)
              const isNotMouseOrKb = !/mouse|touchpad|trackpad|keyboard|power\s+button|sleep|video\s+bus|hdpi|audio|alsa|hdmi|lid/i.test(name)
              if ((isPadName || ((evMask & 0x0b) === 0x0b)) && isNotMouseOrKb) {
                const fd = fs.openSync(devPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
                fds.set(devPath, { fd, type: 'evdev' })
                log.info(`LinuxInputBridge: attached evdev ${devPath} (${name})`)
              }
            } catch {}
          }
        } catch {}
      }
    }

    const parseSteamDeckHid = (buf, len) => {
      if (len < 64 || buf[0] !== 0x01 || buf[2] !== 0x09) return false
      const b8 = buf[8]
      const b9 = buf[9]
      const b10 = buf[10]
      const b11 = buf[11]
      const b13 = buf[13]

      state.btn[0] = (b8 & 0x80) ? 1 : 0 // A
      state.btn[1] = (b8 & 0x20) ? 1 : 0 // B
      state.btn[2] = (b8 & 0x40) ? 1 : 0 // X
      state.btn[3] = (b8 & 0x10) ? 1 : 0 // Y
      state.btn[4] = (b8 & 0x08) ? 1 : 0 // LB
      state.btn[5] = (b8 & 0x04) ? 1 : 0 // RB
      state.btn[6] = (b9 & 0x10) ? 1 : 0 // Back
      state.btn[7] = (b9 & 0x40) ? 1 : 0 // Start
      state.btn[8] = (b10 & 0x40) ? 1 : 0 // L3 (Left thumbstick click)
      state.btn[9] = (b11 & 0x04) ? 1 : 0 // R3 (Right thumbstick click)
      state.btn[10] = (b9 & 0x01) ? 1 : 0 // D-Pad Up
      state.btn[11] = (b9 & 0x02) ? 1 : 0 // D-Pad Right
      state.btn[12] = (b9 & 0x08) ? 1 : 0 // D-Pad Down
      state.btn[13] = (b9 & 0x04) ? 1 : 0 // D-Pad Left
      state.btn[14] = ((b13 & 0x01) || (b9 & 0x80)) ? 1 : 0 // Paddle L4 / L5

      const rawLx = buf.readInt16LE(48)
      const rawLy = buf.readInt16LE(50)
      const rawRx = buf.readInt16LE(52)
      const rawRy = buf.readInt16LE(54)
      state.lx = rawLx < 0 ? rawLx / 32768.0 : rawLx / 32767.0
      state.ly = rawLy < 0 ? -rawLy / 32768.0 : -rawLy / 32767.0
      state.rx = rawRx < 0 ? rawRx / 32768.0 : rawRx / 32767.0
      state.ry = rawRy < 0 ? -rawRy / 32768.0 : -rawRy / 32767.0

      const rawLt = buf.readUInt16LE(44)
      const rawRt = buf.readUInt16LE(46)
      state.lt = (b8 & 0x02) || (rawLt > 8000) ? 1 : 0
      state.rt = (b8 & 0x01) || (rawRt > 8000) ? 1 : 0
      state.active = true
      return true
    }

    const parseJoydev = (buf, len) => {
      let updated = false
      for (let off = 0; off + 8 <= len; off += 8) {
        const value = buf.readInt16LE(off + 4)
        const type = buf[off + 6] & ~0x80
        const num = buf[off + 7]
        if (type === 1) { // JS_EVENT_BUTTON
          const pressed = value !== 0 ? 1 : 0
          if (num === 0) state.btn[0] = pressed       // A
          else if (num === 1) state.btn[1] = pressed  // B
          else if (num === 2) state.btn[2] = pressed  // X
          else if (num === 3) state.btn[3] = pressed  // Y
          else if (num === 4) state.btn[4] = pressed  // LB
          else if (num === 5) state.btn[5] = pressed  // RB
          else if (num === 6) state.btn[6] = pressed  // Back
          else if (num === 7) state.btn[7] = pressed  // Start
          else if (num === 9) state.btn[8] = pressed  // L3
          else if (num === 10) state.btn[9] = pressed // R3
          else if (num === 11) state.btn[10] = pressed// D-Up
          else if (num === 12) state.btn[12] = pressed// D-Down
          else if (num === 13) state.btn[13] = pressed// D-Left
          else if (num === 14) state.btn[11] = pressed// D-Right
          updated = true
        } else if (type === 2) { // JS_EVENT_AXIS
          const fval = value < 0 ? value / 32768.0 : value / 32767.0
          if (num === 0) state.lx = fval
          else if (num === 1) state.ly = -fval
          else if (num === 2) state.lt = value > 0 ? 1 : 0
          else if (num === 3) state.rx = fval
          else if (num === 4) state.ry = -fval
          else if (num === 5) state.rt = value > 0 ? 1 : 0
          else if (num === 6) {
            state.btn[13] = value < -8000 ? 1 : 0 // D-Left
            state.btn[11] = value > 8000 ? 1 : 0  // D-Right
          } else if (num === 7) {
            state.btn[10] = value < -8000 ? 1 : 0 // D-Up
            state.btn[12] = value > 8000 ? 1 : 0  // D-Down
          }
          updated = true
        }
      }
      if (updated) state.active = true
      return updated
    }

    const parseEvdev = (buf, len) => {
      // 64-bit Linux input_event: 16 bytes timeval + 2 bytes type + 2 bytes code + 4 bytes value = 24 bytes
      let updated = false
      for (let off = 0; off + 24 <= len; off += 24) {
        const type = buf.readUInt16LE(off + 16)
        const code = buf.readUInt16LE(off + 18)
        const val = buf.readInt32LE(off + 20)
        if (type === 1) { // EV_KEY
          const p = val !== 0 ? 1 : 0
          if (code === 304) state.btn[0] = p       // BTN_SOUTH (A)
          else if (code === 305) state.btn[1] = p  // BTN_EAST (B)
          else if (code === 307) state.btn[2] = p  // BTN_NORTH (X)
          else if (code === 308) state.btn[3] = p  // BTN_WEST (Y)
          else if (code === 310) state.btn[4] = p  // BTN_TL (LB)
          else if (code === 311) state.btn[5] = p  // BTN_TR (RB)
          else if (code === 312) state.lt = p
          else if (code === 313) state.rt = p
          else if (code === 314) state.btn[6] = p  // BTN_SELECT
          else if (code === 315) state.btn[7] = p  // BTN_START
          else if (code === 317) state.btn[8] = p  // BTN_THUMBL
          else if (code === 318) state.btn[9] = p  // BTN_THUMBR
          else if (code === 544) state.btn[10] = p // BTN_DPAD_UP
          else if (code === 545) state.btn[12] = p // BTN_DPAD_DOWN
          else if (code === 546) state.btn[13] = p // BTN_DPAD_LEFT
          else if (code === 547) state.btn[11] = p // BTN_DPAD_RIGHT
          updated = true
        } else if (type === 3) { // EV_ABS
          const fval = val < 0 ? val / 32768.0 : val / 32767.0
          if (code === 0) state.lx = fval
          else if (code === 1) state.ly = -fval
          else if (code === 3) state.rx = fval
          else if (code === 4) state.ry = -fval
          else if (code === 10) state.lt = val > 128 ? 1 : 0
          else if (code === 9) state.rt = val > 128 ? 1 : 0
          else if (code === 16) {
            state.btn[13] = val < 0 ? 1 : 0
            state.btn[11] = val > 0 ? 1 : 0
          } else if (code === 17) {
            state.btn[10] = val < 0 ? 1 : 0
            state.btn[12] = val > 0 ? 1 : 0
          }
          updated = true
        }
      }
      if (updated) state.active = true
      return updated
    }

    scanDevices()
    let tick = 0
    const timer = setInterval(() => {
      tick++
      if (tick % 120 === 0) scanDevices()
      let anyChange = false
      for (const [devPath, info] of fds.entries()) {
        try {
          for (let reads = 0; reads < 16; reads++) {
            const n = fs.readSync(info.fd, readBuf, 0, readBuf.length, null)
            if (n <= 0) break
            if (info.type === 'steamdeck-hidraw') {
              if (parseSteamDeckHid(readBuf, n)) anyChange = true
            } else if (info.type === 'joydev') {
              if (parseJoydev(readBuf, n)) anyChange = true
            } else if (info.type === 'evdev') {
              if (parseEvdev(readBuf, n)) anyChange = true
            }
          }
        } catch (err) {
          if (err.code !== 'EAGAIN' && err.code !== 'EWOULDBLOCK') {
            try { fs.closeSync(info.fd) } catch {}
            fds.delete(devPath)
          }
        }
      }
      if (anyChange || (state.active && tick % 4 === 0) || (fds.size > 0 && tick % 16 === 0)) {
        writeState()
      }
    }, 12)
    timer.unref?.()

    if (parentChild) {
      parentChild.once('exit', () => {
        clearInterval(timer)
        for (const info of fds.values()) {
          try { fs.closeSync(info.fd) } catch {}
        }
        fds.clear()
        try { fs.unlinkSync(shmPath) } catch {}
        try { fs.unlinkSync(fallbackPath) } catch {}
      })
    }
  }

  /**
   * SoderPad.exe turns a controller into keys for the 3.3.5a client.
   * Runs natively on Windows and through Wine on Linux/SteamOS.
   */
  #startControllerReader(dir, command, defaultArgs, env, parentChild) {
    let reader = path.join(dir, 'SoderPad.exe')
    const bundled = path.join(__dirname, '..', 'bin', 'SoderPad.exe')
    if (fs.existsSync(bundled)) {
      try { fs.copyFileSync(bundled, reader) } catch (e) { log.warn('could not copy bundled SoderPad.exe', e.message) }
    }
    if (!fs.existsSync(reader)) return
    if (this.platform !== 'win32') {
      this.#startLinuxInputBridge(dir, parentChild)
    }
    try {
      const spawnCmd = this.platform === 'win32' ? reader : command
      const spawnArgs = this.platform === 'win32' ? [] : [...(defaultArgs || []), reader]
      const proc = this.spawn(spawnCmd, spawnArgs, {
        cwd: dir, env, detached: true, stdio: 'ignore', windowsHide: true,
      })
      proc.once('error', (err) => log.warn(`controller reader did not start: ${err.message}`))
      if (parentChild) {
        parentChild.once('exit', () => {
          try { proc.kill() } catch {}
          if (this.platform !== 'win32') {
            try { this.spawn('pkill', ['-9', '-f', 'SoderPad.exe'], { stdio: 'ignore' }) } catch {}
          }
        })
      }
      proc.unref()
      log.info('SoderPad controller reader started successfully')
    } catch (err) {
      log.warn(`controller reader did not start: ${err.message}`)
    }
  }

  /**
   * digita.exe types the player's password and hits Enter when the WoW login window appears.
   * Works both natively on Windows and under Wine on Linux / Steam Deck without modifying GlueXML files.
   */
  #startAutoLogin(dir, command, defaultArgs, env, password) {
    if (!password) return
    let helper = path.join(dir, 'digita.exe')
    const bundled = path.join(__dirname, '..', 'bin', 'digita.exe')
    if (fs.existsSync(bundled)) {
      try { fs.copyFileSync(bundled, helper) } catch (e) { log.warn('could not copy bundled digita.exe', e.message) }
    }
    if (!fs.existsSync(helper)) return
    try {
      const spawnCmd = this.platform === 'win32' ? helper : command
      const spawnArgs = this.platform === 'win32' ? [password] : [...(defaultArgs || []), helper, password]
      const proc = this.spawn(spawnCmd, spawnArgs, {
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
    this.installer.ensureRealmlist(id, credentials?.username, credentials?.password)

    const dir = this.config.clientDir(id)
    const exe = resolveInside(dir, client.executable)
    let command = exe
    let args = []
    const env = platform.cleanEnvForSystemBinary ? platform.cleanEnvForSystemBinary({ ...process.env }) : { ...process.env }

    const dataDir = path.join(dir, 'Data')
    const glueDir = path.join(dir, 'Interface', 'GlueXML')
    try { fs.mkdirSync(glueDir, { recursive: true }) } catch {}

    const glueFiles = ['AccountLogin.lua', 'CinematicsFrame.lua']
    for (const f of glueFiles) {
      const src = path.join(__dirname, '..', 'bin', f)
      if (fs.existsSync(src)) {
        try {
          fs.copyFileSync(src, path.join(glueDir, f))
        } catch (err) {
          log.warn(`could not copy ${f} to Interface/GlueXML`, err.message)
        }
      }
    }

    const soderPadAddonDir = path.join(dir, 'Interface', 'AddOns', 'SoderPad')
    const bundledAddonDir = path.join(__dirname, '..', 'bin', 'SoderPad')
    if (fs.existsSync(bundledAddonDir)) {
      try {
        fs.mkdirSync(soderPadAddonDir, { recursive: true })
        for (const file of fs.readdirSync(bundledAddonDir)) {
          fs.copyFileSync(path.join(bundledAddonDir, file), path.join(soderPadAddonDir, file))
        }
      } catch (err) {
        log.warn('could not sync bundled SoderPad addon', err.message)
      }
    }

    // Se versões anteriores (0.1.15/0.1.16) sobrescreveram patch-Z.MPQ com o MPQ pequeno (< 100 KB),
    // restaura a partir do patch-4.MPQ ou remove o MPQ pequeno para não interferir nos MPQs do cliente.
    try {
      const dataZ = path.join(dataDir, 'patch-Z.MPQ')
      const data4 = path.join(dataDir, 'patch-4.MPQ')
      if (fs.existsSync(dataZ) && fs.statSync(dataZ).size <= 100000) {
        if (fs.existsSync(data4) && fs.statSync(data4).size > 100000) {
          fs.copyFileSync(data4, dataZ)
        } else {
          fs.unlinkSync(dataZ)
        }
      }
    } catch {}

    for (const loc of ['enUS', 'esES', 'ptBR', 'deDE', 'frFR', 'ruRU']) {
      const locDir = path.join(dataDir, loc)
      if (fs.existsSync(locDir)) {
        try { fs.rmSync(path.join(locDir, `patch-${loc}-9.MPQ`), { force: true }) } catch {}
        try {
          const locZ = path.join(locDir, `patch-${loc}-Z.MPQ`)
          const loc4 = path.join(locDir, `patch-${loc}-4.MPQ`)
          if (fs.existsSync(locZ) && fs.statSync(locZ).size <= 100000) {
            if (fs.existsSync(loc4) && fs.statSync(loc4).size > 100000) {
              fs.copyFileSync(loc4, locZ)
            } else {
              fs.unlinkSync(locZ)
            }
          }
        } catch {}
      }
    }

    // No Linux / Steam Deck: restaura d3d9_orig.dll puro (DXVK) eliminando a ponte.c proxy (17 KB)
    if (this.platform !== 'win32') {
      try {
        const d3d9Orig = path.join(dir, 'd3d9_orig.dll')
        const d3d9Current = path.join(dir, 'd3d9.dll')
        const d3d9Bak = path.join(dir, 'd3d9.dxvk.bak')
        if (fs.existsSync(d3d9Bak)) {
          try {
            if (!fs.existsSync(d3d9Current)) fs.renameSync(d3d9Bak, d3d9Current)
            else fs.unlinkSync(d3d9Bak)
          } catch {}
        }
        if (fs.existsSync(d3d9Orig) && fs.statSync(d3d9Orig).size > 500000) {
          if (!fs.existsSync(d3d9Current) || fs.statSync(d3d9Current).size < 100000) {
            fs.copyFileSync(d3d9Orig, d3d9Current)
            log.info('Restored pure DXVK d3d9.dll on Linux (bypassing ponte.c loader proxy)')
          }
        } else if (fs.existsSync(d3d9Current) && fs.statSync(d3d9Current).size < 100000) {
          fs.unlinkSync(d3d9Current)
          log.info('Removed ponte.c d3d9 proxy on Linux to use Wine/Proton builtin D3D9')
        }
      } catch (e) {
        log.warn('could not sanitize d3d9 proxy', e.message)
      }

      // Neutraliza vídeos AVI soltos em Data/<locale>/Interface/Cinematics (Wine no Steam Deck trava na decodificação de AVI gerando tela preta)
      for (const loc of ['enUS', 'esES', 'ptBR', 'deDE', 'frFR', 'ruRU']) {
        const cinDir = path.join(dataDir, loc, 'Interface', 'Cinematics')
        if (fs.existsSync(cinDir)) {
          try {
            const cinBak = path.join(dataDir, loc, 'Interface', 'Cinematics.disabled')
            if (!fs.existsSync(cinBak)) {
              fs.renameSync(cinDir, cinBak)
              log.info(`Disabled loose AVI cinematics for ${loc} to prevent Wine video hang`)
            }
          } catch (e) {
            log.warn('could not rename Cinematics dir', e.message)
          }
        }
      }
      const rootCin = path.join(dir, 'Interface', 'Cinematics')
      if (fs.existsSync(rootCin)) {
        try {
          fs.renameSync(rootCin, path.join(dir, 'Interface', 'Cinematics.disabled'))
        } catch {}
      }

      // Desativa Gamescope WSI e bloqueios de VSync / Direct Scanout no SteamOS/KWin/DXVK
      env.ENABLE_GAMESCOPE_WSI = '0'
      env.vblank_mode = '0'
      env.__GL_SYNC_TO_VBLANK = '0'
      env.KWIN_X11_NO_SYNC_TO_VBLANK = '1'
      env.KWIN_DRM_NO_DIRECT_SCANOUT = '1'
      env.SDL_VIDEO_MINIMIZE_ON_FOCUS_LOSS = '0'
      env.SDL_GAMECONTROLLER_ALLOW_STEAM_VIRTUAL_GAMEPAD = '1'

      env.DXVK_CONFIG = 'd3d9.deferSurfaceCreation=False;d3d9.presentInterval=0;dxgi.syncInterval=0;dxvk.tearFree=False;d3d9.maxFrameLatency=3;d3d9.maxFrameRate=60;d3d9.numBackBuffers=3'
      try {
        const dxvkConf = path.join(dir, 'dxvk.conf')
        const safeDxvkConf = [
          'd3d9.deferSurfaceCreation = False',
          'd3d9.presentInterval = 0',
          'dxgi.syncInterval = 0',
          'dxvk.tearFree = False',
          'd3d9.maxFrameLatency = 3',
          'd3d9.maxFrameRate = 60',
          'd3d9.numBackBuffers = 3',
          'dxvk.numCompilerThreads = 2',
          '',
        ].join('\n')
        fs.writeFileSync(dxvkConf, safeDxvkConf, 'utf8')
      } catch {}

      // Se /opt/reshade não existir (como no Steam Deck), desativa vkBasalt para evitar crash/tela preta no Vulkan
      if (!fs.existsSync('/opt/reshade/shaders')) {
        env.ENABLE_VKBASALT = '0'
        env.VKBASALT_CONFIG_FILE = '/dev/null'
      }
    }

    let defaultArgs = []

    if (this.platform !== 'win32') {
      const cfg = this.config.get()
      const internalWine = path.join(this.config.dataDir, 'runtime', 'wine', 'bin', 'wine')
      const wine = await platform.detectWine(cfg.wine.path, this.platform, [internalWine])
      if (!wine.found) throw new LauncherError('WINE_MISSING', 'Wine is required to run the game on this system. Install it (e.g. "sudo pacman -S wine" or "sudo apt install wine") or set its path in Settings.')
      const prefix = cfg.wine.prefix || path.join(this.config.dataDir, 'wineprefix')
      fs.mkdirSync(prefix, { recursive: true })

      const protonScript = wine.protonScript || (platform.findProtonScript ? platform.findProtonScript(wine.path) : null)
      if (wine.isProton && protonScript) {
        command = protonScript
        defaultArgs = ['run']
        args = ['run', exe]
        env.STEAM_COMPAT_DATA_PATH = prefix
        const steamDir = [
          path.join(process.env.HOME || '/home/deck', '.local/share/Steam'),
          path.join(process.env.HOME || '/home/deck', '.steam/steam'),
          '/home/deck/.local/share/Steam'
        ].find((p) => fs.existsSync(p)) || path.join(process.env.HOME || '', '.local/share/Steam')
        env.STEAM_COMPAT_CLIENT_INSTALL_PATH = steamDir
        log.info(`Using Proton runner: ${command} with prefix: ${prefix}`)
      } else {
        command = wine.path
        defaultArgs = []
        args = [exe]

        const wineBinDir = path.dirname(wine.path)
        const wineRootDir = path.dirname(wineBinDir)
        const wineLibDir = path.join(wineRootDir, 'lib')
        env.PATH = `${wineBinDir}:${env.PATH || ''}`
        // Nunca prependa /usr/lib ou lib64 em LD_LIBRARY_PATH de binário 32-bit
        if (!wine.path.startsWith('/usr/bin/')) {
          env.LD_LIBRARY_PATH = `${wineLibDir}:${env.LD_LIBRARY_PATH || ''}`
        }
      }

      // Limpa LD_PRELOAD de bibliotecas 64-bit da Steam que causam crash no Wine 32-bit
      if (env.LD_PRELOAD) {
        env.LD_PRELOAD = env.LD_PRELOAD.split(':').filter(p => !p.includes('gameoverlayrenderer.so')).join(':')
      }

      env.WINEPREFIX = prefix
      env.WINEDEBUG = env.WINEDEBUG || '-all'
      // Desativa o winedbg para evitar que um diálogo de crash fique travando o processo em segundo plano
      env.WINEDLLOVERRIDES = 'winedbg.exe=d;d3d9,dxgi=n,b'
      env.WINE_CRASH_REPORT_DIR = '/dev/null'

      if (client.architecture === 'x86') env.WINEARCH = env.WINEARCH || 'win64' // modern Wine runs 32-bit apps in a win64 prefix (WoW64)

      // First run: create the prefix before starting the game (racing wineboot breaks RpcSs).
      if (!wine.isProton && !fs.existsSync(path.join(prefix, 'drive_c'))) {
        onStatus?.('Preparing Wine (first run, this can take a minute)…')
        await this.#wineboot(wine.path, env)
      }
    }

    log.info(`launching ${id}: ${command} ${args.join(' ')}`)
    const child = await new Promise((resolve, reject) => {
      let proc
      try {
        proc = this.spawn(command, args, { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
        proc.stdout?.on('data', (d) => log.info(`[game stdout] ${d.toString().trim()}`))
        proc.stderr?.on('data', (d) => log.warn(`[game stderr] ${d.toString().trim()}`))
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
      if (this.platform !== 'win32') {
        try { this.spawn('pkill', ['-f', 'SoderPad.exe'], { stdio: 'ignore' }) } catch {}
        try { this.spawn('pkill', ['-f', 'digita.exe'], { stdio: 'ignore' }) } catch {}
      }
    })
    child.unref()
    this.#startControllerReader(dir, command, defaultArgs, env, child)
    this.#startAutoLogin(dir, command, defaultArgs, env, credentials?.password)
    return { pid: child.pid, command: path.basename(command) }
  }
}

module.exports = { GameLauncher }
