<!-- 
  packages/web/pages/admin/index.vue
  
  ONE change from the previous version: definePageMeta({ middleware: 'admin' })
  is added at the top of the <script setup> block. Everything else is identical.

  The middleware (packages/web/middleware/admin.ts) handles:
    - Unauthenticated → /login?redirect=/admin
    - Wrong role       → /
  
  So by the time this component mounts, user.value is guaranteed to be an
  editor, admin, or super_admin.
-->
<template>
  <div class="min-h-screen overflow-x-hidden bg-gray-50 dark:bg-gray-950">
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

      <div role="tablist" aria-label="Admin sections" class="flex gap-2 border-b border-gray-200 dark:border-gray-800">
        <button
          v-for="tab in adminTabs"
          :key="tab.id"
          role="tab"
          :aria-selected="activeAdminTab === tab.id"
          :aria-controls="`${tab.id}-panel`"
          :tabindex="activeAdminTab === tab.id ? 0 : -1"
          class="px-4 py-2 text-sm font-medium -mb-px border-b-2"
          :class="activeAdminTab===tab.id ? 'border-blue-600 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-600 dark:text-gray-400'"
          @click="setAdminTab(tab.id)"
        >{{ tab.label }}</button>
      </div>
      <p v-if="activeAdminQuick" class="text-xs text-gray-500 dark:text-gray-400">Quick view: {{ activeAdminQuick }}</p>

      <section class="space-y-8">
        <div v-if="activeAdminTab === 'homepage'" id="homepage-panel" role="tabpanel" class="p-6 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800">
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

        <div v-if="activeAdminTab === 'homepage'" class="p-6 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800">
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

        <!-- Video Management — tabbed panel -->
        <div v-if="activeAdminTab === 'videos'" id="videos-panel" role="tabpanel" class="p-6 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800">
          <h2 class="text-xl font-bold text-gray-900 dark:text-white mb-4">Video management</h2>

          <!-- Tab bar -->
          <div class="flex gap-1 mb-5 border-b border-gray-200 dark:border-gray-700">
            <button
              v-for="tab in videoTabs"
              :key="tab.id"
              class="px-4 py-2 text-sm font-medium -mb-px border-b-2 transition-colors"
              :class="activeVideoTab === tab.id
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'"
              @click="activeVideoTab = tab.id"
            >
              {{ tab.label }}
            </button>
          </div>

          <!-- All videos -->
          <div v-if="activeVideoTab === 'all'">
            <div v-if="videosLoading" class="space-y-3">
              <div v-for="n in 4" :key="n" class="h-14 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
            </div>
            <div v-else-if="!chronologicallySortedUploads.length" class="text-sm text-gray-500 dark:text-gray-400 py-4">
              No videos found. Upload via rclone — they'll appear here as drafts.
            </div>
            <div v-else class="w-full overflow-x-auto">
              <table class="min-w-[920px] w-full text-sm">
                <thead>
                  <tr class="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 pb-2 pr-4 font-medium w-16">Thumb</th>
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 pb-2 pr-4 font-medium">Title</th>
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 pb-2 pr-4 font-medium">Status</th>
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 pb-2 pr-4 font-medium">Duration</th>
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 pb-2 pr-4 font-medium">Uploaded</th>
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 pb-2 pr-4 font-medium">Notifications</th>
                    <th class="sticky top-0 z-10 bg-white dark:bg-gray-900 pb-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
                  <tr v-for="video in chronologicallySortedUploads" :key="video.id">
                    <td class="py-3 pr-4">
                      <div class="w-14 aspect-video rounded overflow-hidden bg-gray-200 dark:bg-gray-800 relative">
                        <img v-if="video.thumbnail_url" :src="video.thumbnail_url" :alt="video.title" class="w-full h-full object-cover" />
                        <span v-if="video.r2_exists === false" class="absolute inset-0 flex items-center justify-center bg-red-900/60 text-white text-xs">⚠</span>
                      </div>
                    </td>
                    <td class="py-3 pr-4 max-w-[12rem]">
                      <div v-if="editingTitle?.id === video.id" class="flex items-center gap-1">
                        <input
                          ref="titleInputEl"
                          v-model="editingTitle.value"
                          type="text"
                          class="flex-1 min-w-0 px-2 py-1 text-sm rounded border border-blue-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-white"
                          @keydown.enter="saveTitleEdit(video)"
                          @keydown.escape="editingTitle = null"
                          @blur="saveTitleEdit(video)"
                        />
                      </div>
                      <div v-else class="group/title flex min-w-0 items-center gap-1">
                        <p class="min-w-0 font-medium text-gray-900 dark:text-white line-clamp-2 break-words">{{ video.title }}</p>
                        <button
                          class="opacity-0 group-hover/title:opacity-100 p-0.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-opacity"
                          title="Rename"
                          @click="startTitleEdit(video)"
                        >
                          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                          </svg>
                        </button>
                      </div>
                      <p class="text-xs text-gray-400 dark:text-gray-500 truncate">{{ video.id }}</p>
                      <div class="mt-1 flex flex-wrap gap-1">
                        <span v-if="video.r2_exists === false" class="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300 px-2 py-0.5 text-[10px] font-semibold">⚠ R2 missing</span>
                        <span v-if="video.publish_status === 'published' && !video.push_notified_at" class="inline-flex items-center gap-1 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 px-2 py-0.5 text-[10px] font-semibold">🔔 Push pending</span>
                        <span v-if="video.publish_status === 'draft'" class="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 px-2 py-0.5 text-[10px] font-semibold">📝 Draft</span>
                      </div>
                    </td>
                    <td class="py-3 pr-4">
                      <span
                        class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold"
                        :class="statusBadgeClass(video.publish_status)"
                      >
                        {{ video.publish_status ?? 'draft' }}
                      </span>
                    </td>
                    <td class="py-3 pr-4 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                      {{ formatSeconds(getActualDuration(video)) }}
                    </td>
                    <td class="py-3 pr-4 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                      {{ formatDate(video.upload_date) }}
                    </td>
                    <td class="py-3 pr-4">
                      <!-- Published + already notified -->
                      <div
                        v-if="video.publish_status === 'published' && video.push_notified_at"
                        class="flex min-w-0 items-center gap-1.5 text-green-600 dark:text-green-400"
                        :title="`Sent ${formatDate(video.push_notified_at)}`"
                      >
                        <svg class="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zm0 16a2 2 0 002-2H8a2 2 0 002 2z" />
                        </svg>
                        <span class="min-w-0 text-xs whitespace-nowrap truncate">{{ formatDate(video.push_notified_at) }}</span>
                      </div>
                      <!-- Published but not yet notified -->
                      <button
                        v-else-if="video.publish_status === 'published' && !video.push_notified_at"
                        class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-blue-600 hover:bg-blue-700 text-white font-medium disabled:opacity-50 whitespace-nowrap"
                        :disabled="notifying[video.id]"
                        :title="notifying[video.id] ? 'Sending…' : 'Send push notification to all subscribers'"
                        @click="sendNotification(video)"
                      >
                        <svg class="w-3 h-3 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zm0 16a2 2 0 002-2H8a2 2 0 002 2z" />
                        </svg>
                        {{ notifying[video.id] ? 'Sending…' : 'Notify' }}
                      </button>
                      <!-- Not published — N/A -->
                      <span v-else class="text-xs text-gray-400 dark:text-gray-600">—</span>
                    </td>
                    <td class="py-3">
                      <div class="flex flex-wrap gap-2">
                        <button
                          v-if="video.publish_status !== 'published'"
                          class="px-2 py-1 text-xs rounded bg-green-600 hover:bg-green-700 text-white font-medium disabled:opacity-50"
                          :disabled="statusUpdating[video.id]"
                          @click="updateVideoStatus(video, 'published')"
                        >Publish</button>
                        <button
                          v-if="video.publish_status !== 'draft'"
                          class="px-2 py-1 text-xs rounded bg-amber-500 hover:bg-amber-600 text-white font-medium disabled:opacity-50"
                          :disabled="statusUpdating[video.id]"
                          @click="updateVideoStatus(video, 'draft')"
                        >Revert to draft</button>
                        <button
                          v-if="video.publish_status !== 'archived'"
                          class="px-2 py-1 text-xs rounded bg-gray-400 hover:bg-gray-500 text-white font-medium disabled:opacity-50"
                          :disabled="statusUpdating[video.id]"
                          @click="openConfirmModal(video, 'archive')"
                        >Archive</button>
                        <button
                          class="px-2 py-1 text-xs rounded bg-red-600 hover:bg-red-700 text-white font-medium disabled:opacity-50"
                          :disabled="trashing[video.id] || statusUpdating[video.id]"
                          :title="`Permanently delete ${video.title} from D1 and R2`"
                          @click="openConfirmModal(video, 'trash')"
                        >{{ trashing[video.id] ? 'Deleting…' : 'Trash' }}</button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- Preview locks -->
          <div v-else-if="activeVideoTab === 'locks'">
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
        </div>


        <div v-if="activeAdminTab === 'notifications'" id="notifications-panel" role="tabpanel" class="p-6 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 space-y-3">
          <h2 class="text-xl font-bold text-gray-900 dark:text-white">Notifications</h2>
          <p class="text-sm text-gray-600 dark:text-gray-400">Published videos without a push are listed below.</p>
          <div v-for="video in chronologicallySortedUploads.filter(v => v.publish_status === 'published' && !v.push_notified_at)" :key="`notify-${video.id}`" class="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
            <p class="text-sm text-gray-800 dark:text-gray-200 truncate pr-4">{{ video.title }}</p>
            <button class="px-2 py-1 text-xs rounded bg-blue-600 hover:bg-blue-700 text-white" :disabled="notifying[video.id]" @click="sendNotification(video)">Notify</button>
          </div>
        </div>

        <div v-if="activeAdminTab === 'system'" id="system-panel" role="tabpanel" class="p-6 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 space-y-4">
          <h2 class="text-xl font-bold text-gray-900 dark:text-white">System</h2>
          <p class="text-sm text-gray-600 dark:text-gray-400">Operational controls and refresh actions.</p>
          <button class="px-4 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 text-sm" @click="reloadAll">Reload data</button>
        </div>
      </section>

    </main>

    <div class="fixed top-20 right-4 z-50 space-y-2">
      <div v-for="toast in toasts" :key="toast.id" role="status" aria-live="polite" aria-atomic="true" class="rounded-lg border px-3 py-2 text-sm shadow" :class="toast.type === 'success' ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200' : 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'">{{ toast.message }}</div>
    </div>

    <div v-if="confirmModal.open" class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" @click.self="confirmModal.open = false">
      <div
        ref="confirmDialogRef"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmModalTitle"
        aria-describedby="confirmModalDesc"
        tabindex="-1"
        class="w-full max-w-lg rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 p-5"
      >
        <h3 id="confirmModalTitle" class="text-lg font-semibold text-gray-900 dark:text-white mb-2">{{ confirmModal.action === 'trash' ? 'Permanently delete video?' : 'Archive video?' }}</h3>
        <p id="confirmModalDesc" class="text-sm text-gray-600 dark:text-gray-400 mb-4">{{ confirmModal.impactText }}</p>
        <div class="flex justify-end gap-2">
          <button type="button" aria-label="Cancel destructive action" class="px-3 py-2 rounded border border-gray-300 dark:border-gray-700 text-sm" @click="confirmModal.open = false">Cancel</button>
          <button type="button" aria-label="Confirm destructive action" class="px-3 py-2 rounded text-sm text-white" :class="confirmModal.action === 'trash' ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-600 hover:bg-amber-700'" @click="runConfirmedAction">Confirm</button>
        </div>
      </div>
    </div>

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
import { resolvePlaylistDuration } from '~/composables/useHlsDuration'

