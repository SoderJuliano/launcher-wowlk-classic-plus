'use strict'
/**
 * Handoff to the 64-bit client (soder-nextgen), launcher-only start, 27/11/2026.
 *
 * The 64-bit beta/release build has no login fields: it reads ONE JSON line from its standard
 * input, trades the single-use ticket for a session signed (Ed25519) by the launcher API and only
 * then loads anything. Without this line, or with a used/forged ticket, the game closes.
 *
 *   {"v":1,"api":"https://host/launcher/v1","ticket":"...","account":"NAME","pass_hash":"40 hex"}
 *
 * pass_hash = SHA1(UPPER(user) + ":" + UPPER(password)), what the WoW (SRP6) login uses anyway:
 * the real password never reaches the game.
 */
const crypto = require('node:crypto')
const { LauncherError } = require('./errors.cjs')

function passHash(username, password) {
  return crypto.createHash('sha1')
    .update(`${String(username).toUpperCase()}:${String(password).toUpperCase()}`, 'utf8')
    .digest('hex').toUpperCase()
}

function buildHandoff({ apiBase, prefix, ticket, username, password }) {
  if (!username || !password) throw new LauncherError('RELOGIN_REQUIRED', 'Log in again in the launcher to open the 64-bit client.')
  if (!ticket) throw new LauncherError('API_BAD_RESPONSE', 'The server did not issue a game ticket.')
  const api = `${String(apiBase).replace(/\/+$/, '')}${prefix || ''}`
  if (!/^https:\/\//i.test(api)) throw new LauncherError('API_NOT_CONFIGURED', 'The 64-bit client needs an https server address.')
  return { v: 1, api, ticket: String(ticket), account: String(username).toUpperCase(), pass_hash: passHash(username, password) }
}

module.exports = { passHash, buildHandoff }
