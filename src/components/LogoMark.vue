<script setup>
defineProps({ size: { type: Number, default: 34 }, text: { type: Boolean, default: true } })
</script>

<template>
  <span class="logo">
    <svg :width="size" :height="size" viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="lg-gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff1c9" /><stop offset=".45" stop-color="#e9c46a" /><stop offset="1" stop-color="#8a6420" /></linearGradient>
        <linearGradient id="lg-ice" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" /><stop offset=".5" stop-color="#9fdcff" /><stop offset="1" stop-color="#1f78c2" /></linearGradient>
      </defs>
      <path d="M32 2 58 15v26L32 62 6 41V15z" fill="#08121c" stroke="url(#lg-gold)" stroke-width="2.6" />
      <path d="M15 40 19 22.5l6 9.5 7-18 7 18 6-9.5L49 40z" fill="url(#lg-ice)" />
      <path d="M15 40h34l-2.2 4.4H17.2z" fill="url(#lg-gold)" />
      <path d="M32 44.5v9M27.5 49h9" stroke="#bfe8ff" stroke-width="2.6" stroke-linecap="round" />
    </svg>
    <span v-if="text" class="logo__txt"><b>OLK</b><i>PLUS</i></span>
  </span>
</template>

<style scoped>
.logo { display: inline-flex; align-items: center; gap: 10px; }
.logo svg { filter: drop-shadow(0 0 10px rgba(95, 190, 255, .4)); }
.logo__txt { display: grid; line-height: 1; }
.logo__txt b { font: 700 1.05rem/1 var(--font-display); letter-spacing: .18em; background: linear-gradient(180deg, #fff6dc, var(--gold-300) 55%, var(--gold-500)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.logo__txt i { font: 600 .6rem/1 var(--font-display); font-style: normal; letter-spacing: .5em; color: var(--ice-200); margin-top: 4px; }
</style>
