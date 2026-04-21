<template>
  <div
    v-if="show"
    class="fixed inset-0 z-[100] flex items-center justify-center bg-black bg-opacity-80 backdrop-blur-sm"
  >
    <div class="bg-gray-900 rounded-xl p-8 max-w-lg w-full mx-4 text-center shadow-2xl">
      <div class="w-16 h-16 mx-auto mb-4 bg-gradient-to-br from-yellow-400 to-yellow-600 rounded-full flex items-center justify-center">
        <svg class="w-8 h-8 text-gray-900" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
        </svg>
      </div>

      <h3 class="text-2xl font-bold text-white mb-2">Premium Content</h3>
      <p class="text-gray-400 mb-6">
        Unlock the full video and all exclusive content.
      </p>

      <div v-if="loadingPrices" class="flex gap-3 mb-6">
        <div v-for="i in 3" :key="i" class="flex-1 h-28 bg-gray-800 rounded-lg animate-pulse" />
      </div>

      <div v-else-if="!priceError" class="flex gap-3 mb-6">
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
          <p class="text-xl font-bold text-white">{{ formatPrice(primaryPlanPrice('monthly')) }}</p>
          <p class="text-xs text-gray-500 mt-0.5">per month</p>
        </button>

        <button
          class="flex-1 rounded-lg border-2 p-4 text-left transition-all cursor-pointer"
          :class="selectedPlan === 'yearly'
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-gray-700 bg-gray-800 hover:border-gray-500'"
          @click="selectedPlan = 'yearly'"
        >
          <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Yearly</p>
          <p class="text-xl font-bold text-white">{{ formatPrice(primaryPlanPrice('yearly')) }}</p>
          <p class="text-xs text-gray-500 mt-0.5">per year</p>
        </button>

        <button
          class="flex-1 rounded-lg border-2 p-4 text-left transition-all cursor-pointer"
          :class="selectedPlan === 'club'
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-gray-700 bg-gray-800 hover:border-gray-500'"
          @click="selectedPlan = 'club'"
        >
          <p class="text-xs text-gray-400 uppercase tracking-wide mb-1">Club</p>
          <p class="text-xl font-bold text-white">{{ formatPrice(primaryPlanPrice('club')) }}</p>
          <p class="text-xs text-gray-500 mt-0.5">per year</p>
        </button>
      </div>

      <div v-if="priceError" class="text-red-400 text-sm mb-6">
        Could not load pricing. Please refresh the page.
      </div>

      <p v-if="checkoutError" class="text-red-400 text-sm mb-3">
        {{ checkoutError }}
      </p>
      <div class="mb-3 text-left">
        <label class="text-xs uppercase tracking-wide text-gray-500 block mb-1">Promo code</label>
        <div class="flex items-center gap-2">
          <input
            v-model="promoCodeInput"
            type="text"
            autocomplete="off"
            placeholder="e.g. STUDENT2026"
            class="flex-1 px-3 py-2 rounded-lg border border-gray-700 bg-gray-800 text-sm text-white placeholder-gray-500"
          >
          <button
            type="button"
            class="px-3 py-2 text-sm font-medium rounded-lg bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-50"
            :disabled="promoValidating || !promoCodeInput.trim()"
            @click="validatePromoCode"
          >
            {{ promoValidating ? 'Checking…' : 'Apply' }}
          </button>
          <button
            v-if="promoApplied"
            type="button"
            class="px-3 py-2 text-sm font-medium rounded-lg bg-gray-700 hover:bg-gray-600 text-white"
            @click="clearPromoCode"
          >
            Clear
          </button>
        </div>
        <p v-if="promoError" class="text-xs text-red-400 mt-1">{{ promoError }}</p>
        <p v-else-if="promoApplied" class="text-xs text-emerald-400 mt-1">
          Promo applied: {{ promoApplied.code }} · {{ promoApplied.rewardType.replace('_', ' ') }}
        </p>
      </div>

      <div class="space-y-2">
        <button
          v-for="provider in availableProviders"
          :key="provider"
          class="w-full text-white font-semibold py-3 px-6 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          :class="providerButtonClass(provider)"
          :disabled="checkingOut || loadingPrices || !providerPlanPrice(provider, selectedPlan)"
          @click="handleSubscribe(provider)"
        >
          <span v-if="checkingOut && selectedProvider === provider">Redirecting to checkout…</span>
          <span v-else>{{ providerButtonLabel(provider) }}</span>
        </button>
      </div>

      <p class="text-xs text-gray-500 mt-3">
        {{ checkoutBlurb }}
      </p>
      <p v-if="!isLoggedIn" class="text-sm text-gray-400 mt-2">
        You will be asked to sign in before checkout.
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
const route       = useRoute()
const { isLoggedIn, authHeader } = useAuth()

