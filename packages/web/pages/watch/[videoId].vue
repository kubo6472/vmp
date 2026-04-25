<template>
  <div class="min-h-screen overflow-x-hidden bg-gray-50 dark:bg-gray-950">
    <AppHeader />

    <PremiumOverlay :show="showPremiumOverlay && !isFullPublicPreview" :video-id="videoId" />

    <div class="max-w-[1800px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <!-- Loading State -->
      <div v-if="loading" class="flex items-center justify-center min-h-[60vh]">
        <div class="text-center">
          <div class="inline-block w-12 h-12 border-4 border-gray-300 border-t-blue-600 rounded-full animate-spin mb-4"></div>
          <p class="text-gray-600 dark:text-gray-400">{{ strings.loadingVideo }}</p>
        </div>
      </div>

      <!-- Rate Limit State -->
      <div v-else-if="rateLimited" class="max-w-4xl mx-auto">
        <div class="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-6">
          <div class="flex items-start space-x-4">
            <div class="flex-shrink-0 w-10 h-10 bg-amber-100 dark:bg-amber-900 rounded-full flex items-center justify-center">
              <svg class="w-5 h-5 text-amber-600 dark:text-amber-400" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 102 0V6zm-1 8a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
              </svg>
            </div>
            <div class="flex-1">
              <h3 class="text-lg font-semibold text-amber-900 dark:text-amber-200 mb-1">
                {{ strings.rateLimitTitle }}
              </h3>
              <p class="text-amber-800 dark:text-amber-300 mb-4">
                {{ strings.rateLimitMessage(rateLimitCurrent, rateLimitLimit) }}
              </p>
              <div class="flex items-center space-x-3">
                <NuxtLink
                  :to="`/login?redirect=/watch/${videoId}`"
                  class="inline-flex items-center px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-lg transition-colors"
                >
                  {{ strings.signIn }}
                </NuxtLink>
                <NuxtLink to="/" class="text-amber-700 dark:text-amber-400 hover:underline text-sm">
                  {{ strings.backToHomepage }}
                </NuxtLink>
              </div>
              <p v-if="rateLimitRetryAfter" class="mt-3 text-xs text-amber-600 dark:text-amber-500">
                {{ strings.rateLimitWait(formatRetryAfter(rateLimitRetryAfter)) }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Error State -->
      <div v-else-if="error" class="max-w-4xl mx-auto">
        <div class="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg p-6">
          <h3 class="text-lg font-semibold text-red-900 dark:text-red-200 mb-2">{{ strings.error }}</h3>
          <p class="text-red-700 dark:text-red-300">{{ error }}</p>
          <NuxtLink to="/" class="inline-block mt-4 text-blue-600 dark:text-blue-400 hover:underline">
            {{ strings.backToHomepage }}
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
              v-if="!videoData.hasAccess && effectiveFullDuration > 0 && !isFullPublicPreview"
              class="absolute top-0 left-0 right-0 z-30 bg-gradient-to-b from-yellow-500/90 to-yellow-600/90 backdrop-blur-sm text-black px-4 py-2 flex items-center justify-between"
            >
              <div class="flex items-center space-x-2">
                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
                </svg>
                <span class="font-semibold">{{ strings.previewMode }}</span>
              </div>
              <span class="text-sm">{{ strings.upgradeToWatch }}</span>
            </div>

            <!-- Buffering Spinner -->
            <div
              v-if="buffering"
              class="absolute inset-0 z-20 flex items-center justify-center pointer-events-none"
              role="status"
              aria-live="polite"
              :aria-label="strings.videoBuffering"
            >
              <div class="w-14 h-14 border-4 border-white/20 border-t-white rounded-full animate-spin" aria-hidden="true"></div>
              <span class="sr-only">{{ strings.videoBuffering }}</span>
            </div>

            <div
              v-if="videoData.video.isLivestream"
              class="absolute top-0 left-0 right-0 z-30 bg-gradient-to-b from-rose-500/90 to-rose-600/90 backdrop-blur-sm text-white px-4 py-2 flex items-center justify-between"
            >
              <div class="flex items-center space-x-2">
                <span class="inline-block w-2 h-2 rounded-full bg-white"></span>
                <span class="font-semibold">Live</span>
              </div>
              <span class="text-sm">Realtime stream</span>
            </div>

            <button
              v-if="autoplayBlocked"
              type="button"
              class="absolute inset-0 z-20 flex items-center justify-center"
              :aria-label="strings.playVideo"
              @click="handleAutoplayOverlayClick"
            >
              <span class="w-20 h-20 rounded-full bg-black/70 border-2 border-white/70 text-white flex items-center justify-center shadow-xl">
                <svg class="w-10 h-10 ml-1" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </span>
            </button>

            <!-- Video Player -->
            <media-controller
              v-if="!videoData.video.isLivestream"
              id="watch-media-controller"
              class="watch-media-controller group/controls block w-full aspect-video relative"
              @click.capture="handleUserPlaybackInteraction"
              @pointerdown="handleUserPlaybackInteraction"
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

              <!-- Custom Control Bar — stacked: seekbar on top, buttons below -->
              <div class="watch-controls-container">
                <!-- Seekbar row — full width, separate from buttons -->
                <div class="watch-seekbar-row">
                  <div class="watch-seekbar-wrap">
                    <div class="relative w-full h-1 group-hover/controls:h-1.5 rounded-full pointer-events-none transition-all">
                      <div class="absolute inset-0 rounded-full bg-white/25"></div>
                      <div
                        v-if="!videoData.hasAccess && effectiveFullDuration > 0 && !isFullPublicPreview"
                        class="absolute inset-y-0 rounded-r-full bg-white/5"
                        :style="{ left: previewPercentage + '%' }"
                      ></div>
                      <div
                        class="absolute inset-y-0 left-0 rounded-full bg-blue-500"
                        :style="{ width: progressPercentage + '%' }"
                      ></div>
                      <div
                        class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 bg-white rounded-full shadow-md opacity-0 group-hover/controls:opacity-100 transition-opacity"
                        :style="{ left: progressPercentage + '%' }"
                      ></div>
                      <div
                        v-if="!videoData.hasAccess && effectiveFullDuration > 0 && !isFullPublicPreview"
                        class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 bg-yellow-400 border-2 border-black rounded-full flex items-center justify-center shadow-[0_0_0_3px_rgba(250,204,21,0.3)] z-10"
                        :style="{ left: previewPercentage + '%' }"
                      >
                        <svg class="w-2 h-2 text-black" fill="currentColor" viewBox="0 0 20 20">
                          <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
                        </svg>
                      </div>
                    </div>
                    <input
                      type="range"
                      class="watch-seekbar-input absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      aria-label="Seek timeline"
                      :min="0"
                      :max="effectiveFullDuration"
                      :step="0.1"
                      :value="currentTime"
                      :aria-valuemin="0"
                      :aria-valuemax="effectiveFullDuration"
                      :aria-valuenow="currentTime"
                      @input.capture="handleUserPlaybackInteraction"
                      @input="handleSeekbarInput"
                      @keydown.capture="handleUserPlaybackInteraction"
                    />
                  </div>
                </div>

                <!-- Button row -->
                <media-control-bar class="watch-media-control-bar" noautohide>
                  <media-play-button></media-play-button>
                  <media-seek-backward-button class="hidden sm:inline-flex" seek-offset="10"></media-seek-backward-button>
                  <media-seek-forward-button class="hidden sm:inline-flex" seek-offset="10"></media-seek-forward-button>
                  <media-time-display show-duration></media-time-display>
                  <span class="flex-1"></span>
                  <media-mute-button></media-mute-button>
                  <media-volume-range class="hidden sm:inline-flex"></media-volume-range>
                  <media-fullscreen-button></media-fullscreen-button>
                </media-control-bar>
              </div>
            </media-controller>
            <canvas
              v-else
              ref="liveCanvas"
              class="block w-full aspect-video"
            />
            <div
              v-if="videoData.video.isLivestream && !hasLivestreamPlaybackSource"
              class="absolute inset-0 z-10 bg-black/85 flex items-center justify-center px-6 text-center"
            >
              <div>
                <p class="text-base font-semibold text-white">{{ strings.livestreamUnavailable }}</p>
                <p class="mt-1 text-sm text-gray-300">{{ strings.livestreamUnavailableDetail }}</p>
              </div>
            </div>
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
                <span>{{ effectiveFullDuration ? formatDuration(effectiveFullDuration) : '--' }}</span>
              </span>

              <span
                v-if="videoData.video.isLivestream"
                class="flex items-center space-x-1 text-rose-600 dark:text-rose-400 font-semibold"
              >
                <span class="inline-block w-2 h-2 rounded-full bg-rose-500"></span>
                <span>Livestream · {{ videoData.video.livestreamStatus || 'scheduled' }}</span>
              </span>

              <span
                v-else-if="videoData.hasAccess"
                class="flex items-center space-x-1 text-yellow-600 dark:text-yellow-400 font-semibold"
              >
                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
                <span>{{ strings.premiumAccess }}</span>
              </span>

              <span v-else-if="isFullPublicPreview" class="flex items-center space-x-1 text-emerald-600 dark:text-emerald-400 font-medium">
                <span>{{ strings.freeToWatch }}</span>
              </span>
              <span v-else class="flex items-center space-x-1">
                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
                </svg>
                <span>{{ strings.previewOnly(videoData.video.previewDuration != null ? formatDuration(videoData.video.previewDuration) : '--') }}</span>
              </span>
            </div>

            <div
              class="text-gray-700 dark:text-gray-300 leading-relaxed prose prose-sm dark:prose-invert max-w-none"
              v-html="videoDescriptionHtml"
            ></div>
            <p v-if="videoData.video.isLivestream" class="mt-3 text-sm text-gray-500 dark:text-gray-400">
              {{ strings.livestreamRealtimeNote }}
            </p>
          </div>
        </div>

        <!-- Right Column: Recommendations -->
        <div class="space-y-4">
          <h2 class="text-lg font-bold text-gray-900 dark:text-white px-2">{{ strings.upNext }}</h2>

          <div class="space-y-3">
            <div
              v-for="rec in recommendations"
              :key="rec.id"
              class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden hover:border-gray-300 dark:hover:border-gray-700 transition-colors cursor-pointer"
            >
              <NuxtLink :to="`/watch/${rec.slug ?? rec.id}`" class="block">
                <div class="flex space-x-3 p-3">
                  <div class="relative w-40 h-24 flex-shrink-0 bg-gray-200 dark:bg-gray-800 rounded overflow-hidden">
                    <img
                      v-if="rec.thumbnail_url"
                      :src="sizeUrl(rec.thumbnail_url, 'small')"
                      :alt="rec.title"
                      class="w-full h-full object-cover"
                    />
                    <div class="absolute bottom-1 right-1 bg-black bg-opacity-80 text-white text-xs px-1.5 py-0.5 rounded">
                      {{ rec.full_duration ? formatDuration(rec.full_duration) : '--' }}
                    </div>
                    <div
                      v-if="rec.full_duration > 0 ? rec.preview_duration < rec.full_duration : rec.preview_duration > 0"
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
import { ref, computed, watch, onUnmounted, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useRuntimeConfig } from '#app'
import 'media-chrome'
import 'videojs-video-element'
import { resolvePlaylistDuration } from '~/composables/useHlsDuration'
import { sizeUrl } from '~/composables/useThumbnail'
import { renderMarkdownToHtml } from '~/utils/markdown'
import strings from '~/utils/strings'

const route  = useRoute()
const config = useRuntimeConfig()

let moqModule: Awaited<typeof import('@moq/lite')> | null = null
let watchModule: Awaited<typeof import('@moq/watch')> | null = null

const ensureMoqModules = async () => {
  if (import.meta.server) {
    throw new Error('Livestream playback is only available in the browser.')
  }
  if (!moqModule || !watchModule) {
    const [moq, watch] = await Promise.all([
      import('@moq/lite'),
      import('@moq/watch')
    ])
    moqModule = moq
    watchModule = watch
  }
  return { moq: moqModule, watch: watchModule }
}

// ── Auth — userId now comes from the session, not a query param ──────────────
//
// For logged-in users the API looks up their subscription and returns the
// correct hasAccess / playlistUrl for their plan.
const { isLoggedIn, authHeader } = useAuth()

type MediaLikeElement = HTMLElement & {
  src: string
  currentTime: number
  muted: boolean
  readyState: number
  pause: () => void
  play: () => Promise<void>
  load: () => void
  setAttribute: (name: string, value: string) => void
  addEventListener: HTMLElement['addEventListener']
  removeEventListener: HTMLElement['removeEventListener']
}

const videoElement        = ref<MediaLikeElement | null>(null)
const loading             = ref(true)
const error               = ref<string | null>(null)
const videoData           = ref<any>(null)
const recommendations     = ref<any[]>([])
const showPremiumOverlay  = ref(false)
const buffering           = ref(false)
const currentTime         = ref(0)
const rateLimited         = ref(false)
const rateLimitRetryAfter = ref<number | null>(null)
const rateLimitCurrent    = ref(0)
const rateLimitLimit      = ref(0)
const autoplayBlocked     = ref(false)
const autoplayMuting      = ref(false)
const autoplayPlayError   = ref(false)
const liveCanvas          = ref<HTMLCanvasElement | null>(null)

const videoId = computed(() => String(route.params.videoId ?? ''))

// Resolved actual duration (from HLS playlist parsing) when D1 returns 0
const resolvedFullDuration = ref(0)

const effectiveFullDuration = computed(() =>
  resolvedFullDuration.value || videoData.value?.video?.fullDuration || 0
)

/** Full-length preview for non-subscribers (admin set preview lock to full duration). */
const isFullPublicPreview = computed(() => {
  const v = videoData.value
  if (!v?.video || v.hasAccess) return false
  const prev = v.video.previewDuration
  const full = effectiveFullDuration.value
  const EPSILON_SECONDS = 0.5
  return typeof prev === 'number' && full > 0 && prev >= (full - EPSILON_SECONDS)
})
const hasLivestreamMoqSource = computed(() =>
  Boolean(
    videoData.value?.video?.isLivestream &&
    typeof videoData.value?.video?.livestreamMoqEndpoint === 'string' &&
    videoData.value?.video?.livestreamMoqEndpoint.trim().length > 0 &&
    typeof videoData.value?.video?.livestreamMoqBroadcast === 'string' &&
    videoData.value?.video?.livestreamMoqBroadcast.trim().length > 0
  )
)
const hasLivestreamPlaybackSource = computed(() =>
  Boolean(
    videoData.value?.video?.isLivestream &&
    typeof videoData.value?.video?.playlistUrl === 'string' &&
    videoData.value?.video?.playlistUrl.trim().length > 0
  )
)

// ── Computed helpers ─────────────────────────────────────────────────────────

const progressPercentage = computed(() => {
  const duration = effectiveFullDuration.value
  if (!duration) return 0
  return Math.min(100, (currentTime.value / duration) * 100)
})

const previewPercentage = computed(() => {
  if (!videoData.value) return 0
  const full = effectiveFullDuration.value
  if (!full) return 0
  return (Math.min(videoData.value.video.previewDuration, full) / full) * 100
})

const videoDescription = computed(() => {
  const rawDescription = videoData.value?.video?.description
  if (typeof rawDescription !== 'string') return strings.noDescription
  const trimmedDescription = rawDescription.trim()
  return trimmedDescription ? trimmedDescription : strings.noDescription
})
const videoDescriptionHtml = computed(() => renderMarkdownToHtml(videoDescription.value))

const formatDuration = (seconds: number) => {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

const formatRetryAfter = (seconds: number) => {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

// ── Event handlers ────────────────────────────────────────────────────────────

const handleTimeUpdate = (event: Event) => {
  const video = event.target as HTMLVideoElement
  currentTime.value = video.currentTime
  enforcePreviewLimit(video)
}

const handleSeeking = (event: Event) => {
  const video = event.target as HTMLVideoElement
  enforcePreviewLimit(video)
}

const handleSeekbarInput = (event: Event) => {
  const input          = event.target as HTMLInputElement
  const requestedTime  = Number(input.value)
  const previewDuration = videoData.value?.video?.previewDuration

  if (!videoData.value?.hasAccess && previewDuration && requestedTime >= previewDuration) {
    if (isFullPublicPreview.value) {
      currentTime.value = requestedTime
      if (videoElement.value) videoElement.value.currentTime = requestedTime
      return
    }
    input.value        = String(previewDuration)
    currentTime.value  = previewDuration
    const video = videoElement.value
    if (video) { video.currentTime = previewDuration; video.pause() }
    showPremiumOverlay.value = true
    return
  }

  currentTime.value = requestedTime
  if (videoElement.value) videoElement.value.currentTime = requestedTime
}

const enforcePreviewLimit = (video: HTMLVideoElement) => {
  const previewDuration = videoData.value?.video?.previewDuration
  if (videoData.value?.hasAccess || !previewDuration || isFullPublicPreview.value) return
  if (video.currentTime <= previewDuration) return
  video.currentTime = previewDuration
  video.pause()
  showPremiumOverlay.value = true
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onUnmounted(() => {
  teardownVideoListeners()
  teardownLivestreamRuntime()
})

let handleLoadedMetadata: (() => void) | null = null
let handleMediaError:     (() => void) | null = null
let handleWaiting:        (() => void) | null = null
let handlePlaying:        (() => void) | null = null
let handleCanPlay:        (() => void) | null = null
let livestreamRuntime: {
  connection: unknown
  broadcast: unknown
  sync: unknown
  videoSource: unknown
  videoDecoder: unknown
  videoRenderer: unknown
  audioSource: unknown
  audioDecoder: unknown
  audioEmitter: unknown
} | null = null
let reloadInFlight = false
let currentRouteRequestId = 0
let activeLoadAbortController: AbortController | null = null

type FetchVideoAccessOptions = {
  videoId?: string
  signal?: AbortSignal
  guard?: () => boolean
}

const fetchVideoAccess = async (options: FetchVideoAccessOptions = {}) => {
  const targetVideoId = options.videoId ?? (route.params.videoId as string)
  const guard = options.guard ?? (() => true)
  const ensureCurrent = () => {
    if (options.signal?.aborted || !guard()) {
      throw new DOMException('Request aborted', 'AbortError')
    }
  }

  ensureCurrent()
  const videoResponse = await fetch(
    `${config.public.apiUrl}/api/video-access/${targetVideoId}`,
    { headers: { ...authHeader() }, signal: options.signal }
  )
  ensureCurrent()

  if (videoResponse.status === 429) {
    const data = await videoResponse.json().catch(() => ({}))
    ensureCurrent()
    if (data.error === 'rate_limit_exceeded' && data.loginPrompt === true) {
      rateLimited.value = true
      rateLimitRetryAfter.value = data.retryAfter ?? null
      rateLimitCurrent.value = data.current ?? data.limit ?? 0
      rateLimitLimit.value = data.limit ?? data.current ?? 0
      return
    }
    throw new Error('Too many requests. Please try again later.')
  }

  if (!videoResponse.ok) throw new Error('Failed to load video data')
  const data = await videoResponse.json()
  ensureCurrent()
  videoData.value = data
  rateLimited.value = false
  rateLimitRetryAfter.value = null
  rateLimitCurrent.value = 0
  rateLimitLimit.value = 0

  // If D1 has no duration stored yet (new draft auto-registered from R2),
  // parse the HLS playlist to get the real duration.
  resolvedFullDuration.value = 0
  if (!videoData.value?.video?.fullDuration) {
    const playlistUrl = videoData.value?.video?.playlistUrl
    if (playlistUrl) {
      const resolved = await resolvePlaylistDuration(playlistUrl)
      ensureCurrent()
      if (resolved) resolvedFullDuration.value = resolved
    }
  }
}

const createLoadInvocation = () => {
  if (activeLoadAbortController) {
    activeLoadAbortController.abort()
  }

  const requestId = ++currentRouteRequestId
  const abortController = new AbortController()
  activeLoadAbortController = abortController
  const isCurrentInvocation = () =>
    currentRouteRequestId === requestId &&
    activeLoadAbortController === abortController &&
    !abortController.signal.aborted

  const cancel = () => {
    if (activeLoadAbortController === abortController) {
      activeLoadAbortController = null
    }
    abortController.abort()
  }

  return { abortController, isCurrentInvocation, cancel }
}

type LoadVideoForRouteOptions = {
  signal?: AbortSignal
  guard?: () => boolean
}

const loadVideoForRoute = async (targetVideoId: string, options: LoadVideoForRouteOptions = {}) => {
  const guard = options.guard ?? (() => true)
  const ensureCurrent = () => {
    if (options.signal?.aborted || !guard()) {
      throw new DOMException('Request aborted', 'AbortError')
    }
  }

  ensureCurrent()

  autoplayBlocked.value = false
  autoplayMuting.value = false
  buffering.value = false
  autoplayPlayError.value = false
  showPremiumOverlay.value = false
  rateLimited.value = false
  currentTime.value = 0
  loading.value = true
  error.value = null
  teardownLivestreamRuntime()

  try {
    await fetchVideoAccess({
      videoId: targetVideoId,
      signal: options.signal,
      guard
    })
    ensureCurrent()

    recommendations.value = []
    try {
      const recsResponse = await fetch(`${config.public.apiUrl}/api/videos`, {
        signal: options.signal
      })
      ensureCurrent()

      if (recsResponse.ok) {
        const recommendationsData = await recsResponse.json()
        ensureCurrent()
        recommendations.value = (recommendationsData.videos || []).filter((v: any) => v.id !== targetVideoId).slice(0, 5)
      }
    } catch (e: any) {
      if (e?.name === 'AbortError' || options.signal?.aborted || !guard()) throw e
      // Recommendation fetch is best-effort; keep list empty on failure.
    }

    ensureCurrent()
    loading.value = false
    await nextTick()
    ensureCurrent()
    if (videoData.value?.video?.isLivestream) {
      if (hasLivestreamMoqSource.value && !rateLimited.value) {
        error.value = null
        await initializeLivestreamRuntime(
          String(videoData.value.video.livestreamMoqEndpoint),
          String(videoData.value.video.livestreamMoqBroadcast),
          guard,
          options.signal
        )
        ensureCurrent()
      }
      return
    }
    const playlistUrl = videoData.value?.video?.playlistUrl
    if (playlistUrl && !rateLimited.value) {
      error.value = null
      await initializeVideoElement(playlistUrl, guard, options.signal)
      ensureCurrent()
    }
  } catch (e: any) {
    if (e.name === 'AbortError' || options.signal?.aborted || !guard()) return
    error.value = e.message
    loading.value = false
  }
}

const initializeLivestreamRuntime = async (
  moqEndpoint: string,
  moqBroadcast: string,
  isCurrentInvocation: () => boolean = () => true,
  signal?: AbortSignal
) => {
  const ensureActive = () => {
    if (signal?.aborted || !isCurrentInvocation()) {
      throw new DOMException('Request aborted', 'AbortError')
    }
  }

  ensureActive()
  const canvas = liveCanvas.value
  if (!canvas) throw new Error('Live canvas is unavailable')

  teardownVideoListeners()
  teardownLivestreamRuntime()
  let partialRuntime: {
    connection?: unknown
    broadcast?: unknown
    sync?: unknown
    videoSource?: unknown
    videoDecoder?: unknown
    videoRenderer?: unknown
    audioSource?: unknown
    audioDecoder?: unknown
    audioEmitter?: unknown
  } = {}

  try {
    const { moq, watch } = await ensureMoqModules()
    const connection = new moq.Connection.Reload({
      url: new URL(moqEndpoint),
      enabled: true
    })
    partialRuntime.connection = connection

    const broadcast = new watch.Broadcast({
      connection: connection.established,
      enabled: true,
      name: moq.Path.from(moqBroadcast)
    })
    partialRuntime.broadcast = broadcast

    const sync = new watch.Sync()
    partialRuntime.sync = sync

    const videoSource = new watch.Video.Source(sync, { broadcast })
    partialRuntime.videoSource = videoSource

    const videoDecoder = new watch.Video.Decoder(videoSource)
    partialRuntime.videoDecoder = videoDecoder

    const videoRenderer = new watch.Video.Renderer(videoDecoder, { canvas, paused: false })
    partialRuntime.videoRenderer = videoRenderer

    const audioSource = new watch.Audio.Source(sync, { broadcast })
    partialRuntime.audioSource = audioSource

    const audioDecoder = new watch.Audio.Decoder(audioSource)
    partialRuntime.audioDecoder = audioDecoder

    const audioEmitter = new watch.Audio.Emitter(audioDecoder, { paused: false })
    partialRuntime.audioEmitter = audioEmitter

    ensureActive()
    livestreamRuntime = partialRuntime as typeof livestreamRuntime
  } catch (error) {
    teardownLivestreamRuntime(partialRuntime)
    throw error
  }
}

watch(isLoggedIn, async (loggedIn, wasLoggedIn, onCleanup) => {
  if (!loggedIn || wasLoggedIn || reloadInFlight) return

  reloadInFlight = true
  const { abortController, isCurrentInvocation, cancel } = createLoadInvocation()
  onCleanup(() => {
    cancel()
  })

  try {
    await loadVideoForRoute(String(route.params.videoId), {
      signal: abortController.signal,
      guard: isCurrentInvocation
    })
  } finally {
    reloadInFlight = false
  }
})

const initializeVideoElement = async (
  playlistUrl: string,
  isCurrentInvocation: () => boolean = () => true,
  signal?: AbortSignal
) => {
  const ensureActive = () => {
    if (signal?.aborted || !isCurrentInvocation()) {
      throw new DOMException('Request aborted', 'AbortError')
    }
  }

  ensureActive()

  // Wait for the custom element to be fully upgraded before touching it.
  // Setting src before this resolves causes "this.api is undefined" inside
  // the videojs-video element because its internal Video.js instance isn't
  // created until connectedCallback runs.
  await customElements.whenDefined('videojs-video')
  ensureActive()

  const video = videoElement.value
  if (!video) throw new Error('Video element is unavailable')
  ensureActive()

  teardownVideoListeners()
  ensureActive()

  handleLoadedMetadata = () => { console.log('Video metadata loaded') }
  handleMediaError = () => {
    if (!isCurrentInvocation()) return
    error.value = strings.videoPlaybackError
  }
  handleWaiting  = () => { if (isCurrentInvocation()) buffering.value = true }
  handlePlaying  = () => { if (isCurrentInvocation()) buffering.value = false }
  handleCanPlay  = () => { if (isCurrentInvocation()) buffering.value = false }

  video.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true })
  video.addEventListener('error', handleMediaError)
  video.addEventListener('waiting', handleWaiting)
  video.addEventListener('playing', handlePlaying)
  video.addEventListener('canplay', handleCanPlay)
  ensureActive()

  buffering.value = true
  autoplayBlocked.value = false
  autoplayMuting.value = true
  ensureActive()
  video.muted = true
  video.setAttribute('src', playlistUrl)
  video.setAttribute('preload', 'auto')
  video.load()

  // Check if video is already ready to avoid hanging on canplay
  if (video.readyState >= 3) { // HAVE_FUTURE_DATA or HAVE_ENOUGH_DATA
    // Already ready, no need to wait
  } else {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener('canplay', onCanPlay)
        video.removeEventListener('error', onError)
        signal?.removeEventListener('abort', onSignalAbort)
      }
      const onCanPlay = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error('Media failed to load'))
      }
      const onSignalAbort = () => {
        cleanup()
        reject(new DOMException('Request aborted', 'AbortError'))
      }
      video.addEventListener('canplay', onCanPlay)
      video.addEventListener('error', onError)
      signal?.addEventListener('abort', onSignalAbort, { once: true })
    })
  }
  ensureActive()

  try {
    await video.play()
    ensureActive()
    autoplayPlayError.value = false
  } catch (e: any) {
    if (e?.name === 'AbortError' || signal?.aborted || !isCurrentInvocation()) throw e
    buffering.value = false
    // Check if error is due to autoplay policy
    if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
      autoplayBlocked.value = true
    } else {
      // Media/network error
      autoplayPlayError.value = true
      console.error('Video playback error:', e)
    }
  }
}

