<template>
  <div class="min-h-screen overflow-x-hidden bg-gray-50 dark:bg-gray-950">
    <AppHeader />
    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <header>
        <NuxtLink to="/" class="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline">← Back to homepage</NuxtLink>
        <h1 class="text-3xl font-bold text-gray-900 dark:text-white mt-2">{{ categoryName }}</h1>
        <p class="text-gray-600 dark:text-gray-400">{{ total }} videos</p>
      </header>

      <div v-if="loading" class="text-center py-16">
        <div class="inline-block w-8 h-8 border-4 border-gray-300 border-t-blue-600 rounded-full animate-spin"></div>
      </div>
      <div v-else-if="error" class="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-900 p-4 text-red-700 dark:text-red-200">
        {{ error }}
      </div>
      <div v-else-if="videos.length === 0" class="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 text-gray-600 dark:text-gray-300">
        No published videos in this category yet.
      </div>
      <div v-else class="space-y-6">
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          <VideoCard v-for="video in videos" :key="video.id" :video="video" />
        </div>
        <div class="flex items-center justify-center gap-3">
          <button
            class="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 disabled:opacity-40"
            :disabled="page <= 1 || loadingMore"
            @click="loadPage(page - 1)"
          >
            Previous
          </button>
          <span class="text-sm text-gray-600 dark:text-gray-400">Page {{ page }}</span>
          <button
            class="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 disabled:opacity-40"
            :disabled="!hasMore || loadingMore"
            @click="loadPage(page + 1)"
          >
            Next
          </button>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
const route = useRoute()
const config = useRuntimeConfig()

const loading = ref(true)
const loadingMore = ref(false)
const error = ref<string | null>(null)
const videos = ref<any[]>([])
const categoryName = ref('Category')
const total = ref(0)
const page = ref(1)
const hasMore = ref(false)

const loadPage = async (nextPage = 1) => {
  if (nextPage === page.value && !loading.value) loadingMore.value = true
  const slug = encodeURIComponent(String(route.params.slug || ''))
  try {
    const res = await fetch(`${config.public.apiUrl}/api/categories/${slug}/videos?page=${nextPage}&pageSize=24`)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    videos.value = Array.isArray(data.videos) ? data.videos : []
    categoryName.value = data?.category?.name || 'Category'
    total.value = Number(data?.pagination?.total || 0)
    hasMore.value = Boolean(data?.pagination?.hasMore)
    page.value = Number(data?.pagination?.page || nextPage)
    error.value = null
  } catch (e: any) {
    error.value = e.message || 'Failed to load category'
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

onMounted(() => {
  loadPage(1)
})
</script>
