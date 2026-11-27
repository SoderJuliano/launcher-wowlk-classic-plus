/**
 * DEV-ONLY fake bridge so the UI can be previewed in a normal browser (`npx vite`).
 * Never bundled in production (guarded by import.meta.env.DEV in main.js).
 * ?view=login | home | installing | error  picks the scenario.
 * &client=wow64 selects the 64-bit tab; &sup=0 = not a 32-bit supporter;
 * &wine=ok|missing simulates Linux/Steam Deck.
 * &ea=none | off | on = 64-bit early access (none = not in wowsixtyfordev, off/on = member with the toggle).
 */
export function installMockBridge() {
  const q = new URLSearchParams(location.search)
  const view = q.get('view') || 'home'
  const ea = q.get('ea') || 'none'
  const lang = q.get('lang') || 'enUS'
  const listeners = { state: [], progress: [] }
  const client = (id, over) => ({
    id, name: id === 'wow32' ? 'Classic Plus LK — 32-bit' : 'Classic Plus LK — 64-bit', architecture: id === 'wow32' ? 'x86' : 'x64',
    available: id === 'wow32', installed: false, missing: [], version: null, latestVersion: null, updateAvailable: false,
    supporterContentEnabled: false,
    installDir: `C:\\Users\\player\\AppData\\Roaming\\OLK Plus Launcher\\games\\${id}`, hasPackageSource: true, running: false,
    button: id === 'wow32' ? 'INSTALL' : 'UNAVAILABLE', error: null, ...over
  })
  const snap = {
    platform: { platform: 'win32', arch: 'x64', label: 'Windows' },
    wine: q.get('wine') ? { needed: true, found: q.get('wine') === 'ok', version: 'wine-10.0' } : { needed: false, found: true },
    vulkan: { platform: 'win32', supported: true, missingReasons: [], installCommand: null, docsUrl: 'https://vulkan.lunarg.com/sdk/home', driverLinks: [] },
    launcherUpdateError: null,
    api: view === 'login' ? { state: 'incompatible', baseUrl: 'https://bush-wifi-wanting.ngrok-free.dev', error: 'Server is online but the launcher API (/launcher/v1) is not available yet.' } : { state: 'online', baseUrl: 'https://bush-wifi-wanting.ngrok-free.dev', apiVersion: 1 },
    user: view === 'login' ? null : { id: 7, username: 'ARTHAS' },
    supporter: view === 'login' || q.get('sup') === '0' ? null : { supporter: true, since: '2026-11-22T16:59:41Z', donations: 1 },
    earlyAccess64: view === 'login' ? null : { member: ea !== 'none', since: null },
    supporterContentEnabled: false,
    authenticated: view !== 'login',
    selectedClient: q.get('client') || 'wow32',
    clients: [
      client('wow32', view === 'home' ? { installed: true, version: '1.0.0', latestVersion: '1.0.0', button: 'PLAY' }
        : view === 'installing' ? { button: 'DOWNLOADING' }
        : view === 'error' ? { button: 'ERROR', error: { code: 'DRIVE_QUOTA', message: 'Google Drive download quota exceeded for this file. Try again later.' } } : {}),
      client('wow64', { earlyAccess: true, supporterContentEnabled: ea === 'on', available: ea === 'on', button: ea === 'on' ? 'INSTALL' : 'UNAVAILABLE' })
    ],
    task: view === 'installing' ? { id: 'wow32', kind: 'install', stage: 'download' } : null,
    settings: { wow32ManifestUrl: '', apiBaseUrl: '', discoveryEnabled: true, realmlist: 'ru2esxz6.free.tryportwarp.cc:16943', locale: 'enUS', gameLanguage: lang, installDir: 'C:\\Users\\player\\AppData\\Roaming\\OLK Plus Launcher\\games', winePath: '', winePrefix: '', graphicsFiltersEnabled: true, graphicsUseDxvk: true, graphicsResolutionMode: 'auto', graphicsCustomResolution: '', websiteUrl: 'https://example.com', wow32PackageUrl: 'https://drive.google.com/file/d/xxxx/view', wow64PackageUrl: '' },
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
