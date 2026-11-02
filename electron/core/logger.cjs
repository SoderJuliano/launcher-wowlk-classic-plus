'use strict'
/** Tiny rotating file logger (diagnostics). Never logs passwords or tokens. */
const fs = require('node:fs')
const path = require('node:path')

const MAX_BYTES = 2 * 1024 * 1024
let file = null

function init(dir) {
  fs.mkdirSync(dir, { recursive: true })
  file = path.join(dir, 'launcher.log')
  try {
    if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`)
  } catch { /* first run */ }
}

const REDACT = /("?(password|access_token|refresh_token|token|authorization)"?\s*[:=]\s*)("[^"]*"|\S+)/gi

function write(level, msg, extra) {
  let line = `${new Date().toISOString()} [${level}] ${msg}`
  if (extra !== undefined) line += ' ' + (extra instanceof Error ? extra.stack || extra.message : JSON.stringify(extra))
  line = line.replace(REDACT, '$1"***"')
  if (process.env.OLK_LOG_STDOUT) console.log(line)
  if (file) {
    try { fs.appendFileSync(file, line + '\n') } catch { /* disk full / readonly */ }
  }
}

module.exports = {
  init,
  get file() { return file },
  info: (m, e) => write('INFO', m, e),
  warn: (m, e) => write('WARN', m, e),
  error: (m, e) => write('ERROR', m, e)
}
