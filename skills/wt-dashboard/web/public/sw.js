// wt-dashboard service worker: installable PWA + an app shell that opens without the network, and Web Push (WP-268).
// It never touches /api/* (JSON, SSE streams, uploads, files — all live, all behind the session cookie): those
// requests are not intercepted at all. Navigations are network-first (a new build shows up on the next load),
// falling back to the cached shell and then to offline.html; hashed assets are stale-while-revalidate.
const CACHE = 'wtd-shell-v1'
const SHELL = ['./', './index.html', './offline.html', './manifest.webmanifest', './icon-192.png', './favicon.svg']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return // not ours: the network, untouched
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req)
        if (res.ok) (await caches.open(CACHE)).put('./index.html', res.clone()) // the shell only; it carries no data
        return res
      } catch {
        // No server = nothing to show: say so instead of a stale shell whose every call fails.
        return (await caches.match('./offline.html')) ?? Response.error()
      }
    })())
    return
  }
  if (url.pathname.startsWith('/assets/') || SHELL.some((p) => url.pathname === p.slice(1))) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE)
      const hit = await cache.match(req)
      const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res }).catch(() => null)
      return hit ?? (await net) ?? Response.error()
    })())
  }
})

// WP-268 Web Push: the server sends {title, body, tag, url} (push.mjs payloadOf); `tag` makes a repeat replace, not stack.
self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data.json() } catch { d = { body: e.data ? e.data.text() : '' } }
  e.waitUntil(self.registration.showNotification(d.title || 'wt-dashboard', {
    body: d.body || '', tag: d.tag || undefined, icon: './icon-192.png', badge: './icon-192.png', data: { url: d.url || '/#inbox' },
  }))
})
// A click focuses the open dashboard window and moves it to the item's hash route, else opens one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = new URL(e.notification.data?.url || '/#inbox', self.location.origin).href
  e.waitUntil((async () => {
    const w = (await clients.matchAll({ type: 'window', includeUncontrolled: true })).find((c) => new URL(c.url).origin === self.location.origin)
    if (w) { try { await w.focus(); await w.navigate(url); return } catch { /* not controllable: open a new one */ } }
    await clients.openWindow(url)
  })())
})
