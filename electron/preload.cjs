'use strict'
// Minimal, explicit bridge. The renderer has no Node access.
const { contextBridge, ipcRenderer } = require('electron')

const CALLS = ['state', 'locate', 'login', 'logout', 'checkApi', 'selectClient', 'install', 'update', 'repair', 'cancel', 'play', 'clearError', 'saveSettings', 'openGameFolder', 'openLogs', 'openWebsite', 'pickFolder', 'pickFile', 'window', 'version', 'installWine']
const EVENTS = ['state', 'progress']

const api = {}
for (const c of CALLS) api[c] = (...args) => ipcRenderer.invoke(`olk:${c}`, ...args)
api.on = (event, cb) => {
  if (!EVENTS.includes(event)) throw new Error(`Unknown event ${event}`)
  const listener = (_e, payload) => cb(payload)
  ipcRenderer.on(`olk:${event}`, listener)
  return () => ipcRenderer.removeListener(`olk:${event}`, listener)
}

contextBridge.exposeInMainWorld('olk', api)
