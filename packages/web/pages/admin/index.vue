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
            class="px-4 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 text-sm text-gray-900 dark:text-gray-100"
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

      <div role="tablist" aria-label="Admin sections" class="flex gap-2 border-b border-gray-200 dark:border-gray-800 overflow-x-auto whitespace-nowrap pb-1">
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

        <div v-if="activeAdminTab === 'homepage'" class="p-6 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 space-y-3">
          <h2 class="text-xl font-bold text-gray-900 dark:text-white">Homepage hero copy</h2>
          <input v-model="homepageHeroTitle" type="text" class="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white" />
          <textarea v-model="homepageHeroSubtitle" rows="2" class="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white"></textarea>
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
                      <label
                        :for="`thumb-input-${video.id}`"
                        class="relative block w-14 aspect-video rounded overflow-hidden bg-gray-200 dark:bg-gray-800
                               cursor-pointer ring-2 ring-transparent hover:ring-blue-500 transition-all group"
                        :title="video.thumbnail_url ? 'Replace thumbnail' : 'Upload thumbnail'"
                      >
                        <!-- Existing thumbnail -->
                        <img
                          v-if="video.thumbnail_url"
                          :src="sizeUrl(video.thumbnail_url, 'small')"
                          :alt="video.title"
                          class="w-full h-full object-cover"
                        />
                        <!-- Placeholder with upload icon -->
                        <div
                          v-else
                          class="w-full h-full flex items-center justify-center text-gray-400 group-hover:text-blue-500 transition-colors"
                        >
                          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round"
                              d="M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775
                                 5.25 5.25 0 0 1 10.338-2.32 3.75 3.75 0 0 1 3.571 5.095" />
                          </svg>
                        </div>
                        <!-- Hover replace overlay (only when thumbnail exists) -->
                        <div
                          v-if="video.thumbnail_url"
                          class="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all
                                 flex items-center justify-center opacity-0 group-hover:opacity-100"
                        >
                          <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round"
                              d="M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775
                                 5.25 5.25 0 0 1 10.338-2.32 3.75 3.75 0 0 1 3.571 5.095" />
                          </svg>
                        </div>
                        <!-- Uploading spinner overlay -->
                        <div
                          v-if="uploadingFor === video.id"
                          class="absolute inset-0 bg-black/60 flex items-center justify-center"
                        >
                          <div class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                        </div>
                        <!-- R2 missing warning -->
                        <span v-if="video.r2_exists === false" class="absolute inset-0 flex items-center justify-center bg-red-900/60 text-white text-xs">⚠</span>
                      </label>
                      <input
                        :id="`thumb-input-${video.id}`"
                        type="file"
                        accept="image/jpeg,image/png"
                        class="sr-only"
                        @change="(e) => handleThumbnailSelect(e, video)"
                      />
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
                      <!-- Vanity slug editor -->
                      <div class="mt-0.5 group/slug flex items-center gap-1 min-w-0">
                        <div v-if="editingSlug?.id === video.id" class="flex items-center gap-1 w-full">
                          <input
                            ref="slugInputEl"
                            v-model="editingSlug.value"
                            type="text"
                            placeholder="e.g. my-video"
                            class="w-full px-1 py-0.5 text-xs rounded border border-blue-500 bg-white dark:bg-gray-900 text-gray-900 dark:text-white font-mono"
                            @keydown.enter="saveSlugEdit(video)"
                            @keydown.escape="editingSlug = null"
                            @blur="saveSlugEdit(video)"
                          />
                        </div>
                        <template v-else>
                          <span class="text-xs truncate font-mono" :class="video.slug ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-gray-600'">{{ video.slug || '—' }}</span>
                          <button
                            class="opacity-0 group-hover/slug:opacity-100 p-0.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-opacity flex-shrink-0"
                            title="Edit slug"
                            @click="startSlugEdit(video)"
                          >
                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                            </svg>
                          </button>
                          <a
                            v-if="video.slug"
                            :href="`/watch/${video.slug}`"
                            target="_blank"
                            class="opacity-0 group-hover/slug:opacity-100 p-0.5 text-gray-400 hover:text-blue-500 transition-opacity flex-shrink-0"
                            title="Open watch page"
                          >
                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                            </svg>
                          </a>
                        </template>
                      </div>
                      <div class="mt-1 flex flex-wrap gap-1">
                        <span v-if="video.r2_exists === false" class="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300 px-2 py-0.5 text-[10px] font-semibold">⚠ R2 missing</span>
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
                      <!-- Notify button for published videos -->
                      <button
                        v-if="video.publish_status === 'published'"
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
                          v-if="video.publish_status === 'published'"
                          class="px-2 py-1 text-xs rounded bg-purple-600 hover:bg-purple-700 text-white font-medium"
                          title="Swap this published video with a draft"
                          @click="openSwapModal(video)"
                        >Swap</button>
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
                <input v-model.number="previewLockByVideoId[video.id]" type="number" min="0" :max="getActualDuration(video)" class="w-24 px-2 py-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100" />
                <button class="text-xs text-gray-600 dark:text-gray-300 hover:underline" @click="previewLockByVideoId[video.id] = getActualDuration(video)">Unlock full</button>
              </div>
            </div>
          </div>
        </div>


        <div v-if="activeAdminTab === 'notifications'" id="notifications-panel" role="tabpanel" class="p-6 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 space-y-3">
          <h2 class="text-xl font-bold text-gray-900 dark:text-white">Notifications</h2>
          <p class="text-sm text-gray-600 dark:text-gray-400">Published videos without a push are listed below.</p>
          <div v-for="video in chronologicallySortedUploads.filter(v => v.publish_status === 'published')" :key="`notify-${video.id}`" class="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
            <p class="text-sm text-gray-800 dark:text-gray-200 truncate pr-4">{{ video.title }}</p>
            <button class="px-2 py-1 text-xs rounded bg-blue-600 hover:bg-blue-700 text-white" :disabled="notifying[video.id]" @click="sendNotification(video)">Notify</button>
          </div>
        </div>

        <div v-if="activeAdminTab === 'newsletter'" id="newsletter-panel" role="tabpanel" class="p-6 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 space-y-6">
          <div>
            <h2 class="text-xl font-bold text-gray-900 dark:text-white">Newsletter</h2>
            <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Sync paying subscribers to a Brevo list (via Stripe webhooks) and send campaigns to that list.
            </p>
          </div>

          <div v-if="!isAdmin" class="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
            Only site administrators can configure Brevo and send newsletter campaigns. Editors can use other admin tabs.
          </div>

          <template v-else>
            <div v-if="newsletterMessage" class="rounded-lg border px-4 py-3 text-sm" :class="newsletterMessageClass">{{ newsletterMessage }}</div>

            <div class="grid gap-4 md:grid-cols-2">
              <div class="space-y-2">
                <label class="block text-sm font-medium text-gray-900 dark:text-white" for="brevo-list-id">Brevo subscriber list ID</label>
                <input
                  id="brevo-list-id"
                  v-model="newsletterListId"
                  type="text"
                  inputmode="numeric"
                  autocomplete="off"
                  placeholder="e.g. 12"
                  class="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white"
                />
                <p class="text-xs text-gray-500 dark:text-gray-400">Create a list in Brevo Contacts and paste its numeric ID.</p>
              </div>
              <div class="space-y-2">
                <label class="block text-sm font-medium text-gray-900 dark:text-white" for="brevo-sender-email">Campaign sender email</label>
                <input
                  id="brevo-sender-email"
                  v-model="newsletterSenderEmail"
                  type="email"
                  autocomplete="email"
                  placeholder="verified sender in Brevo"
                  class="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white"
                />
                <label class="block text-sm font-medium text-gray-900 dark:text-white mt-3" for="brevo-sender-name">Sender display name (optional)</label>
                <input
                  id="brevo-sender-name"
                  v-model="newsletterSenderName"
                  type="text"
                  autocomplete="off"
                  placeholder="e.g. Your Channel"
                  class="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white"
                />
              </div>
            </div>

            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50"
                :disabled="newsletterSaving"
                @click="saveNewsletterSettings"
              >
                {{ newsletterSaving ? 'Saving…' : 'Save newsletter settings' }}
              </button>
              <button
                type="button"
                class="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold disabled:opacity-50"
                :disabled="newsletterSyncing"
                @click="syncNewsletterRecipients"
              >
                {{ newsletterSyncing ? 'Syncing…' : 'Sync recipients' }}
              </button>
            </div>

            <div class="border-t border-gray-200 dark:border-gray-700 pt-6 space-y-3">
              <h3 class="text-lg font-semibold text-gray-900 dark:text-white">Compose campaign</h3>
              <div class="space-y-2">
                <label class="block text-sm font-medium text-gray-900 dark:text-white" for="newsletter-template">Template</label>
                <select id="newsletter-template" v-model="newsletterTemplateId" class="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white">
                  <option value="">No template (use manual subject/body)</option>
                  <option v-for="tpl in newsletterTemplates" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</option>
                </select>
                <label class="block text-sm font-medium text-gray-900 dark:text-white" for="newsletter-subject">Subject</label>
                <input
                  id="newsletter-subject"
                  v-model="newsletterSubject"
                  type="text"
                  class="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white"
                  placeholder="Email subject line"
                />
              </div>
              <div class="space-y-2">
                <label class="block text-sm font-medium text-gray-900 dark:text-white" for="newsletter-body">HTML body</label>
                <textarea
                  id="newsletter-body"
                  v-model="newsletterHtml"
                  rows="12"
                  class="w-full px-3 py-2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white font-mono text-sm"
                  placeholder="<p>Hello …</p>"
                />
              </div>
              <div class="grid gap-4 lg:grid-cols-2">
                <div>
                  <p class="text-sm font-medium text-gray-900 dark:text-white mb-2">Preview</p>
                  <iframe
                    v-if="newsletterHtml.trim()"
                    title="Newsletter HTML preview"
                    class="w-full min-h-[12rem] rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950"
                    sandbox=""
                    referrerpolicy="no-referrer"
                    :srcdoc="newsletterPreviewSrcdoc"
                  />
                  <div
                    v-else
                    class="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-950 p-4 min-h-[12rem] flex items-center justify-center text-sm text-gray-400"
                  >
                    Preview appears here.
                  </div>
                </div>
                <div class="flex flex-col justify-end gap-2">
                  <button
                    type="button"
                    class="w-full sm:w-auto px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold disabled:opacity-50"
                    :disabled="newsletterSending"
                    @click="sendNewsletterCampaign"
                  >
                    {{ newsletterSending ? 'Sending…' : 'Send to subscriber list' }}
                  </button>
                  <p class="text-xs text-gray-500 dark:text-gray-400">
                    Creates a campaign in Brevo and sends it immediately to the configured list. Ensure your API key has marketing permissions and credits.
                  </p>
                </div>
              </div>
            </div>

            <div class="border-t border-gray-200 dark:border-gray-700 pt-6">
              <h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-2">Recent campaigns (auto-polled on reload)</h3>
              <div class="space-y-2 max-h-56 overflow-auto">
                <div v-for="campaign in newsletterCampaigns" :key="campaign.id" class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                  <p class="text-sm font-medium text-gray-900 dark:text-white">{{ campaign.subject || campaign.name }}</p>
                  <p class="text-xs text-gray-500 dark:text-gray-400">Status: {{ campaign.status }} · Sent: {{ campaign.sentDate || '—' }}</p>
                </div>
              </div>
            </div>
          </template>
        </div>

        <div v-if="activeAdminTab === 'users'" id="users-panel" role="tabpanel" class="p-6 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 space-y-4">
          <h2 class="text-xl font-bold text-gray-900 dark:text-white">Users and roles</h2>
          <div class="space-y-2">
            <div v-for="u in users" :key="u.id" class="rounded-lg border border-gray-200 dark:border-gray-700 p-3 grid grid-cols-1 md:grid-cols-4 gap-2 items-center">
              <div class="md:col-span-2">
                <p class="text-sm font-medium text-gray-900 dark:text-white">{{ u.email }}</p>
                <p class="text-xs text-gray-500 dark:text-gray-400">{{ u.id }}</p>
              </div>
              <select :value="u.role" class="px-2 py-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white" @change="(e) => updateUser(u.id, { role: (e.target as HTMLSelectElement).value })">
                <option value="viewer">viewer</option>
                <option value="moderator">moderator</option>
                <option value="analyst">analyst</option>
                <option value="editor">editor</option>
                <option value="admin">admin</option>
                <option value="super_admin">super_admin</option>
              </select>
              <select :value="u.subscription_status || 'none'" class="px-2 py-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white" @change="(e) => updateUser(u.id, { subscriptionStatus: (e.target as HTMLSelectElement).value })">
                <option value="none">none</option>
                <option value="active">active</option>
                <option value="trialing">trialing</option>
                <option value="past_due">past_due</option>
                <option value="cancelled">cancelled</option>
              </select>
            </div>
          </div>
        </div>

        <div v-if="activeAdminTab === 'analytics'" id="analytics-panel" role="tabpanel" class="p-6 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 space-y-5">
          <h2 class="text-xl font-bold text-gray-900 dark:text-white">Analytics</h2>
          <p class="text-sm text-gray-600 dark:text-gray-400">Views, retention, traffic source, and subscription status snapshots.</p>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div class="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
              <p class="text-xs text-gray-500 dark:text-gray-400">Total segment views</p>
              <p class="text-2xl font-bold text-gray-900 dark:text-white">{{ analytics.totalViews }}</p>
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div class="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
              <h3 class="font-semibold text-gray-900 dark:text-white mb-2">Traffic sources</h3>
              <p v-for="src in analytics.trafficSources" :key="src.source" class="text-sm text-gray-700 dark:text-gray-200">{{ src.source }}: {{ src.hits }}</p>
            </div>
            <div class="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
              <h3 class="font-semibold text-gray-900 dark:text-white mb-2">Subscriptions</h3>
              <p v-for="row in analytics.subscriptions" :key="row.status" class="text-sm text-gray-700 dark:text-gray-200">{{ row.status }}: {{ row.count }}</p>
            </div>
          </div>
        </div>

        <div v-if="activeAdminTab === 'system'" id="system-panel" role="tabpanel" class="p-6 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 space-y-4">
          <h2 class="text-xl font-bold text-gray-900 dark:text-white">System</h2>
          <p class="text-sm text-gray-600 dark:text-gray-400">Operational controls and refresh actions.</p>
          <button class="px-4 py-2 rounded-lg bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 text-sm text-gray-900 dark:text-gray-100" @click="reloadAll">Reload data</button>
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

    <!-- Swap modal -->
    <div v-if="swapModal.open" class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" @click.self="swapModal.open = false">
      <div
        ref="swapDialogRef"
        role="dialog"
        aria-modal="true"
        aria-label="Swap video"
        tabindex="-1"
        class="w-full max-w-2xl rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 p-5 max-h-[90vh] flex flex-col"
      >
        <!-- Step 0: pick a draft -->
        <template v-if="swapModal.step === 0">
          <div class="flex items-center justify-between mb-3 flex-shrink-0">
            <div>
              <h3 class="text-lg font-semibold text-gray-900 dark:text-white">Swap out «{{ swapModal.sourceVideo?.title }}»</h3>
              <p class="text-sm text-gray-600 dark:text-gray-400 mt-0.5">Select a draft video to replace it. The draft will be published and inherit all settings.</p>
            </div>
            <button class="text-sm text-gray-600 dark:text-gray-300 hover:underline ml-4 flex-shrink-0" @click="swapModal.open = false">Close</button>
          </div>
          <div class="overflow-y-auto space-y-2 flex-1">
            <div v-if="!draftVideos.length" class="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">No draft videos available.</div>
            <button
              v-for="draft in draftVideos"
              :key="draft.id"
              class="w-full text-left p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-purple-500 dark:hover:border-purple-500 transition-colors flex items-center gap-3"
              @click="selectSwapTarget(draft)"
            >
              <div class="w-24 aspect-video rounded overflow-hidden bg-gray-200 dark:bg-gray-800 flex-shrink-0">
                <img v-if="draft.thumbnail_url" :src="sizeUrl(draft.thumbnail_url, 'small')" :alt="draft.title" class="w-full h-full object-cover" />
              </div>
              <div class="min-w-0">
                <p class="font-medium text-gray-900 dark:text-white line-clamp-1">{{ draft.title }}</p>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ formatSeconds(getActualDuration(draft)) }} · uploaded {{ formatDate(draft.upload_date) }}</p>
              </div>
            </button>
          </div>
        </template>

        <!-- Step 1: confirm -->
        <template v-else-if="swapModal.step === 1">
          <h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-3">Confirm swap</h3>
          <div class="grid grid-cols-2 gap-4 mb-4">
            <div class="rounded-lg border border-red-200 dark:border-red-900 p-3">
              <p class="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide mb-2">Retiring</p>
              <div class="aspect-video rounded overflow-hidden bg-gray-200 dark:bg-gray-800 mb-2">
                <img v-if="swapModal.sourceVideo?.thumbnail_url" :src="sizeUrl(swapModal.sourceVideo.thumbnail_url, 'medium')" class="w-full h-full object-cover" alt="" />
              </div>
              <p class="font-medium text-gray-900 dark:text-white text-sm line-clamp-2">{{ swapModal.sourceVideo?.title }}</p>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">Will become «OLD - {{ swapModal.sourceVideo?.title }}» (draft)</p>
            </div>
            <div class="rounded-lg border border-green-200 dark:border-green-900 p-3">
              <p class="text-xs font-semibold text-green-600 dark:text-green-400 uppercase tracking-wide mb-2">Publishing</p>
              <div class="aspect-video rounded overflow-hidden bg-gray-200 dark:bg-gray-800 mb-2">
                <img v-if="swapTargetVideo?.thumbnail_url" :src="sizeUrl(swapTargetVideo.thumbnail_url, 'medium')" class="w-full h-full object-cover" alt="" />
              </div>
              <p class="font-medium text-gray-900 dark:text-white text-sm line-clamp-2">{{ swapTargetVideo?.title }}</p>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">Will publish at /watch/{{ swapModal.sourceVideo?.slug ?? swapModal.sourceVideo?.id }}</p>
            </div>
          </div>
          <p class="text-sm text-amber-600 dark:text-amber-400 mb-4">⚠ This cannot be undone. Title, slug, thumbnail, dates, and preview lock transfer to the new video.</p>
          <div class="flex justify-end gap-2">
            <button class="px-3 py-2 rounded border border-gray-300 dark:border-gray-700 text-sm" @click="swapModal.step = 0">Back</button>
            <button class="px-3 py-2 rounded bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold" @click="executeSwap">Confirm Swap</button>
          </div>
        </template>

        <!-- Step 2: in progress -->
        <template v-else>
          <div class="flex flex-col items-center justify-center py-12 gap-3">
            <div class="w-8 h-8 border-2 border-gray-300 border-t-purple-600 rounded-full animate-spin"></div>
            <p class="text-sm text-gray-600 dark:text-gray-400">Swapping videos…</p>
          </div>
        </template>
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
import { sizeUrl } from '~/composables/useThumbnail'

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
  r2_exists: boolean | null
  slug?: string | null
}

