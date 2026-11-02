<script setup>
import { computed, onMounted } from 'vue'
import { store, initStore } from './store.js'
import TitleBar from './components/TitleBar.vue'
import LoginView from './components/LoginView.vue'
import HomeView from './components/HomeView.vue'
import NorthrendScene from './components/NorthrendScene.vue'

onMounted(initStore)
const showLogin = computed(() => store.ready && !store.snap?.authenticated && !store.skippedLogin)
</script>

<template>
  <div class="app">
    <div class="app__bg" aria-hidden="true"><NorthrendScene /></div>
    <TitleBar />
    <main class="app__main">
      <div v-if="!store.ready" class="app__loading"><span class="spinner" /> Loading…</div>
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
.app__bg::after { content: ''; position: absolute; inset: 0; background: radial-gradient(ellipse 80% 70% at 60% 35%, transparent 30%, rgba(3, 6, 10, .78) 100%), linear-gradient(90deg, rgba(3, 6, 10, .82), transparent 40%); }
.app__main { min-height: 0; }
.app__loading { height: 100%; display: grid; place-items: center; grid-auto-flow: column; gap: 10px; justify-content: center; color: var(--text-300); }
.toast { position: fixed; left: 50%; bottom: 140px; transform: translateX(-50%); max-width: 640px; padding: 12px 18px; border-radius: 6px; font-size: .88rem; z-index: 50; box-shadow: 0 16px 40px rgba(0, 0, 0, .6); }
.toast--error { background: #2a0f12; border: 1px solid rgba(255, 107, 107, .55); color: #ffd6d6; }
.toast--info { background: #0b1d2d; border: 1px solid var(--ice-700); color: var(--ice-100); }
.toast-enter-active, .toast-leave-active { transition: opacity .25s, transform .25s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translate(-50%, 10px); }
</style>
