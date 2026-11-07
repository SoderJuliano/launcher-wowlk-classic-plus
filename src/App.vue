<script setup>
import { computed, onMounted } from 'vue'
import { store, initStore, fmtBytes } from './store.js'
import TitleBar from './components/TitleBar.vue'
import LoginView from './components/LoginView.vue'
import HomeView from './components/HomeView.vue'
import WallpaperCarousel from './components/WallpaperCarousel.vue'

onMounted(initStore)
const showLogin = computed(() => store.ready && !store.snap?.authenticated && !store.skippedLogin)
const launcherUpdate = computed(() => store.snap?.launcherUpdate)
const updatePct = computed(() => {
  const u = launcherUpdate.value
  if (!u || !u.total) return 0
  return Math.min(100, Math.round((u.done / u.total) * 100))
})
</script>

<template>
  <div class="app">
    <div class="app__bg"><WallpaperCarousel /></div>
    <TitleBar />
    <main class="app__main">
      <div v-if="launcherUpdate" class="app__update">
        <div class="update-card panel">
          <span class="spinner" />
          <h2 class="gold-text">Atualizando o Launcher</h2>
          <p class="update-card__sub">Baixando nova versão {{ launcherUpdate.version }}…</p>
          <div class="progress-bar">
            <div class="progress-bar__fill" :style="{ width: updatePct + '%' }" />
          </div>
          <div class="update-card__info">
            <span>{{ fmtBytes(launcherUpdate.done) }} / {{ fmtBytes(launcherUpdate.total) }}</span>
            <span v-if="launcherUpdate.bytesPerSec">{{ fmtBytes(launcherUpdate.bytesPerSec) }}/s</span>
            <span>{{ updatePct }}%</span>
          </div>
          <p class="hint">O launcher será reiniciado automaticamente ao concluir.</p>
        </div>
      </div>
      <div v-else-if="!store.ready" class="app__loading"><span class="spinner" /> Loading…</div>
      <LoginView v-else-if="showLogin" />
      <HomeView v-else />
    </main>
    <transition name="toast">
      <div v-if="store.toast" class="toast" :class="`toast--${store.toast.kind}`" role="alert">{{ store.toast.message }}</div>
    </transition>
  </div>
</template>

<style scoped>
.app { position: relative; height: 100%; display: grid; grid-template-rows: auto 1fr; isolation: isolate; }
.app__bg { position: absolute; inset: 0; z-index: -1; }
.app__bg::after {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse 80% 70% at 60% 35%, transparent 25%, rgba(3, 6, 10, .78) 100%),
              linear-gradient(90deg, rgba(3, 6, 10, .82), transparent 45%);
  pointer-events: none;
}
.app__main { min-height: 0; }
.app__loading { height: 100%; display: grid; place-items: center; grid-auto-flow: column; gap: 10px; justify-content: center; color: var(--text-300); }
.app__update { height: 100%; display: grid; place-items: center; padding: 24px; }
.update-card { width: 440px; padding: 36px 30px; text-align: center; display: grid; gap: 14px; place-items: center; }
.update-card h2 { font-size: 1.4rem; margin: 0; }
.update-card__sub { color: var(--text-200); margin: 0; font-size: .95rem; }
.progress-bar { width: 100%; height: 8px; background: rgba(255, 255, 255, 0.1); border-radius: 4px; overflow: hidden; margin-top: 6px; }
.progress-bar__fill { height: 100%; background: linear-gradient(90deg, var(--ice-500, #38bdf8), var(--gold-400, #f0c040)); transition: width 0.2s ease; }
.update-card__info { width: 100%; display: flex; justify-content: space-between; font-size: .82rem; color: var(--text-300); }
.toast { position: fixed; left: 50%; bottom: 140px; transform: translateX(-50%); max-width: 640px; padding: 12px 18px; border-radius: 6px; font-size: .88rem; z-index: 50; box-shadow: 0 16px 40px rgba(0, 0, 0, .6); }
.toast--error { background: #2a0f12; border: 1px solid rgba(255, 107, 107, .55); color: #ffd6d6; }
.toast--info { background: #0b1d2d; border: 1px solid var(--ice-700); color: var(--ice-100); }
.toast-enter-active, .toast-leave-active { transition: opacity .25s, transform .25s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translate(-50%, 10px); }
</style>