type PlanType = 'monthly' | 'yearly' | 'club'
type PaymentProvider = 'stripe' | 'gocardless'

interface Prices { monthly: number; yearly: number; club: number }
interface ProviderPriceMap { stripe: Prices; gocardless: Prices }

const defaultPrices: Prices = { monthly: 6.90, yearly: 74.90, club: 109.00 }
const pricesByProvider = ref<ProviderPriceMap>({
  stripe: { ...defaultPrices },
  gocardless: { ...defaultPrices },
})
const loadingPrices = ref(false)
const priceError = ref(false)
const selectedPlan = ref<PlanType>('monthly')
const availableProviders = ref<PaymentProvider[]>(['stripe'])
const selectedProvider = ref<PaymentProvider>('stripe')
const checkingOut = ref(false)
const checkoutError = ref<string | null>(null)
const promoCodeInput = ref('')
const promoValidating = ref(false)
const promoError = ref<string | null>(null)
const promoApplied = ref<null | { code: string; rewardType: string }>(null)

function formatPrice(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return '…'
  return `€${amount.toFixed(2)}`
}

function providerPlanPrice(provider: PaymentProvider, plan: PlanType): number | null {
  const value = pricesByProvider.value[provider]?.[plan]
  return Number.isFinite(value) ? Number(value) : null
}

function primaryPlanPrice(plan: PlanType): number | null {
  const first = availableProviders.value[0] ?? 'stripe'
  return providerPlanPrice(first, plan)
}

function providerButtonLabel(provider: PaymentProvider): string {
  const amount = providerPlanPrice(provider, selectedPlan.value)
  const priceText = formatPrice(amount)
  if (provider === 'gocardless') return `Pay ${priceText} with your bank account`
  return `Pay ${priceText} with your card`
}

function providerButtonClass(provider: PaymentProvider): string {
  if (provider === 'gocardless') {
    return 'bg-emerald-600 hover:bg-emerald-700'
  }
  return 'bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700'
}

const checkoutBlurb = computed(() => {
  if (!availableProviders.value.length) {
    return 'Secure checkout. Cancel any time.'
  }
  if (availableProviders.value.length === 1) {
    const provider = availableProviders.value[0]
    return provider === 'gocardless'
      ? 'Secure checkout via GoCardless. Cancel any time.'
      : 'Secure checkout via Stripe. Cancel any time.'
  }
  return 'Secure checkout via Stripe or GoCardless. Cancel any time.'
})

