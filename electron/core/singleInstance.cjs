'use strict'
/**
 * Steam Deck: encontra outras instâncias "órfãs" do launcher que seguram o single-instance lock.
 * Acontecia quando o auto-update antigo fazia app.relaunch() dentro do Modo Jogo: a nova instância
 * nascia fora do Gamescope (invisível), segurava o lock e todo PLAY seguinte na Steam fechava na hora.
 */
const fs = require('node:fs')

function readProc(pid, file) {
  try { return fs.readFileSync(`/proc/${pid}/${file}`, 'latin1') } catch { return null }
}

function parentPid(pid) {
  const stat = readProc(pid, 'stat')
  if (!stat) return 0
  const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return Number(after[1]) || 0 // campos: state ppid ...
}

/** Cadeia de ancestrais (não podemos matar o runtime do AppImage nem o pai que nos rodou como filho). */
function ancestors(pid = process.pid) {
  const out = new Set()
  let p = parentPid(pid)
  for (let i = 0; p > 1 && i < 64; i++) { out.add(p); p = parentPid(p) }
  return out
}

/**
 * PIDs dos processos principais de outras instâncias do launcher (mesmo executável),
 * excluindo este processo, seus ancestrais e os helpers do Electron (--type=...).
 */
function findOtherLauncherPids({ exeName, selfPid = process.pid } = {}) {
  const name = exeName || require('node:path').basename(process.execPath)
  const skip = ancestors(selfPid)
  skip.add(selfPid)
  const pids = []
  let entries = []
  try { entries = fs.readdirSync('/proc') } catch { return [] }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue
    const pid = Number(e)
    if (skip.has(pid)) continue
    const cmd = readProc(pid, 'cmdline')
    if (!cmd) continue
    const argv = cmd.split('\0').filter(Boolean)
    if (!argv.length || argv.some((a) => a.startsWith('--type='))) continue
    const bin = argv[0].split('/').pop()
    if (bin !== name) continue
    if (parentPid(pid) === selfPid) continue
    pids.push(pid)
  }
  return pids
}

module.exports = { findOtherLauncherPids, ancestors, parentPid }
