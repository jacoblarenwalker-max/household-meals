// Service worker: Web Push notifications + always-fresh app files. It never stores anything (no Cache Storage):
// the page, scripts and styles are fetched network-first, revalidating past the browser's HTTP cache, so an
// installed Home Screen app picks up a new version on its next open. Bump SW_VERSION with each app release.
const SW_VERSION = 'combo2';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase / jsDelivr untouched
  const fresh = req.mode === 'navigate' || /\.(js|css|html|webmanifest)$/.test(url.pathname) || url.pathname.endsWith('/');
  if (!fresh) return;
  event.respondWith(fetch(req, { cache: 'no-cache' }).catch(() => fetch(req)));
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data ? event.data.text() : '' }; }
  const title = d.title || 'Household Meals';
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: 'icon-192.png?v=js1',
    badge: 'icon-192.png?v=js1',
    data: { url: d.url || './#/week' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './#/week', self.registration.scope);
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((c) => c.url.startsWith(self.registration.scope));
    if (win) {
      // the open app switches to the right week itself; no reload needed
      win.postMessage({ type: 'open', url: target.href });
      return win.focus();
    }
    return self.clients.openWindow(target.href);
  })());
});