// ── Route guard ───────────────────────────────────────────────────────────────
// This single line is the only meaningful addition to this file.
// The middleware checks auth + role before this component ever mounts.
definePageMeta({ middleware: 'admin' })

// ── Everything below is unchanged from the previous version ──────────────────

interface Video {
  id: string
  title: string
  description: string
  thumbnail_url: string
  upload_date: string
  full_duration: number
  preview_duration: number
  publish_status: 'draft' | 'published' | 'archived' | null
  push_notified_at: string | null
  r2_exists: boolean | null
}

type BlockType = 'hero' | 'featured_row' | 'cta' | 'text_split' | 'video_grid'
interface LayoutBlock {
  id: string
  type: BlockType
  title: string
  body: string
}

const config = useRuntimeConfig()
const { authHeader } = useAuth()
const router = useRouter()
const route = useRoute()
const loading = ref(true)
const videosLoading = ref(false)
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
const statusUpdating = ref<Record<string, boolean>>({})
const notifying = ref<Record<string, boolean>>({})
const trashing = ref<Record<string, boolean>>({})
const activeVideoTab = ref<'all' | 'locks'>('all')
const activeAdminTab = ref<'videos' | 'homepage' | 'notifications' | 'system'>('videos')
const activeAdminQuick = ref<string | null>(null)
const adminTabs = [
  { id: 'videos' as const, label: 'Videos' },
  { id: 'homepage' as const, label: 'Homepage' },
  { id: 'notifications' as const, label: 'Notifications' },
  { id: 'system' as const, label: 'System' },
]
const editingTitle = ref<{ id: string; value: string } | null>(null)
const titleInputEl = ref<HTMLInputElement | null>(null)
const videoTabs = [
  { id: 'all' as const, label: 'All videos' },
  { id: 'locks' as const, label: 'Preview locks' },
]

