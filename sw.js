const CACHE_NAME = 'cetak-ktp-v37'; // FIX performa besar: app makin lambat seiring makin banyak KTP diupload (termasuk saat rotate), krn grid card selama ini nampilin thumbnail LANGSUNG dari croppedDataURL -- itu gambar resolusi cetak PENUH (1350x900px, JPEG kualitas 0.95, ratusan KB per kartu) walau di layar cuma dirender kecil (~160px). Tiap kali renderGrid() dipanggil ulang (termasuk stlh rotate 1 kartu doang), browser decode ULANG semua thumbnail resolusi tinggi itu utk SEMUA kartu di grid -- makin banyak kartu, makin berat linear. Fix: kartu skrg py thumbDataURL terpisah (~280px lebar, kualitas JPEG lbh rendah, cuma beberapa KB) khusus dipakai grid; croppedDataURL resolusi penuh TETAP dipakai apa adanya utk zoom modal, enhance, dan proses cetak/PDF -- kualitas hasil akhir tidak berkurang sedikit pun, cuma tampilan grid yg jauh lebih ringan didecode & dirender.
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
