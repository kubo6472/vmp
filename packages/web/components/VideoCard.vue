<template>
  <NuxtLink
    :to="`/watch/${video.slug || video.id}`"
    class="group block"
    :class="linkClass"
  >
    <div class="relative aspect-video rounded-lg overflow-hidden bg-gray-200 dark:bg-gray-800" :class="mediaClass">
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
        {{ premiumLabel }}
      </div>
    </div>
    <div class="min-w-0" :class="contentClass">
      <h3 class="font-semibold text-gray-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 line-clamp-2" :class="titleClass">
        {{ video.title }}
      </h3>
      <p v-if="showDescription" class="text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
        {{ video.description }}
      </p>
    </div>
  </NuxtLink>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useThumbnail } from '~/composables/useThumbnail'
import strings from '~/utils/strings'

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

const props = withDefaults(defineProps<{
  video: Video
  layout?: 'default' | 'horizontal'
  showDescription?: boolean
}>(), {
  layout: 'default',
  showDescription: true,
})

const { sizedUrl } = useThumbnail(computed(() => props.video.thumbnail_url))
const isHorizontal = computed(() => props.layout === 'horizontal')
const showDescription = computed(() => props.showDescription)

const linkClass = computed(() => isHorizontal.value ? 'md:grid md:grid-cols-[58%_42%] md:gap-4 md:items-start md:content-start' : '')
const mediaClass = computed(() => isHorizontal.value ? 'mb-2 md:mb-0' : 'mb-2')
const contentClass = computed(() => isHorizontal.value ? 'space-y-2 self-start' : '')
const titleClass = computed(() => isHorizontal.value ? 'text-xl md:text-3xl leading-tight' : 'mb-1')

// Prefer camelCase `fullDuration` when present, with a fallback to legacy `full_duration`.
const displayDurationSeconds = computed(
  () => props.video.fullDuration ?? props.video.full_duration ?? 0
)

const premiumLabel = strings.premiumBadge

const formatDuration = (seconds: number) => {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}
</script>