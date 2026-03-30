<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-950">
    <AppHeader />

    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <header class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 class="text-3xl font-bold text-gray-900 dark:text-white">Admin Console</h1>
          <p class="text-gray-600 dark:text-gray-400">Homepage curation + uploader controls in one place.</p>
        </div>
        <div class="flex items-center gap-2">
          <button
            class="px-4 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 text-sm"
            @click="reloadAll"
          >
            Reload
          </button>
          <button
            class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50"
            :disabled="saving"
            @click="saveAll"
          >
            {{ saving ? 'Saving...' : 'Save changes' }}
          </button>
        </div>
      </header>

      <div v-if="saveMessage" class="rounded-lg border px-4 py-3 text-sm" :class="saveMessageClass">
        {{ saveMessage }}
      </div>

      <section class="space-y-8">
        <div class="p-6 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-xl font-bold text-gray-900 dark:text-white">Featured videos</h2>
            <p class="text-sm text-gray-600 dark:text-gray-400">Click a slot to replace</p>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <button
              v-for="(video, slotIndex) in featuredVideos"
              :key="`featured-${slotIndex}-${video?.id ?? 'empty'}`"
              class="text-left group"
              @click="openPicker(slotIndex)"
            >
              <div class="relative aspect-video rounded-lg overflow-hidden bg-gray-200 dark:bg-gray-800 mb-2 ring-2 ring-transparent group-hover:ring-blue-500 transition-all">
                <img v-if="video?.thumbnail_url" :src="video.thumbnail_url" :alt="video.title" class="w-full h-full object-cover" />
                <div v-else class="w-full h-full flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">Select featured video</div>
              </div>
              <h3 class="font-semibold text-gray-900 dark:text-white line-clamp-2 mb-1">{{ video?.title || `Slot ${slotIndex + 1}` }}</h3>
              <p class="text-xs text-gray-600 dark:text-gray-400">{{ video?.id || 'No video selected' }}</p>
            </button>
          </div>
        </div>

        <div class="p-6 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-xl font-bold text-gray-900 dark:text-white">Homepage blocks</h2>
            <button class="inline-flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg" @click="addBlock('hero')">
              <span class="text-lg leading-none">+</span>
              Add block
            </button>
          </div>

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
              <div class="flex items-center gap-3 mb-3">
                <span class="cursor-move text-gray-500">↕</span>
                <select v-model="block.type" class="px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-white">
                  <option v-for="componentType in componentTypes" :key="componentType" :value="componentType">{{ componentType }}</option>
                </select>
                <button class="ml-auto text-sm text-red-600 hover:underline" @click="removeBlock(block.id)">Remove</button>
              </div>

              <div class="grid gap-3">
                <input v-model="block.title" type="text" placeholder="Block title" class="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder:text-gray-500 dark:placeholder:text-gray-400" />
                <textarea v-model="block.body" rows="3" placeholder="Block copy" class="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder:text-gray-500 dark:placeholder:text-gray-400"></textarea>
              </div>
            </div>
          </div>
        </div>

        <div class="p-6 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800">
          <h2 class="text-xl font-bold text-gray-900 dark:text-white mb-4">Preview lock timestamps</h2>
          <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">Set where free previews lock for each video (seconds).</p>
          <div class="space-y-3 max-h-[32rem] overflow-auto pr-1">
            <div v-for="video in chronologicallySortedUploads" :key="video.id" class="grid grid-cols-[1fr_auto_auto] gap-3 items-center p-3 rounded-lg border border-gray-200 dark:border-gray-700">
              <div>
                <p class="font-medium text-gray-900 dark:text-white">{{ video.title }}</p>
                <p class="text-xs text-gray-600 dark:text-gray-400">{{ video.id }} · full {{ getActualDuration(video) }}s</p>
              </div>
              <input v-model.number="previewLockByVideoId[video.id]" type="number" min="0" :max="getActualDuration(video)" class="w-24 px-2 py-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900" />
              <button class="text-xs text-gray-600 dark:text-gray-400 hover:underline" @click="previewLockByVideoId[video.id] = getActualDuration(video)">Unlock full</button>
            </div>
          </div>
        </div>
      </section>

      <AdminUploaderPanel />
    </main>

    <div v-if="pickerOpen" class="fixed inset-0 z-40 bg-black/50 flex items-end sm:items-center justify-center p-4" @click.self="closePicker">
      <div class="w-full max-w-3xl max-h-[80vh] overflow-y-auto rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 p-5">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold text-gray-900 dark:text-white">Choose replacement for featured slot {{ activeSlotIndex + 1 }}</h3>
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

