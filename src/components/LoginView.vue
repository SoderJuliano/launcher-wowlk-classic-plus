<script setup>
import { reactive, ref, computed } from 'vue'
import { store, call } from '../store.js'
import LogoMark from './LogoMark.vue'
import ApiStatus from './ApiStatus.vue'
import Icon from './Icon.vue'

const form = reactive({ username: '', password: '', remember: true })
const busy = ref(false)
const error = ref('')
const apiState = computed(() => store.snap?.api?.state)

const MESSAGES = {
  INVALID_CREDENTIALS: 'Invalid username or password.',
  ACCOUNT_LOCKED: 'This account is locked. Confirm your e-mail or contact support.',
  ACCOUNT_BANNED: 'This account is suspended.',
  EMAIL_NOT_VERIFIED: 'Confirm your e-mail before logging in.',
  RATE_LIMITED: 'Too many attempts. Wait a few minutes and try again.',
  HTTP_404: 'The server does not offer launcher login yet. You can continue without signing in.'
}

let lastSubmitTime = 0
async function submit() {
  const now = Date.now()
  if (now - lastSubmitTime < 400) return
  lastSubmitTime = now
  error.value = ''
  busy.value = true
  try {
    await call('login', { username: form.username, password: form.password, remember: form.remember })
  } catch (e) {
    error.value = MESSAGES[e.code] || e.message
  } finally {
    busy.value = false
    form.password = ''
  }
}
function openSite() { call('openWebsite').catch(() => {}) }
</script>

<template>
  <section class="login">
    <form class="login__box panel" novalidate @submit.prevent="submit">
      <LogoMark :size="58" :text="false" class="login__mark" />
      <h1 class="gold-text">Welcome, Adventurer</h1>
      <p class="login__sub">Sign in with your WoW Classic Plus LK account.</p>

      <p v-if="error" class="alert alert--error" role="alert">{{ error }}</p>
      <label class="field"><span>Username</span>
        <input v-model="form.username" class="input" autocomplete="username" maxlength="32" autofocus spellcheck="false" />
      </label>
      <label class="field"><span>Password</span>
        <input v-model="form.password" class="input" type="password" autocomplete="current-password" maxlength="64" />
      </label>
      <label class="login__remember"><input v-model="form.remember" type="checkbox" /> Keep me signed in</label>

      <button
        type="submit" class="btn btn--gold login__btn" :disabled="busy || apiState === 'offline'"
        @pointerup.stop.prevent="submit" @touchend.stop.prevent="submit"
      >
        <span v-if="busy" class="spinner" /><Icon v-else name="lock" /> Log in
      </button>

      <div class="login__foot">
        <ApiStatus />
        <a href="#" @click.prevent="openSite">Create an account</a>
      </div>

      <div v-if="apiState !== 'online'" class="login__skip">
        <p class="hint">O login do launcher está conectando ou temporariamente indisponível. Você pode continuar sem entrar (o jogo pedirá sua conta).</p>
        <button type="button" class="btn btn--ghost" @click="store.skippedLogin = true" @pointerup.stop.prevent="store.skippedLogin = true">Continuar sem entrar / Continue</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.login { height: 100%; display: grid; place-items: center; padding: 24px; }
.login__box { width: 400px; padding: 52px 34px 26px; text-align: center; animation: rise .45s var(--ease); }
@keyframes rise { from { opacity: 0; transform: translateY(12px); } }
.login__mark { position: absolute; top: -32px; left: 50%; transform: translateX(-50%); padding: 6px; border-radius: 50%; background: var(--bg-900); border: 1px solid rgba(212, 168, 69, .45); }
.login__box h1 { font-size: 1.5rem; }
.login__sub { color: var(--text-300); margin: 6px 0 20px; }
.login__box .field, .login__box .alert { text-align: left; }
.login__box .alert { margin-bottom: 14px; }
.login__remember { display: flex; align-items: center; gap: 8px; font-size: .86rem; color: var(--text-200); margin: -2px 0 18px; cursor: pointer; }
.login__remember input { accent-color: var(--gold-400); width: 16px; height: 16px; }
.login__btn { width: 100%; height: 48px; font-size: .86rem; }
.login__foot { display: flex; justify-content: space-between; align-items: center; margin-top: 18px; font-size: .84rem; }
.login__skip { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); display: grid; gap: 10px; }
</style>
