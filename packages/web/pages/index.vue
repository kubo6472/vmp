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
          <p class="text-sm font-medium">{{ strings.pwaInstallPrompt }}</p>
          <div class="flex items-center gap-2 shrink-0">
            <button
              class="px-3 py-1 text-xs font-semibold bg-white text-blue-700 rounded-md hover:bg-blue-50 transition-colors"
              @click="installPwa"
            >
              {{ strings.pwaInstall }}
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
      <div class="mb-8">
        <h1 class="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white mb-3">
          {{ homepageHeroTitle }}
        </h1>
        <p class="text-base sm:text-lg text-gray-600 dark:text-gray-400">
          {{ homepageHeroSubtitle }}
        </p>

        <!-- Pills: redesigned with avatar, name, and value on two lines -->
        <div v-if="pills.length" class="mt-5 flex flex-wrap gap-3 overflow-x-auto pb-1">
          <div
            v-for="pill in pills"
            :key="pill.id"
            class="flex items-center gap-3 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 px-4 py-2.5 shadow-sm min-w-[140px]"
          >
            <div
              v-if="pill.image_url"
              class="w-10 h-10 rounded-full overflow-hidden bg-gray-200 dark:bg-gray-800 flex-shrink-0"
            >
              <img :src="pill.image_url" :alt="pill.label" class="w-full h-full object-cover" />
            </div>
            <div
              v-else
              class="w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center text-white text-sm font-bold"
              :style="{ backgroundColor: pill.color || '#2563eb' }"
            >
              {{ pill.label?.charAt(0)?.toUpperCase() || '?' }}
            </div>
            <div class="min-w-0">
              <p class="text-sm font-medium text-gray-900 dark:text-white truncate leading-tight">{{ pill.label }}</p>
              <p class="text-lg font-bold leading-tight" :style="{ color: pill.color || '#2563eb' }">{{ pill.value }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Loading State -->
      <div v-if="loading" class="text-center py-20">
        <div class="inline-block w-8 h-8 border-4 border-gray-300 border-t-blue-600 rounded-full animate-spin"></div>
        <p class="mt-4 text-gray-600 dark:text-gray-400">{{ strings.loadingVideos }}</p>
      </div>

      <!-- Error State -->
      <div v-else-if="error" class="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg p-6">
        <h3 class="text-lg font-semibold text-red-900 dark:text-red-200 mb-2">{{ strings.errorLoadingVideos }}</h3>
        <p class="text-red-700 dark:text-red-300">{{ error }}</p>
      </div>

      <!-- Redesigned Homepage Layout -->
      <div v-else-if="videos.length > 0" class="space-y-8">

        <!-- Featured Hero Video -->
        <section v-if="heroVideo" class="group">
          <NuxtLink :to="`/watch/${heroVideo.slug || heroVideo.id}`" class="block">
            <div class="relative aspect-[21/9] sm:aspect-[2.4/1] rounded-xl overflow-hidden bg-gray-200 dark:bg-gray-800">
              <img
                v-if="heroVideo.thumbnail_url"
                :src="sizeUrl(heroVideo.thumbnail_url, 'large')"
                :alt="heroVideo.title"
                class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.02]"
              />
              <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent"></div>
              <div class="absolute bottom-0 left-0 right-0 p-4 sm:p-6 lg:p-8">
                <div v-if="isPremiumVideo(heroVideo)" class="inline-flex items-center gap-1 bg-yellow-500 text-black text-xs font-bold px-2 py-0.5 rounded mb-2">
                  {{ strings.premiumBadge }}
                </div>
                <h2 class="text-xl sm:text-2xl lg:text-3xl font-bold text-white mb-1 line-clamp-2">{{ heroVideo.title }}</h2>
                <p v-if="heroVideo.description" class="text-sm text-gray-300 line-clamp-2 max-w-2xl">{{ heroVideo.description }}</p>
              </div>
              <div class="absolute bottom-4 right-4 sm:bottom-6 sm:right-6 bg-black/70 text-white text-xs px-2 py-1 rounded">
                {{ heroVideo.full_duration ? formatDuration(heroVideo.full_duration) : heroVideo.fullDuration ? formatDuration(heroVideo.fullDuration) : '' }}
              </div>
            </div>
          </NuxtLink>
        </section>

        <!-- 2×2 Recent Grid + 2×1 Sidebar -->
        <section v-if="recentGridVideos.length > 0">
          <h2 class="text-xl font-bold text-gray-900 dark:text-white mb-4">{{ strings.recentVideos }}</h2>
          <div class="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-5">
            <!-- Left: 2×2 grid -->
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <VideoCard
                v-for="video in recentGridVideos.slice(0, 4)"
                :key="`recent-${video.id}`"
                :video="video"
              />
            </div>
            <!-- Right: sidebar, two stacked cards -->
            <div v-if="sidebarVideos.length > 0" class="hidden lg:flex flex-col gap-5">
              <VideoCard
                v-for="video in sidebarVideos"
                :key="`sidebar-${video.id}`"
                :video="video"
              />
            </div>
          </div>
        </section>

        <!-- Category sections: rows of 3 or side mini 2x1 -->
        <section v-for="section in categorySections" :key="section.category.id" class="space-y-3">
          <div class="flex items-center justify-between">
            <h2 class="text-xl font-bold text-gray-900 dark:text-white">{{ section.category.name }}</h2>
            <NuxtLink :to="`/category/${section.category.slug}`" class="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline">
              {{ strings.categoryMoreLink }}
            </NuxtLink>
          </div>
          <div
            class="grid grid-cols-1 sm:grid-cols-2 gap-5"
            :class="section.variant === 'side_mini' ? 'lg:grid-cols-2' : 'lg:grid-cols-3'"
          >
            <VideoCard
              v-for="video in section.allVideos.slice(0, section.variant === 'side_mini' ? 2 : 3)"
              :key="`cat-${section.category.id}-${video.id}`"
              :video="video"
            />
          </div>
          <p v-if="section.overflowCount > 0" class="text-xs text-gray-500 dark:text-gray-400">
            {{ strings.moreInCategory(section.overflowCount) }}
          </p>
        </section>

        <!-- Remaining uncategorized videos: rows of 3 -->
        <section v-if="uncategorizedVideos.length > 0">
          <h2 class="text-xl font-bold text-gray-900 dark:text-white mb-4">{{ strings.allUncategorized }}</h2>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            <VideoCard
              v-for="video in uncategorizedVideos"
              :key="`uncat-${video.id}`"
              :video="video"
            />
          </div>
        </section>

        <!-- CTA and text blocks from layout config -->
        <template v-for="block in renderedBlocks" :key="`extra-${block.id}`">
          <section v-if="block.type === 'cta'" class="p-6 rounded-xl border border-blue-200 bg-blue-50 dark:bg-blue-950/40 dark:border-blue-800">
            <h3 v-if="block.title" class="font-semibold text-gray-900 dark:text-white mb-2">{{ block.title }}</h3>
            <p class="text-gray-800 dark:text-gray-200">{{ block.body || 'Upgrade to unlock complete videos and premium features.' }}</p>
          </section>

          <section v-else-if="block.type === 'text_split'" class="grid md:grid-cols-2 gap-4">
            <div class="p-4 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800">
              <h3 class="font-semibold text-gray-900 dark:text-white mb-2">{{ block.title || 'Why upgrade?' }}</h3>
              <p class="text-gray-600 dark:text-gray-400">{{ block.body || 'Get full-length videos and uninterrupted viewing.' }}</p>
            </div>
            <div class="p-4 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800">
              <h3 class="font-semibold text-gray-900 dark:text-white mb-2">Free vs Premium</h3>
              <p class="text-gray-600 dark:text-gray-400">Free users can watch previews, premium users get complete access to every upload.</p>
            </div>
          </section>
        </template>
      </div>

      <!-- Empty State -->
      <div v-else class="text-center py-20">
        <div class="w-16 h-16 mx-auto mb-4 bg-gray-200 dark:bg-gray-800 rounded-full flex items-center justify-center">
          <svg class="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </div>
        <h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-2">{{ strings.noVideosTitle }}</h3>
        <p class="text-gray-600 dark:text-gray-400">{{ strings.noVideosSubtitle }}</p>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import type { HomepageLayoutBlock, HomepagePlacementResponse } from '~/composables/useHomepageLayout'