type BlockType = 'hero' | 'featured_row' | 'cta' | 'text_split' | 'video_grid'
interface LayoutBlock {
  id: string
  type: BlockType
  title: string
  body: string
}

const config = useRuntimeConfig()
const { authHeader, isAdmin } = useAuth()
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
const uploadingFor = ref<string | null>(null)
const activeVideoTab = ref<'all' | 'locks'>('all')
const activeAdminTab = ref<'videos' | 'homepage' | 'notifications' | 'newsletter' | 'users' | 'analytics' | 'system'>('videos')
const adminTabs = [
  { id: 'videos' as const, label: 'Videos' },
  { id: 'homepage' as const, label: 'Homepage' },
  { id: 'notifications' as const, label: 'Notifications' },
  { id: 'newsletter' as const, label: 'Newsletter' },
  { id: 'users' as const, label: 'Users & roles' },
  { id: 'analytics' as const, label: 'Analytics' },
  { id: 'system' as const, label: 'System' },
]
const editingTitle = ref<{ id: string; value: string } | null>(null)
const titleInputEl = ref<HTMLInputElement | null>(null)
const editingSlug  = ref<{ id: string; value: string } | null>(null)
const slugInputEl  = ref<HTMLInputElement | null>(null)
const swapModal = ref<{
  open: boolean
  step: number  // 0=pick, 1=confirm, 2=loading
  sourceVideo: Video | null
  targetId: string | null
}>({ open: false, step: 0, sourceVideo: null, targetId: null })
const videoTabs = [
  { id: 'all' as const, label: 'All videos' },
  { id: 'locks' as const, label: 'Preview locks' },
]

