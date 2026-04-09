<template>
  <header class="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <NuxtLink to="/" class="flex min-w-0 items-center space-x-2 shrink">
          <img src="/icons/pwa-192.png" alt="" aria-hidden="true" class="w-8 h-8 rounded-lg shrink-0" />
          <span class="text-lg font-bold text-gray-900 dark:text-white sm:hidden">VMP</span>
          <span class="hidden sm:block text-xl font-bold text-gray-900 dark:text-white max-w-[12rem] md:max-w-none truncate">
            Video Monetization Platform
          </span>
        </NuxtLink>

        <div class="flex items-center gap-2 sm:gap-4">
          <NuxtLink
            v-if="!isLoggedIn"
            to="/login"
            class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors"
          >
            Sign in
          </NuxtLink>

          <div v-if="isLoggedIn" class="relative" ref="dropdownRef">
            <button
              class="flex items-center justify-center w-9 h-9 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 transition-colors bg-white dark:bg-gray-900"
              title="Open account menu"
              aria-label="Open account menu"
              :aria-expanded="dropdownOpen"
              aria-controls="account-menu"
              @click="dropdownOpen = !dropdownOpen"
            >
              <svg class="w-5 h-5 text-gray-600 dark:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h.01M12 12h.01M19 12h.01" />
              </svg>
            </button>

            <Transition
              enter-active-class="transition-all duration-150 ease-out"
              enter-from-class="opacity-0 scale-95 -translate-y-1"
              enter-to-class="opacity-100 scale-100 translate-y-0"
              leave-active-class="transition-all duration-100 ease-in"
              leave-from-class="opacity-100 scale-100 translate-y-0"
              leave-to-class="opacity-0 scale-95 -translate-y-1"
            >
              <div
                id="account-menu"
                v-show="dropdownOpen"
                :aria-hidden="(!dropdownOpen).toString()"
                class="absolute right-0 top-full mt-2 w-64 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-lg overflow-hidden z-50"
              >
                <div class="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
                  <p class="text-xs text-gray-500 dark:text-gray-400">Signed in as</p>
                  <p class="text-sm font-medium text-gray-900 dark:text-white truncate mt-0.5">{{ user?.email }}</p>
                  <p class="text-xs mt-1" :class="roleBadgeClass">{{ roleLabel }}</p>
                </div>

                <div class="py-1">
                  <button
                    v-if="pushSupported"
                    class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    :title="pushBellTitle"
                    @click="handleBellClick"
                  >
                    <span class="w-4 text-center">{{ pushSubscribed ? '🔔' : '🔕' }}</span>
                    {{ pushSubscribed ? 'Disable notifications' : 'Enable notifications' }}
                  </button>

                  <NuxtLink
                    v-if="canEditContent"
                    to="/admin"
                    class="flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    @click="dropdownOpen = false"
                  >
                    Admin console
                  </NuxtLink>

                  <NuxtLink
                    to="/account"
                    class="flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    @click="dropdownOpen = false"
                  >
                    Account
                  </NuxtLink>

                  <button
                    class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                    @click="handleLogout"
                  >
                    Sign out
                  </button>
                </div>
              </div>
            </Transition>
          </div>
        </div>
      </div>
    </div>

    <div v-if="pushToast || pushError" class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-3">
      <div
        :role="isError ? 'alert' : 'status'"
        :aria-live="isError ? 'assertive' : 'polite'"
        aria-atomic="true"
        class="rounded-lg border px-3 py-2 text-sm"
        :class="pushToast?.type === 'success'
          ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
          : 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'"
      >
        {{ pushToast?.message || pushError }}
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
const { user, isLoggedIn, canEditContent, logout } = useAuth()
const {
  isSupported: pushSupported,
  permission: pushPermission,
  isSubscribed: pushSubscribed,
  pushError,
  subscribe: pushSubscribe,
  unsubscribe: pushUnsubscribe,
  clearError: clearPushError,
} = usePushNotifications()

const router = useRouter()
const dropdownOpen = ref(false)
const dropdownRef  = ref<HTMLElement | null>(null)
const pushToast = ref<{ type: 'success' | 'error'; message: string } | null>(null)
let pushToastTimer: ReturnType<typeof setTimeout> | null = null

const isError = computed(() => !!pushError.value || pushToast.value?.type === 'error')

const pushBellTitle = computed(() => {
  if (pushPermission.value === 'denied') return 'Notifications blocked by browser'
  if (pushSubscribed.value) return 'Notifications on — click to disable'
  return 'Click to enable new video notifications'
})

function showPushToast(type: 'success' | 'error', message: string) {
  pushToast.value = { type, message }
  if (pushToastTimer) clearTimeout(pushToastTimer)
  pushToastTimer = setTimeout(() => { pushToast.value = null }, 2800)
}

async function handleBellClick() {
  if (pushPermission.value === 'denied') {
    showPushToast('error', pushError.value || 'Notifications are blocked in your browser settings.')
    clearPushError()
    dropdownOpen.value = false
    return
  }
  try {
    if (pushSubscribed.value) {
      const before = pushSubscribed.value
      await pushUnsubscribe()
      if (pushError.value) {
        showPushToast('error', pushError.value)
        clearPushError()
      } else if (before && !pushSubscribed.value) {
        showPushToast('success', 'Notifications turned off.')
      }
    } else {
      const before = pushSubscribed.value
      await pushSubscribe()
      if (!before && pushSubscribed.value) showPushToast('success', 'Notifications enabled.')
      else if (pushError.value) {
        showPushToast('error', pushError.value)
        clearPushError()
      }
    }
  } catch (err: any) {
    showPushToast('error', pushError.value || err.message)
    clearPushError()
  } finally {
    dropdownOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleOutsideClick)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', handleOutsideClick)
  if (pushToastTimer) clearTimeout(pushToastTimer)
})

function handleOutsideClick(e: MouseEvent) {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target as Node)) {
    dropdownOpen.value = false
  }
}

async function handleLogout() {
  dropdownOpen.value = false
  await logout()
  router.push('/')
}

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  analyst: 'Analyst',
  moderator: 'Mod',
  viewer: 'Viewer',
}

const roleLabel = computed(() => ROLE_LABELS[user.value?.role ?? ''] ?? 'Viewer')
const ROLE_BADGE_CLASSES: Record<string, string> = {
  super_admin: 'text-purple-700 dark:text-purple-300',
  admin: 'text-blue-700 dark:text-blue-300',
  editor: 'text-emerald-700 dark:text-emerald-300',
  analyst: 'text-amber-700 dark:text-amber-300',
  moderator: 'text-orange-700 dark:text-orange-300',
  viewer: 'text-gray-700 dark:text-gray-400',
}

const roleBadgeClass = computed(() => ROLE_BADGE_CLASSES[user.value?.role ?? ''] ?? ROLE_BADGE_CLASSES.viewer)
</script>