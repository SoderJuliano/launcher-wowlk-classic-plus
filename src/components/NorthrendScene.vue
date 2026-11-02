<script setup>
/**
 * Original Northrend / frozen-citadel illustration drawn in SVG.
 * ~6 KB, no image requests, scales to any screen. Not Blizzard artwork.
 */
import { useId } from 'vue'

defineProps({ animated: { type: Boolean, default: true } })

const uid = useId()
const id = (n) => `${uid}-${n}`

// Deterministic star field
let seed = 7
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const stars = Array.from({ length: 110 }, () => ({
  x: +(rnd() * 1600).toFixed(1),
  y: +(rnd() * 430).toFixed(1),
  r: +(rnd() * 1.3 + 0.3).toFixed(2),
  o: +(rnd() * 0.6 + 0.25).toFixed(2)
}))

// Citadel spires: x, top, half-width
const BASE = 610
const spires = [
  [800, 120, 15], [756, 250, 11], [846, 236, 11], [712, 330, 10], [892, 316, 10],
  [668, 400, 9], [938, 392, 9], [628, 452, 8], [976, 446, 8], [778, 300, 7], [826, 290, 7]
].map(([x, top, w]) => {
  const k = top + (BASE - top) * 0.32
  return `${x},${top} ${x + w * 0.45},${k} ${x + w},${BASE} ${x - w},${BASE} ${x - w * 0.45},${k}`
})
// Glowing windows (frost-lit slits)
const windows = [
  [800, 260, 34], [800, 340, 24], [756, 360, 20], [846, 350, 20],
  [712, 420, 16], [892, 410, 16], [668, 470, 12], [938, 466, 12]
]
</script>

