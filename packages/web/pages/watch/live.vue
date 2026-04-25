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
            <div
              class="absolute top-0 left-0 right-0 z-20 bg-gradient-to-b from-rose-500/90 to-rose-600/90 backdrop-blur-sm text-white px-4 py-2 flex items-center justify-between"
            >
              <div class="flex items-center space-x-2">
                <span class="inline-block w-2 h-2 rounded-full bg-white"></span>
                <span class="font-semibold">Live</span>
              </div>
              <span class="text-sm">Realtime stream</span>
            </div>
            <canvas ref="canvas" class="block w-full aspect-video" />
          </div>

          <div class="bg-white dark:bg-gray-900 rounded-lg p-6 border border-gray-200 dark:border-gray-800">
            <h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-2">
              {{ liveTitle }}
            </h1>

            <div class="flex items-center space-x-4 text-sm text-gray-600 dark:text-gray-400 mb-4">
              <span class="flex items-center space-x-1 text-rose-600 dark:text-rose-400 font-semibold">
                <span class="inline-block w-2 h-2 rounded-full bg-rose-500"></span>
                <span>Livestream · live</span>
              </span>
            </div>

            <div
              class="text-gray-700 dark:text-gray-300 leading-relaxed prose prose-sm dark:prose-invert max-w-none"
              v-html="liveDescriptionHtml"
            ></div>
            <p class="mt-3 text-sm text-gray-500 dark:text-gray-400">
              {{ strings.livestreamRealtimeNote }}
            </p>
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
                    <div class="absolute bottom-1 right-1 bg-black bg-opacity-80 text-white text-xs px-1.5 py-0.5 rounded">
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
import * as Moq from '@moq/lite'
import * as Watch from '@moq/watch'
import { sizeUrl } from '~/composables/useThumbnail'
import { renderMarkdownToHtml } from '~/utils/markdown'
import strings from '~/utils/strings'

const config = useRuntimeConfig()
const canvas = ref<HTMLCanvasElement | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const recommendations = ref<any[]>([])

const liveVideo = ref<{ id: string; title: string; description: string } | null>(null)
const liveTitle = computed(() => liveVideo.value?.title?.trim() || 'Live Stream')
const liveDescription = computed(() => liveVideo.value?.description?.trim() || strings.noDescription)
const liveDescriptionHtml = computed(() => renderMarkdownToHtml(liveDescription.value))

let runtime: {
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

const formatDuration = (seconds: number) => {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
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

onMounted(async () => {
  loading.value = true
  error.value = null

  try {
    const accessResponse = await fetch(`${config.public.apiUrl}/api/video-access/live`)
    if (!accessResponse.ok) {
      throw new Error('Failed to load livestream access')
    }
    const accessData = await accessResponse.json()
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

    loading.value = false
    await nextTick()
    const canvasEl = canvas.value
    if (!canvasEl) {
      throw new Error('Live player failed to initialize.')
    }

    // A MoQ connection that is automatically re-established on drop.
    const connection = new Moq.Connection.Reload({
      url: new URL(moqEndpoint),
      enabled: true
    })

    // The MoQ broadcast being fetched.
    const broadcast = new Watch.Broadcast({
      connection: connection.established,
      enabled: true,
      name: Moq.Path.from(moqBroadcast)
    })

    // Synchronize audio and video playback.
    const sync = new Watch.Sync()

    // Decode and render video into the page canvas.
    const videoSource = new Watch.Video.Source(sync, { broadcast })
    const videoDecoder = new Watch.Video.Decoder(videoSource)
    const videoRenderer = new Watch.Video.Renderer(videoDecoder, { canvas: canvasEl, paused: false })

    // Decode and emit audio through WebAudio.
    const audioSource = new Watch.Audio.Source(sync, { broadcast })
    const audioDecoder = new Watch.Audio.Decoder(audioSource)
    const audioEmitter = new Watch.Audio.Emitter(audioDecoder, { paused: false })

    runtime = {
      connection,
      broadcast,
      sync,
      videoSource,
      videoDecoder,
      videoRenderer,
      audioSource,
      audioDecoder,
      audioEmitter
    }
  } catch (e) {
    console.error('Failed to initialize live stream player', e)
    const message = e instanceof Error ? e.message : ''
    error.value = message || strings.videoPlaybackError
  } finally {
    await loadRecommendations()
    if (loading.value) loading.value = false
  }
})

onUnmounted(() => {
  // Best-effort cleanup across library versions.
  const instances = runtime ? Object.values(runtime) : []
  for (const instance of instances) {
    const resource = instance as { close?: () => void; destroy?: () => void; stop?: () => void } | undefined
    resource?.stop?.()
    resource?.destroy?.()
    resource?.close?.()
  }
  runtime = null
})
</script>
