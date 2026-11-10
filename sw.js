// Fundova service worker: keeps the app opening when the network is weak, and shows phone alerts.
// Alerts are short and generic on purpose. Amounts and details stay inside the app.
const CACHE = 'fundova-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));

// network first, fall back to the last copy we saw
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/.netlify/')) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => { }); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('/')))
  );
});

self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { }
  e.waitUntil(self.registration.showNotification(d.title || 'Fundova', {
    body: d.body || 'Fundova: you have a new notification.',
    tag: d.tag || 'fundova',
    icon: '/logo.png', badge: '/logo.png',
    data: { url: d.url || '/' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
