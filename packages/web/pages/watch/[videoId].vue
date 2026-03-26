<template>
  <div class="min-h-screen bg-gray-900">
    <div class="max-w-5xl mx-auto px-4 py-8">
      <!-- Loading State -->
      <div v-if="loading" class="text-white text-center py-20">
        <p class="text-xl">Loading video...</p>
      </div>

      <!-- Error State -->
      <div v-else-if="error" class="bg-red-900 text-white rounded-lg p-6">
        <h3 class="text-xl font-bold mb-2">Error</h3>
        <p>{{ error }}</p>
      </div>

      <!-- Video Player -->
      <div v-else-if="videoData">
        <div class="mb-4 bg-gray-800 text-gray-100 rounded-lg p-4 text-xs font-mono">
          <p class="font-semibold text-sm mb-2">Playback Debug</p>
          <p><span class="text-gray-400">videoId:</span> {{ videoId }}</p>
          <p><span class="text-gray-400">resolved source:</span> {{ debugState.activeSource || 'n/a' }}</p>
          <p><span class="text-gray-400">manifest fetch:</span> {{ debugState.manifestFetchStatus || 'not attempted' }}</p>
          <p><span class="text-gray-400">last player event:</span> {{ debugState.lastEvent || 'n/a' }}</p>
          <p><span class="text-gray-400">last player error:</span> {{ debugState.lastError || 'n/a' }}</p>
        </div>

        <!-- Subscription Banner -->
        <div
          v-if="!videoData.hasAccess"
          class="bg-yellow-600 text-white p-4 rounded-t-lg"
        >
          <p class="font-semibold">🔒 Preview Mode</p>
          <p class="text-sm">Upgrade to Premium to watch the full video</p>
        </div>

        <!-- Video Element -->
        <div class="bg-black rounded-b-lg overflow-hidden">
          <media-controller
            id="watch-media-controller"
            class="watch-media-controller block w-full aspect-video"
          >
            <videojs-video
              ref="videoElement"
              slot="media"
              class="watch-media-element block w-full h-full"
              playsinline
              preload="auto"
              @timeupdate="handleTimeUpdate"
            ></videojs-video>

            <media-loading-indicator slot="centered-chrome"></media-loading-indicator>

            <media-control-bar class="watch-media-control-bar" noautohide>
              <media-play-button mediacontroller="watch-media-controller"></media-play-button>
              <media-seek-backward-button mediacontroller="watch-media-controller" seek-offset="10"></media-seek-backward-button>
              <media-seek-forward-button mediacontroller="watch-media-controller" seek-offset="10"></media-seek-forward-button>
              <media-time-range mediacontroller="watch-media-controller"></media-time-range>
              <media-time-display mediacontroller="watch-media-controller" show-duration></media-time-display>
              <media-mute-button mediacontroller="watch-media-controller"></media-mute-button>
              <media-volume-range mediacontroller="watch-media-controller"></media-volume-range>
              <media-fullscreen-button mediacontroller="watch-media-controller"></media-fullscreen-button>
            </media-control-bar>
          </media-controller>
        </div>

        <!-- Chapter Bar -->
        <div class="mt-4 bg-gray-800 rounded-lg p-4">
          <h3 class="text-white font-semibold mb-3">Chapters</h3>
          <div class="flex gap-2">
            <div
              v-for="(chapter, index) in videoData.chapters"
              :key="index"
              :class="[
                'flex-1 rounded p-3 text-center text-sm font-medium transition',
                chapter.accessible
                  ? 'bg-green-600 text-white cursor-pointer hover:bg-green-700'
                  : 'bg-red-600 text-white cursor-not-allowed'
              ]"
              @click="chapter.accessible && seekToChapter(chapter.startTime)"
            >
              {{ chapter.title }}
              {{ chapter.accessible ? '' : ' 🔒' }}
            </div>
          </div>
        </div>

        <!-- Video Info -->
        <div class="mt-6 bg-gray-800 rounded-lg p-6 text-white">
          <h2 class="text-2xl font-bold mb-4">{{ videoData.video.title }}</h2>
          <div class="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p class="text-gray-400">Subscription</p>
              <p class="font-semibold">{{ videoData.subscription.planType }}</p>
            </div>
            <div>
              <p class="text-gray-400">Access</p>
              <p class="font-semibold">{{ videoData.hasAccess ? 'Full Access' : 'Preview Only' }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useRuntimeConfig } from '#app'
import 'media-chrome'
import 'videojs-video-element'

const route = useRoute()
const config = useRuntimeConfig()

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
const debugState = ref({
  activeSource: '',
  manifestFetchStatus: '',
  lastEvent: '',
  lastError: ''
})

const videoId = route.params.videoId as string
const userId = (route.query.userId as string) || 'user_free'

onMounted(async () => {
  try {
    const response = await fetch(`${config.public.apiUrl}/api/video-access/${userId}/${videoId}`)
    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`Failed to load video data (${response.status}): ${errorBody}`)
    }

    videoData.value = await response.json()
    console.log('[watch] video-access response', videoData.value)

    const playlistUrl = videoData.value.video.playlistUrl
    debugState.value.activeSource = playlistUrl
    debugState.value.manifestFetchStatus = 'using proxied playlist URL'
    loading.value = false
    await nextTick()
    initializeVideoElement(playlistUrl)
  } catch (e: any) {
    debugState.value.lastError = e?.message || String(e)
    error.value = debugState.value.lastError
  } finally {
    if (!videoData.value || error.value) {
      loading.value = false
    }
  }
})

onUnmounted(() => {
  teardownVideoListeners()
})

const handleTimeUpdate = (event: Event) => {
  const video = event.target as HTMLVideoElement
  const currentTime = video.currentTime

  if (!videoData.value?.hasAccess && currentTime > videoData.value?.video?.previewDuration) {
    video.currentTime = videoData.value.video.previewDuration
    video.pause()
    alert('Please upgrade to Premium to continue watching')
  }

  debugState.value.lastEvent = 'timeupdate'
}

const seekToChapter = (startTime: number) => {
  if (!videoElement.value) return

  videoElement.value.currentTime = startTime
  void videoElement.value.play()
}

let handleLoadedMetadata: (() => void) | null = null
let handleMediaError: (() => void) | null = null

const initializeVideoElement = async (playlistUrl: string) => {
  const video = videoElement.value
  if (!video) {
    throw new Error('Video element is unavailable')
  }

  teardownVideoListeners()

  handleLoadedMetadata = () => {
    debugState.value.lastEvent = 'loadedmetadata'
  }

  handleMediaError = () => {
    const mediaError = (video as any).error ?? null
    debugState.value.lastError = mediaError
      ? `code=${mediaError.code}, message=${mediaError.message || 'n/a'}`
      : 'unknown media element error'
    console.error('[watch] media element error', mediaError)
    error.value = 'Video playback error. The HLS stream could not be loaded.'
  }

  video.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true })
  video.addEventListener('error', handleMediaError)

  video.setAttribute('src', playlistUrl)
  video.setAttribute('playsinline', '')
  video.setAttribute('preload', 'auto')
  debugState.value.lastEvent = 'initializing videojs-video-element'

  await customElements.whenDefined('videojs-video')
  video.load()
}

const teardownVideoListeners = () => {
  const video = videoElement.value
  if (!video) {
    return
  }

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
  --media-control-background: linear-gradient(to top, rgba(0, 0, 0, 0.72), rgba(0, 0, 0, 0.2));
  --media-control-color: #ffffff;
}

.watch-media-element {
  position: relative;
  z-index: 1;
}

.watch-media-control-bar {
  position: relative;
  z-index: 20;
}
</style>
