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
const _initialised = ref(false)

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
    if (!res.ok) throw new Error('Failed to fetch VAPID public key')
    const data = await res.json()
    return data.publicKey as string
  }

  function _urlB64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
    const rawData = atob(base64)
    return Uint8Array.from(rawData, c => c.charCodeAt(0))
  }

  async function _getCurrentSubscription(): Promise<PushSubscription | null> {
    if (!isSupported.value) return null
    const reg = await navigator.serviceWorker.ready
    return reg.pushManager.getSubscription()
  }

  /**
   * Reconcile the local PushManager state with the server for the current user.
   * Called on first mount and whenever the signed-in user changes.
   */
  async function _reconcile() {
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

    // Not logged in, or server re-association failed — reflect browser state only
    isSubscribed.value = sub !== null
  }

  /** Request push permission and register with the backend */
  async function subscribe(): Promise<void> {
    if (!isSupported.value) return
    if (!isLoggedIn.value) {
      navigateTo('/login')
      return
    }

    // Request notification permission
    const perm = await Notification.requestPermission()
    permission.value = perm
    if (perm !== 'granted') return

    let vapidPublicKey: string
    try {
      vapidPublicKey = await _getVapidPublicKey()
    } catch (e) {
      console.error('Could not fetch VAPID key:', e)
      return
    }

    const reg = await navigator.serviceWorker.ready

    // Reuse any existing subscription rather than creating a duplicate
    const existingSubscription = await reg.pushManager.getSubscription()
    const pushSubscription = existingSubscription ?? await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: _urlB64ToUint8Array(vapidPublicKey),
    })

    const subJson = pushSubscription.toJSON()
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
      console.error('Failed to save push subscription:', await res.text())
      // Roll back the browser subscription if we created it (don't roll back a pre-existing one)
      if (!existingSubscription) {
        await pushSubscription.unsubscribe().catch(() => {})
      }
      await _reconcile()
      return
    }

    isSubscribed.value = true
  }

  /** Unsubscribe from push notifications */
  async function unsubscribe(): Promise<void> {
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
      }).catch(e => console.error('Failed to delete push subscription on server:', e))
    }

    isSubscribed.value = false
  }

  // Initialise once per tab (client-side only)
  if (import.meta.client && !_initialised.value) {
    _initialised.value = true
    _reconcile()
  }

  // Re-reconcile whenever the signed-in user changes (login / logout / account switch)
  if (import.meta.client) {
    watch(() => user.value?.id, (_newId, oldId) => {
      if (oldId !== undefined) {
        // User changed — reset first so the bell doesn't flicker with stale state
        isSubscribed.value = false
        _reconcile()
      }
    })
  }

  return {
    isSupported,
    permission: readonly(permission),
    isSubscribed: readonly(isSubscribed),
    subscribe,
    unsubscribe,
  }
}
