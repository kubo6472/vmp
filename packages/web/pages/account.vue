<template>
  <div class="min-h-screen overflow-x-hidden bg-gray-50 dark:bg-gray-950">
    <AppHeader />

    <div class="max-w-2xl mx-auto px-4 sm:px-6 py-10 space-y-6">

      <!-- Welcome banner (shown after successful checkout redirect) -->
      <div
        v-if="showWelcomeBanner"
        class="flex items-start gap-3 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-lg p-4"
      >
        <svg class="w-5 h-5 text-green-600 dark:text-green-400 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
        </svg>
        <div class="flex-1">
          <p class="font-semibold text-green-900 dark:text-green-200">You're now subscribed!</p>
          <p class="text-sm text-green-800 dark:text-green-300 mt-0.5">Welcome to VMP Premium. Enjoy unlimited access to all content.</p>
        </div>
        <button class="text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-200" @click="showWelcomeBanner = false">
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
          </svg>
        </button>
      </div>

      <!-- Page heading -->
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Your account</h1>
        <p class="text-gray-500 dark:text-gray-400 mt-1">{{ user?.email }}</p>
      </div>

      <!-- Loading skeleton -->
      <div v-if="loadingSub" class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6 space-y-3">
        <div class="h-5 w-32 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
        <div class="h-4 w-48 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
        <div class="h-4 w-24 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
      </div>

      <!-- Active subscription card -->
      <div
        v-else-if="subscription"
        class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6"
      >
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Current plan</p>
            <p class="text-lg font-semibold text-gray-900 dark:text-white capitalize">
              {{ planDisplayName(subscription.planType) }}
            </p>
          </div>
          <span
            class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold"
            :class="statusBadgeClass(subscription.status)"
          >
            {{ subscription.status }}
          </span>
        </div>

        <div v-if="subscription.currentPeriodEnd" class="mt-4 text-sm text-gray-600 dark:text-gray-400">
          <span v-if="subscription.status === 'active'">Renews on </span>
          <span v-else>Access until </span>
          <span class="font-medium text-gray-900 dark:text-white">
            {{ formatDate(subscription.currentPeriodEnd) }}
          </span>
        </div>

        <div class="mt-5 pt-5 border-t border-gray-100 dark:border-gray-800">
          <button
            class="inline-flex items-center px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-900 dark:text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            :disabled="openingPortal"
            @click="openPortal"
          >
            <span v-if="openingPortal">Opening…</span>
            <span v-else>Manage subscription</span>
          </button>
          <p v-if="portalError" class="text-red-500 text-xs mt-2">{{ portalError }}</p>
        </div>
      </div>

      <!-- No subscription -->
      <div
        v-else
        class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6 text-center"
      >
        <div class="w-12 h-12 mx-auto mb-3 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center">
          <svg class="w-6 h-6 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
          </svg>
        </div>
        <p class="font-semibold text-gray-900 dark:text-white mb-1">No active subscription</p>
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Subscribe to unlock full access to all premium videos.
        </p>
        <NuxtLink
          to="/"
          class="inline-flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          Browse videos
        </NuxtLink>
      </div>

      <!-- Podcast RSS -->
      <div class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6 space-y-4">
        <div>
          <h2 class="text-base font-semibold text-gray-900 dark:text-white">Podcast RSS</h2>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Submit the public URL to podcast directories. Use your personal URL in your podcast app for full episodes while subscribed.
          </p>
        </div>

        <div v-if="rssError" class="text-sm text-red-600 dark:text-red-400">
          {{ rssError }}
        </div>
        <div v-else-if="loadingRss" class="space-y-2">
          <div class="h-4 w-3/4 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
          <div class="h-4 w-3/4 bg-gray-200 dark:bg-gray-800 rounded animate-pulse" />
        </div>
        <template v-else>
          <div class="space-y-2">
            <p class="text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide">Public listing URL</p>
            <div class="flex items-center gap-2">
              <input
                :value="rssPublicUrl"
                readonly
                class="flex-1 px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              >
              <button
                class="px-3 py-2 text-sm font-medium rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-900 dark:text-white"
                @click="copyText(rssPublicUrl, 'public')"
              >
                {{ copiedWhich === 'public' ? 'Copied' : 'Copy' }}
              </button>
            </div>
            <p v-if="copyError && copiedWhich === 'public'" class="text-xs text-red-600 dark:text-red-400">{{ copyError }}</p>
          </div>

          <div class="space-y-2">
            <p class="text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wide">Your personal URL</p>
            <div class="flex items-center gap-2">
              <input
                :value="rssPersonalUrl"
                readonly
                class="flex-1 px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              >
              <button
                class="px-3 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white"
                @click="copyText(rssPersonalUrl, 'personal')"
              >
                {{ copiedWhich === 'personal' ? 'Copied' : 'Copy' }}
              </button>
            </div>
            <p v-if="copyError && copiedWhich === 'personal'" class="text-xs text-red-600 dark:text-red-400">{{ copyError }}</p>
          </div>
        </template>
      </div>

      <!-- Security / 2FA card -->
      <div class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-9 h-9 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center flex-shrink-0">
            <svg class="w-5 h-5 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
          <h2 class="text-base font-semibold text-gray-900 dark:text-white">Two-factor authentication</h2>
        </div>

        <!-- 2FA enabled (show regardless of whether it is required for this role) -->
        <div v-if="user?.totpEnabled" class="flex items-center gap-3">
          <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200">
            <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
            </svg>
            Enabled
          </span>
          <p class="text-sm text-gray-500 dark:text-gray-400">Your account is protected with an authenticator app.</p>
        </div>

        <!-- 2FA required but not yet set up -->
        <div v-else-if="user?.totpRequired">
          <div class="flex items-center gap-3 mb-4">
            <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200">
              <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
              </svg>
              Setup required
            </span>
            <p class="text-sm text-gray-500 dark:text-gray-400">Your role requires 2FA to access the admin area.</p>
          </div>
          <NuxtLink
            to="/auth/2fa/setup?redirect=/account"
            class="inline-flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Set up two-factor authentication
          </NuxtLink>
        </div>

        <!-- 2FA not required for this role -->
        <div v-else>
          <p class="text-sm text-gray-500 dark:text-gray-400">Two-factor authentication is not required for your account role.</p>
        </div>
      </div>

    </div>
  </div>