const handleAutoplayOverlayClick = async () => {
  const video = videoElement.value
  if (!video) return

  try {
    video.muted = false
    await video.play()
    autoplayBlocked.value = false
    autoplayMuting.value = false
    autoplayPlayError.value = false
  } catch (e: any) {
    // Check if error is due to autoplay policy
    if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
      autoplayBlocked.value = true
      autoplayMuting.value = true
    } else {
      // Media/network error
      autoplayBlocked.value = false
      autoplayPlayError.value = true
      console.error('Video playback error:', e)
    }
  }
}

const handleUserPlaybackInteraction = (event: PointerEvent | MouseEvent | Event) => {
  if (!autoplayMuting.value) return

  // Check if the click originated on or inside the media-mute-button
  const target = event.target as HTMLElement
  const path = event.composedPath?.() || []
  const isOnMuteButton = target.closest?.('media-mute-button') ||
                        path.some((el: EventTarget) => (el as HTMLElement).tagName === 'MEDIA-MUTE-BUTTON')

  if (isOnMuteButton) return

  const video = videoElement.value
  if (!video) return
  video.muted = false
  autoplayMuting.value = false
}

watch(
  () => route.params.videoId,
  async (newVideoId, oldVideoId, onCleanup) => {
    if (newVideoId === oldVideoId) return
    const { abortController, isCurrentInvocation, cancel } = createLoadInvocation()

    onCleanup(() => {
      cancel()
    })

    await loadVideoForRoute(String(newVideoId), {
      signal: abortController.signal,
      guard: isCurrentInvocation
    })
  },
  { immediate: true }
)

