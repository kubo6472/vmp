/**
 * packages/web/composables/useAuth.ts
 *
 * Auth state composable.  Wraps the /api/auth/* endpoints and manages:
 *   - In-memory JWT (never written to localStorage — disappears on tab close)
 *   - Silent session restore on app init via the HttpOnly refresh cookie
 *   - Proactive token refresh ~2 minutes before the JWT expires
 *   - Typed user object with role
 *
 * Usage:
 *   const { user, accessToken, signIn, logout, refreshSession } = useAuth()
 *
 *   // Protect a page
 *   const { user } = useAuth()
 *   if (!user.value) navigateTo('/login')
 *
 *   // Check role
 *   if (user.value?.role === 'editor') { ... }
 *
 * The composable is a singleton — the reactive state is module-level so it's
 * shared across all component instances without a Pinia store.
 */

export type Role = 'super_admin' | 'admin' | 'editor' | 'analyst' | 'moderator' | 'viewer'

export interface AuthUser {
  id:          string
  email:       string
  role:        Role
  totpEnabled: boolean
  totpRequired?: boolean
}

export interface SubscriptionData {
  id:               string
  planType:         string   // 'monthly' | 'yearly' | 'club'
  status:           string   // 'active' | 'cancelled' | 'past_due' | 'trialing'
  stripeCustomerId: string | null
  currentPeriodEnd: string | null
  createdAt:        string
  updatedAt:        string
}

// Module-level state — shared across all useAuth() calls in the same tab.
// This is the idiomatic Nuxt 4 / Composition API singleton pattern.
const user         = ref<AuthUser | null>(null)
const accessToken  = ref<string | null>(null)
const subscription = ref<SubscriptionData | null>(null)
const initialised  = ref(false)
let   refreshTimer: ReturnType<typeof setTimeout> | null = null

