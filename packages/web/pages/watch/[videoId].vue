<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-950">
    <AppHeader />
    
    <div class="max-w-[1800px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <!-- Loading State -->
      <div v-if="loading" class="flex items-center justify-center min-h-[60vh]">
        <div class="text-center">
          <div class="inline-block w-12 h-12 border-4 border-gray-300 border-t-blue-600 rounded-full animate-spin mb-4"></div>
          <p class="text-gray-600 dark:text-gray-400">Loading video...</p>
        </div>
      </div>

      <!-- Error State -->
      <div v-else-if="error" class="max-w-4xl mx-auto">
        <div class="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg p-6">
          <h3 class="text-lg font-semibold text-red-900 dark:text-red-200 mb-2">Error</h3>
          <p class="text-red-700 dark:text-red-300">{{ error }}</p>
          <NuxtLink to="/" class="inline-block mt-4 text-blue-600 dark:text-blue-400 hover:underline">
            ← Back to homepage
          </NuxtLink>
        </div>
      </div>

      <!-- Main Content -->
      <div v-else-if="videoData" class="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-6">
        <!-- Left Column: Player + Info -->
        <div class="space-y-4">
          <!-- Player Container -->
          <div class="relative bg-black rounded-lg overflow-hidden">
            <!-- Premium Banner -->
            <div 
              v-if="!videoData.hasAccess"
              class="absolute top-0 left-0 right-0 z-30 bg-gradient-to-b from-yellow-500/90 to-yellow-600/90 backdrop-blur-sm text-black px-4 py-2 flex items-center justify-between"
            >
              <div class="flex items-center space-x-2">
                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
                </svg>
                <span class="font-semibold">Preview Mode</span>
              </div>
              <span class="text-sm">Upgrade to watch full video</span>
            </div>

            <!-- Video Player -->
            <media-controller
              id="watch-media-controller"
              class="watch-media-controller block w-full aspect-video relative"
            >
              <videojs-video
                ref="videoElement"
                slot="media"
                class="watch-media-element block w-full h-full"
                playsinline
                preload="auto"
                @timeupdate="handleTimeUpdate"
                @seeking="handleSeeking"
              ></videojs-video>

              <media-loading-indicator slot="centered-chrome"></media-loading-indicator>

              <!-- Premium Overlay -->
              <PremiumOverlay :show="showPremiumOverlay" />

              <!-- Custom Control Bar -->
              <media-control-bar class="watch-media-control-bar relative" noautohide>
                <media-play-button></media-play-button>
                <media-seek-backward-button seek-offset="10"></media-seek-backward-button>
                <media-seek-forward-button seek-offset="10"></media-seek-forward-button>

                <!--
                  Custom seekbar — replaces <media-time-range> for two reasons:
                  
                  1) SEEK RESTRICTION: By setting :max="seekMax" we prevent the range
                     input from ever producing a value past the preview lock. No seek
                     can reach locked territory in the first place, so no snap-back
                     is needed.
                  
                  2) COLORS: <media-time-range> lives in its own shadow DOM. Vue's
                     scoped styles add a `data-v-xxxx` attribute to elements it
                     controls, but that attribute never lands on the shadow host, so
                     the scoped CSS rule `.wrap media-time-range { --var }` never
                     matches. CSS custom properties *do* cascade through shadow DOM
                     boundaries, but only from an ancestor that Vue actually scopes.
                     Rather than fight that, we own the markup and paint the three
                     zones ourselves.
                -->
                <div class="watch-seekbar-wrap flex-1 flex items-center px-2 relative h-8">

                  <!-- ── Visual track (pointer-events: none so the range input sits on top) -->
                  <div class="relative w-full h-1.5 rounded-full pointer-events-none">

                    <!-- Zone 1: base track -->
                    <div class="absolute inset-0 rounded-full bg-white/20"></div>

                    <!-- Zone 2: locked section (darker, right of lock) -->
                    <div
                      v-if="!videoData.hasAccess"
                      class="absolute inset-y-0 rounded-r-full bg-white/5"
                      :style="{ left: previewPercentage + '%' }"
                    ></div>

                    <!-- Zone 3: played progress (blue) -->
                    <div
                      class="absolute inset-y-0 left-0 rounded-full bg-blue-400"
                      :style="{ width: progressPercentage + '%' }"
                    ></div>

                    <!-- Scrubber thumb dot (follows progress) -->
                    <div
                      class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 bg-white rounded-full shadow"
                      :style="{ left: progressPercentage + '%' }"
                    ></div>

                    <!-- Lock marker pin at the preview boundary -->
                    <div
                      v-if="!videoData.hasAccess"
                      class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 bg-yellow-400 border-2 border-black rounded-full flex items-center justify-center shadow-[0_0_0_3px_rgba(250,204,21,0.35)] z-10"
                      :style="{ left: previewPercentage + '%' }"
                    >
                      <svg class="w-2.5 h-2.5 text-black" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
                      </svg>
                    </div>
                  </div>

                  <!-- ── Transparent range input overlaid on the visual track.
                       max is ALWAYS fullDuration — this makes the browser map
                       click positions across the full bar correctly.
                       We intercept locked-zone clicks ourselves in handleSeekbarInput
                       rather than relying on the browser's built-in clamping. -->
                  <input
                    type="range"
                    class="watch-seekbar-input absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    :min="0"
                    :max="videoData.video.fullDuration"
                    :step="0.1"
                    :value="currentTime"
                    @input="handleSeekbarInput"
                  />
                </div>

                <media-time-display show-duration></media-time-display>
                <media-mute-button></media-mute-button>
                <media-volume-range></media-volume-range>
                <media-fullscreen-button></media-fullscreen-button>
              </media-control-bar>
            </media-controller>
          </div>

          <!-- Video Info -->
          <div class="bg-white dark:bg-gray-900 rounded-lg p-6 border border-gray-200 dark:border-gray-800">
            <h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-2">
              {{ videoData.video.title }}
            </h1>
            
            <div class="flex items-center space-x-4 text-sm text-gray-600 dark:text-gray-400 mb-4">
              <span class="flex items-center space-x-1">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>{{ formatDuration(videoData.video.fullDuration) }}</span>
              </span>
              
              <span 
                v-if="videoData.subscription.planType === 'premium'"
                class="flex items-center space-x-1 text-yellow-600 dark:text-yellow-400 font-semibold"
              >
                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
                <span>Premium Access</span>
              </span>
              
              <span v-else class="flex items-center space-x-1">
                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
                </svg>
                <span>Preview Only ({{ formatDuration(videoData.video.previewDuration) }})</span>
              </span>
            </div>

            <p class="text-gray-700 dark:text-gray-300 leading-relaxed">
              {{ videoDescription }}
            </p>
          </div>
        </div>

        <!-- Right Column: Recommendations -->
        <div class="space-y-4">
          <h2 class="text-lg font-bold text-gray-900 dark:text-white px-2">Up Next</h2>
          
          <div class="space-y-3">
            <div 
              v-for="rec in recommendations"
              :key="rec.id"
              class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden hover:border-gray-300 dark:hover:border-gray-700 transition-colors cursor-pointer"
            >
              <NuxtLink :to="`/watch/${rec.id}`" class="block">
                <div class="flex space-x-3 p-3">
                  <div class="relative w-40 h-24 flex-shrink-0 bg-gray-200 dark:bg-gray-800 rounded overflow-hidden">
                    <img 
                      v-if="rec.thumbnail_url"
                      :src="rec.thumbnail_url"
                      :alt="rec.title"
                      class="w-full h-full object-cover"
                    />
                    <div class="absolute bottom-1 right-1 bg-black bg-opacity-80 text-white text-xs px-1.5 py-0.5 rounded">
                      {{ formatDuration(rec.full_duration) }}
                    </div>
                    <div 
                      v-if="rec.preview_duration < rec.full_duration"
                      class="absolute top-1 left-1 bg-yellow-500 text-black text-xs font-semibold px-1.5 py-0.5 rounded"
                    >
                      PRO
                    </div>
                  </div>
                  
                  <div class="flex-1 min-w-0">
                    <h3 class="font-semibold text-sm text-gray-900 dark:text-white line-clamp-2 mb-1">
                      {{ rec.title }}
                    </h3>
                    <p class="text-xs text-gray-600 dark:text-gray-400 line-clamp-2">
                      {{ rec.description }}
                    </p>
                  </div>
                </div>
              </NuxtLink>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useRuntimeConfig } from '#app'
