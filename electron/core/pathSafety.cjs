'use strict'
/**
 * Every path coming from a manifest or a ZIP goes through here.
 * Nothing may ever be written outside the installation directory.
 */
const path = require('node:path')
const { LauncherError } = require('./errors.cjs')

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/** Normalises a relative path ("Data/patch-5.mpq") or throws. Always returns forward slashes. */
function normalizeRelative(rel) {
  if (typeof rel !== 'string' || !rel.length || rel.length > 400) throw new LauncherError('UNSAFE_PATH', `Invalid path: ${rel}`)
  if (rel.includes('\0')) throw new LauncherError('UNSAFE_PATH', 'Path contains NUL byte')
  const unified = rel.replace(/\\/g, '/')
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified) || unified.startsWith('//')) {
    throw new LauncherError('UNSAFE_PATH', `Absolute path not allowed: ${rel}`)
  }
  const parts = unified.split('/').filter((p) => p !== '' && p !== '.')
  if (!parts.length) throw new LauncherError('UNSAFE_PATH', `Empty path: ${rel}`)
  for (const p of parts) {
    if (p === '..') throw new LauncherError('UNSAFE_PATH', `Path traversal not allowed: ${rel}`)
    if (WINDOWS_RESERVED.test(p) || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p)) {
      throw new LauncherError('UNSAFE_PATH', `Invalid path segment "${p}" in ${rel}`)
    }
  }
  return parts.join('/')
}

/** Resolves rel inside root and verifies the result is still inside root. */
function resolveInside(root, rel) {
  const clean = normalizeRelative(rel)
  const base = path.resolve(root)
  const target = path.resolve(base, ...clean.split('/'))
  const relCheck = path.relative(base, target)
  if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new LauncherError('UNSAFE_PATH', `Path escapes install dir: ${rel}`)
  }
  return target
}

/** Only https (and http for localhost during development) download/API URLs are accepted. */
function assertSafeUrl(url, { allowHttpLocalhost = true } = {}) {
  let u
  try { u = new URL(url) } catch { throw new LauncherError('UNSAFE_URL', `Invalid URL: ${url}`) }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (u.protocol === 'https:' || (u.protocol === 'http:' && allowHttpLocalhost && local)) return u
  throw new LauncherError('UNSAFE_URL', `Only HTTPS URLs are allowed: ${url}`)
}

module.exports = { normalizeRelative, resolveInside, assertSafeUrl }
