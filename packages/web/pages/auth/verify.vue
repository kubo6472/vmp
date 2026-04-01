<!-- packages/web/pages/auth/verify.vue -->
<!-- 
  Landing page for magic link clicks.
  URL: /auth/verify?token=<raw_token>
  
  Calls the API to exchange the token for a JWT, then redirects home.
  Three states: verifying → success redirect | error (link expired/used).
-->
<template>
  <div class="min-h-screen bg-gray-950 flex items-center justify-center px-4">
    <div class="w-full max-w-sm text-center">

      <!-- Verifying -->
      <div v-if="state === 'verifying'" class="space-y-4">
        <div class="inline-block w-10 h-10 border-4 border-gray-700 border-t-blue-500 rounded-full animate-spin"></div>
        <p class="text-gray-400 text-sm">Signing you in…</p>
      </div>

      <!-- Error -->
      <div v-else-if="state === 'error'" class="space-y-6">
        <div class="w-14 h-14 mx-auto rounded-full bg-red-950 border border-red-800 flex items-center justify-center">
          <svg class="w-7 h-7 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
        <div>
          <h2 class="text-lg font-semibold text-white mb-1">Link invalid</h2>
          <p class="text-gray-400 text-sm leading-relaxed">{{ errorMessage }}</p>
        </div>
        <NuxtLink
          to="/login"
          class="inline-block px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Request a new link
        </NuxtLink>
      </div>

    </div>
  </div>
</template>

<script setup lang="ts">
import { useRoute, navigateTo } from '#app'

const route = useRoute()
const { verify } = useAuth()

type State = 'verifying' | 'error'
const state = ref<State>('verifying')
const errorMessage = ref('')

onMounted(async () => {
  const token = route.query.token as string | undefined

  if (!token) {
    state.value = 'error'
    errorMessage.value = 'No token found in the URL. Try clicking the link in your email again.'
    return
  }

  try {
    const redirect = (route.query.redirect as string) || '/'
    const result = await verify(token)

    // Editor/admin/super_admin users with 2FA enabled get a pending token —
    // redirect them to the TOTP entry page to complete the second factor.
    if ('requiresTwoFactor' in result) {
      await navigateTo(
        `/auth/2fa?pending=${encodeURIComponent(result.pendingToken)}&redirect=${encodeURIComponent(redirect)}`
      )
      return
    }

    // Session is now set in memory. Redirect to the page they originally wanted.
    await navigateTo(redirect)
  } catch (err: any) {
    state.value = 'error'
    errorMessage.value = err.message || 'Something went wrong. Please request a new sign-in link.'
  }
})
</script>
