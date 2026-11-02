# Update system

Two mechanisms:

1. **Base package** (first install / reinstall): one ZIP with the full client (~35 GB today).
2. **Incremental updates**: a per-client JSON manifest listing files with SHA-256 hashes.
   Only new or changed files are downloaded — never a new full ZIP.

## 1. Base package (implemented: `DownloadManager` + `InstallationManager`)

Source, in priority order: `manifest.base_package.url` → Settings → `config/defaults.json`
(`clients.<id>.basePackage.url`).

| Step | What happens |
|---|---|
| Download | To `<installDir>/downloads/<client>.zip.part`. Progress, speed, ETA, cancel. Resumes with HTTP `Range` (+ `If-Range` ETag) after cancel / network loss / restart. Stall timeout 60 s. |
| Google Drive | Share links (`/file/d/<id>/view`, `?id=`) become `drive.usercontent.google.com/download`. The large-file "can't scan for viruses" page is parsed and followed. Quota / private-file pages produce clear errors. **Folder links are rejected** — the link must be to the ZIP file. |
| Verify download | Size must match `Content-Length`/`size`. SHA-256 checked when the publisher provides `sha256`. Only then is `.part` renamed. |
| Disk space | Free space ≥ uncompressed size (+2 % + 512 MB), from the ZIP central directory. |
| Extract | Into `<installDir>/.staging-<client>`, never into the live folder. The package root folder (`ChromieCraft_3.3.5a/`) is stripped. Every entry: no `..`, no absolute paths, no symlinks, no reserved Windows names; **CRC-32 verified**. ZIP64 supported. |
| Validate | `requiredFiles` + `executable` must exist (see `config/defaults.json`). |
| Configure | Realmlist written to `Data/<locale>/realmlist.wtf`, `Data/realmlist.wtf`, `WTF/Config.wtf` (`SET realmList`). |
| Reinstall | `WTF/Account` and `Screenshots` are moved from the old install into the new one. |
| Swap | `staging → <installDir>/<client>`; old folder removed afterwards. An interrupted install leaves the previous one intact. |
| State | `<client>/.olk-install.json` (`version`, `locale`, `realmlist`, `installedAt`, …). PLAY is only enabled when this state exists **and** all required files are present. |

Measured on this project's real package (1,478 entries, 35.4 GB, Windows SSD): **177 s** to
verify + extract + configure.

## 2. Manifest format (schema_version 1)

Served by `GET /launcher/v1/manifest/{client}` (see API_CONTRACT.md) **or**, while that route does
not exist, as a plain static file at `clients.<id>.manifestUrl` (Settings → *update manifest URL*,
or `config/defaults.json`). Any HTTPS host works (R2, S3, GitHub raw, the website). The launcher
uses the API when it is online, otherwise the static URL; both go through the same validation.

| Field | Type | Rules |
|---|---|---|
| `schema_version` | int | must be `1` |
| `client` | string | must equal the requested client id |
| `architecture` | `x86` \| `x64` \| `arm64` | |
| `version` | semver | version this manifest describes, e.g. `1.0.1` |
| `min_launcher_version` | semver? | older launchers refuse and ask the player to update |
| `published_at` | ISO date? | informational |
| `executable` | rel path? | informational (launcher uses its config) |
| `realmlist` | `host[:port]`? | when present, **overrides** the launcher's realmlist on update |
| `base_package` | object? | `{ url, size?, sha256?, root?, version? }` — for new installs |
| `files` | array | `{ path, size, sha256, url }` — max 50,000 |
| `deleted_files` | array | relative paths to delete |

Validation (`ManifestService.validateManifest`): the whole manifest is rejected if **any** rule
fails — non-semver version, wrong client, bad hash (must be 64 hex), non-HTTPS URL, negative
size, duplicate path (case-insensitive), absolute path, `..`, Windows reserved names, paths
starting with `.olk` (launcher-reserved), or a path present in both `files` and `deleted_files`.

`files` should list the files **managed by updates** — at minimum everything that changed since
the base package. Listing every file is allowed (it turns "Repair" into a full integrity check)
but first-time hashing of 35 GB takes a few minutes.

## 3. Update algorithm (`UpdateManager`)

```
plan(manifest):
  for f in files:
    local missing or size ≠ f.size            → download
    else sha256(local) ≠ f.sha256             → download
         (hash cache .olk-hashes.json keyed by size+mtime → unchanged files are not re-hashed;
          "Repair" ignores the cache and re-hashes everything)
  toDelete = deleted_files ∩ existing − protected
  upToDate = nothing to do and installed version == manifest.version

apply(plan):
  1. download each file → <game>/.olk-update/staging/<path>  (resume + SHA-256 verified)
     (files already fully downloaded by an interrupted run are reused)
  2. swap: old → .olk-update/backup/<path>, staged → <path>   (rollback on any error)
  3. delete toDelete
  4. update hash cache, write version to .olk-install.json, remove .olk-update/
```

Guarantees:

- Nothing in the game folder changes until **every** file of the batch is downloaded and verified.
- Files already correct are never downloaded again.
- Deletion happens **only** for paths in `deleted_files`, never for `WTF/Account/**`,
  `Screenshots/**` or launcher files (`.olk*`).
- No manifest can write outside the client folder (`pathSafety.resolveInside`).
- Files in use (game open) → `FILES_IN_USE`, rollback, retry later.

Binary diffs are intentionally not implemented in v1.

## 4. Client isolation

Each client (`wow32`, `wow64`, future ids) has its own folder `<installDir>/<id>`, its own
manifest, state file and hash cache. Nothing is shared. Adding a client = add an entry to
`config/defaults.json` (`clients.<id>`) and publish its manifest; no code changes.
