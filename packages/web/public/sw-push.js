/* global self */
/**
 * Push handlers imported by the generated Workbox service worker.
 * Required for Chrome/Android + installed PWAs where push payloads are only
 * surfaced if the SW handles the "push" event and shows a notification.
 */

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }

  const title = typeof data.title === 'string' && data.title.trim()
    ? data.title
    : 'New update'
  const body = typeof data.body === 'string' ? data.body : ''

  // Accept same-origin absolute URLs or relative paths
  let targetUrl = '/'
  if (typeof data.url === 'string') {
    if (data.url.startsWith('/')) {
      targetUrl = data.url
    } else {
      try {
        const url = new URL(data.url)
        if (url.origin === self.location.origin) {
          targetUrl = data.url
        }
      } catch {
        // Invalid URL, fallback to '/'
      }
    }
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/pwa-192.png',
      badge: '/icons/pwa-192.png',
      data: { url: targetUrl },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification?.data?.url || '/'

  event.waitUntil((async () => {
    // Parse target URL to handle both paths and absolute URLs
    let targetPath = '/'
    let targetFullUrl = targetUrl
    try {
      const parsed = new URL(targetUrl, self.location.origin)
      targetPath = parsed.pathname
      targetFullUrl = parsed.href
    } catch {
      targetPath = targetUrl
    }

    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of clientList) {
      try {
        const currentUrl = new URL(client.url)
        // Match if the pathname matches (handles both path and absolute URL targets)
        if (currentUrl.pathname === targetPath) {
          await client.focus()
          return
        }
      } catch {}
    }

    // Open with the full URL for absolute URLs, or path for relative
    await self.clients.openWindow(targetFullUrl)
  })())
})