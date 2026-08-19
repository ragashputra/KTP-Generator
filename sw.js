const CACHE_NAME = 'cetak-ktp-v27'; // fitur baru: tombol "Cetak Langsung" di modal Preview Cetak — pakai window.print() browser native, jadi begitu diklik langsung muncul dialog pilih printer sesuai yang terpasang/terbaca di PC/laptop user, tanpa perlu download PDF & buka file terpisah dulu. Ukuran & orientasi kertas fisik diinject dinamis via CSS @page (mm persis) sesuai kertas yang dipilih user. Render halaman pakai fungsi drawPageOfCards yang sama dgn export PDF, jadi hasilnya identik. Download PDF tetap ada sebagai opsi kedua.
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
