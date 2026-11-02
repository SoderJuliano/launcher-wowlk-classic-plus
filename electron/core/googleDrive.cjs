'use strict'
/**
 * Google Drive helpers. Large files (>100 MB) do not download directly: Drive answers
 * with an HTML "can't scan this file for viruses" page containing a form with
 * id/export/confirm/uuid fields. We parse that form and follow it.
 */
const { LauncherError } = require('./errors.cjs')

const ID_RE = /^[A-Za-z0-9_-]{20,}$/

function extractFileId(input) {
  const s = String(input ?? '').trim()
  if (ID_RE.test(s)) return s
  let u
  try { u = new URL(s) } catch { return null }
  if (!/(^|\.)google\.com$/.test(u.hostname) && !/(^|\.)googleusercontent\.com$/.test(u.hostname)) return null
  if (u.pathname.includes('/folders/')) return null
  const m = u.pathname.match(/\/file\/d\/([A-Za-z0-9_-]+)/) || u.pathname.match(/\/d\/([A-Za-z0-9_-]+)/)
  if (m) return m[1]
  const id = u.searchParams.get('id')
  return id && ID_RE.test(id) ? id : null
}

const isDriveUrl = (url) => {
  try { return /(^|\.)(drive|docs)\.google\.com$|(^|\.)drive\.usercontent\.google\.com$/.test(new URL(url).hostname) } catch { return false }
}

function isDriveFolder(url) {
  try { return new URL(url).pathname.includes('/folders/') } catch { return false }
}

/** Extracts the folder id from a /drive/folders/<id> link. */
function extractFolderId(url) {
  try { return new URL(url).pathname.match(/\/folders\/([A-Za-z0-9_-]+)/)?.[1] ?? null } catch { return null }
}

/** Parses Drive's public embedded folder view: [{ id, name }] for every file entry. */
function parseFolderListing(html) {
  const out = []
  for (const m of html.matchAll(/id="entry-([A-Za-z0-9_-]{20,})"[\s\S]*?flip-entry-title">([^<]+)</g)) out.push({ id: m[1], name: m[2].trim() })
  return out
}

const directDownloadUrl = (id) => `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`

/** Parses the virus-scan interstitial. Returns the follow-up URL or throws a descriptive error. */
function parseInterstitial(html) {
  if (/quota|Too many users have viewed or downloaded/i.test(html) && !/download-form/.test(html)) {
    throw new LauncherError('DRIVE_QUOTA', 'Google Drive download quota exceeded for this file. Try again later.')
  }
  if (/ServiceLogin|accounts\.google\.com/i.test(html) && !/download-form/.test(html)) {
    throw new LauncherError('DRIVE_PRIVATE', 'The Google Drive file is not shared publicly ("Anyone with the link").')
  }
  const form = html.match(/<form[^>]*id="download-form"[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i)
  if (!form) throw new LauncherError('DRIVE_UNEXPECTED', 'Google Drive returned an unexpected page instead of the file.')
  const action = form[1].replace(/&amp;/g, '&')
  const url = new URL(action)
  for (const m of form[2].matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)) {
    url.searchParams.set(m[1], m[2].replace(/&amp;/g, '&'))
  }
  if (url.hostname !== 'drive.usercontent.google.com') throw new LauncherError('DRIVE_UNEXPECTED', 'Unexpected Google Drive redirect.')
  return url.toString()
}

module.exports = { extractFileId, extractFolderId, parseFolderListing, isDriveUrl, isDriveFolder, directDownloadUrl, parseInterstitial }
