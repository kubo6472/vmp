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
      
      <div v-if="selectedUser" class="bg-white rounded-lg shadow p-6">
        <p class="mb-4">Selected user: <strong>{{ selectedUser }}</strong></p>
        <NuxtLink 
          :to="`/watch/demo_video?userId=${selectedUser}`"
          class="inline-block bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700"
        >
          Watch Demo Video
        </NuxtLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const selectedUser = ref<string | null>(null)

const testUsers = [
  { id: 'user_free', name: 'Free User', type: 'Preview access only' },
  { id: 'user_premium', name: 'Premium User', type: 'Full access' },
  { id: 'user_expired', name: 'Expired User', type: 'Expired premium' }
]

const selectUser = (userId: string) => {
  selectedUser.value = userId
}
</script>