const componentTypes: BlockType[] = ['hero', 'featured_row', 'cta', 'text_split', 'video_grid']
const layoutBlocks = ref<LayoutBlock[]>([])

const chronologicallySortedUploads = computed(() =>
  [...uploads.value].sort((a, b) => new Date(b.upload_date).getTime() - new Date(a.upload_date).getTime())
)

const featuredVideos = computed(() =>
  featuredSlots.value.length ? featuredSlots.value : [...chronologicallySortedUploads.value.slice(0, 4)]
)

const openPicker  = (slotIndex: number) => { activeSlotIndex.value = slotIndex; pickerOpen.value = true }
const closePicker = () => { pickerOpen.value = false }

const swapFeatured = (video: Video) => {
  const next = [...featuredVideos.value]
  next[activeSlotIndex.value] = video
  while (next.length < 4) next.push(null)
  featuredSlots.value = next
  closePicker()
}

// SQLite CURRENT_TIMESTAMP returns "YYYY-MM-DD HH:MM:SS" which Safari cannot
// parse reliably — normalize to ISO 8601 before constructing the Date.
const formatDate = (raw: string) => {
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z'
  return new Date(normalized).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
const getActualDuration = (video: Video) => actualDurationByVideoId.value[video.id] ?? video.full_duration

const hydrateActualDurations = async () => {
  const durations = await Promise.all(uploads.value.map(async (video) => {
    try {
      const res  = await fetch(
        `${config.public.apiUrl}/api/video-access/${video.id}`,
        { headers: authHeader() }
      )
      if (!res.ok) return [video.id, video.full_duration] as const
      const data = await res.json()
      const resolved = await resolvePlaylistDuration(data?.video?.playlistUrl)
      return [video.id, resolved ?? video.full_duration] as const
    } catch {
      return [video.id, video.full_duration] as const
    }
  }))
  actualDurationByVideoId.value = Object.fromEntries(durations)
}

const addBlock    = (type: BlockType) => { layoutBlocks.value.push({ id: crypto.randomUUID(), type, title: 'New block', body: 'Add block content here.' }) }
const removeBlock = (id: string)      => { layoutBlocks.value = layoutBlocks.value.filter(b => b.id !== id) }

const onDragStart = (index: number) => { draggingIndex.value = index }
const onDrop = (targetIndex: number) => {
  if (draggingIndex.value === null || draggingIndex.value === targetIndex) return
  const reordered = [...layoutBlocks.value]
  const [moved]   = reordered.splice(draggingIndex.value, 1)
  reordered.splice(targetIndex, 0, moved)
  layoutBlocks.value  = reordered
  draggingIndex.value = null
}

const getDefaultBlocks = (): LayoutBlock[] => ([
  { id: crypto.randomUUID(), type: 'hero',         title: 'Hero section',         body: 'Feature your main value proposition here.' },
  { id: crypto.randomUUID(), type: 'featured_row', title: 'Featured videos row',  body: 'Drag this block to position featured content on the page.' },
])

const loadVideos = async () => {
  videosLoading.value = true
  try {
    const res  = await fetch(`${config.public.apiUrl}/api/admin/videos`, { headers: authHeader() })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      throw new Error(err.details || err.error || `HTTP ${res.status}`)
    }
    const data = await res.json()
    uploads.value = data.videos || []
    for (const video of uploads.value) {
      previewLockByVideoId.value[video.id] = video.preview_duration
    }
    await hydrateActualDurations()
  } catch (e: any) {
    saveMessage.value = `Failed to load videos: ${e.message}`
    saveMessageClass.value = 'border-red-300 bg-red-50 text-red-700 dark:bg-red-950 dark:border-red-700 dark:text-red-200'
  } finally {
    videosLoading.value = false
  }
}

