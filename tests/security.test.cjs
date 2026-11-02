'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { normalizeRelative, resolveInside, assertSafeUrl } = require('../electron/core/pathSafety.cjs')
const { validateManifest, cmpVersion } = require('../electron/core/ManifestService.cjs')
const drive = require('../electron/core/googleDrive.cjs')
const { cleanTunnelUrl } = require('../electron/core/ApiClient.cjs')

const H = 'a'.repeat(64)

test('path safety rejects traversal, absolute, reserved and odd names', () => {
  for (const bad of ['../x', 'Data/../../x', '/etc/passwd', 'C:\\Windows\\x', '\\\\server\\share', 'Data/CON', 'a/b?.mpq', 'trail. ', '', 'a\0b']) {
    assert.throws(() => normalizeRelative(bad), { code: 'UNSAFE_PATH' }, bad)
  }
  assert.equal(normalizeRelative('Data\\enUS\\patch-enUS.MPQ'), 'Data/enUS/patch-enUS.MPQ')
  assert.equal(normalizeRelative('./Data//common.MPQ'), 'Data/common.MPQ')
  const root = path.resolve('/tmp/olk-root')
  assert.equal(resolveInside(root, 'Data/x.mpq'), path.join(root, 'Data', 'x.mpq'))
  assert.throws(() => resolveInside(root, '../olk-root2/x'), { code: 'UNSAFE_PATH' })
})

test('only https URLs (http allowed for localhost dev)', () => {
  assert.ok(assertSafeUrl('https://cdn.example.com/a'))
  assert.ok(assertSafeUrl('http://127.0.0.1:9/a'))
  assert.throws(() => assertSafeUrl('http://cdn.example.com/a'), { code: 'UNSAFE_URL' })
  assert.throws(() => assertSafeUrl('file:///etc/passwd'), { code: 'UNSAFE_URL' })
  assert.throws(() => assertSafeUrl('javascript:alert(1)'), { code: 'UNSAFE_URL' })
})

test('manifest validation accepts a correct manifest', () => {
  const m = validateManifest({
    schema_version: 1, client: 'wow32', architecture: 'x86', version: '1.0.1', min_launcher_version: '0.1.0',
    executable: 'Wow.exe', realmlist: 'realm.example.com:3724',
    files: [{ path: 'Data\\patch-5.MPQ', size: 10, sha256: H.toUpperCase(), url: 'https://cdn.example.com/wow32/Data/patch-5.MPQ' }],
    deleted_files: ['Data/patch-old.MPQ']
  }, 'wow32')
  assert.equal(m.files[0].path, 'Data/patch-5.MPQ')
  assert.equal(m.files[0].sha256, H)
})

test('manifest validation rejects malicious or malformed manifests', () => {
  const base = { schema_version: 1, client: 'wow32', architecture: 'x86', version: '1.0.0', files: [], deleted_files: [] }
  const bad = [
    { ...base, client: 'wow64' },
    { ...base, schema_version: 2 },
    { ...base, version: 'latest' },
    { ...base, files: [{ path: '../../evil.exe', size: 1, sha256: H, url: 'https://x.example/e' }] },
    { ...base, files: [{ path: '/etc/cron.d/x', size: 1, sha256: H, url: 'https://x.example/e' }] },
    { ...base, files: [{ path: 'Wow.exe', size: 1, sha256: 'nothex', url: 'https://x.example/e' }] },
    { ...base, files: [{ path: 'Wow.exe', size: 1, sha256: H, url: 'http://x.example/e' }] },
    { ...base, files: [{ path: 'Wow.exe', size: -1, sha256: H, url: 'https://x.example/e' }] },
    { ...base, files: [{ path: 'a.mpq', size: 1, sha256: H, url: 'https://x/e' }, { path: 'A.MPQ', size: 1, sha256: H, url: 'https://x/e' }] },
    { ...base, files: [{ path: '.olk-install.json', size: 1, sha256: H, url: 'https://x/e' }] },
    { ...base, deleted_files: ['../../home'] },
    { ...base, realmlist: 'evil"; rm -rf' }
  ]
  for (const m of bad) assert.throws(() => validateManifest(m, 'wow32'), (e) => ['MANIFEST_INVALID', 'UNSAFE_PATH', 'UNSAFE_URL'].includes(e.code), JSON.stringify(m))
})

test('semver comparison', () => {
  assert.ok(cmpVersion('0.1.0', '0.2.0') < 0)
  assert.ok(cmpVersion('1.10.0', '1.9.9') > 0)
  assert.equal(cmpVersion('1.0.0', '1.0.0-beta'), 0)
})

test('google drive link handling', () => {
  assert.equal(drive.extractFileId('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=sharing'), '1AbCdEfGhIjKlMnOpQrStUvWxYz012345')
  assert.equal(drive.extractFileId('https://drive.google.com/uc?id=1AbCdEfGhIjKlMnOpQrStUvWxYz012345&export=download'), '1AbCdEfGhIjKlMnOpQrStUvWxYz012345')
  assert.equal(drive.extractFileId('https://evil.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345'), null)
  assert.ok(drive.isDriveFolder('https://drive.google.com/drive/folders/1SqSux4J7zJO-3y4foaxE4nviU8ggTotr?usp=sharing'))
  const html = `<html><form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
    <input type="hidden" name="id" value="FILEID12345678901234567"><input type="hidden" name="export" value="download">
    <input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="abc-123"></form></html>`
  const next = new URL(drive.parseInterstitial(html))
  assert.equal(next.hostname, 'drive.usercontent.google.com')
  assert.equal(next.searchParams.get('uuid'), 'abc-123')
  assert.throws(() => drive.parseInterstitial('<html>Too many users have viewed or downloaded this file recently</html>'), { code: 'DRIVE_QUOTA' })
  assert.throws(() => drive.parseInterstitial('<form id="download-form" action="https://evil.example/download"></form>'), { code: 'DRIVE_UNEXPECTED' })
})

test('tunnel URL cleanup follows Pikachu fetchTunnelUrl rules', () => {
  assert.equal(cleanTunnelUrl('  https://abc.ngrok-free.dev///  '), 'https://abc.ngrok-free.dev')
  assert.equal(cleanTunnelUrl('not a url'), null)
  assert.equal(cleanTunnelUrl(undefined), null)
})
