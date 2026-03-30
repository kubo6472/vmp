<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-950">
    <AppHeader />

    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <!-- Hero Section -->
      <div class="mb-12">
        <h1 class="text-4xl font-bold text-gray-900 dark:text-white mb-4">
          {{ heroBlock?.title || 'Discover Premium Video Content' }}
        </h1>
        <p class="text-lg text-gray-600 dark:text-gray-400">
          {{ heroBlock?.body || 'Watch free previews or unlock full access with a premium subscription' }}
        </p>
      </div>

      <!-- Loading State -->
      <div v-if="loading" class="text-center py-20">
        <div class="inline-block w-8 h-8 border-4 border-gray-300 border-t-blue-600 rounded-full animate-spin"></div>
        <p class="mt-4 text-gray-600 dark:text-gray-400">Loading videos...</p>
      </div>

      <!-- Error State -->
      <div v-else-if="error" class="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg p-6">
        <h3 class="text-lg font-semibold text-red-900 dark:text-red-200 mb-2">Error Loading Videos</h3>
        <p class="text-red-700 dark:text-red-300">{{ error }}</p>
      </div>

      <!-- Configured Homepage Layout -->
      <div v-else-if="videos.length > 0" class="space-y-10">
        <section
          v-for="block in renderedBlocks"
          :key="block.id"
          class="space-y-4"
        >
          <div v-if="block.type !== 'hero'">
            <h2 class="text-2xl font-bold text-gray-900 dark:text-white">{{ block.title || blockLabelMap[block.type] }}</h2>
            <p v-if="block.body" class="text-gray-600 dark:text-gray-400 mt-1">{{ block.body }}</p>
          </div>

          <div v-if="block.type === 'featured_row'" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            <VideoCard
              v-for="video in featuredVideos"
              :key="`featured-${video.id}`"
              :video="video"
            />
          </div>

          <div v-else-if="block.type === 'video_grid'" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            <VideoCard
              v-for="video in videos"
              :key="`grid-${video.id}`"
              :video="video"
            />
          </div>

          <div v-else-if="block.type === 'cta'" class="p-6 rounded-xl border border-blue-200 bg-blue-50 dark:bg-blue-950/40 dark:border-blue-800">
            <p class="text-gray-800 dark:text-gray-200">{{ block.body || 'Upgrade to unlock complete videos and premium features.' }}</p>
          </div>

          <div v-else-if="block.type === 'text_split'" class="grid md:grid-cols-2 gap-4">
            <div class="p-4 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800">
              <h3 class="font-semibold text-gray-900 dark:text-white mb-2">{{ block.title || 'Why upgrade?' }}</h3>
              <p class="text-gray-600 dark:text-gray-400">{{ block.body || 'Get full-length videos and uninterrupted viewing.' }}</p>
            </div>
            <div class="p-4 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800">
              <h3 class="font-semibold text-gray-900 dark:text-white mb-2">Free vs Premium</h3>
              <p class="text-gray-600 dark:text-gray-400">Free users can watch previews, premium users get complete access to every upload.</p>
            </div>
          </div>

          <div v-else-if="block.type !== 'hero'" class="p-4 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
            <p class="text-gray-700 dark:text-gray-300">{{ block.body }}</p>
          </div>
        </section>

        <section v-if="!hasVideoGridBlock" class="space-y-4">
          <h2 class="text-2xl font-bold text-gray-900 dark:text-white">Available Videos</h2>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            <VideoCard
              v-for="video in videos"
              :key="video.id"
              :video="video"
            />
          </div>
        </section>
      </div>

      <!-- Empty State -->
      <div v-else class="text-center py-20">
        <div class="w-16 h-16 mx-auto mb-4 bg-gray-200 dark:bg-gray-800 rounded-full flex items-center justify-center">
          <svg class="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </div>
        <h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-2">No Videos Yet</h3>
        <p class="text-gray-600 dark:text-gray-400">Check back soon for new content</p>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
interface LayoutBlock {
  id: string
  type: 'hero' | 'featured_row' | 'cta' | 'text_split' | 'video_grid'
  title: string
  body: string
}

const config = useRuntimeConfig()
const loading = ref(true)
const error   = ref<string | null>(null)
const videos  = ref<any[]>([])
const layoutBlocks       = ref<LayoutBlock[]>([])
const featuredVideoIds   = ref<string[]>([])

const blockLabelMap: Record<LayoutBlock['type'], string> = {
  hero:         'Hero',
  featured_row: 'Featured videos',
  cta:          'Call to action',
  text_split:   'Highlights',
  video_grid:   'Available videos',
}

const renderedBlocks = computed(() =>
  layoutBlocks.value.length
    ? layoutBlocks.value
    : [{ id: 'fallback-grid', type: 'video_grid', title: 'Available Videos', body: '' } as LayoutBlock]
)
const heroBlock = computed(() =>
  renderedBlocks.value.find(b => b.type === 'hero')
)
const hasVideoGridBlock = computed(() =>
  renderedBlocks.value.some(b => b.type === 'video_grid')
)
const featuredVideos = computed(() => {
  if (!featuredVideoIds.value.length) return videos.value.slice(0, 4)
  const byId = new Map(videos.value.map(v => [v.id, v]))
  return featuredVideoIds.value.map(id => byId.get(id)).filter(Boolean)
})

const loadAdminConfig = async () => {
  const res = await fetch(`${config.public.apiUrl}/api/admin/config`)
  if (!res.ok) return
  const data = await res.json()
  layoutBlocks.value     = Array.isArray(data?.config?.layoutBlocks)    ? data.config.layoutBlocks    : []
  featuredVideoIds.value = Array.isArray(data?.config?.featuredVideoIds) ? data.config.featuredVideoIds : []
}

onMounted(async () => {
  try {
    const [videosRes] = await Promise.all([
      fetch(`${config.public.apiUrl}/api/videos`),
      loadAdminConfig(),
    ])
    if (!videosRes.ok) throw new Error('Failed to load videos')
    const data = await videosRes.json()
    videos.value = data.videos || []
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})
</script>
