'use strict'
/** Typed error with a stable code the UI can translate. */
class LauncherError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'LauncherError'
    this.code = code
    if (details !== undefined) this.details = details
  }
  toJSON() {
    return { code: this.code, message: this.message }
  }
}

const toPlain = (err) =>
  err instanceof LauncherError
    ? err.toJSON()
    : { code: err?.name === 'AbortError' ? 'CANCELLED' : 'UNEXPECTED', message: err?.message || String(err) }

module.exports = { LauncherError, toPlain }
