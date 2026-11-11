<script setup>
import { computed, ref } from 'vue'
import { store, call, toast, fmtBytes } from '../store.js'
import ApiStatus from './ApiStatus.vue'
import Icon from './Icon.vue'
import SettingsDialog from './SettingsDialog.vue'

const settingsOpen = ref(false)
const snap = computed(() => store.snap)
const client = computed(() => snap.value.clients.find((c) => c.id === snap.value.selectedClient) || snap.value.clients[0])
const busy = computed(() => !!snap.value.task)
const p = computed(() => (store.progress && store.progress.id === client.value.id ? store.progress : null))
const pct = computed(() => {
  if (snap.value.task?.kind === 'wine' && snap.value.task.total) {
    return Math.min(100, (snap.value.task.done / snap.value.task.total) * 100)
  }
  return p.value?.total ? Math.min(100, (p.value.done / p.value.total) * 100) : 0
})

const BUTTON = {
  INSTALL: { label: 'Install', icon: 'download' },
  DOWNLOADING: { label: 'Downloading', busy: true },
  INSTALLING: { label: 'Installing', busy: true },
  VERIFYING: { label: 'Verifying', busy: true },
  UPDATING: { label: 'Updating', busy: true },
  UPDATE: { label: 'Update', icon: 'refresh' },
  PLAY: { label: 'Play', icon: 'play' },
  RUNNING: { label: 'Running', disabled: true },
  REPAIR: { label: 'Repair', icon: 'wrench' },
  ERROR: { label: 'Retry', icon: 'refresh', error: true },
  UNAVAILABLE: { label: 'Coming soon', disabled: true }
}
const btn = computed(() => BUTTON[client.value.button] || BUTTON.INSTALL)

const STAGE_TEXT = { download: 'Downloading game package', extract: 'Installing files', verify: 'Verifying files', update: 'Downloading updates', starting: 'Preparing' }
const statusLine = computed(() => {
  const c = client.value
  if (snap.value.task?.kind === 'wine') {
    const t = snap.value.task
    if (t.stage === 'extract') return 'Instalando Wine Runner (extraindo arquivos)…'
    return `Baixando Wine Runner — ${fmtBytes(t.done)} de ${fmtBytes(t.total)}${t.bytesPerSec ? ` · ${fmtBytes(t.bytesPerSec)}/s` : ''}`
  }
  if (p.value) {
    const base = STAGE_TEXT[p.value.stage] || 'Working'
    if (p.value.stage === 'verify') return `${base} — ${p.value.done} / ${p.value.total}`
    return `${base} — ${fmtBytes(p.value.done)} of ${fmtBytes(p.value.total)}${p.value.bytesPerSec ? ` · ${fmtBytes(p.value.bytesPerSec)}/s` : ''}`
  }
  if (busy.value) return 'Preparing…'
  if (c.error) return c.error.message
  if (!c.available) return 'This client is in development and not available yet.'
  if (c.running) return 'The game is running.'
  if (c.installed && c.located && !c.updateAvailable) return `Ready to play · using your existing folder${c.version ? ` · version ${c.version}` : ''}`
  if (c.installed) return c.updateAvailable ? `Update available: ${c.version ?? 'base'} → ${c.latestVersion}` : `Ready to play${c.version ? ` · version ${c.version}` : ''}`
  if (c.missing?.length) return `Installation incomplete — missing ${c.missing.length} file(s).`
  if (!c.hasPackageSource) return 'Not installed. Already have the game? Click "Locate game" and select its folder.'
  return 'Not installed. Install (about 35 GB) or locate an existing installation.'
})
const eta = computed(() => {
  if (!p.value?.bytesPerSec || !p.value.total || p.value.stage === 'verify') return ''
  const s = (p.value.total - p.value.done) / p.value.bytesPerSec
  if (!Number.isFinite(s) || s <= 0) return ''
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60)
  return h ? `${h} h ${m} min left` : `${m || 1} min left`
})

