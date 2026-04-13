<template>
  <div class="min-h-screen overflow-x-hidden bg-gray-50 dark:bg-gray-950">
    <AppHeader />

    <!-- PWA install prompt banner -->
    <Transition
      enter-active-class="transition-all duration-300 ease-out"
      enter-from-class="opacity-0 -translate-y-2"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition-all duration-200 ease-in"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 -translate-y-2"
    >
      <div
        v-if="showPwaBanner"
        class="bg-blue-600 text-white px-4 py-2.5"
      >
        <div class="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <p class="text-sm font-medium">Install the VMP app for quick access to your videos.</p>
          <div class="flex items-center gap-2 shrink-0">
            <button
              class="px-3 py-1 text-xs font-semibold bg-white text-blue-700 rounded-md hover:bg-blue-50 transition-colors"
              @click="installPwa"
            >
              Install
            </button>
            <button
              class="p-1 rounded-md hover:bg-blue-500 transition-colors"
              aria-label="Dismiss"
              @click="dismissPwaBanner"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <!-- Hero Section -->
      <div class="mb-12">
        <h1 class="text-4xl font-bold text-gray-900 dark:text-white mb-4">
          {{ heroBlock?.title || 'Discover Premium Video Content' }}
        </h1>
        <p class="text-lg text-gray-600 dark:text-gray-400">
          {{ heroBlock?.body || 'Watch free previews or unlock full access with a premium subscription' }}
        </p>
        <div v-if="pills.length" class="mt-5 flex flex-wrap gap-2">
          <div
            v-for="pill in pills"
            :key="pill.id"
            class="inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold text-white"
            :style="{ backgroundColor: pill.color || '#2563eb' }"
          >
            <span>{{ pill.label }}</span>
            <span class="rounded-full bg-black/20 px-2 py-0.5">{{ pill.value }}</span>
          </div>
        </div>
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

          <div v-else-if="block.type === 'video_grid'" class="space-y-10">
            <div>
              <h3 class="text-xl font-semibold text-gray-900 dark:text-white mb-3">Recent videos</h3>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <VideoCard
                  v-for="video in recentTwoByTwoVideos"
                  :key="`recent-${video.id}`"
                  :video="video"
                />
              </div>
            </div>

            <div v-for="section in categorySections" :key="section.category.id" class="space-y-3">
              <div class="flex items-center justify-between">
                <h3 class="text-xl font-semibold text-gray-900 dark:text-white">{{ section.category.name }}</h3>
                <NuxtLink :to="`/category/${section.category.slug}`" class="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline">
                  More -&gt;
                </NuxtLink>
              </div>

              <div v-if="section.variant === 'featured_hero'" class="grid gap-4 lg:grid-cols-[2fr_1fr]">
                <VideoCard v-if="section.allVideos[0]" :video="section.allVideos[0]" :key="`featured-${section.category.id}-${section.allVideos[0].id}`" />
                <div class="grid gap-4">
                  <VideoCard
                    v-for="video in section.allVideos.slice(1, 3)"
                    :key="`featured-side-${section.category.id}-${video.id}`"
                    :video="video"
                  />
                </div>
              </div>

              <div v-else-if="section.variant === 'two_by_two'" class="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <VideoCard v-for="video in section.allVideos.slice(0, 4)" :key="`two-by-two-${section.category.id}-${video.id}`" :video="video" />
              </div>

              <div v-else-if="section.variant === 'side_mini'" class="grid gap-4 lg:grid-cols-[2fr_1fr]">
                <VideoCard v-if="section.allVideos[0]" :video="section.allVideos[0]" :key="`side-main-${section.category.id}-${section.allVideos[0].id}`" />
                <div class="space-y-3">
                  <div
                    v-for="video in section.allVideos.slice(1, 4)"
                    :key="`side-mini-${section.category.id}-${video.id}`"
                    class="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3"
                  >
                    <NuxtLink :to="`/watch/${video.slug || video.id}`" class="text-sm font-semibold text-gray-900 dark:text-white hover:text-blue-600">
                      {{ video.title }}
                    </NuxtLink>
                  </div>
                </div>
              </div>

              <div v-else class="grid grid-cols-1 sm:grid-cols-3 gap-6">
                <VideoCard v-for="video in section.allVideos.slice(0, 3)" :key="`three-row-${section.category.id}-${video.id}`" :video="video" />
              </div>
              <p v-if="section.overflowCount > 0" class="text-xs text-gray-500 dark:text-gray-400">
                +{{ section.overflowCount }} more in this category
              </p>
            </div>

            <div>
              <h3 class="text-xl font-semibold text-gray-900 dark:text-white mb-3">All uncategorized videos</h3>
              <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                <VideoCard
                  v-for="video in videos.filter(v => !categoryAssignedIds.has(v.id))"
                  :key="`grid-${video.id}`"
                  :video="video"
                />
              </div>
            </div>
          </div>

          <div v-else-if="block.type === 'hero'" class="hidden"></div>

          <div v-else-if="block.type === 'video_grid_legacy'" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
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
              v-for="video in videos.filter(v => !categoryAssignedIds.has(v.id))"
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
// ── PWA install banner ────────────────────────────────────────────────────────
const { $pwa } = useNuxtApp()
const pwaBannerDismissed = ref(false)
const showPwaBanner = computed(
  () => import.meta.client && !pwaBannerDismissed.value && !!($pwa as any)?.showInstallPrompt,
)
function installPwa() {
  ;($pwa as any)?.install?.()
  pwaBannerDismissed.value = true
}
function dismissPwaBanner() {
  pwaBannerDismissed.value = true
}

