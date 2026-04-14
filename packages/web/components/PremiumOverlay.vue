<template>
  <div
    v-if="show"
    class="absolute inset-0 z-50 flex items-center justify-center bg-black bg-opacity-80 backdrop-blur-sm"
  >
    <div class="bg-gray-900 rounded-xl p-8 max-w-lg w-full mx-4 text-center shadow-2xl">
      <!-- Lock icon -->
      <div class="w-16 h-16 mx-auto mb-4 bg-gradient-to-br from-yellow-400 to-yellow-600 rounded-full flex items-center justify-center">
        <svg class="w-8 h-8 text-gray-900" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
        </svg>
      </div>

      <h3 class="text-2xl font-bold text-white mb-2">Premium Content</h3>
      <p class="text-gray-400 mb-6">
        Unlock the full video and all exclusive content.
      </p>

      <!-- Loading skeleton -->
      <div v-if="loadingPrices" class="flex gap-3 mb-6">
        <div v-for="i in 3" :key="i" class="flex-1 h-28 bg-gray-800 rounded-lg animate-pulse" />
      </div>

      <!-- Pricing cards -->
      <div v-else-if="!priceError" class="flex gap-3 mb-6">
        <!-- Monthly (default / highlighted) -->
        <button
          class="flex-1 relative rounded-lg border-2 p-4 text-left transition-all cursor-pointer"
          :class="selectedPlan === 'monthly'
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-gray-700 bg-gray-800 hover:border-gray-500'"
          @click="selectedPlan = 'monthly'"
        >
          <div class="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-blue-500 text-white text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap">
            Most popular
          </div>
          <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Monthly</p>
          <p class="text-xl font-bold text-white">{{ formatPrice(prices.monthly) }}</p>
          <p class="text-xs text-gray-500 mt-0.5">per month</p>
        </button>

        <!-- Yearly -->
        <button
          class="flex-1 rounded-lg border-2 p-4 text-left transition-all cursor-pointer"
          :class="selectedPlan === 'yearly'
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-gray-700 bg-gray-800 hover:border-gray-500'"
          @click="selectedPlan = 'yearly'"
        >
          <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Yearly</p>
          <p class="text-xl font-bold text-white">{{ formatPrice(prices.yearly) }}</p>
          <p class="text-xs text-gray-500 mt-0.5">per year</p>
        </button>

        <!-- Club -->
        <button
          class="flex-1 rounded-lg border-2 p-4 text-left transition-all cursor-pointer"
          :class="selectedPlan === 'club'
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-gray-700 bg-gray-800 hover:border-gray-500'"
          @click="selectedPlan = 'club'"
        >
          <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Club</p>
          <p class="text-xl font-bold text-white">{{ formatPrice(prices.club) }}</p>
          <p class="text-xs text-gray-500 mt-0.5">per year</p>
        </button>
      </div>

      <!-- Error loading prices -->
      <div v-if="priceError" class="text-red-400 text-sm mb-6">
        Could not load pricing. Please refresh the page.
      </div>

      <!-- Checkout error -->
      <p v-if="checkoutError" class="text-red-400 text-sm mb-3">
        {{ checkoutError }}
      </p>

      <div v-if="isLoggedIn && availableProviders.length > 1" class="mb-4 rounded-lg border border-gray-700 bg-gray-800 p-3 text-left">
        <p class="text-xs uppercase tracking-wide text-gray-400 mb-2">Payment method</p>
        <div class="grid gap-2 sm:grid-cols-2">
          <label
            v-for="provider in availableProviders"
            :key="provider"
            class="inline-flex items-center gap-2 text-sm text-gray-200"
          >
            <input
              v-model="selectedProvider"
              type="radio"
              :value="provider"
              class="accent-blue-500"
            >
            <span>{{ providerLabel(provider) }}</span>
          </label>
        </div>
      </div>

      <!-- CTA -->
      <button
        class="w-full bg-gradient-to-r from-blue-500 to-purple-600 text-white font-semibold py-3 px-6 rounded-lg hover:from-blue-600 hover:to-purple-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="checkingOut || loadingPrices"
        @click="handleSubscribe"
      >
        <span v-if="checkingOut">Redirecting to checkout…</span>
        <span v-else-if="isLoggedIn">Subscribe {{ planLabel }} — {{ formatPrice(prices[selectedPlan]) }}</span>
        <span v-else>Sign in to subscribe</span>
      </button>

      <p v-if="isLoggedIn" class="text-xs text-gray-500 mt-3">
        {{ providerBlurb }}
      </p>
      <p v-else class="text-sm text-gray-400 mt-3">
        Already subscribed?
        <NuxtLink :to="`/login?redirect=/watch/${videoId}`" class="text-blue-400 hover:underline">Sign in</NuxtLink>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  show:    boolean
  videoId: string
}>()