async function run(action, ...args) {
  try { await call(action, ...args) } catch (e) { if (e.code !== 'CANCELLED') toast(e.message) }
}
let lastMainTime = 0
function main(e) {
  const now = Date.now()
  if (now - lastMainTime < 400) return
  lastMainTime = now
  const c = client.value
  switch (c.button) {
    case 'INSTALL': case 'REPAIR': return run('install', c.id)
    case 'UPDATE': return run('update', c.id)
    case 'PLAY': return run('play', c.id)
    case 'ERROR': call('clearError', c.id); return c.installed ? run('play', c.id) : run('install', c.id)
  }
}
const select = (id) => !busy.value && run('selectClient', id)
async function locate() {
  try {
    const r = await call('locate', client.value.id)
    if (r) toast('Game found and ready to play.', 'info')
  } catch (e) { toast(e.message) }
}
async function installWine() {
  try {
    toast('Iniciando download do Wine Runner…', 'info')
    await call('installWine')
    toast('Wine Runner instalado e configurado com sucesso!', 'info')
  } catch (e) {
    if (e.code !== 'CANCELLED') toast(`Falha ao instalar Wine: ${e.message}`)
  }
}
const logout = () => run('logout').then(() => (store.skippedLogin = false))
const ARCH = { x86: '32-bit', x64: '64-bit' }
</script>

