<template>
  <div class="min-h-screen bg-gray-50">
    <div class="max-w-7xl mx-auto px-4 py-12">
      <h1 class="text-4xl font-bold mb-8">VMP Demo</h1>
      
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
        <div 
          v-for="user in testUsers" 
          :key="user.id"
          class="bg-white rounded-lg shadow p-6 cursor-pointer hover:shadow-lg transition"
          @click="selectUser(user.id)"
        >
          <h3 class="text-xl font-semibold mb-2">{{ user.name }}</h3>
          <p class="text-gray-600">{{ user.type }}</p>
        </div>
      </div>
      
      <div v-if="selectedUser" class="bg-white rounded-lg shadow p-6 space-y-4">
        <p class="mb-4">Selected user: <strong>{{ selectedUser }}</strong></p>
        <label class="block">
          <span class="mb-1 block text-sm font-medium text-gray-700">Video ID</span>
          <input
            v-model.trim="videoId"
            type="text"
            placeholder="Enter video ID or playlist path"
            class="w-full max-w-md rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
          />
          <span class="mt-1 block text-xs text-gray-500">
            Example: <code>e1b68f1b-8706-48ef-b7c4-3f6093ae23da</code> or
            <code>videos/&lt;id&gt;/processed/playlist.m3u8</code>
          </span>
        </label>
        <NuxtLink 
          :to="watchLink"
          class="inline-block rounded-lg bg-blue-600 px-6 py-3 text-white hover:bg-blue-700"
        >
          Watch Demo Video
        </NuxtLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const selectedUser = ref<string | null>(null)
const videoId = ref('demo_video')

const testUsers = [
  { id: 'user_free', name: 'Free User', type: 'Preview access only' },
  { id: 'user_premium', name: 'Premium User', type: 'Full access' },
  { id: 'user_expired', name: 'Expired User', type: 'Expired premium' }
]

const selectUser = (userId: string) => {
  selectedUser.value = userId
}

const watchLink = computed(() => {
  if (!selectedUser.value || !videoId.value) {
    return '#'
  }

  return `/watch/${encodeURIComponent(videoId.value)}?userId=${encodeURIComponent(selectedUser.value)}`
})
</script>
