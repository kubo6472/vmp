<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-950">
    <AppHeader />

    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div class="mb-12">
        <h1 class="text-4xl font-bold text-gray-900 dark:text-white mb-4">
          Discover Premium Video Content
        </h1>
        <p class="text-lg text-gray-600 dark:text-gray-400">
          Admin overlay for curating homepage content visually.
        </p>
      </div>

      <div v-if="loading" class="text-center py-20">
        <div class="inline-block w-8 h-8 border-4 border-gray-300 border-t-blue-600 rounded-full animate-spin"></div>
        <p class="mt-4 text-gray-600 dark:text-gray-400">Loading videos...</p>
      </div>

      <div v-else-if="error" class="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg p-6">
        <h3 class="text-lg font-semibold text-red-900 dark:text-red-200 mb-2">Error Loading Videos</h3>
        <p class="text-red-700 dark:text-red-300">{{ error }}</p>
      </div>

      <div v-else class="space-y-12">
        <section>
          <div class="flex items-center justify-between mb-6">
            <h2 class="text-2xl font-bold text-gray-900 dark:text-white">Featured videos</h2>
            <p class="text-sm text-gray-600 dark:text-gray-400">Click any card to replace it</p>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <button
              v-for="(video, slotIndex) in featuredVideos"
              :key="`featured-${slotIndex}-${video?.id ?? 'empty'}`"
              class="text-left group"
              @click="openPicker(slotIndex)"
            >
              <div class="relative aspect-video rounded-lg overflow-hidden bg-gray-200 dark:bg-gray-800 mb-2 ring-2 ring-transparent group-hover:ring-blue-500 transition-all">
                <img
                  v-if="video?.thumbnail_url"
                  :src="video.thumbnail_url"
                  :alt="video.title"
                  class="w-full h-full object-cover transition-transform group-hover:scale-105"
                />
                <div
                  v-else
                  class="w-full h-full flex items-center justify-center text-sm text-gray-500 dark:text-gray-400"
                >
                  Select a featured video
                </div>
                <div class="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors"></div>
                <div class="absolute top-2 right-2 bg-blue-600 text-white text-xs font-semibold px-2 py-1 rounded">
                  Click to switch
                </div>
              </div>
              <h3 class="font-semibold text-gray-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 line-clamp-2 mb-1">
                {{ video?.title || `Featured slot ${slotIndex + 1}` }}
              </h3>
              <p class="text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
                {{ video?.description || 'Use this slot for a high-converting hero/featured placement.' }}
              </p>
            </button>
          </div>
        </section>

        <section class="p-6 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-xl font-bold text-gray-900 dark:text-white">Homepage component editor</h2>
            <button
              class="inline-flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg"
              @click="addBlock('hero')"
            >
              <span class="text-lg leading-none">+</span>
              Add block
            </button>
          </div>

          <p class="text-sm text-gray-600 dark:text-gray-400 mb-5">
            Drag blocks to reorder, switch types from the dropdown, and edit content inline.
          </p>

          <div class="space-y-3">
            <div
              v-for="(block, index) in layoutBlocks"
              :key="block.id"
              class="p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-950"
              draggable="true"
              @dragstart="onDragStart(index)"
              @dragover.prevent
              @drop="onDrop(index)"
            >
              <div class="flex flex-wrap items-center gap-3 mb-3">
                <span class="cursor-move text-gray-500" title="Drag to reorder">↕</span>
                <select
                  v-model="block.type"
                  class="px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm"
                >
                  <option v-for="componentType in componentTypes" :key="componentType" :value="componentType">
                    {{ componentType }}
                  </option>
                </select>
                <button
                  class="ml-auto text-sm text-red-600 dark:text-red-400 hover:underline"
                  @click="removeBlock(block.id)"
                >
                  Remove
                </button>
              </div>

              <div class="grid gap-3">
                <input
                  v-model="block.title"
                  type="text"
                  placeholder="Block title"
                  class="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900"
                />
                <textarea
                  v-model="block.body"
                  rows="3"
                  placeholder="Block copy"
                  class="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900"
                ></textarea>
              </div>
            </div>
          </div>
        </section>

        <section>
          <h2 class="text-2xl font-bold text-gray-900 dark:text-white mb-6">All public uploads (newest first)</h2>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            <VideoCard
              v-for="video in chronologicallySortedUploads"
              :key="video.id"
              :video="video"
              user-id="user_premium"
            />
          </div>
        </section>
      </div>
    </main>

    <div
      v-if="pickerOpen"
      class="fixed inset-0 z-40 bg-black/50 flex items-end sm:items-center justify-center p-4"
      @click.self="closePicker"
    >
      <div class="w-full max-w-3xl max-h-[80vh] overflow-y-auto rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 p-5">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold text-gray-900 dark:text-white">
            Choose replacement for featured slot {{ activeSlotIndex + 1 }}
          </h3>
          <button class="text-sm text-gray-600 dark:text-gray-300 hover:underline" @click="closePicker">Close</button>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <button
            v-for="video in chronologicallySortedUploads"
            :key="`picker-${video.id}`"
            class="text-left p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-blue-500"
            @click="swapFeatured(video)"
          >
            <div class="aspect-video rounded-md overflow-hidden bg-gray-200 dark:bg-gray-800 mb-2">
              <img v-if="video.thumbnail_url" :src="video.thumbnail_url" :alt="video.title" class="w-full h-full object-cover" />
            </div>
            <p class="font-medium text-gray-900 dark:text-white line-clamp-2">{{ video.title }}</p>
            <p class="text-xs text-gray-600 dark:text-gray-400 mt-1">{{ formatDate(video.upload_date) }}</p>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Video {
  id: string
  title: string
  description: string
  thumbnail_url: string
  upload_date: string
  full_duration: number
  preview_duration: number
}

