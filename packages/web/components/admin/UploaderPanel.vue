<template>
  <section class="p-6 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 space-y-5">
    <div>
      <h2 class="text-xl font-bold text-gray-900 dark:text-white">Uploader</h2>
      <p class="text-sm text-gray-600 dark:text-gray-400">Drag/drop videos, upload with tus resumable chunks, then trigger processing.</p>
    </div>

    <div
      class="rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition-colors"
      :class="isDragActive ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30' : 'border-gray-300 dark:border-gray-700'"
      @click="openFilePicker"
      @dragover.prevent="onDragOver"
      @dragleave="onDragLeave"
      @drop.prevent="onDrop"
    >
      <p class="text-sm text-gray-700 dark:text-gray-300">
        {{ selectedFile ? `Selected: ${selectedFile.name} (${Math.round(selectedFile.size / 1024 / 1024)} MB)` : 'Drop video file here or click to choose' }}
      </p>
      <input ref="fileInputRef" type="file" accept="video/*" class="hidden" @change="onFileInputChange" />
    </div>

    <div class="flex flex-wrap items-end gap-3">
      <label class="text-sm text-gray-700 dark:text-gray-300">
        <span class="block mb-1">Visibility</span>
        <select v-model="visibility" class="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 text-gray-900 dark:text-white text-sm">
          <option value="private">private</option>
          <option value="unlisted">unlisted</option>
          <option value="public">public</option>
        </select>
      </label>

      <label class="text-sm text-gray-700 dark:text-gray-300">
        <span class="block mb-1">Processing Mode</span>
        <select v-model="processingMode" class="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 text-gray-900 dark:text-white text-sm">
          <option value="register-existing-cmaf">register-existing-cmaf</option>
          <option value="legacy-process">legacy-process</option>
        </select>
      </label>

      <button
        class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50"
        :disabled="!selectedFile || isUploading"
        @click="uploadSelectedFile"
      >
        {{ isUploading ? 'Uploading...' : 'Upload with tus' }}
      </button>

      <button
        class="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold disabled:opacity-50"
        :disabled="!uploadedVideoId || processing"
        @click="processUploadedVideo"
      >
        {{ processing ? 'Processing...' : 'Process Video' }}
      </button>

      <button
        class="px-4 py-2 rounded-lg bg-white dark:bg-gray-950 border border-gray-300 dark:border-gray-700 text-sm"
        :disabled="loadingVideos"
        @click="loadVideos"
      >
        Refresh list
      </button>
    </div>

    <div class="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-3 text-sm text-gray-700 dark:text-gray-300 whitespace-pre-line min-h-12">
      {{ uploadStatus }}
    </div>

    <div class="overflow-x-auto">
      <table class="min-w-full text-sm">
        <thead>
          <tr class="text-left text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
            <th class="py-2 pr-3">Video ID</th>
            <th class="py-2 pr-3">Status</th>
            <th class="py-2 pr-3">Visibility</th>
            <th class="py-2 pr-3">Updated</th>
            <th class="py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loadingVideos">
            <td colspan="5" class="py-3 text-gray-500 dark:text-gray-400">Loading...</td>
          </tr>
          <tr v-else-if="!videos.length">
            <td colspan="5" class="py-3 text-gray-500 dark:text-gray-400">No videos yet.</td>
          </tr>
          <tr v-for="video in videos" :key="video.videoId" class="border-b border-gray-100 dark:border-gray-800">
            <td class="py-3 pr-3 font-mono text-xs">{{ video.videoId }}</td>
            <td class="py-3 pr-3"><span class="px-2 py-1 rounded-full bg-gray-200 dark:bg-gray-800">{{ video.status }}</span></td>
            <td class="py-3 pr-3">{{ video.visibility }}</td>
            <td class="py-3 pr-3">{{ formatTimestamp(video.updatedAt) }}</td>
            <td class="py-3">
              <button
                v-if="video.needsProcessing"
                class="px-3 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold disabled:opacity-50"
                :disabled="processing"
                @click="processVideo(video.videoId, video.visibility)"
              >
                Process video
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<script setup lang="ts">
type Visibility = 'private' | 'unlisted' | 'public'
type ProcessingMode = 'register-existing-cmaf' | 'legacy-process'

