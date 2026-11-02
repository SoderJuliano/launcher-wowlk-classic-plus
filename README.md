# OLK Plus Launcher

Desktop launcher for **WoW Classic Plus LK** — login (Pikachu API), install, incremental
updates and game start. Windows, Linux (Debian/Ubuntu, Arch, any distro via AppImage);
macOS buildable.

Stack: Electron 45 + Vue 3 + Vite. Why: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| Doc | |
|---|---|
| [docs/API_CONTRACT.md](docs/API_CONTRACT.md) | What the Pikachu API must implement (auth + manifest) |
| [docs/UPDATE_SYSTEM.md](docs/UPDATE_SYSTEM.md) | Base package, manifest format, incremental update algorithm |
| [docs/RELEASE_GUIDE.md](docs/RELEASE_GUIDE.md) | Publishing game patches and launcher releases |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modules, state machine, data on disk, security |

## Requirements

- Node.js ≥ 22 (24 recommended), npm
- Linux players: **Wine** (the game is a Windows client)
  - Arch: `sudo pacman -S wine`
  - Debian/Ubuntu: `sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32 wine64`
    (`wine32` is required: the 3.3.5a client is 32-bit)

## Run (development)

```bash
npm install
npm run dev        # Vite dev server + Electron with hot reload of the UI
npm start          # production UI build + Electron
npm test           # 31 automated tests (node --test)
```

Browser-only UI preview with a fake backend: `npx vite` → http://localhost:5199/?view=home
(`login`, `installing`, `error`).

## Build

```bash
npm run dist:win     # on Windows → release/OLK Plus Launcher Setup x.y.z.exe + portable .exe
npm run dist:linux   # on Linux   → release/*.AppImage, *.deb, *.pacman
npm run dist:mac     # on macOS   → release/*.dmg (unsigned)
```

Linux packages from Windows (Docker Desktop):

```bash
docker run --rm -v "%cd%:/project" electronuserland/builder:latest bash -lc "apt-get install -y -qq libarchive-tools; mkdir /build && cd /project && tar --exclude=./node_modules --exclude=./release -cf - . | (cd /build && tar xf -) && cd /build && npm ci && npm run dist:linux && cp release/*.AppImage release/*.deb release/*.pacman /project/release/"
```

CI: pushing a tag `v*` runs `.github/workflows/build.yml` (Windows, Linux, macOS).

## Already have the game? "Locate game"

Players who already extracted the client click **Locate game** (or *Locate installed game* in
the sidebar), and pick the folder in the file explorer — the game folder itself or its parent
(e.g. `wow-soder-configurado` containing `ChromieCraft_3.3.5a`). The launcher validates
`Wow.exe` + required MPQs, adopts the folder **in place** (no copy), writes the realmlist and
enables PLAY. Future patches are applied to that same folder. A later full *Install* goes to
the launcher's own folder and never touches the located one.

## Configuration (no rebuild needed)

Factory defaults: `config/defaults.json`. Players change values in **Settings**; they are saved
to `settings.json` in the app-data folder (`%APPDATA%\OLK Plus Launcher` /
`~/.config/OLK Plus Launcher`).

| Setting | Default |
|---|---|
| Realmlist | `ru2esxz6.free.tryportwarp.cc:16943` (from the project's own client files; port 16943 verified open) |
| Pikachu URL | auto-discovered from Abra API `key=ngrockurl` (last item); manual override possible |
| 32-bit package link | **empty — see pending items** |
| Install folder | `<app-data>/games` (each client in its own sub-folder) |
| Wine path / prefix | auto-detect / `<app-data>/wineprefix` |
| Website URL | **empty — see pending items** |
| 32-bit update manifest URL | empty — a static HTTPS JSON (see UPDATE_SYSTEM.md); used when the Pikachu launcher API is unavailable |

## What was tested

| Area | How | Result |
|---|---|---|
| Path safety, manifest validation, Drive links, URL rules | unit tests | ✅ |
| Download: progress, SHA-256, resume after connection loss (Range), cancel, Drive confirmation page | unit tests with local HTTP server | ✅ |
| Install: root strip, CRC, required files, realmlist ×3, traversal/symlink ZIPs refused, corrupted ZIP refused, reinstall keeps WTF/Account | unit tests | ✅ |
| Incremental update: only changed files, nothing re-downloaded, deletions only from list, protected paths, rollback on bad hash, repair detects corruption | unit tests | ✅ |
| Auth: discovery (last item), health, login/locked/invalid, encrypted remember-me, auto refresh, logout, manifest with token, outdated launcher | unit tests against a contract mock | ✅ |
| **Real 35.4 GB client package** (1,478 entries, ZIP64) install + validation + realmlist | `tests/manual/real-package.cjs` | ✅ 177 s |
| **Real Wow.exe** start on Windows, duplicate start blocked | `tests/manual/real-launch.cjs` | ✅ |
| **Real Wow.exe on Linux via Wine** (prefix init + launch, Ubuntu container, Wine 6) | `tests/manual/wine-wow.cjs` | ✅ |
| Full app in Electron (real Abra discovery → Pikachu, login error, settings validation, download → install → PLAY, logs without secrets) | `tests/manual/e2e-electron.mjs` | ✅ |
| Packaged Windows app; .deb installed and started on Ubuntu (Xvfb) | manual | ✅ |
| Unit tests on Linux | Docker | ✅ 30 pass, 1 Windows-only skipped |

## Pending (needs input / server work)

1. **Base ZIP link** — the Drive *folder* shared is empty for anonymous access. Upload the ZIP,
   share the **file** as "Anyone with the link" and put its link in `config/defaults.json`
   (`clients.wow32.basePackage.url`) or in Settings. Drive quotas will limit many simultaneous
   downloads → move to R2/S3 when possible.
2. **Pikachu launcher API** (`/launcher/v1/health`, `/auth/*`, `/manifest/*`) is not implemented
   yet — the launcher shows "Launcher API pending" and lets players continue without signing in.
3. **wow64 client** has no package yet → shown as "In development" (`available: false`).
4. **Website URL** for the "Website" / "Create an account" buttons.
5. The local 35 GB package contains `WTF/` (59 files: personal settings/account folders),
   `Logs/`, `Cache/`, `Wow.exe.orig` and `*.backup` files. Clean them before publishing.
6. The realmlist host is a free tunnel (`*.tryportwarp.cc`); when it changes, publish the new
   value in the manifest `realmlist` field.
7. No code signing certificate (SmartScreen warning on Windows).