import { buildHomepageRenderModel } from '~/composables/useHomepageLayout'
import { sizeUrl } from '~/composables/useThumbnail'
import strings from '~/utils/strings'

const { siteSettings, fetchSiteSettings } = useSiteSettings()
await fetchSiteSettings()
useHead({
  title: computed(() => siteSettings.value.siteName),
})

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
const layoutBlocks       = ref<HomepageLayoutBlock[]>([])
const featuredVideoIds   = ref<string[]>([])
const featuredMode = ref<'latest' | 'specific'>('latest')
const featuredVideoId = ref<string | null>(null)
const categories = ref<VideoCategory[]>([])
const pills = ref<Array<{ id: string; label: string; value: number; color: string; image_url?: string }>>([])
const homepageHeroTitle = ref<string>(strings.heroTitleDefault)
const homepageHeroSubtitle = ref<string>(strings.heroSubtitleDefault)

const blockLabelMap: Record<HomepageLayoutBlock['type'], string> = {
  hero:                'Hero',
  featured_row:        'Featured videos',
  cta:                 'Call to action',
  text_split:          'Highlights',
  video_grid:          'Available videos',
  video_grid_legacy:   'Available videos',
}

const homepageRenderModel = computed(() =>
  buildHomepageRenderModel({
    videos: videos.value,
    layoutBlocks: layoutBlocks.value,
    placement: placement.value,
  }),
)
const renderedBlocks = computed(() => homepageRenderModel.value.renderedBlocks)
const heroBlock = computed(() => homepageRenderModel.value.heroBlock)
const hasVideoGridBlock = computed(() => homepageRenderModel.value.hasVideoGridBlock)
const categoryAssignedIds = computed(() => homepageRenderModel.value.categoryAssignedIds)

