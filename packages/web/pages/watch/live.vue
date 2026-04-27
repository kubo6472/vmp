<template>
  <div class="min-h-screen overflow-x-hidden bg-gray-50 dark:bg-gray-950">
    <AppHeader />

    <div class="max-w-[1800px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <div v-if="loading" class="flex items-center justify-center min-h-[60vh]">
        <div class="text-center">
          <div class="inline-block w-12 h-12 border-4 border-gray-300 border-t-blue-600 rounded-full animate-spin mb-4"></div>
          <p class="text-gray-600 dark:text-gray-400">{{ strings.loadingVideo }}</p>
        </div>
      </div>

      <div v-else-if="error" class="max-w-4xl mx-auto">
        <div class="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg p-6">
          <h3 class="text-lg font-semibold text-red-900 dark:text-red-200 mb-2">{{ strings.error }}</h3>
          <p class="text-red-700 dark:text-red-300">{{ error }}</p>
          <NuxtLink to="/" class="inline-block mt-4 text-blue-600 dark:text-blue-400 hover:underline">
            {{ strings.backToHomepage }}
          </NuxtLink>
        </div>
      </div>

      <div v-else class="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-6">
        <div class="space-y-4">
          <div class="relative bg-black rounded-lg overflow-hidden">
            <div ref="liveMoqShellRef" class="watch-live-moq-shell group/livemoq relative block w-full aspect-video bg-black">
              <canvas ref="canvas" class="block w-full h-full" />
              <div class="watch-live-moq-controls-container">
                <media-control-bar class="watch-live-moq-control-bar" noautohide>
                  <button
                    type="button"
                    class="watch-live-moq-icon-btn"
                    :aria-label="liveMoqIsPaused ? strings.playVideo : strings.pauseVideo"
                    @click="handleLiveMoqPlayPause"
                  >
                    <svg v-if="liveMoqIsPaused" class="w-7 h-7" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    <svg v-else class="w-7 h-7" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                    </svg>
                  </button>
                  <button type="button" class="watch-live-moq-live-edge-btn" :aria-label="strings.goToLive" @click="liveMoqGoLive">
                    <span class="inline-block w-2 h-2 rounded-full bg-rose-500 shrink-0" aria-hidden="true"></span>
                    <span>{{ strings.live }}</span>
                  </button>
                  <span class="flex-1 min-w-2"></span>
                  <button
                    type="button"
                    class="watch-live-moq-icon-btn"
                    :aria-label="liveMoqIsMuted ? strings.unmute : strings.mute"
                    @click="liveMoqToggleMute"
                  >
                    <svg v-if="liveMoqIsMuted" class="w-6 h-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                    </svg>
                    <svg v-else class="w-6 h-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                    </svg>
                  </button>
                  <input
                    type="range"
                    class="watch-live-moq-volume"
                    min="0"
                    max="1"
                    step="0.05"
                    :value="liveMoqVolume"
                    :aria-label="strings.volume"
                    @input="onLiveMoqVolumeInput"
                  />
                  <button type="button" class="watch-live-moq-icon-btn" :aria-label="strings.fullscreen" @click="liveMoqToggleFullscreen">
                    <svg class="w-6 h-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                    </svg>
                  </button>
                </media-control-bar>
              </div>
            </div>
          </div>

          <div class="bg-white dark:bg-gray-900 rounded-lg p-6 border border-gray-200 dark:border-gray-800">
            <h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-2">
              {{ liveTitle }}
            </h1>

            <div class="flex items-center space-x-4 text-sm text-gray-600 dark:text-gray-400 mb-4">
              <span class="inline-flex items-center gap-2 rounded px-2 py-0.5 text-rose-600 dark:text-rose-400 font-semibold">
                <span class="inline-block w-2.5 h-3 rounded-sm bg-rose-500 shrink-0" aria-hidden="true"></span>
                <span class="inline-flex items-center gap-1.5">
                  <span class="inline-block w-2 h-2 rounded-full bg-rose-500 shrink-0" aria-hidden="true"></span>
                  <span>{{ strings.live }}</span>
                </span>
              </span>
            </div>

            <div
              class="text-gray-700 dark:text-gray-300 leading-relaxed prose prose-sm dark:prose-invert max-w-none"
              v-html="liveDescriptionHtml"
            ></div>
          </div>
        </div>

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
                    <div
                      v-if="isLiveRecommendation(rec)"
                      class="absolute bottom-1 right-1 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded inline-flex items-center gap-1"
                    >
                      <span class="inline-block w-1.5 h-2 rounded-sm bg-rose-500 shrink-0" aria-hidden="true"></span>
                      <span class="inline-flex items-center gap-0.5 font-semibold">
                        <span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" aria-hidden="true"></span>
                        Live
                      </span>
                    </div>
                    <div
                      v-else
                      class="absolute bottom-1 right-1 bg-black bg-opacity-80 text-white text-xs px-1.5 py-0.5 rounded"
                    >
                      {{ rec.full_duration ? formatDuration(rec.full_duration) : '--' }}
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
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRuntimeConfig } from '#app'
import 'media-chrome'
import { isLiveRecommendation, useMoqLivePlayerControls } from '~/composables/useMoqLivePlayerControls'
import { sizeUrl } from '~/composables/useThumbnail'
import { renderMarkdownToHtml } from '~/utils/markdown'
import strings from '~/utils/strings'

