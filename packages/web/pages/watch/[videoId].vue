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
          <video 
            ref="videoElement"
            class="w-full"
            controls
            @timeupdate="handleTimeUpdate"
          ></video>
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
type HlsModule = typeof import('hls.js')
type HlsInstance = InstanceType<HlsModule['default']>

const route = useRoute()
const config = useRuntimeConfig()

const videoElement = ref<HTMLVideoElement | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const videoData = ref<any>(null)
let hls: HlsInstance | null = null
let manifestObjectUrl: string | null = null

const videoId = route.params.videoId as string
const userId = route.query.userId as string || 'user_free'

onMounted(async () => {
  try {
    // Fetch video access data
    const response = await fetch(`${config.public.apiUrl}/api/video-access/${userId}/${videoId}`)
    
    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`Failed to load video data (${response.status}): ${errorBody}`)
    }
    
    videoData.value = await response.json()
    
    // Initialize HLS player
    await nextTick()
    const Hls = (await import('hls.js')).default

    if (videoElement.value && Hls.isSupported()) {
      const playableSource = await normalizePlaylistUrl(videoData.value.video.playlistUrl)

      hls = new Hls()
      hls.loadSource(playableSource)
      hls.attachMedia(videoElement.value)
      
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('HLS manifest loaded')
      })
      
      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error('HLS error:', data)
        if (data.fatal) {
          error.value = 'Video playback error. The current playlist may be invalid.'
        }
      })
    } else if (videoElement.value?.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      videoElement.value.src = videoData.value.video.playlistUrl
    }
    
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

onUnmounted(() => {
  if (hls) {
    hls.destroy()
  }

  if (manifestObjectUrl) {
    URL.revokeObjectURL(manifestObjectUrl)
  }
})

const handleTimeUpdate = (event: Event) => {
  const video = event.target as HTMLVideoElement
  const currentTime = video.currentTime
  
  // Check if user is trying to watch premium content without access
  if (!videoData.value.hasAccess && currentTime > videoData.value.video.previewDuration) {
    video.currentTime = videoData.value.video.previewDuration
    video.pause()
    alert('Please upgrade to Premium to continue watching')
  }
}

const seekToChapter = (startTime: number) => {
  if (videoElement.value) {
    videoElement.value.currentTime = startTime
    videoElement.value.play()
  }
}

const normalizePlaylistUrl = async (playlistUrl: string): Promise<string> => {
  try {
    const response = await fetch(playlistUrl)
    if (!response.ok) {
      return playlistUrl
    }

    const manifest = await response.text()
    const normalized = rewriteManifestSegmentUrls(manifest, playlistUrl)
    if (normalized === manifest) {
      return playlistUrl
    }

    manifestObjectUrl = URL.createObjectURL(
      new Blob([normalized], { type: 'application/vnd.apple.mpegurl' })
    )

    return manifestObjectUrl
  } catch (e) {
    console.warn('Unable to normalize playlist URL, using original playlist', e)
    return playlistUrl
  }
}

const rewriteManifestSegmentUrls = (manifest: string, playlistUrl: string): string => {
  const playlist = new URL(playlistUrl)
  const prefixToTrim = `${playlist.pathname.split('/').slice(1, -1).join('/')}/`
  const lines = manifest.split('\n')

  const rewritten = lines.map((line) => {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith('#') || /^https?:\/\//i.test(trimmed)) {
      return line
    }

    if (!trimmed.startsWith(prefixToTrim)) {
      return line
    }

    return trimmed.slice(prefixToTrim.length)
  })

  return rewritten.join('\n')
}
</script>