type BlockType = 'hero' | 'featured_row' | 'cta' | 'text_split' | 'video_grid'

interface LayoutBlock {
  id: string
  type: BlockType
  title: string
  body: string
}

const config = useRuntimeConfig()
const loading = ref(true)
const error = ref<string | null>(null)
const uploads = ref<Video[]>([])
const pickerOpen = ref(false)
const activeSlotIndex = ref(0)
const featuredSlots = ref<(Video | null)[]>([])
const draggingIndex = ref<number | null>(null)

const componentTypes: BlockType[] = ['hero', 'featured_row', 'cta', 'text_split', 'video_grid']
const layoutBlocks = ref<LayoutBlock[]>([
  {
    id: crypto.randomUUID(),
    type: 'hero',
    title: 'Hero section',
    body: 'Feature your main value proposition here.'
  },
  {
    id: crypto.randomUUID(),
    type: 'featured_row',
    title: 'Featured videos row',
    body: 'Drag this block to position featured content on the page.'
  }
])

const chronologicallySortedUploads = computed(() => {
  return [...uploads.value].sort((a, b) => {
    return new Date(b.upload_date).getTime() - new Date(a.upload_date).getTime()
  })
})

const featuredVideos = computed(() => {
  if (featuredSlots.value.length === 0) {
    return [...chronologicallySortedUploads.value.slice(0, 4)]
  }
  return featuredSlots.value
})

const openPicker = (slotIndex: number) => {
  activeSlotIndex.value = slotIndex
  pickerOpen.value = true
}

const closePicker = () => {
  pickerOpen.value = false
}

const swapFeatured = (video: Video) => {
  const next = [...featuredVideos.value]
  next[activeSlotIndex.value] = video
  while (next.length < 4) next.push(null)
  featuredSlots.value = next
  closePicker()
}

const formatDate = (rawDate: string) => {
  return new Date(rawDate).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

const addBlock = (type: BlockType) => {
  layoutBlocks.value.push({
    id: crypto.randomUUID(),
    type,
    title: 'New block',
    body: 'Add block content here.'
  })
}

const removeBlock = (id: string) => {
  layoutBlocks.value = layoutBlocks.value.filter((block) => block.id !== id)
}

const onDragStart = (index: number) => {
  draggingIndex.value = index
}

const onDrop = (targetIndex: number) => {
  if (draggingIndex.value === null || draggingIndex.value === targetIndex) return

  const reordered = [...layoutBlocks.value]
  const [movedBlock] = reordered.splice(draggingIndex.value, 1)
  reordered.splice(targetIndex, 0, movedBlock)
  layoutBlocks.value = reordered
  draggingIndex.value = null
}

onMounted(async () => {
  try {
    const response = await fetch(`${config.public.apiUrl}/api/videos`)

    if (!response.ok) {
      throw new Error('Failed to load videos')
    }

    const data = await response.json()
    uploads.value = data.videos || []
    featuredSlots.value = [...chronologicallySortedUploads.value.slice(0, 4)]
  } catch (e: any) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})
</script>
