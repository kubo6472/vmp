<template>
  <NuxtLink
    :to="`/watch/${video.slug ?? video.id}`"
    class="group block"
  >
    <div class="relative aspect-video rounded-lg overflow-hidden bg-gray-200 dark:bg-gray-800 mb-2">
      <img
        v-if="video.thumbnail_url"
        :src="sizedUrl('medium')"
        :alt="video.title"
        class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
      />
      <div class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-10 transition-all"></div>

      <!-- Duration Badge -->
      <div class="absolute bottom-2 right-2 bg-black bg-opacity-80 text-white text-xs px-2 py-1 rounded">
        {{ displayDurationSeconds ? formatDuration(displayDurationSeconds) : '--' }}
      </div>

      <!-- Premium Badge — show when preview is explicitly shorter than full, or when
      full duration is unknown (0) but a non-zero preview_duration is set -->
      <div
        v-if="displayDurationSeconds > 0 ? video.preview_duration < displayDurationSeconds : video.preview_duration > 0"
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
import { computed } from 'vue'
import { useThumbnail } from '~/composables/useThumbnail'

interface Video {
  id: string
  title: string
  description: string
  thumbnail_url: string
  /**
   * Legacy snake_case duration from older API responses.
   */
  full_duration?: number
  /**
   * Newer camelCase duration used by video-access and, in some cases, list endpoints.
   */
  fullDuration?: number
  preview_duration: number
  upload_date: string
  slug?: string | null
}

const props = defineProps<{ video: Video }>()

const { sizedUrl } = useThumbnail(computed(() => props.video.thumbnail_url))

// Prefer camelCase `fullDuration` when present, with a fallback to legacy `full_duration`.
const displayDurationSeconds = computed(
  () => props.video.fullDuration ?? props.video.full_duration ?? 0
)

const formatDuration = (seconds: number) => {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}
</script>
