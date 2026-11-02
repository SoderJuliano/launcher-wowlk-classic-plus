<script setup>
import { reactive, ref, computed } from 'vue'
import { store, call, toast } from '../store.js'
import Icon from './Icon.vue'

const emit = defineEmits(['close'])
const s = store.snap.settings
const form = reactive({
  apiBaseUrl: s.apiBaseUrl,
  discoveryEnabled: s.discoveryEnabled,
  realmlist: s.realmlist,
  installDir: s.installDir,
  winePath: s.winePath,
  winePrefix: s.winePrefix,
  wow32PackageUrl: s.wow32PackageUrl,
  wow32ManifestUrl: s.wow32ManifestUrl,
  websiteUrl: s.websiteUrl
})
const saving = ref(false)
const error = ref('')
const isLinux = computed(() => store.snap.platform.platform !== 'win32')
const busy = computed(() => !!store.snap.task)

async function pick(key, kind) {
  const r = await window.olk[kind === 'file' ? 'pickFile' : 'pickFolder']()
  if (r?.ok && r.data) form[key] = r.data
}

async function save() {
  error.value = ''
  saving.value = true
  const patch = {
    'api.baseUrl': form.apiBaseUrl.trim(),
    'api.discovery.enabled': form.discoveryEnabled,
    realmlist: form.realmlist.trim(),
    'clients.wow32.basePackage.url': form.wow32PackageUrl.trim(),
    'clients.wow32.manifestUrl': form.wow32ManifestUrl.trim(),
    websiteUrl: form.websiteUrl.trim()
  }
  if (!busy.value) patch.installDir = form.installDir.trim()
  if (isLinux.value) { patch['wine.path'] = form.winePath.trim(); patch['wine.prefix'] = form.winePrefix.trim() }
  try {
    await call('saveSettings', patch)
    toast('Settings saved.', 'info')
    emit('close')
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="set-title" @keydown.esc="emit('close')">
    <form class="dlg__box panel" novalidate @submit.prevent="save">
      <header class="dlg__head">
        <h2 id="set-title" class="gold-text">Settings</h2>
        <button type="button" class="btn btn--ghost btn--icon" aria-label="Close" @click="emit('close')"><Icon name="close" /></button>
      </header>

      <div class="dlg__body">
        <p v-if="error" class="alert alert--error">{{ error }}</p>

        <h3>Server</h3>
        <label class="field"><span>Realmlist</span>
          <input v-model="form.realmlist" class="input" placeholder="host:port" spellcheck="false" />
          <small class="hint">Written to realmlist.wtf and Config.wtf of every installed client.</small>
        </label>
        <label class="check"><input v-model="form.discoveryEnabled" type="checkbox" /> Discover the launcher API address automatically</label>
        <label class="field"><span>Launcher API URL (override)</span>
          <input v-model="form.apiBaseUrl" class="input" placeholder="https://… (empty = automatic)" spellcheck="false" />
        </label>

        <h3>Game package</h3>
        <label class="field"><span>32-bit client — full package (ZIP) link</span>
          <input v-model="form.wow32PackageUrl" class="input" placeholder="https://drive.google.com/file/d/…/view" spellcheck="false" />
          <small class="hint">Google Drive file links are supported (the file must be shared as "Anyone with the link"). When the server publishes a manifest, its link takes precedence.</small>
        </label>
        <label class="field"><span>32-bit client — update manifest URL</span>
          <input v-model="form.wow32ManifestUrl" class="input" placeholder="https://…/manifests/wow32.json" spellcheck="false" />
          <small class="hint">Patches are read from this JSON file when the launcher API is not available. See docs/UPDATE_SYSTEM.md.</small>
        </label>
        <label class="field"><span>Install folder</span>
          <div class="row"><input v-model="form.installDir" class="input" :disabled="busy" spellcheck="false" /><button type="button" class="btn" :disabled="busy" @click="pick('installDir')"><Icon name="folder" /></button></div>
          <small class="hint">Each client gets its own sub-folder. Changing it does not move existing installs.</small>
        </label>

        <template v-if="isLinux">
          <h3>Wine</h3>
          <label class="field"><span>Wine executable (empty = auto-detect)</span>
            <div class="row"><input v-model="form.winePath" class="input" placeholder="/usr/bin/wine" spellcheck="false" /><button type="button" class="btn" @click="pick('winePath', 'file')"><Icon name="folder" /></button></div>
          </label>
          <label class="field"><span>Wine prefix (empty = launcher default)</span>
            <div class="row"><input v-model="form.winePrefix" class="input" spellcheck="false" /><button type="button" class="btn" @click="pick('winePrefix')"><Icon name="folder" /></button></div>
          </label>
        </template>

        <h3>Other</h3>
        <label class="field"><span>Website URL</span><input v-model="form.websiteUrl" class="input" spellcheck="false" /></label>
        <p class="hint">Logs: {{ store.snap.logFile }}</p>
      </div>

      <footer class="dlg__foot">
        <button type="button" class="btn btn--ghost" @click="emit('close')">Cancel</button>
        <button type="submit" class="btn btn--gold" :disabled="saving"><span v-if="saving" class="spinner" /> Save</button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.dlg { position: fixed; inset: 44px 0 0; display: grid; place-items: center; background: rgba(2, 5, 9, .72); backdrop-filter: blur(5px); z-index: 40; }
.dlg__box { width: min(620px, 92vw); max-height: calc(100vh - 90px); display: grid; grid-template-rows: auto 1fr auto; }
.dlg__head, .dlg__foot { display: flex; justify-content: space-between; align-items: center; padding: 16px 22px; }
.dlg__head { border-bottom: 1px solid var(--line); }
.dlg__foot { border-top: 1px solid var(--line); justify-content: flex-end; gap: 10px; }
.dlg__body { overflow: auto; padding: 8px 22px 16px; }
.dlg__body h3 { font-size: .8rem; letter-spacing: .2em; text-transform: uppercase; color: var(--gold-300); margin: 18px 0 12px; }
.row { display: flex; gap: 8px; }
.check { display: flex; gap: 8px; align-items: center; font-size: .86rem; margin-bottom: 14px; cursor: pointer; }
.check input { accent-color: var(--gold-400); }
</style>