import 'media-chrome'
import 'videojs-video-element'

const route = useRoute()
const config = useRuntimeConfig()
const { authHeader } = useAuth()

type MediaLikeElement = HTMLElement & {
  src: string
  currentTime: number
  pause: () => void
  play: () => Promise<void>
  load: () => void
  setAttribute: (name: string, value: string) => void
  addEventListener: HTMLElement['addEventListener']
  removeEventListener: HTMLElement['removeEventListener']
}

const videoElement = ref<MediaLikeElement | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const videoData = ref<any>(null)
const recommendations = ref<any[]>([])
const showPremiumOverlay = ref(false)

// Tracks the video's current playback position so our custom seekbar
// can stay in sync without relying on media-chrome's internal state.
const currentTime = ref(0)

const videoId = route.params.videoId as string

// ── Computed helpers ────────────────────────────────────────────────────────

// How far along (0–100) the playhead is relative to the FULL duration.
// Used to position the progress bar and the scrubber thumb dot.
const progressPercentage = computed(() => {
  const duration = videoData.value?.video?.fullDuration
  if (!duration) return 0
  return Math.min(100, (currentTime.value / duration) * 100)
})

// Where to draw the lock marker and begin the locked zone (0–100).
const previewPercentage = computed(() => {
  if (!videoData.value) return 0
  return (videoData.value.video.previewDuration / videoData.value.video.fullDuration) * 100
})

// seekMax is intentionally removed — see handleSeekbarInput for the new approach.

const videoDescription = computed(() => {
  return videoData.value?.video?.description || 'No description available.'
})

