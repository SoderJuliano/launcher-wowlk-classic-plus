'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const {
  steamCrc32,
  getAllIdsForShortcut,
  parseBinaryVdf,
  serializeBinaryVdf,
  isMatchingShortcut,
  installSteamGridArtwork
} = require('../electron/core/steamGrid.cjs')

test('Steam Grid: CRC32 and getAllIdsForShortcut', () => {
  const item = {
    AppName: 'OLK Plus Launcher',
    Exe: '"/home/deck/Downloads/OLK-Plus-Launcher-0.1.21.AppImage"',
    appid: -126965618
  }
  const ids = getAllIdsForShortcut(item)
  assert.ok(ids.length > 5)
  assert.ok(ids.includes('-126965618'))
  assert.ok(ids.includes('4168001678'))
  assert.ok(ids.includes('17901430896716677120'))
})

test('Steam Grid: binary VDF serialize and parse round-trip', () => {
  const original = {
    "0": {
      "AppName": "OLK Plus Launcher",
      "Exe": "\"/home/deck/Downloads/OLK.AppImage\"",
      "StartDir": "\"/home/deck/Downloads\"",
      "icon": "/path/to/icon.png",
      "appid": -123456
    }
  }
  const buf = serializeBinaryVdf(original)
  const res = parseBinaryVdf(buf)
  assert.ok(res?.shortcuts?.['0'])
  assert.equal(res.shortcuts['0'].AppName, 'OLK Plus Launcher')
  assert.equal(res.shortcuts['0'].appid, -123456)
})

test('Steam Grid: shortcut matching logic', () => {
  assert.equal(isMatchingShortcut({ AppName: 'OLK Plus Launcher', Exe: '/path/app' }), true)
  assert.equal(isMatchingShortcut({ AppName: 'World of Warcraft', Exe: '/path/app' }), true)
  assert.equal(isMatchingShortcut({ AppName: 'ChromieCraft', Exe: '/path/app' }), true)
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