export function useAuth() {
  const config = useRuntimeConfig()
  const apiUrl = config.public.apiUrl as string

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Parse a JWT payload without verifying the signature.
   * Verification happens server-side; here we just need the expiry time
   * to schedule the next refresh.
   */
  function parseJwtPayload(token: string): Record<string, unknown> | null {
    try {
      const payloadB64 = token.split('.')[1]
      const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/') +
        '=='.slice(0, (4 - (payloadB64.length % 4)) % 4)
      return JSON.parse(atob(padded))
    } catch {
      return null
    }
  }

  /**
   * Store the access token in memory and schedule a refresh ~2 min before expiry.
   * The Worker will reject the token at exactly `exp`; we refresh early to
   * keep the session seamless.
   */
  function setAccessToken(token: string, authUser: AuthUser) {
    accessToken.value = token
    user.value = { ...authUser, totpEnabled: !!authUser.totpEnabled }

    if (refreshTimer) clearTimeout(refreshTimer)

    const payload = parseJwtPayload(token)
    if (payload?.exp && typeof payload.exp === 'number') {
      const expiresInMs = payload.exp * 1000 - Date.now()
      const refreshInMs = Math.max(0, expiresInMs - 2 * 60 * 1000) // 2 min early
      refreshTimer = setTimeout(() => silentRefresh(), refreshInMs)
    }
  }

  function clearSession() {
    user.value = null
    accessToken.value = null
    subscription.value = null
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
  }

  // ── API calls ─────────────────────────────────────────────────────────────

  /**
   * POST /api/auth/magic-link
   * Sends a sign-in email. The user then clicks the link, which lands on
   * /auth/verify?token=... and this composable's verify() is called.
   */
  async function signIn(email: string, redirectPath?: string): Promise<{ ok: boolean; message: string }> {
    const res = await fetch(`${apiUrl}/api/auth/magic-link`, {
      method:      'POST',
      credentials: 'include',          // needed so the Set-Cookie from verify() works
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ email, redirect: redirectPath }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Failed to send sign-in link')
    return data
  }

  /**
   * GET /api/auth/verify?token=<raw>
   * Called from the /auth/verify page after the user clicks the magic link.
   * On success, stores the access token and schedules renewal.
   * If the user requires 2FA, returns { requiresTwoFactor: true, pendingToken }
   * instead of an AuthUser — the caller must redirect to /auth/2fa.
   */
  async function verify(token: string): Promise<AuthUser | { requiresTwoFactor: true; pendingToken: string }> {
    const res = await fetch(`${apiUrl}/api/auth/verify?token=${encodeURIComponent(token)}`, {
      credentials: 'include',    // lets the browser store the Set-Cookie refresh token
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Verification failed')

    if (data.requiresTwoFactor) {
      return { requiresTwoFactor: true, pendingToken: data.pendingToken }
    }

    setAccessToken(data.accessToken, data.user)
    return data.user
  }

  /**
   * POST /api/auth/2fa/verify
   * Called from /auth/2fa after the user enters their TOTP code.
   * Exchanges a pending token + code for a real session.
   */
  async function verifyTotp(code: string, pendingToken: string): Promise<AuthUser> {
    const res = await fetch(`${apiUrl}/api/auth/2fa/verify`, {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ code, pendingToken }),
    })
    const data = await res.json()
    if (!res.ok) {
      const err = new Error(data.error || 'Verification failed') as Error & { code?: string }
      err.code = data.code
      throw err
    }

    setAccessToken(data.accessToken, data.user)
    return data.user
  }

  /**
   * POST /api/auth/refresh
   * Exchanges the HttpOnly cookie for a fresh JWT.
   * Called on app init and by the auto-refresh timer.
   * Returns false (doesn't throw) if there's no active session — that's normal
   * for an unauthenticated visitor.
   */
  async function refreshSession(): Promise<boolean> {
    try {
      const res = await fetch(`${apiUrl}/api/auth/refresh`, {
        method:      'POST',
        credentials: 'include',
      })
      if (!res.ok) { clearSession(); return false }

      const data = await res.json()
      setAccessToken(data.accessToken, data.user)
      return true
    } catch {
      clearSession()
      return false
    }
  }

  async function silentRefresh() {
    const ok = await refreshSession()
    if (!ok) clearSession()  // cookie expired or was revoked
  }

  /**
   * POST /api/auth/logout
   * Revokes the refresh token server-side and clears the cookie + in-memory state.
   */
  async function logout() {
    await fetch(`${apiUrl}/api/auth/logout`, {
      method:      'POST',
      credentials: 'include',
    }).catch(() => {})  // best-effort; clear locally even if the request fails
    clearSession()
  }

  /**
   * Returns the Authorization header value for use in protected API calls.
   *
   * Example:
   *   const res = await fetch('/api/some-protected-route', {
   *     headers: { ...authHeader() }
   *   })
   */
  function authHeader(): Record<string, string> {
    return accessToken.value ? { Authorization: `Bearer ${accessToken.value}` } : {}
  }

  /**
   * GET /api/account/subscription
   * Fetches the user's current subscription and stores it in module-level state.
   * Called lazily (from account page or after checkout) rather than on every boot
   * to avoid an extra round-trip for users who are just browsing.
   */
  async function fetchSubscription(): Promise<void> {
    if (!accessToken.value) return
    try {
      const res = await fetch(`${apiUrl}/api/account/subscription`, {
        headers:     authHeader(),
        credentials: 'include',
      })
      if (res.ok) {
        const data = await res.json()
        subscription.value = data.subscription ?? null
      } else {
        // Non-OK response (e.g. 401 after token expiry) — clear stale entitlements
        subscription.value = null
      }
    } catch {
      // Network error — clear stale entitlements rather than showing wrong access
      subscription.value = null
    }
  }

  /**
   * initialise() should be called once, in a plugin or app.vue onMounted.
   * It silently tries to restore the session from the refresh cookie.
   */
  async function initialise() {
    if (initialised.value) return
    initialised.value = true
    await refreshSession()
  }

  function markTotpEnabled() {
    if (user.value) user.value = { ...user.value, totpEnabled: true }
  }

  /**
   * Store a new access token + user returned by the server (e.g. after 2FA
   * confirmation, where the server issues a fresh session in the same response
   * rather than requiring a separate /refresh round-trip).
   */
  function applyNewSession(token: string, authUser: AuthUser) {
    setAccessToken(token, authUser)
  }

  return {
    // State
    user:         readonly(user),
    accessToken:  readonly(accessToken),
    subscription: readonly(subscription),
    initialised:  readonly(initialised),

    // Methods
    signIn,
    verify,
    verifyTotp,
    refreshSession,
    fetchSubscription,
    logout,
    authHeader,
    initialise,
    markTotpEnabled,
    applyNewSession,

    // Role / subscription helpers
    isLoggedIn:     computed(() => user.value !== null),
    isPremium:      computed(() => {
      if (!subscription.value) return false
      if (subscription.value.status !== 'active' && subscription.value.status !== 'trialing') return false
      if (!subscription.value.currentPeriodEnd) return true
      return new Date(subscription.value.currentPeriodEnd) > new Date()
    }),
    canEditContent: computed(() => ['editor', 'admin', 'super_admin'].includes(user.value?.role ?? '')),
    isAdmin:        computed(() => ['admin', 'super_admin'].includes(user.value?.role ?? '')),
  }
}