const formatDuration = (seconds: number) => {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// ── Event handlers ───────────────────────────────────────────────────────────

// Keep our reactive currentTime in sync with the video element.
// Also run the hard enforcer as a safety net (e.g. if someone manually
// edits the DOM or the video is seeked via keyboard).
const handleTimeUpdate = (event: Event) => {
  const video = event.target as HTMLVideoElement
  currentTime.value = video.currentTime
  enforcePreviewLimit(video)
}

const handleSeeking = (event: Event) => {
  const video = event.target as HTMLVideoElement
  enforcePreviewLimit(video)
}

// Called when the user clicks or drags our custom range input.
//
// The range max is always fullDuration, so the browser maps clicks correctly
// across the whole bar. We then inspect the value ourselves:
//
//   • If the user clicked in the FREE zone (< previewDuration) → seek normally.
//   • If the user clicked in the LOCKED zone (≥ previewDuration) and has no
//     access → reject the seek, snap back to the lock boundary, show overlay.
//
// This is better than capping `max` at `previewDuration` because that caused
// the browser to compress the coordinate space: a click at 80% of the bar
// width would have resolved to 80% × previewDuration instead of 80% × fullDuration.
const handleSeekbarInput = (event: Event) => {
  const input = event.target as HTMLInputElement
  const requestedTime = Number(input.value)
  const previewDuration = videoData.value?.video?.previewDuration

  // Locked-zone click for a non-premium user.
  if (!videoData.value?.hasAccess && previewDuration && requestedTime >= previewDuration) {
    // Reset the range thumb back to the lock boundary so it doesn't
    // visually jump past the lock pin.
    input.value = String(previewDuration)
    currentTime.value = previewDuration

    const video = videoElement.value
    if (video) {
      video.currentTime = previewDuration
      video.pause()
    }

    showPremiumOverlay.value = true
    setTimeout(() => { showPremiumOverlay.value = false }, 5000)
    return
  }

  // Normal seek within the accessible zone.
  currentTime.value = requestedTime
  const video = videoElement.value
  if (video) {
    video.currentTime = requestedTime
  }
}

const enforcePreviewLimit = (video: HTMLVideoElement) => {
  const previewDuration = videoData.value?.video?.previewDuration
  if (videoData.value?.hasAccess || !previewDuration) return
  if (video.currentTime <= previewDuration) return

  video.currentTime = previewDuration
  video.pause()
  showPremiumOverlay.value = true

  setTimeout(() => {
    showPremiumOverlay.value = false
  }, 5000)
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(async () => {
  try {
    const videoResponse = await fetch(`${config.public.apiUrl}/api/video-access/${videoId}`, {
      headers: authHeader()
    })
    if (!videoResponse.ok) throw new Error('Failed to load video data')
    videoData.value = await videoResponse.json()
    
    const recsResponse = await fetch(`${config.public.apiUrl}/api/videos`)
    if (recsResponse.ok) {
      const data = await recsResponse.json()
      recommendations.value = (data.videos || []).filter((v: any) => v.id !== videoId).slice(0, 5)
    }
    
    loading.value = false
    await nextTick()
    initializeVideoElement(videoData.value.video.playlistUrl)
  } catch (e: any) {
    error.value = e.message
    loading.value = false
  }
})

onUnmounted(() => {
  teardownVideoListeners()
})

let handleLoadedMetadata: (() => void) | null = null
let handleMediaError: (() => void) | null = null

const initializeVideoElement = async (playlistUrl: string) => {
  const video = videoElement.value
  if (!video) throw new Error('Video element is unavailable')

  teardownVideoListeners()

  handleLoadedMetadata = () => {
    console.log('Video metadata loaded')
  }

  handleMediaError = () => {
    const mediaError = (video as any).error ?? null
    console.error('[watch] media element error', mediaError)
    error.value = 'Video playback error. The HLS stream could not be loaded.'
  }

  video.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true })
  video.addEventListener('error', handleMediaError)

  video.setAttribute('src', playlistUrl)
  video.setAttribute('playsinline', '')
  video.setAttribute('preload', 'auto')

  await customElements.whenDefined('videojs-video')
  video.load()
}

const teardownVideoListeners = () => {
  const video = videoElement.value
  if (!video) return

  if (handleLoadedMetadata) {
    video.removeEventListener('loadedmetadata', handleLoadedMetadata)
    handleLoadedMetadata = null
  }
  if (handleMediaError) {
    video.removeEventListener('error', handleMediaError)
    handleMediaError = null
  }
}
</script>

<style scoped>
.watch-media-controller {
  --media-control-background: linear-gradient(to top, rgba(0, 0, 0, 0.85), rgba(0, 0, 0, 0.3));
  --media-control-color: #ffffff;
}

.watch-media-element {
  position: relative;
  z-index: 1;
}

.watch-media-control-bar {
  position: relative;
  z-index: 20;
  padding: 8px 16px;
}

/* The range input is transparent — it overlays the visual track and captures
   pointer events, while the visual divs underneath render the actual colors.
   Reset browser-default margins so it sits flush over the track. */
.watch-seekbar-input {
  margin: 0;
  padding: 0;
}
</style>