const loadConfig = async () => {
  const res = await fetch(`${config.public.apiUrl}/api/admin/config`)
  if (!res.ok) {
    layoutBlocks.value  = getDefaultBlocks()
    featuredSlots.value = [...chronologicallySortedUploads.value.slice(0, 4)]
    return
  }
  const data         = await res.json()
  const featuredIds: string[] = data?.config?.featuredVideoIds || []
  layoutBlocks.value = Array.isArray(data?.config?.layoutBlocks) && data.config.layoutBlocks.length
    ? data.config.layoutBlocks
    : getDefaultBlocks()

  const nextSlots = featuredIds
    .map(id => chronologicallySortedUploads.value.find(v => v.id === id) || null)
    .slice(0, 4)
  while (nextSlots.length < 4) nextSlots.push(chronologicallySortedUploads.value[nextSlots.length] || null)
  featuredSlots.value = nextSlots
}

const saveAll = async () => {
  saving.value      = true
  saveMessage.value = ''
  try {
    const featuredVideoIds = featuredSlots.value.map(v => v?.id).filter(Boolean)
    const [configRes, locksRes] = await Promise.all([
      fetch(`${config.public.apiUrl}/api/admin/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ config: { featuredVideoIds, layoutBlocks: layoutBlocks.value } }),
      }),
      fetch(`${config.public.apiUrl}/api/admin/preview-locks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({
          locks: Object.entries(previewLockByVideoId.value).map(([videoId, previewDuration]) => ({ videoId, previewDuration })),
        }),
      }),
    ])
    if (!configRes.ok || !locksRes.ok) throw new Error('One or more save operations failed')
    saveMessage.value      = 'Changes saved to API database settings and preview lock durations.'
    saveMessageClass.value = 'border-green-300 bg-green-50 text-green-700 dark:bg-green-950 dark:border-green-700 dark:text-green-200'
    await reloadAll()
  } catch (e: any) {
    saveMessage.value      = e.message || 'Failed to save changes'
    saveMessageClass.value = 'border-red-300 bg-red-50 text-red-700 dark:bg-red-950 dark:border-red-700 dark:text-red-200'
  } finally {
    saving.value = false
  }
}