const config = useRuntimeConfig()
const canvas = ref<HTMLCanvasElement | null>(null)

const {
  shellRef: liveMoqShellRef,
  attach: attachLiveMoqControls,
  detach: detachLiveMoqControls,
  isPaused: liveMoqIsPaused,
  volume01: liveMoqVolume,
  isMuted: liveMoqIsMuted,
  togglePause: liveMoqTogglePause,
  goLive: liveMoqGoLive,
  toggleMute: liveMoqToggleMute,
  setVolume: liveMoqSetVolume,
  toggleFullscreen: liveMoqToggleFullscreen
} = useMoqLivePlayerControls()

const userInitiatedPaused = ref(false)
const uiToggleInFlight = ref(false)
const handleLiveMoqPlayPause = () => {
  uiToggleInFlight.value = true
  if (liveMoqIsPaused.value) {
    userInitiatedPaused.value = false
    liveMoqGoLive()
  } else {
    userInitiatedPaused.value = true
    liveMoqTogglePause()
  }
  queueMicrotask(() => { uiToggleInFlight.value = false })
}

watch(liveMoqIsPaused, (isPaused, wasPaused) => {
  if (isPaused === wasPaused) return
  if (!uiToggleInFlight.value) {
    userInitiatedPaused.value = isPaused
  }
})

const onLiveMoqVolumeInput = (e: Event) => {
  const input = e.target as HTMLInputElement
  const v = Number.parseFloat(input.value)
  if (Number.isFinite(v)) liveMoqSetVolume(v)
}
const loading = ref(true)
const error = ref<string | null>(null)
const recommendations = ref<any[]>([])

const liveVideo = ref<{ id: string; title: string; description: string } | null>(null)
const liveTitle = computed(() => liveVideo.value?.title?.trim() || 'Live Stream')
const liveDescription = computed(() => liveVideo.value?.description?.trim() || strings.noDescription)
const liveDescriptionHtml = computed(() => renderMarkdownToHtml(liveDescription.value))

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

let runtime: {
  connection: { close?: () => void }
  broadcast: { close?: () => void; reload?: { set?: (value: boolean) => void } }
  moqBackend: { close?: () => void; paused?: { set?: (value: boolean) => void } }
} | null = null
let reconnectInFlight = false
let reconnectCooldownUntil = 0