type BlockType = 'hero' | 'featured' | 'featured_row' | 'cta' | 'text_split' | 'video_grid'
interface LayoutBlock {
  id: string
  type: BlockType
  title: string
  body: string
}

const config = useRuntimeConfig()

const { isLoggedIn, canEditContent, authHeader, initialise } = useAuth()
const route = useRoute()
const loading = ref(true)
const uploads = ref<Video[]>([])
const pickerOpen = ref(false)
const activeSlotIndex = ref(0)
const featuredSlots = ref<(Video | null)[]>([])
const draggingIndex = ref<number | null>(null)
const saving = ref(false)
const saveMessage = ref('')
const saveMessageClass = ref('')
const previewLockByVideoId = ref<Record<string, number>>({})
const actualDurationByVideoId = ref<Record<string, number>>({})

const componentTypes: BlockType[] = ['hero', 'featured', 'featured_row', 'cta', 'text_split', 'video_grid']
const layoutBlocks = ref<LayoutBlock[]>([])

const chronologicallySortedUploads = computed(() => {
  return [...uploads.value].sort((a, b) => new Date(b.upload_date).getTime() - new Date(a.upload_date).getTime())
})

const featuredVideos = computed(() => {
  if (!featuredSlots.value.length) return [...chronologicallySortedUploads.value.slice(0, 4)]
  return featuredSlots.value
})

const openPicker = (slotIndex: number) => {
  activeSlotIndex.value = slotIndex
  pickerOpen.value = true
}
const closePicker = () => { pickerOpen.value = false }

const swapFeatured = (video: Video) => {
  const next = [...featuredVideos.value]
  next[activeSlotIndex.value] = video
  while (next.length < 4) next.push(null)
  featuredSlots.value = next
  closePicker()
}

