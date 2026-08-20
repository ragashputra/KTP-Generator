const CACHE_NAME = 'cetak-ktp-v44'; // UPDATE v44: overhaul tipografi seluruh UI — ganti Inter/JetBrains Mono jadi Plus Jakarta Sans (body/UI) + Lexend (heading/brand/angka statistik) + Roboto Mono (angka & kode teknis), lebih premium & humanis. Ditambah type scale proporsional (--fs-2xs s/d --fs-2xl) dipakai konsisten ke semua komponen (header, tombol, card, modal, crop editor, stats, toast) menggantikan ukuran px hardcode yang sebelumnya acak. Tidak ada perubahan logika/fungsi, murni visual & keterbacaan. Cache di-bump krn index.html berubah (link Google Fonts baru + CSS token).
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
