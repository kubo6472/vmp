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
        class="px-4 py-2 rounded-lg bg-white dark:bg-gray-950 border border-gray-300 dark:border-gray-700 text-sm disabled:opacity-50"
        :disabled="loadingVideos"
        @click="loadVideos"
      >
        {{ loadingVideos ? 'Syncing…' : 'Refresh list' }}
      </button>
    </div>

    <div class="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-3 text-sm text-gray-700 dark:text-gray-300 whitespace-pre-line min-h-12">
      {{ uploadStatus }}
    </div>

    <div class="overflow-x-auto">
      <table class="min-w-full text-sm">
        <thead>
          <tr class="text-left text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
            <th class="py-2 pr-3">Title / ID</th>
            <th class="py-2 pr-3">Status</th>
            <th class="py-2 pr-3">Visibility</th>
            <th class="py-2 pr-3">Updated</th>
            <th class="py-2 pr-3">Actions</th>
            <th class="py-2">Publish</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loadingVideos">
            <td colspan="6" class="py-3 text-gray-500 dark:text-gray-400">Syncing with R2…</td>
          </tr>
          <tr v-else-if="!videos.length">
            <td colspan="6" class="py-3 text-gray-500 dark:text-gray-400">No videos found.</td>
          </tr>
          <tr v-for="video in videos" :key="video.videoId" class="border-b border-gray-100 dark:border-gray-800">
            <td class="py-3 pr-3">
              <p class="font-medium text-gray-900 dark:text-white truncate max-w-[16rem]">{{ video.title }}</p>
              <p class="font-mono text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ video.videoId }}</p>
            </td>
            <td class="py-3 pr-3">
              <span
                class="px-2 py-1 rounded-full text-xs font-medium"
                :class="video.needsProcessing
                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                  : 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'"
              >{{ video.needsProcessing ? 'needs processing' : 'ready' }}</span>
            </td>
            <td class="py-3 pr-3">
              <span
                class="px-2 py-1 rounded-full text-xs font-medium"
                :class="video.visibility === 'public'
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                  : 'bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300'"
              >{{ video.visibility }}</span>
            </td>
            <td class="py-3 pr-3 text-gray-600 dark:text-gray-400">{{ formatTimestamp(video.updatedAt) }}</td>
            <td class="py-3 pr-3">
              <button
                v-if="video.needsProcessing"
                class="px-3 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold disabled:opacity-50"
                :disabled="processing"
                @click="processVideo(video.videoId, video.visibility)"
              >
                Process
              </button>
            </td>
            <td class="py-3">
              <button
                v-if="video.visibility !== 'public'"
                class="px-3 py-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold disabled:opacity-50"
                :disabled="publishingId === video.videoId"
                @click="setVisibility(video.videoId, 'public')"
              >
                {{ publishingId === video.videoId ? '…' : 'Publish' }}
              </button>
              <button
                v-else
                class="px-3 py-1 rounded-md bg-white dark:bg-gray-950 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-xs font-semibold disabled:opacity-50"
                :disabled="publishingId === video.videoId"
                @click="setVisibility(video.videoId, 'private')"
              >
                {{ publishingId === video.videoId ? '…' : 'Unpublish' }}
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
  title: string
  status: 'uploaded' | 'processed'
  needsProcessing: boolean
  visibility: Visibility
  updatedAt: string | null
  publishedAt: string | null
}

const config = useRuntimeConfig()
const { isUploading, uploadFile } = useTusUpload()
const { authHeader } = useAuth()

const fileInputRef    = ref<HTMLInputElement | null>(null)
const isDragActive    = ref(false)
const selectedFile    = ref<File | null>(null)
const uploadedVideoId = ref<string | null>(null)
const visibility      = ref<Visibility>('private')
const processingMode  = ref<ProcessingMode>('register-existing-cmaf')
const processing      = ref(false)
const uploadStatus    = ref('Select a video to upload.')
const videos          = ref<VideoListItem[]>([])
const loadingVideos   = ref(false)
const publishingId    = ref<string | null>(null)

const processorBaseUrl = computed(() =>
  (config.public.videoProcessorApiUrl || config.public.videoProcessorAdminUrl || '').replace(/\/$/, '')
)

const setStatus = (msg: string) => { uploadStatus.value = msg }

const setSelectedFile = (file: File | null) => {
  selectedFile.value    = file
  uploadedVideoId.value = null
  setStatus(file ? `Ready to upload ${file.name}.` : 'Select a video to upload.')
}