interface VideoListItem {
  videoId: string
  status: 'uploaded' | 'processed'
  needsProcessing?: boolean
  visibility: Visibility
  updatedAt: string
}

const config = useRuntimeConfig()
const { isUploading, uploadFile } = useTusUpload()

const fileInputRef = ref<HTMLInputElement | null>(null)
const isDragActive = ref(false)
const selectedFile = ref<File | null>(null)
const uploadedVideoId = ref<string | null>(null)
const visibility = ref<Visibility>('private')
const processingMode = ref<ProcessingMode>('register-existing-cmaf')
const processing = ref(false)
const uploadStatus = ref('Select a video to upload.')
const videos = ref<VideoListItem[]>([])
const loadingVideos = ref(false)

const uploaderApiBaseUrl = computed(() => {
  const configuredUrl = config.public.videoProcessorApiUrl || config.public.videoProcessorAdminUrl
  return (configuredUrl || '').replace(/\/$/, '')
})

const setStatus = (message: string) => {
  uploadStatus.value = message
}

const setSelectedFile = (file: File | null) => {
  selectedFile.value = file
  uploadedVideoId.value = null
  if (!file) {
    setStatus('Select a video to upload.')
    return
  }

  setStatus(`Ready to upload ${file.name}.`)
}

const openFilePicker = () => {
  fileInputRef.value?.click()
}

const onFileInputChange = (event: Event) => {
  const target = event.target as HTMLInputElement
  setSelectedFile(target.files?.[0] || null)
}

const onDragOver = () => {
  isDragActive.value = true
}

const onDragLeave = () => {
  isDragActive.value = false
}

const onDrop = (event: DragEvent) => {
  isDragActive.value = false
  setSelectedFile(event.dataTransfer?.files?.[0] || null)
}

const uploadSelectedFile = async () => {
  if (!selectedFile.value) return

  try {
    const file = selectedFile.value
    const result = await uploadFile(file, {
      apiBaseUrl: uploaderApiBaseUrl.value,
      visibility: visibility.value,
      onStatus: setStatus,
      onProgress: (uploadedBytes, totalBytes) => {
        const pct = ((uploadedBytes / totalBytes) * 100).toFixed(1)
        setStatus(`Uploading via tus... ${pct}% (${Math.round(uploadedBytes / 1024 / 1024)} / ${Math.round(totalBytes / 1024 / 1024)} MB)`)
      }
    })

    uploadedVideoId.value = result.videoId
    await loadVideos()
  } catch (error: any) {
    setStatus(`Upload failed: ${error?.message || 'Unknown error'}`)
  }
}

const processVideo = async (videoId: string, videoVisibility: Visibility) => {
  processing.value = true
  setStatus(`Processing ${videoId} with mode ${processingMode.value}...`)

  try {
    const response = await fetch(`${uploaderApiBaseUrl.value}/api/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        visibility: videoVisibility,
        processingMode: processingMode.value
      })
    })

    const data = await safeJson(response)
    if (!response.ok) {
      throw new Error(data.error || data.rawText || `Process request failed (${response.status})`)
    }

    setStatus(`Processed ${videoId}. Playlist key: ${data.playlistKey || 'n/a'}`)
    await loadVideos()
  } catch (error: any) {
    setStatus(`Processing failed: ${error?.message || 'Unknown error'}`)
  } finally {
    processing.value = false
  }
}

const processUploadedVideo = async () => {
  if (!uploadedVideoId.value) return
  await processVideo(uploadedVideoId.value, visibility.value)
}

const loadVideos = async () => {
  loadingVideos.value = true

  try {
    const response = await fetch(`${uploaderApiBaseUrl.value}/api/videos`)
    const data = await safeJson(response)

    if (!response.ok) {
      throw new Error(data.error || data.rawText || `Unable to load videos (${response.status})`)
    }

    videos.value = Array.isArray(data.videos) ? data.videos : []
  } catch (error: any) {
    videos.value = []
    setStatus(`Unable to load videos: ${error?.message || 'Unknown error'}`)
  } finally {
    loadingVideos.value = false
  }
}

const formatTimestamp = (timestamp: string) => {
  if (!timestamp) return '—'
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString()
}

const safeJson = async (response: Response) => {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { rawText: text }
  }
}

onMounted(() => {
  loadVideos()
})
</script>
