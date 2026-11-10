<script setup>
import { ref, onMounted } from 'vue'
import LogoMark from './LogoMark.vue'
import Icon from './Icon.vue'

const version = ref('')
onMounted(async () => { const r = await window.olk.version(); version.value = r?.data || '' })
const win = (a) => window.olk.window(a)
</script>

<template>
  <header class="tb">
    <LogoMark :size="26" />
    <span class="tb__ver" v-if="version">Launcher v{{ version }}</span>
    <div class="tb__drag" />
    <div class="tb__ctl">
      <button type="button" aria-label="Minimize" @click="win('minimize')" @pointerup.stop.prevent="win('minimize')"><Icon name="min" :size="16" /></button>
      <button type="button" aria-label="Maximize" @click="win('maximize')" @pointerup.stop.prevent="win('maximize')"><Icon name="max" :size="14" /></button>
      <button type="button" class="tb__x" aria-label="Close" @click="win('close')" @pointerup.stop.prevent="win('close')"><Icon name="x" :size="16" /></button>
    </div>
  </header>
</template>

<style scoped>
.tb { height: 44px; display: flex; align-items: center; gap: 14px; padding-left: 14px; background: linear-gradient(180deg, rgba(3, 6, 10, .85), rgba(3, 6, 10, .4)); border-bottom: 1px solid rgba(212, 168, 69, .16); -webkit-app-region: drag; }
.tb__ver { font-size: .7rem; color: var(--text-400); letter-spacing: .08em; }
.tb__drag { flex: 1; }
.tb__ctl { display: flex; height: 100%; -webkit-app-region: no-drag; }
.tb__ctl button { width: 46px; height: 100%; border: 0; background: transparent; color: var(--text-300); cursor: pointer; display: grid; place-items: center; }
.tb__ctl button:hover { background: rgba(255, 255, 255, .06); color: #fff; }
.tb__ctl .tb__x:hover { background: #c42b1c; }
</style>
