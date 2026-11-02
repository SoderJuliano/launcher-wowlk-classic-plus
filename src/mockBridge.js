/**
 * DEV-ONLY fake bridge so the UI can be previewed in a normal browser (`npx vite`).
 * Never bundled in production (guarded by import.meta.env.DEV in main.js).
 * ?view=login | home | installing | error  picks the scenario.
 */
export function installMockBridge() {
  const view = new URLSearchParams(location.search).get('view') || 'home'
  const listeners = { state: [], progress: [] }
  const client = (id, over) => ({
    id, name: id === 'wow32' ? 'Classic Plus LK — 32-bit' : 'Classic Plus LK — 64-bit', architecture: id === 'wow32' ? 'x86' : 'x64',
    available: id === 'wow32', installed: false, missing: [], version: null, latestVersion: null, updateAvailable: false,
    installDir: `C:\\Users\\player\\AppData\\Roaming\\OLK Plus Launcher\\games\\${id}`, hasPackageSource: true, running: false,
    button: id === 'wow32' ? 'INSTALL' : 'UNAVAILABLE', error: null, ...over
  })
  const snap = {
    platform: { platform: 'win32', arch: 'x64', label: 'Windows' },
    wine: { needed: false, found: true },
    api: view === 'login' ? { state: 'incompatible', baseUrl: 'https://bush-wifi-wanting.ngrok-free.dev', error: 'Server is online but the launcher API (/launcher/v1) is not available yet.' } : { state: 'online', baseUrl: 'https://bush-wifi-wanting.ngrok-free.dev', apiVersion: 1 },
    user: view === 'login' ? null : { id: 7, username: 'ARTHAS' },
    authenticated: view !== 'login',
    selectedClient: 'wow32',
    clients: [
      client('wow32', view === 'home' ? { installed: true, version: '1.0.0', latestVersion: '1.0.0', button: 'PLAY' }
        : view === 'installing' ? { button: 'DOWNLOADING' }
        : view === 'error' ? { button: 'ERROR', error: { code: 'DRIVE_QUOTA', message: 'Google Drive download quota exceeded for this file. Try again later.' } } : {}),
      client('wow64')
    ],
    task: view === 'installing' ? { id: 'wow32', kind: 'install', stage: 'download' } : null,
    settings: { wow32ManifestUrl: '', apiBaseUrl: '', discoveryEnabled: true, realmlist: 'ru2esxz6.free.tryportwarp.cc:16943', locale: 'enUS', installDir: 'C:\\Users\\player\\AppData\\Roaming\\OLK Plus Launcher\\games', winePath: '', winePrefix: '', websiteUrl: 'https://example.com', wow32PackageUrl: 'https://drive.google.com/file/d/xxxx/view', wow64PackageUrl: '' },
    logFile: 'C:\\…\\launcher.log'
  }
  const ok = (data) => Promise.resolve({ ok: true, data })
  window.olk = new Proxy({}, {
    get: (_, name) => {
      if (name === 'on') return (ev, cb) => { listeners[ev].push(cb); if (view === 'installing' && ev === 'progress') setTimeout(() => cb({ id: 'wow32', stage: 'download', phase: 'download', done: 14.2 * 1024 ** 3, total: 35.44 * 1024 ** 3, bytesPerSec: 38 * 1024 ** 2 }), 50); return () => {} }
      if (name === 'state') return () => ok(snap)
      if (name === 'version') return () => ok('0.1.0')
      if (name === 'login') return () => Promise.resolve({ ok: false, error: { code: 'HTTP_404', message: 'The server does not support this launcher feature yet.' } })
      return () => ok(null)
    }
  })
}