interface LayoutBlock {
  id: string
  type: 'hero' | 'featured_row' | 'cta' | 'text_split' | 'video_grid' | 'video_grid_legacy'
  title: string
  body: string
}

interface VideoCategory {
  id: string
  slug: string
  name: string
  direction: 'asc' | 'desc'
}

const config = useRuntimeConfig()
const { authHeader } = useAuth()
const loading = ref(true)
const error   = ref<string | null>(null)
const videos  = ref<any[]>([])
const layoutBlocks       = ref<LayoutBlock[]>([])
const featuredVideoIds   = ref<string[]>([])
const featuredMode = ref<'latest' | 'specific'>('latest')
const featuredVideoId = ref<string | null>(null)
const categories = ref<VideoCategory[]>([])
const pills = ref<Array<{ id: string; label: string; value: number; color: string }>>([])

const blockLabelMap: Record<LayoutBlock['type'], string> = {
  hero:                'Hero',
  featured_row:        'Featured videos',
  cta:                 'Call to action',
  text_split:          'Highlights',
  video_grid:          'Available videos',
  video_grid_legacy:   'Available videos',
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
const videoById = computed(() => new Map(videos.value.map(v => [v.id, v])))

const categoryAssignedIds = computed(() => {
  const assigned = new Set<string>()
  for (const v of videos.value) {
    if (v.category_id) assigned.add(v.id)
  }
  return assigned
})

const sortedByUpload = computed(() =>
  [...videos.value].sort((a, b) => new Date(b.upload_date).getTime() - new Date(a.upload_date).getTime())
)

type PlacementResponse = {
  featured: Array<{ id: string }>
  recentGrid: Array<{ id: string } | null>
  categoryBlocks: Array<{
    category: VideoCategory
    visible: Array<{ id: string }>
    overflow: Array<{ id: string }>
  }>
}

const placement = ref<PlacementResponse | null>(null)

const featuredVideos = computed(() => {
  const ids = placement.value?.featured?.map(v => v.id) ?? []
  return ids.map(id => videoById.value.get(id)).filter(Boolean)
})

const recentTwoByTwoVideos = computed(() => {
  const ids = (placement.value?.recentGrid ?? [])
    .map(v => v?.id ?? null)
    .filter((v): v is string => typeof v === 'string')
  return ids.map(id => videoById.value.get(id)).filter(Boolean)
})

const categorySections = computed(() =>
  (placement.value?.categoryBlocks ?? []).map((block) => {
    const combinedIds = [...block.visible, ...block.overflow].map(v => v.id)
    const allVideos = combinedIds.map(id => videoById.value.get(id)).filter(Boolean)
    const variantPool = ['featured_hero', 'two_by_two', 'side_mini', 'three_by_one'] as const
    const variant = variantPool[Math.abs(block.category.slug.split('').reduce((n, ch) => n + ch.charCodeAt(0), 0)) % variantPool.length]
    const visibleCount = variant === 'two_by_two' || variant === 'side_mini' ? 4 : 3
    return {
      category: block.category,
      allVideos,
      visible: allVideos.slice(0, visibleCount),
      overflowCount: Math.max(0, allVideos.length - visibleCount),
      variant,
    }
  }).filter(section => section.allVideos.length > 0)
)

const loadAdminConfig = async () => {
  const res = await fetch(`${config.public.apiUrl}/api/admin/config`, {
    headers: authHeader(),
  })
  if (!res.ok) return
  const data = await res.json()
  layoutBlocks.value     = Array.isArray(data?.config?.layoutBlocks)    ? data.config.layoutBlocks    : []
  featuredVideoIds.value = Array.isArray(data?.config?.featuredVideoIds) ? data.config.featuredVideoIds : []
  featuredMode.value = data?.config?.featuredMode === 'specific' ? 'specific' : 'latest'
  featuredVideoId.value = typeof data?.config?.featuredVideoId === 'string' ? data.config.featuredVideoId : null
}

const loadCategories = async () => {
  const res = await fetch(`${config.public.apiUrl}/api/admin/categories`, {
    headers: authHeader(),
  })
  if (!res.ok) return
  const data = await res.json()
  categories.value = Array.isArray(data?.categories) ? data.categories : []
}

const loadPlacement = async () => {
  const res = await fetch(`${config.public.apiUrl}/api/homepage/placement`)
  if (!res.ok) return
  placement.value = await res.json()
}

const loadPills = async () => {
  const res = await fetch(`${config.public.apiUrl}/api/pills`)
  if (!res.ok) return
  const data = await res.json()
  pills.value = Array.isArray(data?.pills) ? data.pills : []
}

onMounted(async () => {
  try {
    const [videosRes] = await Promise.all([
      fetch(`${config.public.apiUrl}/api/videos`),
      loadAdminConfig(),
      loadCategories(),
      loadPlacement(),
      loadPills(),
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
