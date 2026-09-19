const CACHE = 'plate-ledger-v1.1.0';
const SHELL = ['./', './index.html', './app.js', './manifest.json', './data/cnf.json', './data/usda.json', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
const FB = ['https://www.gstatic.com/firebasejs/12.3.0/firebase-app-compat.js', 'https://www.gstatic.com/firebasejs/12.3.0/firebase-auth-compat.js', 'https://www.gstatic.com/firebasejs/12.3.0/firebase-firestore-compat.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).then(() => Promise.allSettled(FB.map(u => fetch(u, { mode: 'cors' }).then(r => c.put(u, r)))))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin && !FB.includes(e.request.url)) return; // never touch the Anthropic API, Firebase traffic or fonts
  e.respondWith(caches.match(e.request).then(cached => {
    const fresh = fetch(e.request).then(res => { if (res.ok || res.type === 'opaque') caches.open(CACHE).then(c => c.put(e.request, res.clone())); return res; }).catch(() => cached);
    return cached || fresh;
  }));
});
