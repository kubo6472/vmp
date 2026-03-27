<template>
  <div 
    v-if="show"
    class="absolute inset-0 z-50 flex items-center justify-center bg-black bg-opacity-75 backdrop-blur-sm"
  >
    <div class="bg-gray-900 rounded-lg p-8 max-w-md text-center">
      <div class="w-16 h-16 mx-auto mb-4 bg-gradient-to-br from-yellow-400 to-yellow-600 rounded-full flex items-center justify-center">
        <svg class="w-8 h-8 text-gray-900" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
        </svg>
      </div>
      
      <h3 class="text-2xl font-bold text-white mb-2">Premium Content</h3>
      <p class="text-gray-300 mb-6">
        Upgrade to Premium to watch the full video and unlock all exclusive content.
      </p>
      
      <button class="w-full bg-gradient-to-r from-blue-500 to-purple-600 text-white font-semibold py-3 px-6 rounded-lg hover:from-blue-600 hover:to-purple-700 transition-all">
        Upgrade to Premium
      </button>
      
      <p class="text-sm text-gray-400 mt-4">
        Payment integration coming soon
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  show: boolean
}>()
</script>