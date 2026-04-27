<template>
  <div class="min-h-screen bg-gray-950 flex items-center justify-center px-4">
    <div class="w-full max-w-sm">

      <!-- Logo / Brand -->
      <div class="text-center mb-8">
        <div class="inline-flex items-center space-x-2 mb-4">
          <div class="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg"></div>
          <span class="text-xl font-bold text-white">VMP</span>
        </div>
        <h1 class="text-2xl font-bold text-white">Sign in</h1>
        <p class="text-gray-400 text-sm mt-1">We'll email you a sign-in link. No password needed.</p>
      </div>

      <!-- Form -->
      <div class="bg-gray-900 rounded-xl border border-gray-800 p-6 space-y-4">
        <div v-if="sent" class="rounded-lg bg-green-950 border border-green-800 px-4 py-3 text-sm text-green-300 leading-relaxed">
          ✓ Check your inbox — a sign-in link is on its way.
          <br><span class="text-green-500 text-xs">It expires in 15 minutes.</span>
          <p class="mt-2 text-[11px] text-green-400">
            If this browser does not open the link inside the app, copy/paste it into this browser to keep your session flow consistent.
          </p>
        </div>

        <div v-else>
          <label for="email" class="block text-sm font-medium text-gray-300 mb-2">Email address</label>
          <input
            id="email"
            v-model="email"
            type="email"
            autocomplete="email"
            placeholder="you@example.com"
            class="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
            :disabled="loading"
            @keydown.enter="submit"
          />

          <div v-if="errorMessage" class="mt-2 text-xs text-red-400">{{ errorMessage }}</div>

          <button
            class="w-full mt-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-lg text-sm transition-colors"
            :disabled="loading || !email"
            @click="submit"
          >
            {{ loading ? 'Sending…' : 'Send sign-in link' }}
          </button>
        </div>
      </div>

      <p class="text-center text-xs text-gray-600 mt-6">
        By signing in, you agree to our terms of service.
      </p>

    </div>
  </div>
</template>

<script setup lang="ts">
const route  = useRoute()
const { signIn, isLoggedIn } = useAuth()

// Must start with a single slash; rejects //evil.com and external URLs.
function safeRedirect(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const t = value.trim()
  if (!t.startsWith('/') || t.startsWith('//') || t.length > 1024) return fallback
  return t
}

// Capture the redirect target before any navigation.
// The middleware sets this to e.g. /admin when an unauthed user hits that route.
const redirectTo = safeRedirect(route.query.redirect, '/')

// Already logged in — skip the login page entirely
if (isLoggedIn.value) {
  await navigateTo(redirectTo)
}

const email        = ref('')
const loading      = ref(false)
const sent         = ref(false)
const errorMessage = ref('')

async function submit() {
  if (!email.value || loading.value) return
  loading.value  = true
  errorMessage.value = ''
  try {
    await signIn(email.value, redirectTo)
    sent.value = true
    // Note: we don't redirect here. The user will click the magic link in their
    // email, land on /auth/verify?token=..., and verify.vue will redirect to
    // redirectTo after successful verification.
    //
    // Redirect preference is forwarded in the magic-link request and encoded
    // into the emailed verify URL by the API.
  } catch (err: any) {
    errorMessage.value = err.message || 'Something went wrong. Please try again.'
  } finally {
    loading.value = false
  }
}
</script>
