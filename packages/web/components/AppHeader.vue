<template>
  <header class="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <NuxtLink to="/" class="flex items-center space-x-2">
          <div class="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg"></div>
          <span class="text-xl font-bold text-gray-900 dark:text-white">
            Video Monetization Platform
          </span>
        </NuxtLink>

        <nav class="flex items-center gap-5 text-sm font-medium">
          <NuxtLink to="/" class="text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white">Homepage</NuxtLink>
          <NuxtLink v-if="canEditContent" to="/admin" class="text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white">Admin</NuxtLink>

          <span v-if="isLoggedIn" class="text-gray-500 dark:text-gray-400">{{ user?.email }}</span>
          <NuxtLink
            v-if="!isLoggedIn"
            :to="`/login?redirect=${encodeURIComponent(currentPath)}`"
            class="px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700"
          >
            Log in
          </NuxtLink>
          <button
            v-else
            class="px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
            @click="signOut"
          >
            Log out
          </button>
        </nav>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
const route = useRoute()
const { user, isLoggedIn, canEditContent, logout } = useAuth()

const currentPath = computed(() => route.fullPath || '/')

const signOut = async () => {
  await logout()
  await navigateTo('/')
}
</script>
