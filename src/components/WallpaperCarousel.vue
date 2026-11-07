<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'

const glob = import.meta.glob('../assets/wallpapers/*.{jpg,jpeg,png,webp}', { eager: true, import: 'default' })
const images = Object.values(glob)

const currentIndex = ref(0)
const isTransitioning = ref(false)

function pickRandomIndex(len) {
  if (len <= 1) return 0
  const last = parseInt(localStorage.getItem('olk_last_wallpaper_idx') || '-1', 10)
  let idx = Math.floor(Math.random() * len)
  if (idx === last && len > 1) {
    idx = (idx + 1) % len
  }
  localStorage.setItem('olk_last_wallpaper_idx', String(idx))
  return idx
}

onMounted(() => {
  if (images.length > 0) {
    currentIndex.value = pickRandomIndex(images.length)
  }
  window.addEventListener('keydown', handleKey)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKey)
})

function setIndex(idx) {
  if (idx < 0) idx = images.length - 1
  else if (idx >= images.length) idx = 0
  currentIndex.value = idx
  localStorage.setItem('olk_last_wallpaper_idx', String(idx))
}

function prev() { setIndex(currentIndex.value - 1) }
function next() { setIndex(currentIndex.value + 1) }

function handleKey(e) {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return
  if (e.key === 'ArrowLeft') prev()
  else if (e.key === 'ArrowRight') next()
}

const currentSrc = computed(() => images[currentIndex.value] || '')
</script>

<template>
  <div class="wallpaper-carousel">
    <transition name="fade" mode="out-in">
      <img
        :key="currentSrc"
        :src="currentSrc"
        alt="Background Artwork"
        class="wallpaper__img"
      />
    </transition>

    <div v-if="images.length > 1" class="carousel__controls">
      <button
        type="button"
        class="carousel__btn"
        title="Imagem anterior (Seta Esquerda)"
        aria-label="Previous Wallpaper"
        @click="prev"
      >
        ‹
      </button>

      <div class="carousel__dots">
        <button
          v-for="(_, i) in images"
          :key="i"
          type="button"
          class="carousel__dot"
          :class="{ 'carousel__dot--active': i === currentIndex }"
          :title="`Papel de parede ${i + 1}`"
          :aria-label="`Wallpaper ${i + 1}`"
          @click="setIndex(i)"
        />
      </div>

      <button
        type="button"
        class="carousel__btn"
        title="Próxima imagem (Seta Direita)"
        aria-label="Next Wallpaper"
        @click="next"
      >
        ›
      </button>
    </div>
  </div>
</template>

<style scoped>
.wallpaper-carousel {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  user-select: none;
}

.wallpaper__img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  pointer-events: none;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.5s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.carousel__controls {
  position: absolute;
  bottom: 12px;
  right: 18px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(4, 8, 14, 0.65);
  border: 1px solid rgba(255, 255, 255, 0.08);
  padding: 4px 10px;
  border-radius: 20px;
  backdrop-filter: blur(8px);
  opacity: 0.35;
  transition: opacity 0.25s ease, background 0.25s ease;
}

.carousel__controls:hover {
  opacity: 0.95;
  background: rgba(4, 8, 14, 0.85);
}

.carousel__btn {
  background: transparent;
  border: none;
  color: #c9d1d9;
  font-size: 1.15rem;
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: color 0.15s ease, transform 0.15s ease;
}

.carousel__btn:hover {
  color: var(--gold-400, #f0c040);
  transform: scale(1.15);
}

.carousel__dots {
  display: flex;
  align-items: center;
  gap: 6px;
}

.carousel__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.25);
  border: none;
  cursor: pointer;
  padding: 0;
  transition: background 0.2s ease, transform 0.2s ease;
}

.carousel__dot:hover {
  background: rgba(255, 255, 255, 0.6);
  transform: scale(1.2);
}

.carousel__dot--active {
  background: var(--gold-400, #f0c040);
  transform: scale(1.35);
  box-shadow: 0 0 6px rgba(240, 192, 64, 0.6);
}
</style>