<template>
  <div class="home">
    <aside class="side">
      <p class="side__h">Game client</p>
      <button
        v-for="c in snap.clients" :key="c.id" type="button" class="cc"
        :class="{ 'is-sel': c.id === client.id, 'is-off': !c.available }" :disabled="busy && c.id !== client.id"
        @click="select(c.id)" @pointerup.stop.prevent="select(c.id)"
      >
        <span class="cc__bits">{{ ARCH[c.architecture]?.slice(0, 2) }}<small>bit</small></span>
        <span class="cc__txt">
          <b>{{ ARCH[c.architecture] }} client</b>
          <small>{{ !c.available ? 'In development' : c.installed ? (c.version ? `Installed · v${c.version}` : 'Installed') : 'Not installed' }}</small>
        </span>
        <span class="cc__dot" :class="c.installed ? 'ok' : c.available ? 'idle' : 'off'" />
      </button>

      <div class="side__links">
        <button v-if="client.available" type="button" class="lnk" :disabled="busy" @click="locate" @pointerup.stop.prevent="locate"><Icon name="folder" /> Locate installed game</button>
        <button type="button" class="lnk" @click="settingsOpen = true" @pointerup.stop.prevent="settingsOpen = true"><Icon name="gear" /> Settings</button>
        <button type="button" class="lnk" @click="run('openGameFolder', client.id)" @pointerup.stop.prevent="run('openGameFolder', client.id)"><Icon name="folder" /> Game folder</button>
        <button type="button" class="lnk" @click="run('openWebsite')" @pointerup.stop.prevent="run('openWebsite')"><Icon name="globe" /> Website</button>
        <button type="button" class="lnk" @click="run('openLogs')" @pointerup.stop.prevent="run('openLogs')"><Icon name="log" /> Logs</button>
      </div>
    </aside>

    <section class="stage">
      <header class="stage__top">
        <ApiStatus />
        <div class="who">
          <template v-if="snap.user"><Icon name="user" /> {{ snap.user.username }}
            <button type="button" class="btn btn--ghost btn--icon" title="Log out" aria-label="Log out" @click="logout"><Icon name="logout" /></button>
          </template>
          <button v-else type="button" class="btn btn--ghost" @click="store.skippedLogin = false"><Icon name="lock" /> Sign in</button>
        </div>
      </header>

      <div class="hero">
        <p class="hero__kicker">Wrath of the Lich King · 3.3.5a · Free to play</p>
        <h1 class="hero__title"><span>Classic Plus</span> <em>LK</em></h1>
        <p class="hero__tag">The Classic Experience, Evolved.</p>
        <dl class="hero__facts">
          <div><dt>Client</dt><dd>{{ client.name }}</dd></div>
          <div><dt>Realm</dt><dd>{{ snap.settings.realmlist }}</dd></div>
          <div><dt>Platform</dt><dd>{{ snap.platform.label }}<template v-if="snap.wine?.needed"> · Wine {{ snap.wine.found ? snap.wine.version || 'found' : 'not found' }}</template></dd></div>
          <div v-if="snap.wine?.needed"><dt>Steam Deck</dt><dd>Teclado: <b>STEAM + X</b></dd></div>
        </dl>
        <div v-if="snap.wine?.needed && !snap.wine.found" class="alert alert--warn hero__warn wine-alert">
          <Icon name="alert" :size="16" />
          <div class="wine-alert__content">
            <p><strong>Compatibilidade Linux / Steam Deck:</strong> O Wine é necessário para executar o jogo.</p>
            <button
              type="button" class="btn btn--wine" :disabled="busy"
              @click="installWine"
            >
              <span v-if="busy && snap.task?.kind === 'wine'" class="spinner" />
              <Icon v-else name="download" :size="14" />
              {{ busy && snap.task?.kind === 'wine' ? 'Instalando Wine Runner…' : 'Instalar Wine Runner Automático (~110 MB)' }}
            </button>
          </div>
        </div>
      </div>

      <footer class="bar panel">
        <div class="bar__info">
          <div class="bar__status" :class="{ 'is-err': client.error && !busy }">
            <Icon v-if="client.error && !busy" name="alert" :size="15" />
            <span>{{ statusLine }}</span>
          </div>
          <div class="bar__track" :class="{ 'is-active': busy }" role="progressbar" :aria-valuenow="Math.round(pct)" aria-valuemin="0" aria-valuemax="100">
            <span class="bar__fill" :style="{ width: (busy ? pct : client.installed ? 100 : 0) + '%' }" />
          </div>
          <div class="bar__sub">
            <span v-if="p?.file" class="bar__file">{{ p.file }}</span>
            <span v-else>{{ client.installDir }}</span>
            <span v-if="busy" class="bar__pct">{{ eta ? `${eta} · ` : '' }}{{ pct.toFixed(1) }}%</span>
          </div>
        </div>

        <div class="bar__actions">
          <button v-if="busy" type="button" class="btn btn--danger" @click="run('cancel')" @pointerup.stop.prevent="run('cancel')"><Icon name="stop" /> Cancel</button>
          <button v-else-if="client.available && !client.installed" type="button" class="btn btn--ghost" title="Already have the game? Select its folder" @click="locate" @pointerup.stop.prevent="locate"><Icon name="folder" /> Locate game</button>
          <button v-else-if="client.installed && client.available && client.latestVersion" type="button" class="btn btn--ghost" title="Check and repair game files" @click="run('repair', client.id)" @pointerup.stop.prevent="run('repair', client.id)"><Icon name="wrench" /> Repair</button>
          <button
            type="button" class="main" :class="{ 'main--busy': btn.busy, 'main--err': btn.error, 'main--play': client.button === 'PLAY' }"
            :disabled="btn.busy || btn.disabled || (busy && !btn.busy)"
            @click="main"
            @pointerup.stop.prevent="main"
            @touchend.stop.prevent="main"
          >
            <span v-if="btn.busy" class="spinner" /><Icon v-else-if="btn.icon" :name="btn.icon" :size="20" />
            {{ btn.label }}
          </button>
        </div>
      </footer>
    </section>

    <SettingsDialog v-if="settingsOpen" @close="settingsOpen = false" />
  </div>
</template>