const componentTypes: BlockType[] = ['hero', 'featured_row', 'cta', 'text_split', 'video_grid']
const layoutBlocks = ref<LayoutBlock[]>([])

const newsletterListId = ref('')
const newsletterSenderEmail = ref('')
const newsletterSenderName = ref('')
const newsletterSubject = ref('')
const newsletterHtml = ref('')
const newsletterTemplateId = ref('')
const newsletterSaving = ref(false)
const newsletterSending = ref(false)
const newsletterMessage = ref('')
const newsletterMessageClass = ref('')
const newsletterSyncing = ref(false)
const newsletterTemplates = ref<any[]>([])
const newsletterCampaigns = ref<any[]>([])
const homepageHeroTitle = ref('')
const homepageHeroSubtitle = ref('')
const users = ref<any[]>([])
const analytics = ref<{ totalViews: number; trafficSources: any[]; retention: any[]; subscriptions: any[] }>({
  totalViews: 0,
  trafficSources: [],
  retention: [],
  subscriptions: [],
})
/** Stable per send attempt until success — retries reuse the same key for server idempotency. */
const newsletterSendDedupeKey = ref<string | null>(null)

/** Sandboxed document for preview — avoids v-html XSS in the admin app. */
const newsletterPreviewSrcdoc = computed(() => {
  const bodyHtml = newsletterHtml.value
  if (!bodyHtml.trim()) return ''
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
    body{font-family:system-ui,sans-serif;margin:0;padding:12px;color:#111;background:#fff}
    @media (prefers-color-scheme: dark){ body{color:#e5e5e5;background:#0a0a0a} }
  </style></head><body>${bodyHtml}</body></html>`
})

const chronologicallySortedUploads = computed(() =>
  [...uploads.value].sort((a, b) => new Date(b.upload_date).getTime() - new Date(a.upload_date).getTime())
)

const draftVideos      = computed(() => chronologicallySortedUploads.value.filter(v => v.publish_status === 'draft' && v.r2_exists !== false))
const swapTargetVideo  = computed(() => uploads.value.find(v => v.id === swapModal.value.targetId) ?? null)

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

const loadNewsletterSettings = async () => {
  if (!isAdmin.value) return
  try {
    const res = await fetch(`${config.public.apiUrl}/api/admin/newsletter/settings`, { headers: authHeader() })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    const data = await res.json()
    newsletterListId.value = data.brevoSubscriberListId != null ? String(data.brevoSubscriberListId) : ''
    newsletterSenderEmail.value = data.brevoCampaignSenderEmail ?? ''
    newsletterSenderName.value = data.brevoCampaignSenderName ?? ''
  } catch (e: any) {
    newsletterMessage.value = `Could not load newsletter settings: ${e.message}`
    newsletterMessageClass.value = 'border-red-300 bg-red-50 text-red-700 dark:bg-red-950 dark:border-red-700 dark:text-red-200'
  }
}

const loadNewsletterTemplates = async () => {
  if (!isAdmin.value) return
  const res = await fetch(`${config.public.apiUrl}/api/admin/newsletter/templates`, { headers: authHeader() })
  if (!res.ok) return
  const data = await res.json()
  newsletterTemplates.value = data.templates || []
}

const loadNewsletterCampaigns = async () => {
  if (!isAdmin.value) return
  const res = await fetch(`${config.public.apiUrl}/api/admin/newsletter/campaigns`, { headers: authHeader() })
  if (!res.ok) return
  const data = await res.json()
  newsletterCampaigns.value = data.campaigns || []
}

const syncNewsletterRecipients = async () => {
  newsletterSyncing.value = true
  try {
    const res = await fetch(`${config.public.apiUrl}/api/admin/newsletter/sync`, {
      method: 'POST',
      headers: authHeader(),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    newsletterMessage.value = `Sync complete. Recipients synced: ${data.synced}`
    newsletterMessageClass.value = 'border-green-300 bg-green-50 text-green-700 dark:bg-green-950 dark:border-green-700 dark:text-green-200'
  } catch (e: any) {
    newsletterMessage.value = e.message || 'Sync failed'
    newsletterMessageClass.value = 'border-red-300 bg-red-50 text-red-700 dark:bg-red-950 dark:border-red-700 dark:text-red-200'
  } finally {
    newsletterSyncing.value = false
  }
}

const loadHomepageContent = async () => {
  if (!isAdmin.value) return
  const res = await fetch(`${config.public.apiUrl}/api/admin/homepage/content`, { headers: authHeader() })
  if (!res.ok) return
  const data = await res.json()
  homepageHeroTitle.value = data.title || ''
  homepageHeroSubtitle.value = data.subtitle || ''
}

const saveHomepageContent = async () => {
  if (!isAdmin.value) return
  const res = await fetch(`${config.public.apiUrl}/api/admin/homepage/content`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ title: homepageHeroTitle.value, subtitle: homepageHeroSubtitle.value }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
}

const loadUsers = async () => {
  if (!isAdmin.value) return
  const res = await fetch(`${config.public.apiUrl}/api/admin/users`, { headers: authHeader() })
  if (!res.ok) return
  const data = await res.json()
  users.value = data.users || []
}

const updateUser = async (userId: string, patch: Record<string, string>) => {
  try {
    const res = await fetch(`${config.public.apiUrl}/api/admin/users`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ userId, ...patch }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    await loadUsers()
    showToast('success', 'User updated.')
  } catch (error: any) {
    console.error('Failed to update user', error)
    showToast('error', `Failed to update user: ${error.message || 'unknown error'}`)
  }
}

const loadAnalytics = async () => {
  if (!isAdmin.value) return
  const res = await fetch(`${config.public.apiUrl}/api/admin/analytics`, { headers: authHeader() })
  if (!res.ok) return
  analytics.value = await res.json()
}

const saveNewsletterSettings = async () => {
  if (!isAdmin.value) return
  newsletterSaving.value = true
  newsletterMessage.value = ''
  try {
    const raw = newsletterListId.value.trim()
    let brevoSubscriberListId: number | '' = ''
    if (raw) {
      if (!/^\d+$/.test(raw)) {
        throw new Error('Subscriber list ID must be a positive integer or empty')
      }
      const n = Number.parseInt(raw, 10)
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error('Subscriber list ID must be a positive integer or empty')
      }
      brevoSubscriberListId = n
    }
    const res = await fetch(`${config.public.apiUrl}/api/admin/newsletter/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({
        brevoSubscriberListId,
        brevoCampaignSenderEmail: newsletterSenderEmail.value.trim(),
        brevoCampaignSenderName: newsletterSenderName.value.trim(),
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    newsletterMessage.value = 'Newsletter settings saved.'
    newsletterMessageClass.value = 'border-green-300 bg-green-50 text-green-700 dark:bg-green-950 dark:border-green-700 dark:text-green-200'
    await loadNewsletterSettings()
  } catch (e: any) {
    newsletterMessage.value = e.message || 'Failed to save settings'
    newsletterMessageClass.value = 'border-red-300 bg-red-50 text-red-700 dark:bg-red-950 dark:border-red-700 dark:text-red-200'
  } finally {
    newsletterSaving.value = false
  }
}

const sendNewsletterCampaign = async () => {
  if (!isAdmin.value) return
  newsletterSending.value = true
  newsletterMessage.value = ''
  try {
    if (!newsletterSendDedupeKey.value) {
      newsletterSendDedupeKey.value = crypto.randomUUID()
    }
    const res = await fetch(`${config.public.apiUrl}/api/admin/newsletter/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({
        subject: newsletterSubject.value.trim(),
        htmlBody: newsletterHtml.value,
        templateId: newsletterTemplateId.value || undefined,
        dedupeKey: newsletterSendDedupeKey.value,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    newsletterSendDedupeKey.value = null
    newsletterMessage.value = data.idempotent
      ? `Already sent (Brevo campaign id ${data.campaignId}).`
      : (data.campaignId != null
        ? `Campaign scheduled (Brevo campaign id ${data.campaignId}).`
        : 'Campaign sent.')
    newsletterMessageClass.value = 'border-green-300 bg-green-50 text-green-700 dark:bg-green-950 dark:border-green-700 dark:text-green-200'
  } catch (e: any) {
    newsletterMessage.value = e.message || 'Send failed'
    newsletterMessageClass.value = 'border-red-300 bg-red-50 text-red-700 dark:bg-red-950 dark:border-red-700 dark:text-red-200'
  } finally {
    newsletterSending.value = false
  }
}

const saveAll = async () => {
  saving.value      = true
  saveMessage.value = ''
  try {
    const featuredVideoIds = featuredSlots.value.map(v => v?.id).filter(Boolean)
    await saveHomepageContent()
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
  try {
    await loadVideos()
    await loadConfig()
    await loadNewsletterSettings()
    await loadNewsletterTemplates()
    await loadNewsletterCampaigns()
    await loadHomepageContent()
    await loadUsers()
    await loadAnalytics()
  }
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



async function handleThumbnailSelect(event: Event, video: Video) {
  const input = event.target as HTMLInputElement
  const file  = input.files?.[0]
  if (!file) return

  // 10 MB client-side guard (the API also enforces this).
  if (file.size > 10 * 1024 * 1024) {
    alert('Image must be under 10 MB')
    input.value = ''
    return
  }

  uploadingFor.value = video.id
  try {
    const formData = new FormData()
    formData.append('thumbnail', file)

    // Do NOT set Content-Type manually — the browser sets it with the correct
    // multipart boundary when FormData is the body.
    const res = await fetch(
      `${config.public.apiUrl}/api/admin/videos/${video.id}/thumbnail`,
      { method: 'POST', headers: { ...authHeader() }, body: formData },
    )
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Upload failed' }))
      throw new Error(err.error || 'Upload failed')
    }
    const data = await res.json()
    // Update the local record so the UI reflects the new thumbnail without a full reload.
    // The API returns a versioned URL (?v=...) to force cache eviction across devices.
    if (data?.thumbnails?.large) {
      const cacheBustedUrl = String(data.thumbnails.large)
      const idx = uploads.value.findIndex(v => v.id === video.id)
      if (idx !== -1) {
        uploads.value[idx] = { ...uploads.value[idx], thumbnail_url: cacheBustedUrl }
      }
      featuredSlots.value = featuredSlots.value.map(slot =>
        slot?.id === video.id ? { ...slot, thumbnail_url: cacheBustedUrl } : slot
      )
      showToast('success', `Thumbnail updated for ${video.title}. Cache refreshed.`)
    } else {
      // If the API response is missing a thumbnail URL, keep the existing thumbnail as-is.
      showToast('error', 'Thumbnail upload succeeded but API did not return a thumbnail URL.')
    }
  } catch (err: any) {
    showToast('error', `Thumbnail upload failed: ${err.message}`)
  } finally {
    uploadingFor.value = null
    input.value = '' // reset so the same file can be re-selected
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

async function startSlugEdit(video: Video) {
  editingSlug.value = { id: video.id, value: video.slug ?? '' }
  await nextTick()
  slugInputEl.value?.focus()
  slugInputEl.value?.select()
}

async function saveSlugEdit(video: Video) {
  const editing = editingSlug.value
  if (!editing || editing.id !== video.id) return
  const newSlug = editing.value.trim() || null
  editingSlug.value = null
  if (newSlug === (video.slug ?? null)) return
  try {
    const res = await fetch(`${config.public.apiUrl}/api/admin/videos/${video.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ slug: newSlug }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    const idx = uploads.value.findIndex(v => v.id === video.id)
    if (idx !== -1) uploads.value[idx] = { ...uploads.value[idx], slug: newSlug }
    showToast('success', newSlug ? `Slug set: /watch/${newSlug}` : 'Slug cleared.')
  } catch (e: any) {
    showToast('error', `Failed to update slug: ${e.message}`)
  }
}

function openSwapModal(video: Video) {
  swapModal.value = { open: true, step: 0, sourceVideo: video, targetId: null }
}

function selectSwapTarget(draft: Video) {
  swapModal.value.targetId = draft.id
  swapModal.value.step = 1
}

async function executeSwap() {
  if (!swapModal.value.sourceVideo || !swapModal.value.targetId) return
  swapModal.value.step = 2
  try {
    const res = await fetch(
      `${config.public.apiUrl}/api/admin/videos/${swapModal.value.sourceVideo.id}/swap`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ swapWithId: swapModal.value.targetId }),
      }
    )
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    swapModal.value.open = false
    showToast('success', 'Swap complete — video list updated.')
    await reloadAll()
  } catch (e: any) {
    showToast('error', `Swap failed: ${e.message}`)
    swapModal.value.step = 1
  }
}

const confirmDialogRef = ref<HTMLElement | null>(null)
const swapDialogRef    = ref<HTMLElement | null>(null)
const lastFocusedEl    = ref<HTMLElement | null>(null)

function setAdminTab(tab: 'videos' | 'homepage' | 'notifications' | 'newsletter' | 'users' | 'analytics' | 'system') {
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
  if (tab && ['videos', 'homepage', 'notifications', 'newsletter', 'users', 'analytics', 'system'].includes(String(tab))) {
    activeAdminTab.value = tab as any
  }
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

function onSwapModalKeydown(e: KeyboardEvent) {
  if (!swapModal.value.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    swapModal.value.open = false
    return
  }
  if (e.key !== 'Tab' || !swapDialogRef.value) return
  const focusable = swapDialogRef.value.querySelectorAll<HTMLElement>(
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

watch(() => swapModal.value.open, async (open) => {
  if (open) {
    lastFocusedEl.value = document.activeElement as HTMLElement | null
    await nextTick()
    swapDialogRef.value?.focus()
    window.addEventListener('keydown', onSwapModalKeydown)
  } else {
    window.removeEventListener('keydown', onSwapModalKeydown)
    lastFocusedEl.value?.focus()
  }
})

onMounted(async () => {
  await reloadAll()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onConfirmModalKeydown)
  window.removeEventListener('keydown', onSwapModalKeydown)
  for (const timer of toastTimers.values()) clearTimeout(timer)
  toastTimers.clear()
})
</script>