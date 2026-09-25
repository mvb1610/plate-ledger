// Plate Ledger service worker.
// build_data.py stamps content hashes into the two cache names (and lists the font files) at deploy time: every deploy
// gets a fresh app cache, while the 2.6 MB food database keeps its own cache and is only downloaded again when it changes.
const SHELL_CACHE = 'pl-shell-__SHELL__';
const DATA_CACHE = 'pl-data-__DATA__';
const SHELL = ['./', './index.html', './app.js', './manifest.json', './fonts/fonts.css', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', /*__FONTS__*/];
const DATA = ['./data/cnf.json', './data/usda.json'];
const put = async (cache, url) => { const r = await fetch(url, { cache: 'reload' }); if (!r.ok) throw new Error(url + ' ' + r.status); await cache.put(url, r); };

self.addEventListener('install', e => e.waitUntil((async () => {
  const shell = await caches.open(SHELL_CACHE);
  await Promise.all(SHELL.map(u => put(shell, u)));
  const data = await caches.open(DATA_CACHE);
  await Promise.all(DATA.map(async u => { if (!(await data.match(u))) await put(data, u); }));
  await self.skipWaiting();
})()));

self.addEventListener('activate', e => e.waitUntil((async () => {
  const keys = await caches.keys();
  const legacy = keys.some(k => k.startsWith('plate-ledger-')); // caches from app versions ≤ 1.3
  await Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== DATA_CACHE).map(k => caches.delete(k)));
  await self.clients.claim();
  if (legacy) for (const c of await self.clients.matchAll({ type: 'window' })) if (typeof c.navigate === 'function') c.navigate(c.url).catch(() => {}); // one-time hop onto this version
})()));

// Cache-first for the app's own files; no background re-downloads (a new deploy brings a new service worker instead).
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return; // Firestore, Google sign-in, Anthropic, Open Food Facts go straight to the network
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') { const page = await caches.match('./index.html'); if (page) return page; }
    return fetch(req);
  })());
});
