<!-- packages/web/pages/auth/2fa.vue -->
<!--
  TOTP verification page — second step of login for editor/admin/super_admin.
  URL: /auth/2fa?pending=<pendingToken>&redirect=<path>

  The user arrives here after clicking a magic link. They must enter the
  6-digit code from their authenticator app to complete the sign-in.
-->
<template>
  <div class="min-h-screen bg-gray-950 flex items-center justify-center px-4">
    <div class="w-full max-w-sm">

      <!-- Header -->
      <div class="text-center mb-8">
        <div class="w-14 h-14 mx-auto rounded-full bg-blue-950 border border-blue-800 flex items-center justify-center mb-4">
          <svg class="w-7 h-7 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
        <h1 class="text-xl font-semibold text-white">Two-factor authentication</h1>
        <p class="text-gray-400 text-sm mt-2">Enter the 6-digit code from your authenticator app.</p>
      </div>

      <!-- Error -->
      <div v-if="errorMessage" class="mb-4 px-4 py-3 rounded-lg bg-red-950 border border-red-800 text-red-400 text-sm">
        {{ errorMessage }}
      </div>

      <!-- Session expired -->
      <div v-if="sessionExpired" class="text-center space-y-4">
        <p class="text-gray-400 text-sm">Your sign-in session has expired. Please start again.</p>
        <NuxtLink to="/login"
          class="inline-block px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
          Back to sign in
        </NuxtLink>
      </div>

      <!-- TOTP form -->
      <form v-else @submit.prevent="submit" class="space-y-5">
        <div>
          <label for="code" class="block text-sm font-medium text-gray-300 mb-1.5">
            Authenticator code
          </label>
          <input
            id="code"
            v-model="code"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            placeholder="000000"
            :disabled="loading"
            class="w-full px-4 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-center text-2xl tracking-[0.5em] font-mono placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          />
        </div>

        <button
          type="submit"
          :disabled="loading || code.length !== 6"
          class="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors text-sm"
        >
          <span v-if="loading" class="inline-flex items-center gap-2">
            <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin inline-block"></span>
            Verifying…
          </span>
          <span v-else>Verify</span>
        </button>

        <p class="text-center text-xs text-gray-500">
          Lost access to your authenticator?
          <a href="mailto:support@vmp.tjm.sk" class="text-blue-400 hover:underline">Contact support</a>
        </p>
      </form>

    </div>
  </div>
</template>

<script setup lang="ts">
import { useRoute, navigateTo } from '#app'

const route = useRoute()
const { verifyTotp } = useAuth()

const code           = ref('')
const loading        = ref(false)
const errorMessage   = ref('')
const sessionExpired = ref(false)

const pendingToken = computed(() => route.query.pending as string | undefined)
const redirect     = computed(() => (route.query.redirect as string) || '/')

// Redirect away if no pending token in URL
onMounted(() => {
  if (!pendingToken.value) {
    sessionExpired.value = true
  }
})

async function submit() {
  if (!pendingToken.value || code.value.length !== 6) return

  loading.value      = true
  errorMessage.value = ''

  try {
    await verifyTotp(code.value, pendingToken.value)
    await navigateTo(redirect.value)
  } catch (err: any) {
    const msg = err.message || ''
    if (msg.includes('expired') || msg.includes('session')) {
      sessionExpired.value = true
    } else {
      errorMessage.value = msg || 'Invalid code. Please try again.'
      code.value = ''
    }
  } finally {
    loading.value = false
  }
}
</script>