<template>
  <svg
    class="scene"
    :class="{ 'scene--animated': animated }"
    viewBox="0 0 1600 900"
    preserveAspectRatio="xMidYMax slice"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <linearGradient :id="id('sky')" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#02050a" />
        <stop offset=".45" stop-color="#071628" />
        <stop offset=".72" stop-color="#0f3352" />
        <stop offset="1" stop-color="#1b5577" />
      </linearGradient>
      <radialGradient :id="id('moon')" cx=".5" cy=".5" r=".5">
        <stop offset="0" stop-color="#f2fbff" />
        <stop offset=".55" stop-color="#cdeaff" />
        <stop offset="1" stop-color="#cdeaff" stop-opacity="0" />
      </radialGradient>
      <radialGradient :id="id('halo')" cx=".5" cy=".5" r=".5">
        <stop offset="0" stop-color="#7fcbff" stop-opacity=".35" />
        <stop offset="1" stop-color="#7fcbff" stop-opacity="0" />
      </radialGradient>
      <linearGradient :id="id('aurora')" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#3fe0c5" stop-opacity="0" />
        <stop offset=".3" stop-color="#3fe0c5" stop-opacity=".55" />
        <stop offset=".65" stop-color="#4fb3f7" stop-opacity=".5" />
        <stop offset="1" stop-color="#7b6cff" stop-opacity="0" />
      </linearGradient>
      <linearGradient :id="id('beam')" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#9fdcff" stop-opacity="0" />
        <stop offset=".7" stop-color="#9fdcff" stop-opacity=".35" />
        <stop offset="1" stop-color="#d6efff" stop-opacity=".8" />
      </linearGradient>
      <linearGradient :id="id('far')" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#5c88a8" />
        <stop offset=".25" stop-color="#244a69" />
        <stop offset="1" stop-color="#0d2238" />
      </linearGradient>
      <linearGradient :id="id('citadel')" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#3a6584" />
        <stop offset=".4" stop-color="#122a40" />
        <stop offset="1" stop-color="#06111c" />
      </linearGradient>
      <linearGradient :id="id('mid')" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#2a5372" />
        <stop offset=".18" stop-color="#0d2236" />
        <stop offset="1" stop-color="#050d16" />
      </linearGradient>
      <linearGradient :id="id('fog')" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#9fd4f5" stop-opacity="0" />
        <stop offset=".5" stop-color="#9fd4f5" stop-opacity=".16" />
        <stop offset="1" stop-color="#9fd4f5" stop-opacity="0" />
      </linearGradient>
      <linearGradient :id="id('fade')" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#060b12" stop-opacity="0" />
        <stop offset="1" stop-color="#060b12" />
      </linearGradient>
      <filter :id="id('blur')" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="22" /></filter>
      <filter :id="id('soft')" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" /></filter>
    </defs>

    <rect width="1600" height="900" :fill="`url(#${id('sky')})`" />

    <g class="scene__stars">
      <circle v-for="(s, i) in stars" :key="i" :cx="s.x" :cy="s.y" :r="s.r" fill="#e8f6ff" :opacity="s.o" />
    </g>

    <!-- moon -->
    <circle cx="1220" cy="190" r="190" :fill="`url(#${id('halo')})`" />
    <circle cx="1220" cy="190" r="62" :fill="`url(#${id('moon')})`" />

    <!-- aurora -->
    <g class="scene__aurora" :filter="`url(#${id('blur')})`">
      <path d="M-50 260C250 140 520 300 820 200s560-120 830 10v70c-280-110-530-30-830 60S180 280-50 350z" :fill="`url(#${id('aurora')})`" />
      <path d="M100 160c260-90 520 40 760-30s440-80 640 0v40c-210-60-420-10-640 50S330 200 100 230z" :fill="`url(#${id('aurora')})`" opacity=".6" />
    </g>

    <!-- far range -->
    <path d="M0 560 90 470 160 520 260 400 340 470 420 420 520 520 560 500 600 540 1000 540 1060 480 1130 520 1220 390 1300 470 1380 430 1470 500 1540 450 1600 490V900H0z" :fill="`url(#${id('far')})`" opacity=".85" />

    <!-- light beam from the crown spire -->
    <rect class="scene__beam" x="788" y="-40" width="24" height="170" :fill="`url(#${id('beam')})`" :filter="`url(#${id('soft')})`" />

    <!-- citadel -->
    <g>
      <polygon v-for="(p, i) in spires" :key="i" :points="p" :fill="`url(#${id('citadel')})`" stroke="#7fcbff" stroke-opacity=".18" stroke-width="1" />
      <path d="M590 610 610 560h30l10-24h300l10 24h30l20 50z" fill="#081624" stroke="#7fcbff" stroke-opacity=".15" />
      <g class="scene__windows" stroke="#bfe8ff" stroke-linecap="round" stroke-width="2.4">
        <line v-for="(w, i) in windows" :key="i" :x1="w[0]" :y1="w[1]" :x2="w[0]" :y2="w[1] + w[2]" />
      </g>
      <circle cx="800" cy="122" r="5" fill="#eaf7ff" />
      <circle cx="800" cy="122" r="18" fill="#9fdcff" opacity=".35" :filter="`url(#${id('soft')})`" />
    </g>

    <!-- mid cliffs with snow ridges -->
    <path d="M0 650 120 590 210 630 330 560 420 610 520 600 600 650 700 640 760 660 840 660 900 640 1010 650 1100 600 1200 630 1290 560 1380 610 1480 580 1600 620V900H0z" :fill="`url(#${id('mid')})`" />
    <path d="M0 650 120 590 210 630 330 560 420 610 520 600 600 650M1100 600 1200 630 1290 560 1380 610 1480 580 1600 620" fill="none" stroke="#cfeaff" stroke-opacity=".35" stroke-width="2" />

    <!-- drifting fog -->
    <g class="scene__fog">
      <rect x="-200" y="600" width="2000" height="160" :fill="`url(#${id('fog')})`" />
      <rect x="-200" y="680" width="2000" height="120" :fill="`url(#${id('fog')})`" opacity=".8" />
    </g>

    <!-- foreground framing rocks -->
    <path d="M0 720 80 680 170 730 260 700 360 760 420 900H0z" fill="#03080e" />
    <path d="M1600 700 1520 670 1430 720 1340 700 1250 770 1200 900h400z" fill="#03080e" />
    <path d="M0 720 80 680 170 730 260 700 360 760M1600 700 1520 670 1430 720 1340 700 1250 770" fill="none" stroke="#a9d9f5" stroke-opacity=".25" stroke-width="1.5" />

    <rect y="640" width="1600" height="260" :fill="`url(#${id('fade')})`" />
  </svg>
</template>

<style scoped>
.scene { position: absolute; inset: 0; width: 100%; height: 100%; }
.scene--animated .scene__aurora { animation: aurora 18s ease-in-out infinite alternate; transform-origin: center; }
.scene--animated .scene__fog { animation: fog 26s ease-in-out infinite alternate; }
.scene--animated .scene__beam { animation: beam 6s ease-in-out infinite; }
.scene--animated .scene__windows { animation: windows 5s ease-in-out infinite; }
@keyframes aurora { from { transform: translateX(-40px) scaleY(1); opacity: .75; } to { transform: translateX(40px) scaleY(1.12); opacity: 1; } }
@keyframes fog { from { transform: translateX(-60px); } to { transform: translateX(60px); } }
@keyframes beam { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
@keyframes windows { 0%, 100% { opacity: .65; } 50% { opacity: 1; } }
</style>
