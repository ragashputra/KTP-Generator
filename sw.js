const CACHE_NAME = 'cetak-ktp-v33'; // Rombak pipeline auto-detect crop KTP di app.js: threshold Otsu asli (ganti persentase magic-number), blur adaptif sesuai resolusi, Hough multi-pass (ketat->longgar), pemilihan kandidat sisi terbaik (bukan cuma garis ekstrem), validasi rasio kartu ID-1 (~1.586:1) utk menolak quad yg salah tangkap tepi meja/dompet, refine sudut ke tepi tajam terdekat, + badge "Mendeteksi tepi KTP..." di index.html/app.js saat proses berjalan.
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
