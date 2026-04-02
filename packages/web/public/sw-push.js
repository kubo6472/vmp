/* global self */
/**
 * Push handlers imported by the generated Workbox service worker.
 * Required for Chrome/Android + installed PWAs where push payloads are only
 * surfaced if the SW handles the "push" event and shows a notification.
 */

function sanitizeTargetUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return '/'

  // Allow only root-relative paths with a single leading slash.
  if (rawUrl.startsWith('/') && rawUrl[1] !== '/') {
    return rawUrl
  }

  // Allow absolute URLs only when they are same-origin.
  try {
    const parsed = new URL(rawUrl)
    if (parsed.origin === self.location.origin) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`
    }
  } catch {
    // Invalid URL, fall through to '/'.
  }

  return '/'
}

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
  const targetUrl = sanitizeTargetUrl(data.url)

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
  const targetPath = sanitizeTargetUrl(event.notification?.data?.url)

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of clientList) {
      try {
        const currentUrl = new URL(client.url)
        if (currentUrl.pathname === new URL(targetPath, self.location.origin).pathname) {
          await client.focus()
          return
        }
      } catch {}
    }

    await self.clients.openWindow(targetPath)
  })())
})
