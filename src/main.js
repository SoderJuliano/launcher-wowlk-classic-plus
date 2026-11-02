import { createApp } from 'vue'
import '@fontsource/cinzel/600.css'
import '@fontsource/cinzel/700.css'
import '@fontsource/cinzel-decorative/900.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/600.css'
import './assets/tokens.css'
import './assets/app.css'
import App from './App.vue'

async function boot() {
  // Browser preview (npm run build:ui && vite) has no Electron bridge: use a mock in dev only.
  if (!window.olk && import.meta.env.DEV) {
    const { installMockBridge } = await import('./mockBridge.js')
    installMockBridge()
  }
  createApp(App).mount('#app')
}
boot()
