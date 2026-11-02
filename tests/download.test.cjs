'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { DownloadManager } = require('../electron/core/DownloadManager.cjs')
const { sha, tmpDir, serve } = require('./helpers.cjs')

const BIG = crypto.randomBytes(512 * 1024)

test('downloads, reports progress and verifies SHA-256 before renaming', async () => {
  const srv = await serve({ '/f.bin': { body: BIG } })
  const dir = tmpDir()
  const seen = []
  try {
    const r = await new DownloadManager().download({ url: `${srv.base}/f.bin`, dest: path.join(dir, 'f.bin'), size: BIG.length, sha256: sha(BIG), onProgress: (p) => seen.push(p.received) })
    assert.equal(r.sha256, sha(BIG))
    assert.ok(fs.readFileSync(path.join(dir, 'f.bin')).equals(BIG))
    assert.ok(!fs.existsSync(path.join(dir, 'f.bin.part')))
    assert.equal(seen.at(-1), BIG.length)
  } finally { await srv.close() }
})

test('rejects a file whose SHA-256 does not match and leaves nothing behind', async () => {
  const srv = await serve({ '/f.bin': { body: BIG } })
  const dir = tmpDir()
  try {
    await assert.rejects(new DownloadManager().download({ url: `${srv.base}/f.bin`, dest: path.join(dir, 'f.bin'), sha256: 'b'.repeat(64) }), { code: 'CHECKSUM_MISMATCH' })
    assert.deepEqual(fs.readdirSync(dir), [])
  } finally { await srv.close() }
})

test('interrupted download keeps the .part file and resumes with Range', async () => {
  let cut = true
  const srv = await serve({
    '/f.bin': (req, res) => {
      const m = /bytes=(\d+)-/.exec(req.headers.range || '')
      if (cut && !m) {
        cut = false
        res.writeHead(200, { 'Content-Length': BIG.length, ETag: '"v1"', 'Accept-Ranges': 'bytes' })
        res.write(BIG.subarray(0, 200 * 1024))
        return setTimeout(() => res.destroy(), 30)
      }
      const start = Number(m[1])
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${BIG.length - 1}/${BIG.length}`, 'Content-Length': BIG.length - start, ETag: '"v1"' })
      res.end(BIG.subarray(start))
    }
  })
  const dir = tmpDir()
  const dest = path.join(dir, 'f.bin')
  const dm = new DownloadManager()
  try {
    await assert.rejects(dm.download({ url: `${srv.base}/f.bin`, dest, sha256: sha(BIG) }), (e) => ['NETWORK', 'DOWNLOAD_INCOMPLETE'].includes(e.code))
    const partial = fs.statSync(`${dest}.part`).size
    assert.ok(partial > 0 && partial < BIG.length, `partial=${partial}`)
    assert.ok(!fs.existsSync(dest), 'unverified file must not appear')
    await dm.download({ url: `${srv.base}/f.bin`, dest, sha256: sha(BIG) })
    assert.ok(fs.readFileSync(dest).equals(BIG))
    const resumeHit = srv.hits.find((h) => h.range)
    assert.equal(resumeHit.range, `bytes=${partial}-`)
  } finally { await srv.close() }
})

test('cancellation aborts and keeps progress', async () => {
  const srv = await serve({
    '/slow.bin': (req, res) => {
      res.writeHead(200, { 'Content-Length': BIG.length })
      res.write(BIG.subarray(0, 64 * 1024))
      setTimeout(() => res.end(BIG.subarray(64 * 1024)), 3000).unref()
    }
  })
  const dir = tmpDir()
  const ctrl = new AbortController()
  try {
    const p = new DownloadManager().download({ url: `${srv.base}/slow.bin`, dest: path.join(dir, 's.bin'), signal: ctrl.signal, onProgress: () => ctrl.abort() })
    await assert.rejects(p, { code: 'CANCELLED' })
    assert.ok(fs.existsSync(path.join(dir, 's.bin.part')))
  } finally { await srv.close() }
})

test('follows the Google Drive large-file confirmation page', async () => {
  const srv = await serve({
    '/download': (req, res, u) => {
      if (u.searchParams.get('uuid') === 'u-1') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': BIG.length })
        return res.end(BIG)
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
        <input type="hidden" name="id" value="FILEID1234567890123456"><input type="hidden" name="export" value="download">
        <input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-1"></form>`)
    }
  })
  // Route drive.usercontent.google.com to the local server.
  const fetchImpl = (url, init) => fetch(String(url).replace('https://drive.usercontent.google.com', srv.base), init)
  const dir = tmpDir()
  try {
    const r = await new DownloadManager({ fetchImpl }).download({ url: 'https://drive.google.com/file/d/FILEID1234567890123456/view?usp=sharing', dest: path.join(dir, 'g.zip'), sha256: sha(BIG) })
    assert.equal(r.sha256, sha(BIG))
    assert.equal(srv.hits.length, 2)
  } finally { await srv.close() }
})

test('a Drive FOLDER link is rejected with a clear message', () => {
  assert.throws(() => new DownloadManager().normalizeUrl('https://drive.google.com/drive/folders/1SqSux4J7zJO-3y4foaxE4nviU8ggTotr?usp=sharing'), { code: 'DRIVE_FOLDER' })
})
