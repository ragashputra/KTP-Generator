const CACHE_NAME = 'cetak-ktp-v28'; // fitur baru: Statistik Penggunaan — tombol ikon bar-chart di header buka modal yang nampilin total "Cetak Langsung" vs "Download PDF" dari SEMUA user (shared, bukan per-device), pakai CountAPI (countapi.mileshilliard.com, gratis tanpa signup) sebagai storage counter. Tracking dipanggil fire-and-forget di downloadPDF() & printDirect(), gak pernah block/gagalin proses cetak utama kalau internet/layanan lagi down.
const ASSETS = ['./index.html', './app.js', './manifest.json', './icon.svg'];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e=>{
  if(e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached=>{
      return cached || fetch(e.request).then(resp=>{
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(cache=>cache.put(e.request, clone));
        return resp;
      }).catch(()=>cached);
    })
  );
});
