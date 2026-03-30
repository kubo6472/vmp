<template>
  <header class="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">

        <!-- Logo -->
        <NuxtLink to="/" class="flex items-center space-x-2 shrink-0">
          <div class="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg"></div>
          <span class="text-xl font-bold text-gray-900 dark:text-white">
            Video Monetization Platform
          </span>
        </NuxtLink>

        <!-- Right side -->
        <div class="flex items-center gap-4">

          <!-- Nav links (only shown when logged in as editor+) -->
          <nav v-if="canEditContent" class="hidden sm:flex items-center gap-5 text-sm font-medium">
            <NuxtLink
              to="/"
              class="text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white transition-colors"
            >
              Homepage
            </NuxtLink>
            <NuxtLink
              to="/admin"
              class="text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white transition-colors"
            >
              Admin
            </NuxtLink>
          </nav>

          <!-- Unauthenticated -->
          <NuxtLink
            v-if="!isLoggedIn"
            to="/login"
            class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors"
          >
            Sign in
          </NuxtLink>

          <!-- Authenticated — user chip with dropdown -->
          <div v-else class="relative" ref="dropdownRef">
            <button
              class="flex items-center gap-2.5 pl-1 pr-3 py-1 rounded-full border border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 transition-colors bg-white dark:bg-gray-900"
              @click="dropdownOpen = !dropdownOpen"
            >
              <!-- Avatar -->
              <div class="w-7 h-7 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                {{ userInitial }}
              </div>

              <!-- Email (hidden on small screens) -->
              <span class="hidden sm:block text-sm text-gray-700 dark:text-gray-300 max-w-[140px] truncate">
                {{ user?.email }}
              </span>

              <!-- Role badge -->
              <span :class="['hidden sm:block text-xs font-semibold px-1.5 py-0.5 rounded', roleBadgeClass]">
                {{ roleLabel }}
              </span>

              <!-- Chevron -->
              <svg
                class="w-3.5 h-3.5 text-gray-500 transition-transform"
                :class="{ 'rotate-180': dropdownOpen }"
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            <!-- Dropdown -->
            <Transition
              enter-active-class="transition-all duration-150 ease-out"
              enter-from-class="opacity-0 scale-95 -translate-y-1"
              enter-to-class="opacity-100 scale-100 translate-y-0"
              leave-active-class="transition-all duration-100 ease-in"
              leave-from-class="opacity-100 scale-100 translate-y-0"
              leave-to-class="opacity-0 scale-95 -translate-y-1"
            >
              <div
                v-if="dropdownOpen"
                class="absolute right-0 top-full mt-2 w-52 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-lg overflow-hidden z-50"
              >
                <!-- User info -->
                <div class="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
                  <p class="text-xs text-gray-500 dark:text-gray-400">Signed in as</p>
                  <p class="text-sm font-medium text-gray-900 dark:text-white truncate mt-0.5">{{ user?.email }}</p>
                </div>

                <!-- Actions -->
                <div class="py-1">
                  <NuxtLink
                    v-if="canEditContent"
                    to="/admin"
                    class="flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    @click="dropdownOpen = false"
                  >
                    <svg class="w-4 h-4 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    Admin console
                  </NuxtLink>

                  <button
                    class="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                    @click="handleLogout"
                  >
                    <svg class="w-4 h-4 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                    </svg>
                    Sign out
                  </button>
                </div>
              </div>
            </Transition>
          </div>

        </div>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
const { user, isLoggedIn, canEditContent, logout } = useAuth()
const router = useRouter()

const dropdownOpen = ref(false)
const dropdownRef  = ref<HTMLElement | null>(null)

// Close dropdown when clicking outside
onMounted(() => {
  document.addEventListener('mousedown', handleOutsideClick)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', handleOutsideClick)
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

const userInitial = computed(() => {
  const email = user.value?.email
  return email ? email[0].toUpperCase() : '?'
})

// Maps roles to human-readable short labels
const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Owner',
  admin:       'Admin',
  editor:      'Editor',
  analyst:     'Analyst',
  moderator:   'Mod',
  viewer:      'Viewer',
}

const roleLabel = computed(() => ROLE_LABELS[user.value?.role ?? ''] ?? 'Viewer')

// Role badge colours — each role gets a distinct tint so it's scannable at a glance
const ROLE_BADGE_CLASSES: Record<string, string> = {
  super_admin: 'bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300',
  admin:       'bg-blue-100   text-blue-800   dark:bg-blue-900/50   dark:text-blue-300',
  editor:      'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300',
  analyst:     'bg-amber-100  text-amber-800  dark:bg-amber-900/50  dark:text-amber-300',
  moderator:   'bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-300',
  viewer:      'bg-gray-100   text-gray-700   dark:bg-gray-800      dark:text-gray-400',
}

const roleBadgeClass = computed(() => ROLE_BADGE_CLASSES[user.value?.role ?? ''] ?? ROLE_BADGE_CLASSES.viewer)
</script>
