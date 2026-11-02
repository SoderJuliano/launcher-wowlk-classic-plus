import { reactive } from 'vue'

/** Single reactive mirror of the main-process state. */
export const store = reactive({
  ready: false,
  snap: null,
  progress: null,
  skippedLogin: false,
  toast: null
})

let toastTimer
export function toast(message, kind = 'error') {
  store.toast = { message, kind }
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (store.toast = null), 6000)
}

/** Calls the bridge; returns data or throws { code, message }. */
export async function call(name, ...args) {
  const r = await window.olk[name](...args)
  if (!r?.ok) throw r?.error || { code: 'UNEXPECTED', message: 'Unexpected error' }
  return r.data
}

export async function initStore() {
  window.olk.on('state', (s) => {
    store.snap = s
    if (!s.task) store.progress = null
  })
  window.olk.on('progress', (p) => (store.progress = p))
  store.snap = await call('state')
  store.ready = true
}

export const fmtBytes = (n) => {
  if (n == null || !Number.isFinite(n)) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i >= 3 ? 2 : i ? 1 : 0)} ${u[i]}`
}