async function loadPrices() {
  loadingPrices.value = true
  priceError.value = false
  try {
    const res = await fetch(`${apiUrl}/api/account/pricing`)
    if (!res.ok) {
      priceError.value = true
      return
    }

    const data = await res.json()
    const providers = Array.isArray(data.enabledProviders)
      ? data.enabledProviders.filter((p: string) => p === 'stripe' || p === 'gocardless')
      : []
    availableProviders.value = providers.length ? providers : ['stripe']

    const fallback: Prices = {
      monthly: Number(data.monthly ?? defaultPrices.monthly),
      yearly: Number(data.yearly ?? defaultPrices.yearly),
      club: Number(data.club ?? defaultPrices.club),
    }

    const stripeRaw = data?.pricesByProvider?.stripe ?? {}
    const gocardlessRaw = data?.pricesByProvider?.gocardless ?? {}

    pricesByProvider.value = {
      stripe: {
        monthly: Number(stripeRaw.monthly ?? fallback.monthly),
        yearly: Number(stripeRaw.yearly ?? fallback.yearly),
        club: Number(stripeRaw.club ?? fallback.club),
      },
      gocardless: {
        monthly: Number(gocardlessRaw.monthly ?? fallback.monthly),
        yearly: Number(gocardlessRaw.yearly ?? fallback.yearly),
        club: Number(gocardlessRaw.club ?? fallback.club),
      },
    }

    if (!availableProviders.value.includes(selectedProvider.value)) {
      selectedProvider.value = availableProviders.value[0] ?? 'stripe'
    }

    const hasVisiblePrice = availableProviders.value.some((provider) => providerPlanPrice(provider, selectedPlan.value) != null)
    if (!hasVisiblePrice) {
      priceError.value = true
    }
  } catch {
    priceError.value = true
  } finally {
    loadingPrices.value = false
  }
}

async function handleSubscribe(provider?: PaymentProvider) {
  if (!isLoggedIn.value) {
    const selected = provider ?? availableProviders.value[0] ?? 'stripe'
    const redirect = `/watch/${encodeURIComponent(props.videoId)}?showPremium=1&checkout_plan=${selectedPlan.value}&checkout_provider=${selected}`
    await navigateTo(`/login?redirect=${encodeURIComponent(redirect)}`)
    return
  }

  const selected = provider ?? availableProviders.value[0] ?? 'stripe'
  selectedProvider.value = selected
  checkingOut.value = true
  checkoutError.value = null
  const promoCode = promoApplied.value?.code || ''
  try {
    const res = await fetch(`${apiUrl}/api/payments/checkout`, {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json', ...authHeader() },
      body:        JSON.stringify({ planType: selectedPlan.value, provider: selected, promoCode }),
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

async function validatePromoCode() {
  promoError.value = null
  promoApplied.value = null
  const code = promoCodeInput.value.trim().toUpperCase()
  promoCodeInput.value = code
  if (!code) return

  if (!isLoggedIn.value) {
    promoError.value = 'Please sign in to validate promo codes.'
    return
  }

  promoValidating.value = true
  try {
    const res = await fetch(`${apiUrl}/api/account/promotions/validate`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ promoCode: code, planType: selectedPlan.value }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data?.valid) {
      promoError.value = data?.error || 'Promo code is not valid.'
      return
    }
    promoApplied.value = {
      code: String(data?.promo?.code || code),
      rewardType: String(data?.promo?.rewardType || 'free_month'),
    }
  } catch {
    promoError.value = 'Network error while validating promo code.'
  } finally {
    promoValidating.value = false
  }
}

function clearPromoCode() {
  promoCodeInput.value = ''
  promoApplied.value = null
  promoError.value = null
}

function applyCheckoutIntentFromRoute() {
  const q = route.query
  const plan = q.checkout_plan
  if (plan === 'monthly' || plan === 'yearly' || plan === 'club') {
    selectedPlan.value = plan
  }
  const prov = q.checkout_provider
  if (prov === 'stripe' || prov === 'gocardless') {
    selectedProvider.value = prov
  }
}

watch(() => props.show, (visible) => {
  if (visible) {
    applyCheckoutIntentFromRoute()
    clearPromoCode()
    loadPrices()
  }
}, { immediate: true })

watch(selectedPlan, () => {
  // Plan changes can invalidate a previously-applied code.
  promoApplied.value = null
  promoError.value = null
})

watch(promoCodeInput, (newInput) => {
  const trimmed = newInput.trim()
  const appliedCode = promoApplied.value?.code ?? ''
  if (trimmed !== appliedCode) {
    promoApplied.value = null
    promoError.value = null
  }
})

watch(() => route.fullPath, () => {
  if (props.show) applyCheckoutIntentFromRoute()
})
</script>