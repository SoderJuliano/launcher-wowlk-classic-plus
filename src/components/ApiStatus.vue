<script setup>
import { computed, ref } from 'vue'
import { store, call } from '../store.js'

const checking = ref(false)
const api = computed(() => store.snap?.api || { state: 'unknown' })
const LABEL = { online: 'Server online', offline: 'Server offline', incompatible: 'Launcher API pending', unknown: 'Checking server…' }
async function recheck() {
  checking.value = true
  try { await call('checkApi') } catch { /* state shows it */ } finally { checking.value = false }
}
</script>

<template>
  <button type="button" class="api" :class="`is-${api.state}`" :title="api.error || api.baseUrl || ''" @click="recheck">
    <span class="api__dot" />
    <span>{{ checking ? 'Checking…' : LABEL[api.state] || api.state }}</span>
  </button>
</template>

<style scoped>
.api { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--line); background: rgba(3, 6, 10, .55); font-size: .76rem; color: var(--text-200); cursor: pointer; }
.api:hover { border-color: var(--line-strong); }
.api__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-400); }
.is-online .api__dot { background: var(--ok); box-shadow: 0 0 10px var(--ok); }
.is-offline .api__dot { background: var(--danger); box-shadow: 0 0 10px var(--danger); }
.is-incompatible .api__dot { background: var(--warn); box-shadow: 0 0 10px var(--warn); }
</style>
