'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const yazl = require('yazl')
const { ConfigurationManager } = require('../electron/core/ConfigurationManager.cjs')

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function tmpDir(prefix = 'olk-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** Config pointing at a temp data dir, with a fake client layout mirroring the real package. */
function makeConfig(dataDir, overrides = {}) {
  const defaultsFile = path.join(__dirname, '..', 'config', 'defaults.json')
  const cfg = new ConfigurationManager({ defaultsFile, dataDir })
  cfg.defaults.clients.wow32.requiredFiles = ['Wow.exe', 'Data/common.MPQ', 'Data/{locale}/locale-{locale}.MPQ']
  Object.assign(cfg.defaults, overrides)
  return cfg
}

/** Builds a ZIP. entries: { name: string, data?: Buffer|string, dir?: boolean, mode?: number } */
function makeZip(file, entries) {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile()
    for (const e of entries) {
      if (e.dir) z.addEmptyDirectory(e.name)
      else z.addBuffer(Buffer.from(e.data ?? ''), e.name, { mode: e.mode, compress: e.compress ?? true })
    }
    z.end()
    z.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve).on('error', reject)
  })
}

/** A package that looks like the real ChromieCraft_3.3.5a ZIP. */
function realisticEntries(root = 'ChromieCraft_3.3.5a/') {
  return [
    { name: root, dir: true },
    { name: `${root}Wow.exe`, data: 'MZ fake exe' },
    { name: `${root}Data/common.MPQ`, data: Buffer.alloc(4096, 1) },
    { name: `${root}Data/realmlist.wtf`, data: 'set realmlist old.example\r\n' },
    { name: `${root}Data/enUS/locale-enUS.MPQ`, data: Buffer.alloc(2048, 2) },
    { name: `${root}Data/enUS/realmlist.wtf`, data: 'set realmlist 100.102.36.27\r\n' },
    { name: `${root}WTF/Config.wtf`, data: 'SET locale "enUS"\r\nSET realmList "100.102.36.27"\r\nSET gxApi "d3d9"\r\n' },
    { name: `${root}Interface/AddOns/Test/Test.toc`, data: '## Title: Test' }
  ]
}

/**
 * Tiny HTTP server with Range support. routes: { '/path': { body: Buffer, status?, headers?, slowAfter?: bytes, html?: true } }
 */
function serve(routes) {
  const hits = []
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost')
    const route = routes[u.pathname] || routes[u.pathname + u.search]
    hits.push({ path: u.pathname, search: u.search, range: req.headers.range || null })
    if (!route) { res.writeHead(404); return res.end('nope') }
    if (typeof route === 'function') return route(req, res, u)
    const body = Buffer.from(route.body)
    const headers = { 'Content-Type': route.type || 'application/octet-stream', 'Accept-Ranges': 'bytes', ETag: '"v1"', ...(route.headers || {}) }
    const m = /bytes=(\d+)-/.exec(req.headers.range || '')
    if (m && !route.noRange) {
      const start = Number(m[1])
      if (start >= body.length) { res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }); return res.end() }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`, 'Content-Length': body.length - start })
      return res.end(body.subarray(start))
    }
    res.writeHead(route.status || 200, { ...headers, 'Content-Length': body.length })
    if (route.cutAt) { res.write(body.subarray(0, route.cutAt)); return setTimeout(() => res.destroy(), 20) }
    res.end(body)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`
    resolve({ base, hits, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }) })
  }))
}

module.exports = { sha, tmpDir, makeConfig, makeZip, realisticEntries, serve }
