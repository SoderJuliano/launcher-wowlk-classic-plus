'use strict'
const fs = require('node:fs')
const crypto = require('node:crypto')

/** Streams a file through SHA-256. Reports progress in bytes. */
function sha256File(file, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file, { highWaterMark: 1 << 20, signal })
    stream.on('data', (chunk) => { hash.update(chunk); onProgress?.(chunk.length) })
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

const isSha256 = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/i.test(s)

module.exports = { sha256File, isSha256 }
