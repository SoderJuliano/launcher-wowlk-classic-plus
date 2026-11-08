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
const detectingWine = ref(false)
const wineCandidates = ref([])
const resettingPrefix = ref(false)

async function pick(key, kind) {
  const r = await window.olk[kind === 'file' ? 'pickFile' : 'pickFolder']()
  if (r?.ok && r.data) form[key] = r.data
}

async function scanWine() {
  detectingWine.value = true
  wineCandidates.value = []
  try {
    const list = await call('detectWineCandidates')
    wineCandidates.value = Array.isArray(list) ? list : []
    if (!wineCandidates.value.length) {
      toast('Nenhum binário Wine/Proton adicional encontrado automaticamente.', 'warn')
    } else {
      toast(`Encontrado(s) ${wineCandidates.value.length} binário(s) de Wine/Proton.`, 'info')
    }
  } catch (e) {
    toast(`Falha ao escanear Wine: ${e.message}`, 'error')
  } finally {
    detectingWine.value = false
  }
}

function selectWine(candidate) {
  form.winePath = candidate.path
  toast(`Wine selecionado: ${candidate.path}`, 'info')
}

async function resetPrefix() {
  if (!confirm('Deseja realmente resetar o Wineprefix? Isso recriará o ambiente limpo do Wine no próximo início.')) return
  resettingPrefix.value = true
  try {
    await call('resetWinePrefix')
    toast('Wineprefix limpo com sucesso!', 'info')
  } catch (e) {
    toast(`Erro ao resetar prefix: ${e.message}`, 'error')
  } finally {
    resettingPrefix.value = false
  }
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
  if (isLinux.value) {
    patch['wine.path'] = form.winePath.trim()
    patch['wine.prefix'] = form.winePrefix.trim()
  }
  try {
    await call('saveSettings', patch)
    toast('Configurações salvas com sucesso.', 'info')
    emit('close')
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="set-title" @click.self="emit('close')" @keydown.esc="emit('close')">
    <form class="dlg__box panel" novalidate @submit.prevent="save">
      <header class="dlg__head">
        <button type="button" class="btn btn--ghost btn--back" @click="emit('close')">
          <Icon name="back" /> <span>Voltar</span>
        </button>
        <h2 id="set-title" class="gold-text">Configurações</h2>
        <button type="button" class="btn btn--ghost btn--icon" aria-label="Fechar" @click="emit('close')">
          <Icon name="close" />
        </button>
      </header>

      <div class="dlg__body">
        <p v-if="error" class="alert alert--error">{{ error }}</p>

        <template v-if="isLinux">
          <h3>Wine & Plataforma (Linux / Steam Deck)</h3>

          <div class="wine-status-card">
            <div class="wine-status-header">
              <span class="wine-status-label">Status do Wine detectado:</span>
              <span class="wine-status-val" :class="store.snap.wine?.found ? 'ok' : 'err'">
                {{ store.snap.wine?.found ? (store.snap.wine.version || 'Encontrado') : 'Não detectado' }}
              </span>
            </div>
            <div v-if="store.snap.wine?.path" class="wine-status-path hint">
              Binário ativo: {{ store.snap.wine.path }}
            </div>
          </div>

          <label class="field">
            <span>Executável do Wine (deixe vazio para detecção automática)</span>
            <div class="row">
              <input v-model="form.winePath" class="input" placeholder="/usr/bin/wine ou deixe vazio" spellcheck="false" />
              <button type="button" class="btn" title="Procurar arquivo" @click="pick('winePath', 'file')">
                <Icon name="folder" />
              </button>
            </div>
          </label>

          <div class="actions-row">
            <button type="button" class="btn btn--outline" :disabled="detectingWine" @click="scanWine">
              <Icon name="refresh" />
              <span>{{ detectingWine ? 'Escaneando...' : 'Detectar Wine no Sistema' }}</span>
            </button>
            <button type="button" class="btn btn--ghost" :disabled="resettingPrefix" @click="resetPrefix">
              <Icon name="wrench" />
              <span>{{ resettingPrefix ? 'Limpando...' : 'Resetar Wineprefix' }}</span>
            </button>
          </div>

          <div v-if="wineCandidates.length" class="candidates-list">
            <p class="hint">Instalações do Wine encontradas no seu sistema:</p>
            <div v-for="c in wineCandidates" :key="c.path" class="candidate-item">
              <div class="candidate-info">
                <strong class="candidate-version">{{ c.version }}</strong>
                <span class="candidate-path">{{ c.path }}</span>
              </div>
              <button type="button" class="btn btn--gold btn--sm" @click="selectWine(c)">Usar</button>
            </div>
          </div>

          <label class="field" style="margin-top: 14px;">
            <span>Pasta do Wine prefix (deixe vazio para padrão do launcher)</span>
            <div class="row">
              <input v-model="form.winePrefix" class="input" spellcheck="false" />
              <button type="button" class="btn" title="Procurar pasta" @click="pick('winePrefix')">
                <Icon name="folder" />
              </button>
            </div>
          </label>
        </template>

        <h3>Servidor & Conexão</h3>
        <label class="field"><span>Realmlist</span>
          <input v-model="form.realmlist" class="input" placeholder="host:port" spellcheck="false" />
          <small class="hint">Gravado automaticamente no realmlist.wtf e Config.wtf do cliente.</small>
        </label>
        <label class="check"><input v-model="form.discoveryEnabled" type="checkbox" /> Descobrir endereço da API do launcher automaticamente</label>
        <label class="field"><span>URL da API do Launcher (sobrescrever)</span>
          <input v-model="form.apiBaseUrl" class="input" placeholder="https://… (vazio = automático)" spellcheck="false" />
        </label>

        <h3>Diretório e Pacotes do Jogo</h3>
        <label class="field"><span>Pasta de Instalação dos Jogos</span>
          <div class="row">
            <input v-model="form.installDir" class="input" :disabled="busy" spellcheck="false" />
            <button type="button" class="btn" :disabled="busy" @click="pick('installDir')">
              <Icon name="folder" />
            </button>
          </div>
          <small class="hint">Cada cliente recebe sua própria subpasta. Mudar não move instalações existentes.</small>
        </label>
        <label class="field"><span>Cliente 32-bit — Link do pacote completo (ZIP)</span>
          <input v-model="form.wow32PackageUrl" class="input" placeholder="https://drive.google.com/file/d/…/view" spellcheck="false" />
        </label>
        <label class="field"><span>Cliente 32-bit — URL do manifesto de atualização</span>
          <input v-model="form.wow32ManifestUrl" class="input" placeholder="https://…/manifests/wow32.json" spellcheck="false" />
        </label>

        <h3>Outros</h3>
        <label class="field"><span>URL do Site Oficial</span>
          <input v-model="form.websiteUrl" class="input" spellcheck="false" />
        </label>
        <p class="hint">Arquivo de logs: {{ store.snap.logFile }}</p>
      </div>

      <footer class="dlg__foot">
        <button type="button" class="btn btn--ghost" @click="emit('close')">Voltar</button>
        <button type="submit" class="btn btn--gold" :disabled="saving">
          <span v-if="saving" class="spinner" /> Salvar Configurações
        </button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.dlg { position: fixed; inset: 44px 0 0; display: grid; place-items: center; background: rgba(2, 5, 9, .78); backdrop-filter: blur(6px); z-index: 50; }
.dlg__box { width: min(660px, 94vw); max-height: calc(100vh - 70px); display: grid; grid-template-rows: auto 1fr auto; border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,.6); }
.dlg__head, .dlg__foot { display: flex; justify-content: space-between; align-items: center; padding: 12px 20px; background: rgba(10, 16, 26, .95); }
.dlg__head { border-bottom: 1px solid var(--line); }
.dlg__foot { border-top: 1px solid var(--line); justify-content: flex-end; gap: 12px; }
.dlg__body { overflow-y: auto; padding: 12px 20px 20px; background: rgba(8, 12, 19, .92); }
.dlg__body h3 { font-size: .82rem; letter-spacing: .15em; text-transform: uppercase; color: var(--gold-300); margin: 18px 0 10px; border-bottom: 1px solid rgba(255,255,255,.06); padding-bottom: 4px; }
.row { display: flex; gap: 8px; }
.btn--back { display: inline-flex; align-items: center; gap: 6px; font-weight: 500; font-size: .88rem; padding: 6px 12px; }
.check { display: flex; gap: 8px; align-items: center; font-size: .86rem; margin-bottom: 14px; cursor: pointer; }
.check input { accent-color: var(--gold-400); }
.actions-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
.wine-status-card { background: rgba(255,255,255,.03); border: 1px solid var(--line); border-radius: 6px; padding: 10px 14px; margin-bottom: 12px; }
.wine-status-header { display: flex; justify-content: space-between; align-items: center; font-size: .88rem; }
.wine-status-val.ok { color: #4ade80; font-weight: 600; }
.wine-status-val.err { color: #f87171; font-weight: 600; }
.wine-status-path { font-size: .78rem; margin-top: 4px; word-break: break-all; }
.candidates-list { margin-top: 10px; background: rgba(0,0,0,.3); border-radius: 6px; padding: 8px 12px; border: 1px solid rgba(255,255,255,.05); }
.candidate-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,.05); gap: 10px; }
.candidate-item:last-child { border-bottom: none; }
.candidate-info { display: flex; flex-direction: column; overflow: hidden; }
.candidate-version { font-size: .84rem; color: #fff; }
.candidate-path { font-size: .75rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn--sm { padding: 4px 10px; font-size: .78rem; }
</style>