const reloadAll = async () => {
  loading.value = true
  try { await loadVideos(); await loadConfig() }
  finally { loading.value = false }
}

function statusBadgeClass(status: string | null) {
  if (status === 'published') return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
  if (status === 'archived')  return 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
  return 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200' // draft
}

function formatSeconds(total: number): string {
  if (!total || !Number.isFinite(total)) return '--'
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

async function startTitleEdit(video: Video) {
  editingTitle.value = { id: video.id, value: video.title }
  await nextTick()
  titleInputEl.value?.focus()
  titleInputEl.value?.select()
}

async function saveTitleEdit(video: Video) {
  const editing = editingTitle.value
  if (!editing || editing.id !== video.id) return
  const newTitle = editing.value.trim()
  editingTitle.value = null
  if (!newTitle || newTitle === video.title) return
  try {
    const res = await fetch(`${config.public.apiUrl}/api/admin/videos/${video.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ title: newTitle }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    const idx = uploads.value.findIndex(v => v.id === video.id)
    if (idx !== -1) uploads.value[idx] = { ...uploads.value[idx], title: newTitle }
    // Keep the featured grid in sync so header cards show the new title immediately
    featuredSlots.value = featuredSlots.value.map(slot =>
      slot?.id === video.id ? { ...slot, title: newTitle } : slot
    )
  } catch (e: any) {
    saveMessage.value = `Failed to rename: ${e.message}`
    saveMessageClass.value = 'border-red-300 bg-red-50 text-red-700 dark:bg-red-950 dark:border-red-700 dark:text-red-200'
  }
}

async function updateVideoStatus(video: Video, newStatus: 'draft' | 'published' | 'archived') {
  statusUpdating.value[video.id] = true
  try {
    const res = await fetch(`${config.public.apiUrl}/api/admin/videos/${video.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ status: newStatus }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    const { video: updated } = await res.json()
    const idx = uploads.value.findIndex(v => v.id === video.id)
    if (idx !== -1) uploads.value[idx] = { ...uploads.value[idx], ...updated }
    showToast('success', `Status updated: ${video.title} → ${newStatus}.`)
  } catch (e: any) {
    saveMessage.value = `Failed to update "${video.title}": ${e.message}`
    showToast('error', `Failed to update ${video.title}: ${e.message}`)
    saveMessageClass.value = 'border-red-300 bg-red-50 text-red-700 dark:bg-red-950 dark:border-red-700 dark:text-red-200'
  } finally {
    statusUpdating.value[video.id] = false
  }
}

async function sendNotification(video: Video) {
  notifying.value[video.id] = true
  try {
    const res = await fetch(`${config.public.apiUrl}/api/admin/videos/${video.id}/notify`, {
      method: 'POST',
      headers: authHeader(),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    const { push_notified_at } = await res.json()
    const idx = uploads.value.findIndex(v => v.id === video.id)
    if (idx !== -1) uploads.value[idx] = { ...uploads.value[idx], push_notified_at }
    showToast('success', `Notification queued for ${video.title}.`)
  } catch (e: any) {
    saveMessage.value = `Failed to send notification for "${video.title}": ${e.message}`
    showToast('error', `Failed to notify ${video.title}: ${e.message}`)
    saveMessageClass.value = 'border-red-300 bg-red-50 text-red-700 dark:bg-red-950 dark:border-red-700 dark:text-red-200'
  } finally {
    notifying.value[video.id] = false
  }
}

async function trashVideo(video: Video) {
  trashing.value[video.id] = true
  try {
    const res = await fetch(`${config.public.apiUrl}/api/admin/videos/${video.id}`, {
      method: 'DELETE',
      headers: authHeader(),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    uploads.value = uploads.value.filter(v => v.id !== video.id)
    featuredSlots.value = featuredSlots.value.map(slot =>
      slot?.id === video.id ? null : slot
    )
    saveMessage.value = `"${video.title}" has been permanently deleted.`
    showToast('success', `${video.title} deleted.`)
    saveMessageClass.value = 'border-green-300 bg-green-50 text-green-700 dark:bg-green-950 dark:border-green-700 dark:text-green-200'
  } catch (e: any) {
    saveMessage.value = `Failed to delete "${video.title}": ${e.message}`
    saveMessageClass.value = 'border-red-300 bg-red-50 text-red-700 dark:bg-red-950 dark:border-red-700 dark:text-red-200'
  } finally {
    trashing.value[video.id] = false
  }
}



type Toast = { id: number; type: 'success' | 'error'; message: string }
const toasts = ref<Toast[]>([])
let toastId = 0
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>()
function showToast(type: Toast['type'], message: string) {
  const id = ++toastId
  toasts.value.push({ id, type, message })
  const timer = setTimeout(() => {
    toasts.value = toasts.value.filter(t => t.id !== id)
    toastTimers.delete(id)
  }, 3200)
  toastTimers.set(id, timer)
}

const confirmModal = ref<{ open: boolean; action: 'trash' | 'archive' | null; video: Video | null; impactText: string }>({
  open: false,
  action: null,
  video: null,
  impactText: '',
})

function openConfirmModal(video: Video, action: 'trash' | 'archive') {
  confirmModal.value = {
    open: true,
    action,
    video,
    impactText: action === 'trash'
      ? `This permanently removes ${video.title} from the database and deletes all files in R2 (videos/${video.id}/). This cannot be undone.`
      : `This hides ${video.title} from published surfaces. It remains restorable from Drafts.`
  }
}

async function runConfirmedAction() {
  const current = confirmModal.value
  if (!current.video || !current.action) return
  confirmModal.value.open = false
  if (current.action === 'trash') await trashVideo(current.video)
  else await updateVideoStatus(current.video, 'archived')
}

const confirmDialogRef = ref<HTMLElement | null>(null)
const lastFocusedEl = ref<HTMLElement | null>(null)

function setAdminTab(tab: 'videos' | 'homepage' | 'notifications' | 'system') {
  router.replace({ query: { ...route.query, tab } })
}

function onConfirmModalKeydown(e: KeyboardEvent) {
  if (!confirmModal.value.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    confirmModal.value.open = false
    return
  }
  if (e.key !== 'Tab' || !confirmDialogRef.value) return
  const focusable = confirmDialogRef.value.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement as HTMLElement | null
  if (e.shiftKey && active === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

watch(() => route.query, (query) => {
  const tab = query.tab
  if (tab && ['videos', 'homepage', 'notifications', 'system'].includes(String(tab))) {
    activeAdminTab.value = tab as any
  }
  const quick = query.quick
  activeAdminQuick.value = quick ? String(quick) : null
}, { immediate: true })

watch(() => confirmModal.value.open, async (open) => {
  if (open) {
    lastFocusedEl.value = document.activeElement as HTMLElement | null
    await nextTick()
    confirmDialogRef.value?.focus()
    window.addEventListener('keydown', onConfirmModalKeydown)
  } else {
    window.removeEventListener('keydown', onConfirmModalKeydown)
    lastFocusedEl.value?.focus()
  }
})

onMounted(async () => {
  await reloadAll()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onConfirmModalKeydown)
  for (const timer of toastTimers.values()) clearTimeout(timer)
  toastTimers.clear()
})
</script>