<style scoped>
.home { height: 100%; display: grid; grid-template-columns: 250px 1fr; }
.side { padding: 22px 16px; background: linear-gradient(180deg, rgba(3, 6, 10, .82), rgba(3, 6, 10, .6)); border-right: 1px solid rgba(212, 168, 69, .14); display: flex; flex-direction: column; gap: 10px; backdrop-filter: blur(6px); }
.side__h { margin: 0 0 4px; font: 600 .66rem/1 var(--font-body); letter-spacing: .2em; text-transform: uppercase; color: var(--text-400); }
.cc { display: grid; grid-template-columns: 46px 1fr 10px; align-items: center; gap: 12px; padding: 12px; border-radius: 6px; border: 1px solid var(--line); background: rgba(8, 14, 22, .6); text-align: left; cursor: pointer; transition: border-color .2s, background .2s, box-shadow .2s; }
.cc:hover:not(:disabled) { border-color: var(--line-strong); }
.cc.is-sel { border-color: var(--gold-400); background: linear-gradient(90deg, rgba(233, 196, 106, .12), rgba(8, 14, 22, .6)); box-shadow: inset 3px 0 0 var(--gold-300); }
.cc.is-off { opacity: .6; }
.cc__bits { font: 900 1.5rem/1 var(--font-deco); color: var(--ice-200); text-align: center; }
.cc__bits small { display: block; font: 600 .55rem/1 var(--font-body); letter-spacing: .2em; color: var(--text-400); margin-top: 3px; text-transform: uppercase; }
.cc__txt { display: grid; gap: 3px; }
.cc__txt b { font: 600 .9rem var(--font-display); color: var(--text-100); }
.cc__txt small { font-size: .74rem; color: var(--text-300); }
.cc__dot { width: 8px; height: 8px; border-radius: 50%; }
.cc__dot.ok { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
.cc__dot.idle { background: var(--gold-300); }
.cc__dot.off { background: var(--text-400); }
.side__links { margin-top: auto; display: grid; gap: 2px; }
.lnk { display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 4px; border: 0; background: transparent; color: var(--text-300); cursor: pointer; text-align: left; font-size: .88rem; }
.lnk:hover { background: rgba(127, 203, 255, .06); color: var(--text-100); }

.stage { position: relative; display: grid; grid-template-rows: auto 1fr auto; padding: 18px 28px 22px; min-width: 0; min-height: 0; overflow: hidden; }
.stage__top { display: flex; justify-content: space-between; align-items: center; }
.who { display: flex; align-items: center; gap: 8px; font: 600 .86rem var(--font-display); color: var(--text-100); letter-spacing: .06em; }
.hero { align-self: center; max-width: 620px; overflow-y: auto; max-height: 100%; }
.hero__kicker { font: 600 .7rem/1 var(--font-body); letter-spacing: .3em; text-transform: uppercase; color: var(--ice-200); margin: 0 0 14px; }
.hero__title { white-space: nowrap; font: 900 clamp(2.2rem, 4.6vw, 3.8rem)/1 var(--font-deco); text-transform: uppercase; background: linear-gradient(180deg, #fff, #d6efff 40%, #7fcbff 75%, #2a93e0); -webkit-background-clip: text; background-clip: text; color: transparent; filter: drop-shadow(0 3px 0 rgba(0, 0, 0, .6)) drop-shadow(0 0 30px rgba(95, 190, 255, .4)); }
.hero__title em { font-style: normal; background: linear-gradient(180deg, #fff1c9, #e9c46a 50%, #9a6f22); -webkit-background-clip: text; background-clip: text; }
.hero__tag { font: 600 1.15rem var(--font-display); color: var(--gold-100); margin: 12px 0 22px; letter-spacing: .05em; }
.hero__facts { display: flex; flex-wrap: wrap; gap: 10px; margin: 0; }
.hero__facts div { padding: 8px 12px; border-radius: 4px; background: rgba(3, 6, 10, .6); border: 1px solid var(--line); }
.hero__facts dt { font: 600 .6rem/1 var(--font-body); letter-spacing: .18em; text-transform: uppercase; color: var(--text-400); margin-bottom: 5px; }
.hero__facts dd { margin: 0; font-size: .84rem; color: var(--text-100); }
.hero__warn { margin-top: 16px; max-width: 560px; }
.hero__warn code { color: var(--gold-200); }
.wine-alert { display: flex; align-items: flex-start; gap: 12px; }
.wine-alert__content { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.wine-alert__content p { margin: 0; font-size: .82rem; line-height: 1.4; }
.btn--wine { align-self: flex-start; height: 32px; padding: 0 14px; font-size: .72rem; background: var(--gold-400); color: #1a1005; font-weight: 700; border-radius: 4px; border: 1px solid var(--gold-200); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.btn--wine:hover:not(:disabled) { filter: brightness(1.15); }

@media (max-height: 720px) {
  .stage { padding: 10px 20px 12px; }
  .hero__kicker { margin: 0 0 4px; font-size: .62rem; }
  .hero__title { font-size: 2.2rem; }
  .hero__tag { margin: 4px 0 10px; font-size: .92rem; }
  .hero__facts { gap: 6px; }
  .hero__facts div { padding: 4px 8px; }
  .hero__facts dt { margin-bottom: 2px; }
  .hero__warn { margin-top: 6px; }
  .bar { padding: 8px 14px; gap: 12px; }
  .main { height: 40px; min-width: 120px; font-size: .8rem; }
}

.bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 20px; align-items: center; padding: 16px 20px; }
.bar__info { min-width: 0; display: grid; gap: 8px; }
.bar__status { display: flex; align-items: center; gap: 8px; font-size: .9rem; color: var(--text-100); min-width: 0; }
.bar__status span:first-of-type { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar__status.is-err { color: #ffc9c9; }
.bar__pct { flex: none; color: var(--text-300); }
.bar__track { height: 8px; border-radius: 4px; background: #0b1724; border: 1px solid var(--line); overflow: hidden; }
.bar__fill { display: block; height: 100%; background: linear-gradient(90deg, var(--ice-500), var(--ice-200)); box-shadow: 0 0 14px var(--ice-glow); transition: width .3s var(--ease); }
.bar__track.is-active .bar__fill { background-image: linear-gradient(90deg, var(--ice-500), var(--ice-200)), repeating-linear-gradient(45deg, transparent 0 8px, rgba(255, 255, 255, .12) 8px 16px); }
.bar__sub { display: flex; justify-content: space-between; gap: 12px; font-size: .74rem; color: var(--text-400); }
.bar__sub span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar__actions { display: flex; align-items: center; gap: 10px; flex: none; }
.bar__actions .btn { height: 38px; padding: 0 14px; font-size: .68rem; }
.main {
  min-width: 150px; height: 48px; padding: 0 22px; border-radius: 5px; cursor: pointer; white-space: nowrap;
  display: inline-flex; align-items: center; justify-content: center; gap: 10px;
  font: 700 .92rem/1 var(--font-display); letter-spacing: .16em; text-transform: uppercase; color: #fff;
  border: 1px solid var(--gold-300);
  background: linear-gradient(180deg, rgba(255, 255, 255, .2), transparent 50%), linear-gradient(180deg, #4fb3f7, #1f78c2 60%, #134b78);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .45), 0 0 0 1px #000, 0 0 30px -4px var(--ice-glow);
  text-shadow: 0 1px 2px rgba(0, 30, 60, .7);
  transition: filter .2s, box-shadow .2s, transform .1s;
}
.main:hover:not(:disabled) { filter: brightness(1.12); box-shadow: inset 0 1px 0 rgba(255, 255, 255, .55), 0 0 0 1px #000, 0 0 46px 0 var(--ice-glow); }
.main:active:not(:disabled) { transform: translateY(1px); }
.main--play { color: #2a1a04; text-shadow: 0 1px 0 rgba(255, 240, 200, .6); border-color: #fff1c9; background: linear-gradient(180deg, var(--gold-100), var(--gold-300) 40%, var(--gold-500)); box-shadow: inset 0 1px 0 rgba(255, 255, 255, .7), 0 0 0 1px #4a3210, 0 0 34px -4px var(--gold-glow); }
.main--play:hover:not(:disabled) { box-shadow: inset 0 1px 0 rgba(255, 255, 255, .8), 0 0 0 1px #4a3210, 0 0 50px 0 rgba(233, 196, 106, .55); }
.main--err { background: linear-gradient(180deg, #a33, #6a1a1a); border-color: #ff9a9a; }
.main:disabled { cursor: default; filter: saturate(.6) brightness(.85); }
.main--busy:disabled { filter: none; }
</style>
