// Gör att appen startar snabbt och öppnas även utan uppkoppling (skalet, inte datan).
// Uppgifter hämtas alltid färska från databasen och sparas aldrig här.
const CACHE = 'stallappen-v1';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'xlsx.js', 'config.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return; // databas, väder och typsnitt går direkt
  // nätverk först så att uppdateringar syns direkt, cache som reserv
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then(r => r || caches.match('index.html'))));
});