const formatDate = (rawDate: string) => new Date(rawDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
const getActualDuration = (video: Video) => actualDurationByVideoId.value[video.id] ?? video.full_duration

const resolvePlaylistDuration = async (playlistUrl: string, depth = 0): Promise<number | null> => {
  if (!playlistUrl || depth > 2) return null

  const response = await fetch(playlistUrl)
  if (!response.ok) return null

  const text = await response.text()
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const extInfLines = lines.filter((line) => line.startsWith('#EXTINF:'))

  if (extInfLines.length > 0) {
    const totalSeconds = extInfLines.reduce((sum, line) => {
      const parsed = Number.parseFloat(line.slice('#EXTINF:'.length))
      return Number.isFinite(parsed) ? sum + parsed : sum
    }, 0)
    return Number.isFinite(totalSeconds) ? Math.round(totalSeconds) : null
  }

  const firstVariantIndex = lines.findIndex((line) => line.startsWith('#EXT-X-STREAM-INF'))
  if (firstVariantIndex >= 0 && lines[firstVariantIndex + 1]) {
    const variantUri = lines[firstVariantIndex + 1]
    const nestedUrl = new URL(variantUri, playlistUrl).toString()
    return resolvePlaylistDuration(nestedUrl, depth + 1)
  }

  return null
}

const hydrateActualDurations = async () => {
  const durations = await Promise.all(uploads.value.map(async (video) => {
    try {
      const accessResponse = await fetch(`${config.public.apiUrl}/api/video-access/${video.id}`, { headers: authHeader() })
      if (!accessResponse.ok) return [video.id, video.full_duration] as const
      const accessData = await accessResponse.json()
      const playlistUrl = accessData?.video?.playlistUrl
      const resolvedDuration = await resolvePlaylistDuration(playlistUrl)
      return [video.id, resolvedDuration ?? video.full_duration] as const
    } catch (_) {
      return [video.id, video.full_duration] as const
    }
  }))

  actualDurationByVideoId.value = Object.fromEntries(durations)
}

const addBlock = (type: BlockType) => {
  layoutBlocks.value.push({ id: crypto.randomUUID(), type, title: 'New block', body: 'Add block content here.' })
}

const removeBlock = (id: string) => {
  layoutBlocks.value = layoutBlocks.value.filter((block) => block.id !== id)
}

const onDragStart = (index: number) => { draggingIndex.value = index }
const onDrop = (targetIndex: number) => {
  if (draggingIndex.value === null || draggingIndex.value === targetIndex) return
  const reordered = [...layoutBlocks.value]
  const [movedBlock] = reordered.splice(draggingIndex.value, 1)
  reordered.splice(targetIndex, 0, movedBlock)
  layoutBlocks.value = reordered
  draggingIndex.value = null
}

const getDefaultBlocks = (): LayoutBlock[] => ([
  { id: crypto.randomUUID(), type: 'hero', title: 'Hero section', body: 'Feature your main value proposition here.' },
  { id: crypto.randomUUID(), type: 'featured_row', title: 'Featured videos row', body: 'Drag this block to position featured content on the page.' }
])

const loadVideos = async () => {
  const response = await fetch(`${config.public.apiUrl}/api/videos`, { headers: authHeader() })
  const data = await response.json()
  uploads.value = data.videos || []
  for (const video of uploads.value) {
    previewLockByVideoId.value[video.id] = video.preview_duration
  }
  await hydrateActualDurations()
}

const loadConfig = async () => {
  const response = await fetch(`${config.public.apiUrl}/api/admin/config`, { headers: authHeader() })
  if (!response.ok) {
    layoutBlocks.value = getDefaultBlocks()
    featuredSlots.value = [...chronologicallySortedUploads.value.slice(0, 4)]
    return
  }

  const data = await response.json()
  const featuredIds: string[] = data?.config?.featuredVideoIds || []
  layoutBlocks.value = Array.isArray(data?.config?.layoutBlocks) && data.config.layoutBlocks.length
    ? data.config.layoutBlocks
    : getDefaultBlocks()

  const nextSlots = featuredIds
    .map((id) => chronologicallySortedUploads.value.find((video) => video.id === id) || null)
    .slice(0, 4)

  while (nextSlots.length < 4) {
    nextSlots.push(chronologicallySortedUploads.value[nextSlots.length] || null)
  }

  featuredSlots.value = nextSlots
}

const saveAll = async () => {
  saving.value = true
  saveMessage.value = ''

  try {
    const featuredVideoIds = featuredSlots.value.map((video) => video?.id).filter(Boolean)

    const [configResponse, locksResponse] = await Promise.all([
      fetch(`${config.public.apiUrl}/api/admin/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ config: { featuredVideoIds, layoutBlocks: layoutBlocks.value } })
      }),
      fetch(`${config.public.apiUrl}/api/admin/preview-locks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({
          locks: Object.entries(previewLockByVideoId.value).map(([videoId, previewDuration]) => ({ videoId, previewDuration }))
        })
      })
    ])

    if (!configResponse.ok || !locksResponse.ok) {
      throw new Error('One or more save operations failed')
    }

    saveMessage.value = 'Changes saved to API database settings and preview lock durations.'
    saveMessageClass.value = 'border-green-300 bg-green-50 text-green-700 dark:bg-green-950 dark:border-green-700 dark:text-green-200'
    await reloadAll()
  } catch (e: any) {
    saveMessage.value = e.message || 'Failed to save changes'
    saveMessageClass.value = 'border-red-300 bg-red-50 text-red-700 dark:bg-red-950 dark:border-red-700 dark:text-red-200'
  } finally {
    saving.value = false
  }
}

const reloadAll = async () => {
  loading.value = true
  try {
    await loadVideos()
    await loadConfig()
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await initialise()

  if (!isLoggedIn.value) {
    await navigateTo(`/login?redirect=${encodeURIComponent(route.fullPath || '/admin')}`)
    return
  }

  if (!canEditContent.value) {
    await navigateTo('/')
    return
  }

  await reloadAll()
})
</script>