const config      = useRuntimeConfig()
const apiUrl      = config.public.apiUrl as string
const { isLoggedIn, authHeader } = useAuth()

interface Prices { monthly: number; yearly: number; club: number }
type PaymentProvider = 'stripe' | 'gocardless'

const prices        = ref<Prices>({ monthly: 6.90, yearly: 74.90, club: 109.00 })
const loadingPrices = ref(false)
const priceError    = ref(false)
const selectedPlan  = ref<'monthly' | 'yearly' | 'club'>('monthly')
const availableProviders = ref<PaymentProvider[]>(['stripe'])
const selectedProvider = ref<PaymentProvider>('stripe')
const checkingOut   = ref(false)
const checkoutError = ref<string | null>(null)

const planLabel = computed(() => {
  const labels: Record<string, string> = { monthly: 'monthly', yearly: 'yearly', club: 'club' }
  return labels[selectedPlan.value] ?? selectedPlan.value
})

function formatPrice(amount: number | undefined): string {
  if (amount === undefined) return '…'
  return `€${amount.toFixed(2)}`
}

function providerLabel(provider: PaymentProvider) {
  return provider === 'gocardless' ? 'GoCardless (bank debit)' : 'Stripe (card)'
}

const providerBlurb = computed(() =>
  selectedProvider.value === 'gocardless'
    ? 'Bank debit checkout via GoCardless. Clearing can take a few business days.'
    : 'Secure checkout via Stripe. Cancel any time.'
)

async function loadPrices() {
  loadingPrices.value = true
  priceError.value = false
  try {
    const res = await fetch(`${apiUrl}/api/account/pricing`)
    if (res.ok) {
      const data = await res.json()
      if (data?.pricing_not_configured) {
        priceError.value = true
        return
      }
      prices.value = {
        monthly: Number(data.monthly),
        yearly: Number(data.yearly),
        club: Number(data.club),
      }
      const providers = Array.isArray(data.enabledProviders)
        ? data.enabledProviders.filter((p: string) => p === 'stripe' || p === 'gocardless')
        : []
      availableProviders.value = providers.length ? providers : ['stripe']
      if (!availableProviders.value.includes(selectedProvider.value)) {
        selectedProvider.value = availableProviders.value[0] ?? 'stripe'
      }
    } else {
      priceError.value = true
    }
  } catch {
    priceError.value = true
  } finally {
    loadingPrices.value = false
  }
}

async function handleSubscribe() {
  if (!isLoggedIn.value) {
    await navigateTo(`/login?redirect=/watch/${props.videoId}`)
    return
  }
  checkingOut.value = true
  checkoutError.value = null
  try {
    const res = await fetch(`${apiUrl}/api/payments/checkout`, {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json', ...authHeader() },
      body:        JSON.stringify({ planType: selectedPlan.value, provider: selectedProvider.value }),
    })
    const data = await res.json()
    if (!res.ok || !data.checkoutUrl) {
      checkoutError.value = data.error ?? 'Could not start checkout. Please try again.'
      return
    }
    window.location.href = data.checkoutUrl
  } catch {
    checkoutError.value = 'Network error. Please try again.'
  } finally {
    checkingOut.value = false
  }
}

// Load prices whenever the overlay becomes visible
watch(() => props.show, (visible) => {
  if (visible) loadPrices()
}, { immediate: true })
</script>
