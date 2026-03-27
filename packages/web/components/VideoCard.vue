<template>
  <NuxtLink 
    :to="`/watch/${video.id}?userId=${userId}`"
    class="group block"
  >
    <div class="relative aspect-video rounded-lg overflow-hidden bg-gray-200 dark:bg-gray-800 mb-2">
      <img 
        v-if="video.thumbnail_url"
        :src="video.thumbnail_url" 
        :alt="video.title"
        class="w-full h-full object-cover transition-transform group-hover:scale-105"
      />
      <div class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-10 transition-all"></div>
      
      <!-- Duration Badge -->
      <div class="absolute bottom-2 right-2 bg-black bg-opacity-80 text-white text-xs px-2 py-1 rounded">
        {{ formatDuration(video.full_duration) }}
      </div>
      
      <!-- Premium Badge (if preview only) -->
      <div 
        v-if="video.preview_duration < video.full_duration"
        class="absolute top-2 left-2 bg-yellow-500 text-black text-xs font-semibold px-2 py-1 rounded"
      >
        PREMIUM
      </div>
    </div>
    
    <h3 class="font-semibold text-gray-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 line-clamp-2 mb-1">
      {{ video.title }}
    </h3>
    
    <p class="text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
      {{ video.description }}
    </p>
  </NuxtLink>
</template>

<script setup lang="ts">
interface Video {
  id: string
  title: string
  description: string
  thumbnail_url: string
  full_duration: number
  preview_duration: number
  upload_date: string
}

defineProps<{
  video: Video
  userId: string
}>()

const formatDuration = (seconds: number) => {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}
</script>