# Release guide

How to publish game updates and new launcher versions. The admin publishing tool is **not**
part of this repository (it will run on the server); this guide defines what it must produce.

## A. Hosting

| What | Where | Notes |
|---|---|---|
| Base ZIP | Google Drive (today) or object storage | Must be a **file** link shared as "Anyone with the link". Drive has daily download quotas — expect `DRIVE_QUOTA` errors with many players. |
| Patch files | Cloudflare R2 (recommended: no egress fees), S3, or any HTTPS static host | Direct HTTPS URLs, `Range` support, immutable paths. |
| Manifests | Served by Pikachu `GET /launcher/v1/manifest/{client}` | Pikachu can read them from storage or disk. |

Suggested layout (versioned, immutable — a URL never changes content):

```
olk-plus-storage/
  initial/wow32-1.0.0.zip
  patches/wow32/1.0.1/Data/patch-5.MPQ
  patches/wow32/1.0.1/Wow.exe
  manifests/wow32.json        ← current manifest (the only mutable object)
  manifests/wow64.json
```

## B. Publishing a game update (what the future admin tool must do)

1. Start from the **previous published tree** of the client and the new tree.
2. For every file in the new tree compute `size` + `sha256`; compare with the previous manifest.
3. Upload new/changed files to `patches/<client>/<version>/<path>` (never overwrite old URLs).
4. Files present before and absent now → `deleted_files`.
5. Write the manifest (`schema_version: 1`, bumped semver `version`, `files`, `deleted_files`,
   optional `realmlist`, `min_launcher_version` if required) and validate it with:
   ```bash
   node -e "const {validateManifest}=require('./electron/core/ManifestService.cjs');validateManifest(require('./wow32.json'),'wow32');console.log('ok')"
   ```
6. Upload the manifest **last** (atomically replace `manifests/<client>.json`).
7. Rollback = re-publish the previous manifest with a higher version number.

`files` must contain at least every file changed since the base package; carrying earlier
patched files forward keeps fresh installs (base ZIP + manifest) correct.

## C. Changing the realm address

Either ship `realmlist` in the next manifest (applied on update), or players change it in
Settings. The launcher rewrites `realmlist.wtf` / `Config.wtf` before every launch.

## D. New base package

Upload the new ZIP, then set `base_package` in the manifest (`url`, `size`, `sha256`,
`root`, `version`). Reinstalls and new players use it; existing players keep updating
incrementally.

## E. Releasing the launcher

1. Bump `version` in `package.json` (semver).
2. Tag `vX.Y.Z` and push — `.github/workflows/build.yml` builds Windows (NSIS installer +
   portable), Linux (AppImage, .deb, .pacman) and macOS (dmg, unsigned) and attaches them to
   a draft GitHub Release.
3. Local alternatives: `npm run dist:win` on Windows; `npm run dist:linux` on Linux (or the
   Docker command in README).
4. If the new launcher is mandatory, raise `min_launcher_version` in the manifests.

Code signing (Windows Authenticode / Apple notarization) is not configured; Windows
SmartScreen will warn on first run until a certificate is added (`build.win.certificateFile`).
