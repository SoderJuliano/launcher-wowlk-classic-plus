'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const {
  steamCrc32,
  calculateSteamAppIds,
  parseBinaryVdf,
  isMatchingShortcut,
  installSteamGridArtwork
} = require('../electron/core/steamGrid.cjs')

test('Steam Grid: CRC32 and AppId calculation', () => {
  const ids = calculateSteamAppIds('/home/deck/Downloads/OLK-Plus-Launcher-0.1.20.AppImage', 'OLK Plus Launcher')
  assert.ok(ids.appId32)
  assert.ok(ids.appId64)
  assert.ok(ids.appIdSigned)
  // appId32 must have top bit set (>= 0x80000000)
  assert.ok(Number(ids.appId32) >= 0x80000000)
})

test('Steam Grid: binary VDF parser', () => {
  const buf = Buffer.from([
    0x00, ...Buffer.from('shortcuts\0'),
      0x00, ...Buffer.from('0\0'),
        0x01, ...Buffer.from('AppName\0'), ...Buffer.from('OLK Plus\0'),
        0x01, ...Buffer.from('Exe\0'), ...Buffer.from('/home/deck/Downloads/olk.AppImage\0'),
        0x02, ...Buffer.from('appid\0'), 0x12, 0x34, 0x56, 0x78,
      0x08,
    0x08,
    0x08
  ])
  const res = parseBinaryVdf(buf)
  assert.ok(res?.shortcuts?.['0'])
  assert.equal(res.shortcuts['0'].AppName, 'OLK Plus')
  assert.equal(res.shortcuts['0'].appid, 2018915346)
})

test('Steam Grid: shortcut matching logic', () => {
  assert.equal(isMatchingShortcut({ AppName: 'OLK Plus Launcher', Exe: '/path/app' }), true)
  assert.equal(isMatchingShortcut({ AppName: 'WoW Classic Plus', Exe: '/path/app' }), true)
  assert.equal(isMatchingShortcut({ AppName: 'Other Game', Exe: '/path/olk-plus-launcher' }), true)
  assert.equal(isMatchingShortcut({ AppName: 'Cyberpunk 2077', Exe: '/games/cp2077.exe' }), false)
})

test('Steam Grid: install and export artwork', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'olk-steamgrid-test-'))
  const assetsDir = path.join(tmpDir, 'assets')
  fs.mkdirSync(assetsDir, { recursive: true })

  // Create mock source images
  fs.writeFileSync(path.join(assetsDir, 'hero_1920x620.jpg'), 'hero')
  fs.writeFileSync(path.join(assetsDir, 'poster_600x900.jpg'), 'poster')
  fs.writeFileSync(path.join(assetsDir, 'capsule_460x215.jpg'), 'capsule')
  fs.writeFileSync(path.join(assetsDir, 'logo.png'), 'logo')

  const res = installSteamGridArtwork(assetsDir)
  assert.equal(res.ok, true)
  assert.ok(Array.isArray(res.exportedTo))

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
