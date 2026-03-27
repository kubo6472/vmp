<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-950">
    <AppHeader />
    
    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <!-- Hero Section -->
      <div class="mb-12">
        <h1 class="text-4xl font-bold text-gray-900 dark:text-white mb-4">
          Discover Premium Video Content
        </h1>
        <p class="text-lg text-gray-600 dark:text-gray-400">
          Watch free previews or unlock full access with a premium subscription
        </p>
      </div>

      <!-- User Selection (temporary) -->
      <div class="mb-12 p-6 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800">
        <h2 class="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-4">
          Demo Mode - Select User Type
        </h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <button
            v-for="user in testUsers"
            :key="user.id"
            @click="selectedUser = user.id"
            :class="[
              'p-4 rounded-lg border-2 transition-all text-left',
              selectedUser === user.id
                ? 'border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-blue-950'
                : 'border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700'
            ]"
          >
            <div class="font-semibold text-gray-900 dark:text-white mb-1">{{ user.name }}</div>
            <div class="text-sm text-gray-600 dark:text-gray-400">{{ user.type }}</div>
          </button>
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

      <!-- Video Grid -->
      <div v-else-if="videos.length > 0">
        <h2 class="text-2xl font-bold text-gray-900 dark:text-white mb-6">Available Videos</h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          <VideoCard 
            v-for="video in videos" 
            :key="video.id"
            :video="video"
            :userId="selectedUser"
          />
        </div>
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
const config = useRuntimeConfig()
const selectedUser = ref('user_free')
const loading = ref(true)
const error = ref<string | null>(null)
const videos = ref<any[]>([])

const testUsers = [
  { id: 'user_free', name: 'Free User', type: 'Preview access only' },
  { id: 'user_premium', name: 'Premium User', type: 'Full access' },
  { id: 'user_expired', name: 'Expired User', type: 'Expired premium' }
]

onMounted(async () => {
  try {
    const response = await fetch(`${config.public.apiUrl}/api/videos`)
    
    if (!response.ok) {
      throw new Error('Failed to load videos')
    }
    
    const data = await response.json()
    videos.value = data.videos || []
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})
</script>