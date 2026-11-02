# Pikachu API — Launcher contract (v1)

Everything another developer needs to implement the server side for the **OLK Plus Launcher**.
The launcher already implements the client side of every route below
(`electron/core/ApiClient.cjs`, `AuthenticationService.cjs`, `ManifestService.cjs`) and
is tested against a reference mock (`tests/api-auth.test.cjs`).

> Abra API is **not** used for authentication. It is only used to discover Pikachu's current URL.

---

## 1. Base URL

The Pikachu tunnel URL changes, so the launcher discovers it at startup:

```
GET https://abra-api.top/notifications/retrieve?key=ngrockurl
→ [ { "content": "https://xxxx.ngrok-free.dev", ... }, ... ]
```

Rule (same as Pikachu's `fetchTunnelUrl()`): take the **last** item, `content.trim()`,
strip trailing `/`, accept only if it starts with `http`. The URL is confirmed with
`GET /launcher/v1/health`. If a request fails with a network error, the launcher
rediscovers once and retries. Users can override the URL in Settings.

All routes live under:

```
{BASE}/launcher/v1
```

HTTPS is required (ngrok provides it). Plain HTTP is accepted by the launcher only for
`localhost`/`127.0.0.1` during development.

## 2. Common rules

### Request headers sent by the launcher

| Header | Value |
|---|---|
| `Accept` | `application/json` |
| `Content-Type` | `application/json` (requests with a body) |
| `User-Agent` | `OLKPlusLauncher` |
| `X-Launcher-Version` | launcher semver, e.g. `0.1.0` |
| `ngrok-skip-browser-warning` | `true` (avoids ngrok's HTML interstitial) |
| `Authorization` | `Bearer <access_token>` on authenticated routes |

### Responses

- Success: `2xx` with a JSON body (or `204` with no body).
- Errors: **always** this envelope, with a stable `code`:

```json
{ "error": { "code": "INVALID_CREDENTIALS", "message": "Invalid username or password." } }
```

`message` may be shown to the player; keep it short, in English, without internal details.
A `Retry-After` header (seconds) is honoured on `429` and `503`.

### Error codes

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION` | Malformed body / missing fields |
| 401 | `INVALID_CREDENTIALS` | Wrong password **or account does not exist** (never distinguish) |
| 401 | `UNAUTHORIZED` | Missing / invalid / expired access token |
| 401 | `INVALID_REFRESH_TOKEN` | Refresh token unknown, expired, revoked or already rotated |
| 403 | `EMAIL_NOT_VERIFIED` | Account exists but e-mail not confirmed yet (account still `locked`) |
| 403 | `ACCOUNT_LOCKED` | Account locked for any other reason |
| 403 | `ACCOUNT_BANNED` | Active row in `account_banned` (message may include the end date) |
| 404 | `NOT_FOUND` | Unknown client id / route |
| 426 | `LAUNCHER_OUTDATED` | `X-Launcher-Version` below the minimum the server supports |
| 429 | `RATE_LIMITED` | Too many attempts (see §7) |
| 500 | `INTERNAL` | Unexpected error |
| 503 | `MAINTENANCE` | Planned maintenance |

The launcher maps any other status to a generic message, so new codes are safe to add.

---

## 3. `GET /health`

No auth. Used for the "server online" indicator and to validate a discovered URL.

```json
200 { "service": "pikachu", "api_version": 1, "maintenance": false, "time": "2026-11-01T12:00:00Z" }
```

`service` **must** be `"pikachu"` and `api_version` `1`. A `404` here makes the launcher show
"Launcher API pending" (the state today, since the route does not exist yet).

---

## 4. Authentication

Accounts are the AzerothCore `acore_auth.account` rows created from the website queue.

### 4.1 `POST /auth/login`

```json
{
  "username": "ARTHAS",
  "password": "Frostmourne1",
  "client": { "launcher_version": "0.1.0", "platform": "win32" }
}
```

- `username`: 1–32 chars; compare **case-insensitively** (AzerothCore stores it upper-case).
- `password`: ≤ 64 chars (the game limits it to 16). Never log it.
- `client.platform`: `win32` | `linux` | `darwin` (telemetry only).

**Password check (SRP6, no plain password is stored anywhere):**

```js
// Node — same algorithm the website uses to create the verifier.
const N = BigInt('0x894B645E89E1535BBDAD5B8B290650530801B18EBFBF5E8FAB3C82872A3E9BB7'), g = 7n
const sha1 = (...b) => crypto.createHash('sha1').update(Buffer.concat(b)).digest()
const le = (buf) => BigInt('0x' + Buffer.from(buf).reverse().toString('hex'))
function verifierFor(username, password, salt /* Buffer(32) from account.salt */) {
  const h1 = sha1(Buffer.from(`${username.toUpperCase()}:${password.toUpperCase()}`))
  const x = le(sha1(salt, h1))
  let v = 1n, b = g % N, e = x
  while (e > 0n) { if (e & 1n) v = (v * b) % N; b = (b * b) % N; e >>= 1n }
  return Buffer.from(v.toString(16).padStart(64, '0'), 'hex').reverse() // 32 bytes LE
}
// valid = crypto.timingSafeEqual(verifierFor(u, p, row.salt), row.verifier)
```

Order of checks: rate limit → account lookup → verifier (do the work even when the account
does not exist, to keep timing uniform) → `account_banned` → `locked` / e-mail verification.

**200 OK**

```json
{
  "access_token": "eyJ…",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "r_8f3c…",
  "refresh_expires_in": 2592000,
  "user": { "id": 123, "username": "ARTHAS", "email_verified": true }
}
```

| Field | Rule |
|---|---|
| `access_token` | JWT or opaque. Short-lived: **15 min recommended** (`expires_in`, seconds). |
| `refresh_token` | Opaque, ≥ 32 random bytes, **stored hashed** server-side. 30 days recommended. |
| `user.id` | `account.id` |
| `user.username` | Canonical (upper-case) name |

Errors: `400 VALIDATION`, `401 INVALID_CREDENTIALS`, `403 EMAIL_NOT_VERIFIED | ACCOUNT_LOCKED | ACCOUNT_BANNED`, `429`, `503`.

### 4.2 `POST /auth/refresh`

```json
{ "refresh_token": "r_8f3c…" }
```

Returns the same body as login. **Rotate** the refresh token on every call (invalidate the old
one). Re-check ban/lock status. Errors: `401 INVALID_REFRESH_TOKEN` (launcher then asks for
login again).

The launcher refreshes automatically when the access token has < 60 s left, and on startup
when the player chose "Keep me signed in" (only the refresh token is kept, encrypted with the
OS keystore).

### 4.3 `POST /auth/logout`

Header `Authorization: Bearer <access_token>`, body `{ "refresh_token": "…" }`.
Revoke the refresh token (and the access token if revocable). Respond `204`.
Idempotent: unknown tokens also return `204`. The launcher clears its local session
regardless of the result.

---

## 5. `GET /manifest/{client}`

`client` ∈ `wow32`, `wow64` (future ids are allowed). Requires `Authorization: Bearer`.
Returns the update manifest described in **[UPDATE_SYSTEM.md](UPDATE_SYSTEM.md)**:

```json
{
  "schema_version": 1,
  "client": "wow32",
  "architecture": "x86",
  "version": "1.0.1",
  "min_launcher_version": "0.1.0",
  "published_at": "2026-11-01T12:00:00Z",
  "executable": "Wow.exe",
  "realmlist": "ru2esxz6.free.tryportwarp.cc:16943",
  "base_package": {
    "url": "https://drive.google.com/file/d/<ID>/view",
    "size": 0,
    "sha256": "",
    "root": "ChromieCraft_3.3.5a/",
    "version": "1.0.0"
  },
  "files": [
    { "path": "Data/patch-5.MPQ", "size": 123456, "sha256": "<64 hex>", "url": "https://cdn.example.com/wow32/1.0.1/Data/patch-5.MPQ" }
  ],
  "deleted_files": ["Data/patch-old.MPQ"]
}
```

`404 NOT_FOUND` for unknown/unpublished clients. Cache headers (`ETag`) are welcome.
Serving the manifest from a static file is fine — Pikachu only needs to check the token.

---

## 6. Compatibility rules

- The launcher ignores unknown JSON fields → adding fields is backwards compatible.
- Removing/renaming fields or changing meaning requires `/launcher/v2`.
- `schema_version` of the manifest only changes on breaking manifest changes.
- `min_launcher_version` (manifest) and `426 LAUNCHER_OUTDATED` (any route) force old launchers to update.
- Error `code`s are part of the contract; `message`s are not.

## 7. Server-side security checklist

- HTTPS only; reject requests with bodies > 16 KB on auth routes.
- Rate limit `/auth/login`: per IP (e.g. 10/min) **and** per username (e.g. 5 failures → 15 min lock), respond `429` + `Retry-After`.
- Generic `INVALID_CREDENTIALS` for unknown users and wrong passwords; constant-time comparison.
- Store refresh tokens hashed (SHA-256), rotate on use, revoke all on password reset.
- Never log passwords, tokens or full request bodies of auth routes.
- Read-only DB user for login (SELECT on `account`, `account_banned`); a separate user for writes.
- MySQL never exposed publicly — Pikachu talks to it locally.

## 8. Quick check with curl

```bash
BASE=$(curl -s -H 'Cache-Control: no-cache' 'https://abra-api.top/notifications/retrieve?key=ngrockurl' \
  | jq -r '.[-1].content | gsub("^\\s+|\\s+$"; "") | sub("/+$"; "")')
curl -s -H 'ngrok-skip-browser-warning: true' "$BASE/launcher/v1/health"
curl -s -H 'ngrok-skip-browser-warning: true' -H 'Content-Type: application/json' \
  -d '{"username":"ARTHAS","password":"secret","client":{"launcher_version":"0.1.0","platform":"linux"}}' \
  "$BASE/launcher/v1/auth/login"
```