</template>

<script setup lang="ts">
const route  = useRoute()
const config = useRuntimeConfig()
const apiUrl = config.public.apiUrl as string

const { user, subscription, fetchSubscription, authHeader, isLoggedIn } = useAuth()

// Guard: redirect to login if not authenticated
if (!isLoggedIn.value) {
  await navigateTo(`/login?redirect=/account`)
}

const loadingSub        = ref(true)
const openingPortal     = ref(false)
const portalError       = ref<string | null>(null)
const showWelcomeBanner = ref(route.query.subscribed === '1')
const loadingRss        = ref(true)
const rssError          = ref<string | null>(null)
const copyError         = ref<string | null>(null)
const rssPublicUrl      = ref('')
const rssPersonalUrl    = ref('')
const copiedWhich       = ref<'public' | 'personal' | null>(null)

onMounted(async () => {
  if (showWelcomeBanner.value) {
    // After a Stripe checkout redirect the webhook may not have fired yet.
    // Poll up to 5 times (at 2 s intervals) until we see an active subscription.
    const MAX_ATTEMPTS = 5
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await fetchSubscription()
      if (subscription.value?.status === 'active' || subscription.value?.status === 'trialing') break
      if (attempt < MAX_ATTEMPTS - 1) await new Promise(r => setTimeout(r, 2000))
    }
  } else {
    await fetchSubscription()
  }
  loadingSub.value = false

  await fetchRssUrls()
})

function planDisplayName(planType: string): string {
  const names: Record<string, string> = {
    monthly: 'Monthly',
    yearly:  'Yearly',
    club:    'Klubové predplatné',
  }
  return names[planType] ?? planType
}

function statusBadgeClass(status: string): string {
  if (status === 'active' || status === 'trialing') {
    return 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200'
  }
  if (status === 'past_due') {
    return 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200'
  }
  return 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

async function openPortal() {
  openingPortal.value = true
  portalError.value = null
  try {
    const res = await fetch(`${apiUrl}/api/payments/portal`, {
      method:      'POST',
      credentials: 'include',
      headers:     authHeader(),
    })
    const data = await res.json()
    if (!res.ok || !data.portalUrl) {
      portalError.value = data.error ?? 'Could not open billing portal. Please try again.'
      return
    }
    window.location.href = data.portalUrl
  } catch {
    portalError.value = 'Network error. Please try again.'
  } finally {
    openingPortal.value = false
  }
}

async function fetchRssUrls() {
  loadingRss.value = true
  rssError.value = null
  try {
    const res = await fetch(`${apiUrl}/api/account/rss`, {
      headers: authHeader(),
      credentials: 'include',
    })
    const data = await res.json()
    if (!res.ok) {
      rssError.value = data.error ?? 'Could not load RSS URLs.'
      return
    }
    rssPublicUrl.value = data.publicUrl ?? ''
    rssPersonalUrl.value = data.personalUrl ?? ''
  } catch {
    rssError.value = 'Network error while loading RSS URLs.'
  } finally {
    loadingRss.value = false
  }
}

async function copyText(value: string, which: 'public' | 'personal') {
  if (!value) return
  copyError.value = null
  try {
    await navigator.clipboard.writeText(value)
    copiedWhich.value = which
    setTimeout(() => {
      if (copiedWhich.value === which) copiedWhich.value = null
    }, 1200)
  } catch {
    copiedWhich.value = which
    copyError.value = 'Could not copy to clipboard. You can copy manually from the field.'
  }
}
</script>
