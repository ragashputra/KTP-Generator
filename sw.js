const CACHE_NAME = 'cetak-ktp-v46'; // UPDATE v46: modal Statistik Penggunaan sekarang auto-polling tiap 6 detik selagi kebuka (stop otomatis saat ditutup), pakai animasi count-up halus + indikator badge "Live", dan graceful kalau fetch pas polling gagal (angka terakhir gak ketiban strip error, cuma refresh manual yg nampilin error). Perubahan di app.js & index.html (markup badge Live). Cache di-bump supaya versi baru langsung ke-fetch & dipakai user existing, bukan nyangkut di file lama yang sudah ter-cache (lihat strategi cache-first di fetch handler bawah).
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
