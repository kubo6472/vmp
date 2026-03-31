<template>
  <div class="min-h-screen bg-gray-50 dark:bg-gray-950">
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
</script>
