/* PULSE service worker: web push + offline cache of the latest brief and the mobile shell. */
const CACHE = 'pulse-v2';
const SHELL = ['/m', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // latest brief + mobile shell: network first, fall back to the cached copy when offline
  if (url.pathname === '/api/briefs/latest' || url.pathname === '/m' || url.pathname.startsWith('/_next/static/')) {
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || new Response('{"offline":true}', { headers: { 'Content-Type': 'application/json' } }))));
  }
});

self.addEventListener('push', (e) => {
  let d = { title: 'PULSE', body: '', url: '/m', tag: undefined };
  try { d = { ...d, ...e.data.json() }; } catch { if (e.data) d.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body, tag: d.tag, icon: '/icon.svg', badge: '/icon.svg', data: { url: d.url } }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/m';
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => {
    for (const c of cs) if ('focus' in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
