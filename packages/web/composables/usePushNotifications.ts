/**
 * packages/web/composables/usePushNotifications.ts
 *
 * Manages Web Push subscription lifecycle for the current browser device.
 * Requires the backend to have VAPID keys configured and the push_subscriptions
 * D1 table created (migration 0012).
 *
 * Usage:
 *   const { isSupported, permission, isSubscribed, subscribe, unsubscribe } = usePushNotifications()
 */

import { useAuth } from '~/composables/useAuth'

// Module-level singleton state so all components share the same subscription status
const isSubscribed = ref(false)
const permission = ref<NotificationPermission>('default')
const pushError = ref<string | null>(null)
const _initialised = ref(false)
let _watcherRegistered = false

export function usePushNotifications() {
  const { authHeader, isLoggedIn, user } = useAuth()
  const config = useRuntimeConfig()
  const apiUrl = config.public.apiUrl

  const isSupported = computed(() =>
    import.meta.client &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window,
  )

  async function _getVapidPublicKey(): Promise<string> {
    const res = await fetch(`${apiUrl}/api/push/vapid-public-key`)
    if (!res.ok) {
      throw new Error(await _extractApiErrorMessage(res))
    }
    const data = await res.json()
    return data.publicKey as string
  }

  async function _extractApiErrorMessage(res: Response): Promise<string> {
    const parsed = await res.clone().json().catch(() => null) as { error?: string, message?: string } | null
    if (parsed?.error || parsed?.message) return parsed.error || parsed.message || 'Server error'
    return await res.text().catch(() => 'Server error')
  }

  function _urlB64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
    const rawData = atob(base64)
    return Uint8Array.from(rawData, c => c.charCodeAt(0))
  }

  async function _getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
    const existing = await navigator.serviceWorker.getRegistration()
    if (existing) return existing
    await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    return navigator.serviceWorker.ready
  }

  async function _getCurrentSubscription(): Promise<PushSubscription | null> {
    if (!isSupported.value) return null
    const reg = await _getServiceWorkerRegistration()
    return reg.pushManager.getSubscription()
  }

  /**
   * Reconcile the local PushManager state with the server for the current user.
   * Called on first mount and whenever the signed-in user changes.
   */
  async function _reconcile() {
    try {
      if (!isSupported.value) return
      permission.value = Notification.permission

      const sub = await _getCurrentSubscription()
      if (!sub) {
        isSubscribed.value = false
        return
      }

      // If the user is logged in, re-POST the existing subscription so the server
      // associates it with the correct account (handles same-device login switch).
      if (isLoggedIn.value) {
        const subJson = sub.toJSON()
        const res = await fetch(`${apiUrl}/api/push/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({
            endpoint: subJson.endpoint,
            keys: { p256dh: subJson.keys?.p256dh, auth: subJson.keys?.auth },
          }),
        }).catch(() => null)

        if (res && res.ok) {
          isSubscribed.value = true
          return
        }
      }

      // Not logged in, or server re-association failed — browser has a subscription
      isSubscribed.value = true
    } catch (err) {
      console.warn('Push reconciliation failed:', err)
      // Leave isSubscribed unchanged on error
    }
  }

  /** Request push permission and register with the backend */
  async function subscribe(): Promise<void> {
    pushError.value = null
    if (!isSupported.value) return
    if (!isLoggedIn.value) {
      navigateTo('/login')
      return
    }

    // Request notification permission
    const perm = await Notification.requestPermission()
    permission.value = perm
    if (perm !== 'granted') {
      pushError.value = 'Browser notifications were blocked. Enable notifications in your browser settings and try again.'
      return
    }

    let vapidPublicKey: string
    try {
      vapidPublicKey = await _getVapidPublicKey()
    } catch (e) {
      console.error('Could not fetch VAPID key:', e)
      pushError.value = 'Push service is not configured right now. Please try again later.'
      return
    }

    const reg = await _getServiceWorkerRegistration()

    // Reuse any existing subscription rather than creating a duplicate
    const existingSubscription = await reg.pushManager.getSubscription()
    // Holder so TypeScript tracks mutations across the nested `doSubscribe` closure.
    const browserSub = { current: existingSubscription as PushSubscription | null }

    async function doSubscribe(): Promise<void> {
      if (!browserSub.current) {
        const applicationServerKey = _urlB64ToUint8Array(vapidPublicKey)
        browserSub.current = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
        })
      }

      const subJson = browserSub.current.toJSON()
      const res = await fetch(`${apiUrl}/api/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          keys: {
            p256dh: subJson.keys?.p256dh,
            auth: subJson.keys?.auth,
          },
        }),
      })

      if (!res.ok) {
        throw new Error(await _extractApiErrorMessage(res))
      }
    }

    try {
      await doSubscribe()
    } catch (firstError) {
      // If the existing subscription was stale (wrong VAPID key, expired endpoint,
      // or missing keys from a pre-VAPID session) unsubscribe it and retry once
      // with a fresh subscription.
      if (existingSubscription) {
        console.warn('Existing push subscription rejected by server, retrying with fresh one:', firstError)
        await existingSubscription.unsubscribe().catch(() => {})
        browserSub.current = null
        try {
          await doSubscribe()
        } catch (retryError) {
          console.error('Failed to save push subscription after retry:', retryError)
          pushError.value = retryError instanceof Error
            ? `Failed to enable notifications: ${retryError.message}`
            : 'Failed to enable notifications. Please try again.'
          // Roll back the fresh subscription created during the retry
          const rollback = browserSub.current as PushSubscription | null
          if (rollback) await rollback.unsubscribe().catch(() => {})
          await _reconcile()
          return
        }
      } else {
        console.error('Failed to save push subscription:', firstError)
        pushError.value = firstError instanceof Error
          ? `Failed to enable notifications: ${firstError.message}`
          : 'Failed to enable notifications. Please try again.'
        // Roll back the newly created browser subscription
        const rollback = browserSub.current as PushSubscription | null
        if (rollback) await rollback.unsubscribe().catch(() => {})
        await _reconcile()
        return
      }
    }

    isSubscribed.value = true
    pushError.value = null
  }

  /** Unsubscribe from push notifications */
  async function unsubscribe(): Promise<void> {
    pushError.value = null
    const pushSub = await _getCurrentSubscription()
    if (!pushSub) {
      isSubscribed.value = false
      return
    }

    const endpoint = pushSub.endpoint
    await pushSub.unsubscribe()

    if (isLoggedIn.value) {
      await fetch(`${apiUrl}/api/push/subscribe`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ endpoint }),
      }).then(async (res) => {
        if (!res.ok) {
          const message = await _extractApiErrorMessage(res)
          throw new Error(message || `HTTP ${res.status}`)
        }
      }).catch((e) => {
        console.error('Failed to delete push subscription on server:', e)
        pushError.value = 'Notifications were disabled in this browser, but we could not sync this change to the server.'
      })
    }

    isSubscribed.value = false
  }

  // Initialise once per tab (client-side only)
  if (import.meta.client && !_initialised.value) {
    _initialised.value = true
    _reconcile()
  }

  // Re-reconcile whenever the signed-in user changes (login / logout / account switch).
  // Guard with _watcherRegistered so only one watcher is created across all composable calls.
  if (import.meta.client && !_watcherRegistered) {
    _watcherRegistered = true
    watch(() => user.value?.id, (newId, oldId) => {
      if (newId !== oldId) {
        // User changed (including first login) — reset then reconcile
        isSubscribed.value = false
        pushError.value = null
        void _reconcile()
      }
    })
  }

  /** Clear any persistent push error */
  function clearError(): void {
    pushError.value = null
  }

  return {
    isSupported,
    permission: readonly(permission),
    isSubscribed: readonly(isSubscribed),
    pushError: readonly(pushError),
    subscribe,
    unsubscribe,
    clearError,
  }
}