"use strict";
const sw = globalThis;
sw.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    }
    catch {
        data = {};
    }
    const title = typeof data.title === 'string' && data.title.trim()
        ? data.title
        : 'New update';
    const body = typeof data.body === 'string' ? data.body : '';
    let targetUrl = '/';
    if (typeof data.url === 'string') {
        if (data.url.startsWith('/')) {
            targetUrl = data.url;
        }
        else {
            try {
                const url = new URL(data.url);
                if (url.origin === sw.location.origin) {
                    targetUrl = data.url;
                }
            }
            catch {
            }
        }
    }
    event.waitUntil(sw.registration.showNotification(title, {
        body,
        icon: '/icons/pwa-192.png',
        badge: '/icons/pwa-192.png',
        data: { url: targetUrl },
    }));
});
sw.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = event.notification?.data?.url || '/';
    event.waitUntil((async () => {
        let targetPath;
        let targetFullUrl = targetUrl;
        try {
            const parsed = new URL(targetUrl, sw.location.origin);
            targetPath = parsed.pathname;
            targetFullUrl = parsed.href;
        }
        catch {
            targetPath = targetUrl;
        }
        const clientList = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clientList) {
            try {
                const currentUrl = new URL(client.url);
                if (currentUrl.pathname === targetPath) {
                    await client.focus();
                    return;
                }
            }
            catch {
            }
        }
        await sw.clients.openWindow(targetFullUrl);
    })());
});
