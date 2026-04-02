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
  const targetUrl = typeof data.url === 'string' && data.url.startsWith('/')
    ? data.url
    : '/'

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
  const targetPath = event.notification?.data?.url || '/'

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of clientList) {
      try {
        const currentUrl = new URL(client.url)
        if (currentUrl.pathname === targetPath) {
          await client.focus()
          return
        }
      } catch {}
    }

    await self.clients.openWindow(targetPath)
  })())
})