const sortedByUpload = computed(() =>
  [...videos.value].sort((a, b) => new Date(b.upload_date).getTime() - new Date(a.upload_date).getTime())
)

const placement = ref<HomepagePlacementResponse | null>(null)
const featuredVideos = computed(() => homepageRenderModel.value.featuredVideos)
const recentTwoByTwoVideos = computed(() => homepageRenderModel.value.recentTwoByTwoVideos)
const categorySections = computed(() => homepageRenderModel.value.categorySections)

// Redesigned layout computeds
const heroVideo = computed(() => {
  if (featuredVideos.value.length > 0) return featuredVideos.value[0]
  return sortedByUpload.value[0] ?? null
})

const heroVideoId = computed(() => heroVideo.value?.id)

const recentGridVideos = computed(() => {
  const sorted = sortedByUpload.value.filter((v: any) => v.id !== heroVideoId.value)
  if (recentTwoByTwoVideos.value.length > 0) {
    const ids = new Set(recentTwoByTwoVideos.value.map((v: any) => v.id))
    const fromPlacement = recentTwoByTwoVideos.value.filter((v: any) => v.id !== heroVideoId.value)
    if (fromPlacement.length >= 4) return fromPlacement.slice(0, 4)
    const extra = sorted.filter((v: any) => !ids.has(v.id))
    return [...fromPlacement, ...extra].slice(0, 4)
  }
  return sorted.slice(0, 4)
})

const sidebarVideos = computed(() => {
  const usedIds = new Set([heroVideoId.value, ...recentGridVideos.value.map((v: any) => v.id)])
  return sortedByUpload.value.filter((v: any) => !usedIds.has(v.id)).slice(0, 2)
})

const uncategorizedVideos = computed(() => {
  const usedIds = new Set([
    heroVideoId.value,
    ...recentGridVideos.value.map((v: any) => v.id),
    ...sidebarVideos.value.map((v: any) => v.id),
    ...categorySections.value.flatMap((s: any) => s.allVideos.map((v: any) => v.id)),
  ])
  return videos.value.filter((v: any) => !usedIds.has(v.id))
})

function isPremiumVideo(video: any) {
  const full = video.full_duration ?? video.fullDuration ?? 0
  const preview = video.preview_duration ?? 0
  return full > 0 ? preview < full : preview > 0
}

const formatDuration = (seconds: number) => {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

const loadAdminConfig = async () => {
  const res = await fetch(`${config.public.apiUrl}/api/admin/homepage/content`, {
    headers: authHeader(),
  })
  if (!res.ok) return
  const data = await res.json()
  homepageHeroTitle.value = data.title || strings.heroTitleDefault
  homepageHeroSubtitle.value = data.subtitle || strings.heroSubtitleDefault
  const homepageConfig = data?.homepageConfig ?? {}
  layoutBlocks.value     = Array.isArray(homepageConfig?.layoutBlocks)    ? homepageConfig.layoutBlocks    : []
  featuredVideoIds.value = Array.isArray(homepageConfig?.featuredVideoIds) ? homepageConfig.featuredVideoIds : []
  featuredMode.value = homepageConfig?.featuredMode === 'specific' ? 'specific' : 'latest'
  featuredVideoId.value = typeof homepageConfig?.featuredVideoId === 'string' ? homepageConfig.featuredVideoId : null
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