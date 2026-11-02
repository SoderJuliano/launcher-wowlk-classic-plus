# Architecture

## Technology choice

**Electron 45 (Node 24) + Vue 3 + Vite**, plain JavaScript (CommonJS in the main process).

| Option | Verdict |
|---|---|
| Tauri 2 / Rust | Smaller binary, but needs the MSVC toolchain on Windows (not available on the dev machine) and a webview per OS (WebKitGTK on Linux behaves differently). Would have blocked building and testing the Windows launcher here. |
| Java | Heavy runtime, weaker UI story, more packaging work per distro. |
| **Electron** | One codebase builds Windows (NSIS/portable), Debian (.deb), Arch (.pacman), any distro (AppImage) and macOS (dmg). Node streams handle 35 GB downloads/extraction comfortably; same Vue stack and visual identity as the website. Cost: ~100 MB installer. |

The core is plain Node with no Electron imports (except `main.cjs`), so it is unit-tested with
`node --test` on Windows and Linux.

## Processes

```
┌──────────────── Renderer (Vue 3, sandboxed, no Node) ───────────────┐
│ LoginView · HomeView · SettingsDialog · ApiStatus                    │
│ window.olk.* (invoke)  ←  olk:state / olk:progress (events)          │
└──────────────────────────────┬───────────────────────────────────────┘
                     preload.cjs (contextBridge, whitelist)
┌──────────────────────────────┴───────────────────────────────────────┐
│ main.cjs — window, IPC (sender check), safeStorage, shell             │
│   LauncherController — one task at a time, button state, progress     │
│     ├─ ConfigurationManager  defaults.json + settings.json            │
│     ├─ ApiClient            Abra discovery → Pikachu /launcher/v1     │
│     ├─ AuthenticationService login/refresh/logout, encrypted session │
│     ├─ ManifestService      fetch + strict validation                 │
│     ├─ DownloadManager      resume, SHA-256, Google Drive             │
│     ├─ InstallationManager  ZIP64 extract, CRC, validate, realmlist   │
│     ├─ UpdateManager        diff, staged download, swap, rollback     │
│     ├─ GameLauncher         direct (Windows) / Wine (Linux)           │
│     └─ PlatformService      OS, Wine detection, disk space            │
│   support: pathSafety · hashing · googleDrive · realmlist · logger    │
└───────────────────────────────────────────────────────────────────────┘
```

## Main button state machine (per client)

```
UNAVAILABLE (client.available = false, e.g. wow64 today)
INSTALL ──install──▶ DOWNLOADING ──▶ INSTALLING ──▶ (VERIFYING ▶ UPDATING) ──▶ PLAY ──play──▶ RUNNING ──exit──▶ PLAY
PLAY ──manifest newer──▶ UPDATE ──▶ VERIFYING ▶ UPDATING ▶ PLAY
any failure ──▶ ERROR (Retry)            state file but files missing ──▶ REPAIR
```

## Data on disk

| Path (OS app-data folder `OLK Plus Launcher/`) | Content |
|---|---|
| `settings.json` | User overrides only (validated keys) |
| `session.bin` | Refresh token + username, encrypted with OS keystore (DPAPI / libsecret / Keychain). Only with "Keep me signed in". |
| `logs/launcher.log` | Diagnostics, rotated at 2 MB, tokens/passwords redacted |
| `games/<client>/` | Installed client (default; configurable) |
| `games/<client>/.olk-install.json` | Install state |
| `games/<client>/.olk-hashes.json` | SHA-256 cache (size + mtime) |
| `games/downloads/` | Base ZIP while downloading (deleted after install) |
| `wineprefix/` | Linux/macOS Wine prefix (configurable) |

## Security measures

| Threat | Mitigation |
|---|---|
| Malicious manifest/ZIP writing outside the folder | `pathSafety.normalizeRelative/resolveInside` on every path; symlinks rejected; yauzl name validation |
| Tampered / corrupted downloads | SHA-256 (manifest files, base ZIP when given), CRC-32 per ZIP entry, size check |
| Half-written install/update | Staging dirs + atomic rename; backup + rollback for updates |
| Plain-HTTP / weird schemes | Only `https:` (http only for localhost) for API, downloads, website |
| Credential leaks | Password only in memory; refresh token encrypted at rest; log redaction |
| Renderer compromise | `contextIsolation`, `sandbox`, no `nodeIntegration`, strict CSP, no navigation/popups, IPC whitelist + sender check |
| Executing unverified files | The game is only launched after install validation; patched files are swapped in only after hash verification |