const openFilePicker    = () => { fileInputRef.value?.click() }
const onDragOver        = () => { isDragActive.value = true }
const onDragLeave       = () => { isDragActive.value = false }
const onFileInputChange = (e: Event) => setSelectedFile((e.target as HTMLInputElement).files?.[0] || null)
const onDrop            = (e: DragEvent) => { isDragActive.value = false; setSelectedFile(e.dataTransfer?.files?.[0] || null) }

const uploadSelectedFile = async () => {
  if (!selectedFile.value) return
  try {
    const result = await uploadFile(selectedFile.value, {
      apiBaseUrl:  processorBaseUrl.value,
      visibility:  visibility.value,
      onStatus:    setStatus,
      onProgress:  (done, total) => {
        const pct = ((done / total) * 100).toFixed(1)
        setStatus(`Uploading via tus… ${pct}% (${Math.round(done / 1024 / 1024)} / ${Math.round(total / 1024 / 1024)} MB)`)
      }
    })
    uploadedVideoId.value = result.videoId
    await loadVideos()
  } catch (err: any) {
    setStatus(`Upload failed: ${err?.message || 'Unknown error'}`)
  }
}

const processVideo = async (videoId: string, videoVisibility: Visibility) => {
  processing.value = true
  setStatus(`Processing ${videoId} (${processingMode.value})…`)
  try {
    const res  = await fetch(`${processorBaseUrl.value}/api/process`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ videoId, visibility: videoVisibility, processingMode: processingMode.value })
    })
    const data = await safeJson(res)
    if (!res.ok) throw new Error(data.error || data.rawText || `Process failed (${res.status})`)
    setStatus(`Processed ${videoId}. Playlist key: ${data.playlistKey || 'n/a'}`)
    await loadVideos()
  } catch (err: any) {
    setStatus(`Processing failed: ${err?.message || 'Unknown error'}`)
  } finally {
    processing.value = false
  }
}

const processUploadedVideo = () => {
  if (uploadedVideoId.value) processVideo(uploadedVideoId.value, visibility.value)
}

/**
 * Two-step load:
 *   1. Trigger video-processor's R2 scan → D1 sync (best-effort; errors don't block display)
 *   2. Read the authoritative state from D1 via the main API
 *
 * This ensures:
 *   - New rclone uploads appear in the list immediately on Refresh
 *   - Visibility/publish state shown is always what D1 has (admin-controlled), not R2 metadata
 */
const loadVideos = async () => {
  loadingVideos.value = true
  setStatus('Syncing R2 → D1…')
  try {
    // Step 1: fire R2 scan + D1 sync; swallow errors (processor may be temporarily unavailable)
    await fetch(`${processorBaseUrl.value}/api/videos`).catch(() => {})

    // Step 2: authoritative list from D1
    const res  = await fetch(`${config.public.apiUrl}/api/admin/videos`, { headers: authHeader() })
    const data = await safeJson(res)
    if (!res.ok) throw new Error(data.error || data.rawText || `Unable to load videos (${res.status})`)

    videos.value = (Array.isArray(data.videos) ? data.videos : []).map((v: any) => ({
      videoId:        v.id,
      title:          v.title || v.id,
      status:         v.status as 'uploaded' | 'processed',
      needsProcessing: v.status === 'uploaded',
      visibility:     (v.visibility || 'private') as Visibility,
      updatedAt:      v.updated_at   || null,
      publishedAt:    v.published_at || null,
    }))
    setStatus(`${videos.value.length} video${videos.value.length === 1 ? '' : 's'} loaded.`)
  } catch (err: any) {
    videos.value = []
    setStatus(`Unable to load videos: ${err?.message || 'Unknown error'}`)
  } finally {
    loadingVideos.value = false
  }
}

const setVisibility = async (videoId: string, vis: Visibility) => {
  publishingId.value = videoId
  try {
    const res  = await fetch(`${config.public.apiUrl}/api/admin/videos/${videoId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body:    JSON.stringify({ visibility: vis })
    })
    const data = await safeJson(res)
    if (!res.ok) throw new Error(data.error || `Failed to update visibility (${res.status})`)
    const video = videos.value.find(v => v.videoId === videoId)
    if (video) video.visibility = vis
    setStatus(`${videoId} is now ${vis}.`)
  } catch (err: any) {
    setStatus(`Publish failed: ${err?.message || 'Unknown error'}`)
  } finally {
    publishingId.value = null
  }
}

const formatTimestamp = (ts: string | null) => {
  if (!ts) return '—'
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString()
}

const safeJson = async (res: Response) => {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return { rawText: text } }
}

onMounted(loadVideos)
</script>
