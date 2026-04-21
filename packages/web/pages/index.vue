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
      <div class="mb-8">
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

      <div v-else-if="videos.length > 0" class="space-y-8">
        <section
          v-for="block in homepageRenderModel.blockItems"
          :key="`home-block-${block.id}`"
          class="space-y-3"
        >
          <div v-if="block.title || block.body">
            <h2 v-if="block.title" class="text-xl font-bold text-gray-900 dark:text-white">{{ block.title }}</h2>
            <p v-if="block.body" class="text-sm text-gray-600 dark:text-gray-400 mt-1">{{ block.body }}</p>
          </div>

          <div v-if="block.type === 'top_video'" class="space-y-4">
            <VideoCard
              v-for="video in block.videos"
              :key="`top-video-${video.id}`"
              :video="video"
            />
          </div>

          <div v-else-if="block.type === 'featured_row'" class="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <VideoCard
              v-for="video in block.videos"
              :key="`featured-row-${video.id}`"
              :video="video"
            />
          </div>

          <div v-else-if="block.type === 'category'" class="space-y-2">
            <div v-if="block.categorySection" class="flex items-center justify-between">
              <h3 class="text-lg font-semibold text-gray-900 dark:text-white">{{ block.categorySection.category.name }}</h3>
              <NuxtLink :to="`/category/${block.categorySection.category.slug}`" class="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline">
                {{ strings.categoryMoreLink }}
              </NuxtLink>
            </div>
            <div v-if="block.categorySection" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              <VideoCard
                v-for="video in block.categorySection.visible"
                :key="`category-block-${block.id}-${video.id}`"
                :video="video"
              />
            </div>
          </div>

          <div
            v-else-if="block.type === 'split_horizontal' || block.type === 'split_vertical'"
            class="grid gap-4"
            :class="block.type === 'split_horizontal' ? 'md:grid-cols-2' : 'grid-cols-1'"
          >
            <section
              v-for="child in block.children"
              :key="`split-child-${child.id}`"
              class="rounded-lg border border-gray-200 dark:border-gray-800 p-4 space-y-3 bg-white dark:bg-gray-900"
            >
              <div v-if="child.title || child.body">
                <h3 v-if="child.title" class="font-semibold text-gray-900 dark:text-white">{{ child.title }}</h3>
                <p v-if="child.body" class="text-sm text-gray-600 dark:text-gray-400">{{ child.body }}</p>
              </div>
              <div v-if="child.type === 'top_video'" class="space-y-3">
                <VideoCard
                  v-for="video in child.videos"
                  :key="`split-top-${child.id}-${video.id}`"
                  :video="video"
                />
              </div>
              <div v-else-if="child.type === 'featured_row'" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <VideoCard
                  v-for="video in child.videos"
                  :key="`split-featured-${child.id}-${video.id}`"
                  :video="video"
                />
              </div>
              <div v-else-if="child.categorySection" class="space-y-2">
                <div class="flex items-center justify-between">
                  <h4 class="font-semibold text-gray-900 dark:text-white">{{ child.categorySection.category.name }}</h4>
                  <NuxtLink :to="`/category/${child.categorySection.category.slug}`" class="text-sm font-semibold text-blue-600 dark:text-blue-400 hover:underline">
                    {{ strings.categoryMoreLink }}
                  </NuxtLink>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <VideoCard
                    v-for="video in child.categorySection.visible"
                    :key="`split-category-${child.id}-${video.id}`"
                    :video="video"
                  />
                </div>
              </div>
            </section>
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
        <h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-2">{{ strings.noVideosTitle }}</h3>
        <p class="text-gray-600 dark:text-gray-400">{{ strings.noVideosSubtitle }}</p>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import type { HomepagePlacementResponse } from '~/composables/useHomepageLayout'
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
const layoutBlocks = ref<any[]>([])
const categories = ref<VideoCategory[]>([])
const pills = ref<Array<{ id: string; label: string; value: number; color: string; image_url?: string }>>([])

const homepageRenderModel = computed(() =>
  buildHomepageRenderModel({
    videos: videos.value,
    layoutBlocks: layoutBlocks.value,
    placement: placement.value,
  }),
)
const placement = ref<HomepagePlacementResponse | null>(null)

const loadAdminConfig = async () => {
  const res = await fetch(`${config.public.apiUrl}/api/homepage/content`)
  if (!res.ok) return
  const data = await res.json()
  const homepageConfig = data?.homepageConfig ?? {}
  layoutBlocks.value = Array.isArray(homepageConfig?.layoutBlocks) ? homepageConfig.layoutBlocks : []
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