function teardownVideoListeners() {
  const video = videoElement.value
  if (!video) return
  if (handleLoadedMetadata) { video.removeEventListener('loadedmetadata', handleLoadedMetadata); handleLoadedMetadata = null }
  if (handleMediaError)     { video.removeEventListener('error', handleMediaError);               handleMediaError     = null }
  if (handleWaiting)        { video.removeEventListener('waiting', handleWaiting);                handleWaiting        = null }
  if (handlePlaying)        { video.removeEventListener('playing', handlePlaying);                handlePlaying        = null }
  if (handleCanPlay)        { video.removeEventListener('canplay', handleCanPlay);                handleCanPlay        = null }
}

function teardownLivestreamRuntime(runtimeToDispose?: Record<string, unknown> | null) {
  const source = runtimeToDispose ?? livestreamRuntime
  const instances = source ? Object.values(source) : []
  for (const instance of instances) {
    const resource = instance as { close?: () => void; destroy?: () => void; stop?: () => void } | undefined
    resource?.stop?.()
    resource?.destroy?.()
    resource?.close?.()
  }
  if (!runtimeToDispose || runtimeToDispose === livestreamRuntime) {
    livestreamRuntime = null
  }
}
</script>

<style scoped>
.watch-media-controller {
  --media-control-background: transparent;
  --media-control-color: #ffffff;
}
.watch-media-element { position: relative; z-index: 1; }

.watch-controls-container {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 20;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.9) 0%, rgba(0, 0, 0, 0.5) 60%, transparent 100%);
  display: flex;
  flex-direction: column;
}

.watch-seekbar-row {
  padding: 0 12px;
}

.watch-seekbar-wrap {
  position: relative;
  display: flex;
  align-items: center;
  height: 20px;
  cursor: pointer;
}

.watch-seekbar-input {
  margin: 0;
  padding: 0;
}

.watch-media-control-bar {
  position: relative;
  z-index: 20;
  padding: 2px 8px 6px;
  --media-control-background: transparent;
}

@media (min-width: 640px) {
  .watch-seekbar-row { padding: 0 16px; }
  .watch-media-control-bar { padding: 2px 12px 8px; }
}
</style>