const formatDuration = (seconds: number) => {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

const closeRuntimePart = (resource: unknown) => {
  const closable = resource as { close?: () => void; destroy?: () => void; stop?: () => void } | null
  closable?.stop?.()
  closable?.destroy?.()
  closable?.close?.()
}

const disposeLiveRuntime = (runtimeToDispose?: {
  connection?: unknown
  broadcast?: unknown
  moqBackend?: unknown
} | null, shouldDetach = false) => {
  if (shouldDetach) detachLiveMoqControls()
  closeRuntimePart(runtimeToDispose?.moqBackend)
  closeRuntimePart(runtimeToDispose?.broadcast)
  closeRuntimePart(runtimeToDispose?.connection)
}

const reconnectToLiveEdge = () => {
  const nowMs = Date.now()
  if (nowMs < reconnectCooldownUntil) return
  const current = runtime
  if (!current || reconnectInFlight) return
  reconnectInFlight = true
  reconnectCooldownUntil = nowMs + 1000
  try {
    // Sleep/wake often leaves the transport stalled; force a catalog refresh.
    if (!userInitiatedPaused.value) {
      current.moqBackend?.paused?.set?.(false)
    }
    current.broadcast?.reload?.set?.(true)
    queueMicrotask(() => {
      current.broadcast?.reload?.set?.(false)
      reconnectInFlight = false
    })
  } catch {
    reconnectInFlight = false
  }
}

const loadRecommendations = async () => {
  try {
    const recsResponse = await fetch(`${config.public.apiUrl}/api/videos`)
    if (!recsResponse.ok) return
    const recommendationsData = await recsResponse.json()
    recommendations.value = (recommendationsData.videos || []).slice(0, 5)
  } catch {
    recommendations.value = []
  }
}

let isMounted = true

onMounted(async () => {
  loading.value = true
  error.value = null
  let partialRuntime: {
    connection?: unknown
    broadcast?: unknown
    moqBackend?: unknown
  } | null = null

  try {
    const accessResponse = await fetch(`${config.public.apiUrl}/api/video-access/live`)
    if (!isMounted) return
    if (!accessResponse.ok) {
      throw new Error('Failed to load livestream access')
    }
    const accessData = await accessResponse.json()
    if (!isMounted) return
    const videoId = typeof accessData?.videoId === 'string' ? accessData.videoId : 'live'
    if (videoId === 'live') {
      throw new Error('Livestream route is not configured. Create a livestream video with slug "live" or use /watch/:videoId.')
    }
    const hasAccess = Boolean(accessData?.hasAccess)
    liveVideo.value = {
      id: videoId,
      title: typeof accessData?.video?.title === 'string' ? accessData.video.title : 'Live Stream',
      description: typeof accessData?.video?.description === 'string' ? accessData.video.description : '',
    }
    const moqEndpoint = typeof accessData?.video?.livestreamMoqEndpoint === 'string'
      ? accessData.video.livestreamMoqEndpoint.trim()
      : ''
    const moqBroadcast = typeof accessData?.video?.livestreamMoqBroadcast === 'string'
      ? accessData.video.livestreamMoqBroadcast.trim()
      : ''
    if (!hasAccess) {
      throw new Error('You do not have access to this livestream.')
    }
    if (!moqEndpoint || !moqBroadcast) {
      throw new Error(strings.livestreamUnavailableDetail)
    }

    const { moq, watch } = await ensureMoqModules()
    if (!isMounted) return
    loading.value = false
    await nextTick()
    if (!isMounted) return
    const canvasEl = canvas.value
    if (!canvasEl) {
      throw new Error('Live player failed to initialize.')
    }

    // A MoQ connection that is automatically re-established on drop.
    const connection = new moq.Connection.Reload({
      url: new URL(moqEndpoint),
      enabled: true
    })
    partialRuntime = { connection }
    if (!isMounted) return

    // The MoQ broadcast being fetched.
    const broadcast = new watch.Broadcast({
      connection: connection.established,
      enabled: true,
      name: moq.Path.from(moqBroadcast)
    })
    partialRuntime.broadcast = broadcast
    if (!isMounted) return

    const moqBackend = new watch.MultiBackend({
      element: canvasEl,
      broadcast,
      latency: 'real-time',
      paused: false
    })
    partialRuntime.moqBackend = moqBackend
    if (!isMounted) return
    attachLiveMoqControls(moqBackend, broadcast)

    runtime = {
      connection,
      broadcast,
      moqBackend
    }
    partialRuntime = null
  } catch (e) {
    if (partialRuntime) disposeLiveRuntime(partialRuntime, false)
    console.error('Failed to initialize live stream player', e)
    const message = e instanceof Error ? e.message : ''
    error.value = message || strings.videoPlaybackError
  } finally {
    if (partialRuntime) {
      disposeLiveRuntime(partialRuntime, false)
      partialRuntime = null
    }
    if (isMounted) {
      await loadRecommendations()
      if (loading.value) loading.value = false
    }
  }
})

const handleVisibilityChange = () => {
  if (document.visibilityState === 'visible') reconnectToLiveEdge()
}
const handleWindowFocus = () => reconnectToLiveEdge()

onMounted(() => {
  if (import.meta.client) {
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleWindowFocus)
    window.addEventListener('pageshow', handleWindowFocus)
  }
})

onUnmounted(() => {
  isMounted = false
  disposeLiveRuntime(runtime, true)
  runtime = null
  if (import.meta.client) {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.removeEventListener('focus', handleWindowFocus)
    window.removeEventListener('pageshow', handleWindowFocus)
  }
})
</script>

<style scoped>
.watch-live-moq-shell {
  --media-control-background: transparent;
  --media-control-color: #ffffff;
}

.watch-live-moq-controls-container {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 20;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.9) 0%, rgba(0, 0, 0, 0.5) 60%, transparent 100%);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}

.watch-live-moq-shell:hover .watch-live-moq-controls-container,
.watch-live-moq-shell:focus-within .watch-live-moq-controls-container {
  opacity: 1;
  pointer-events: auto;
}

.watch-live-moq-control-bar {
  position: relative;
  z-index: 20;
  padding: 2px 8px 8px;
  --media-control-background: transparent;
}

.watch-live-moq-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2.25rem;
  min-height: 2.25rem;
  padding: 0.25rem;
  color: #fff;
  border-radius: 0.25rem;
  transition: background 0.15s ease;
}

.watch-live-moq-icon-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

.watch-live-moq-live-edge-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.5rem;
  margin-left: 0.25rem;
  font-size: 0.8125rem;
  font-weight: 600;
  color: #fecdd3;
  border-radius: 0.25rem;
  transition: background 0.15s ease;
}

.watch-live-moq-live-edge-btn:hover {
  background: rgba(244, 63, 94, 0.25);
}

.watch-live-moq-volume {
  width: 4.5rem;
  max-width: 22vw;
  height: 0.25rem;
  margin: 0 0.25rem;
  cursor: pointer;
  accent-color: #3b82f6;
  vertical-align: middle;
}

@media (min-width: 640px) {
  .watch-live-moq-volume {
    width: 5.5rem;
  }
  .watch-live-moq-control-bar {
    padding: 2px 12px 10px;
  }
}
</style>
