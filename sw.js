const CACHE_NAME = 'cetak-ktp-v36'; // FIX kritis: magnifier loupe (v35) posisinya salah total di layar -- kena 2 bug bertumpuk: (1) di app.js, perhitungan posisi CSS nambah scrollLeft/scrollTop DUA KALI di atas offset yg didapat dari getBoundingClientRect() (yg sebenarnya sudah otomatis merefleksikan posisi stlh scroll); (2) di index.html, CSS transform:translate(-50%,-100%) dipakai BARENGAN dgn offset manual LOUPE_OFFSET_Y di app.js, dua-duanya sama2 geser loupe ke atas -- hasilnya loupe kelontang jauh ke atas layar, kepotong keluar frame. Fix: loupe skrg ditempel ke <body> dgn position:fixed (bukan child #cropStage yg overflow:auto -- itu sumber masalah sistem koordinat yg gak nyambung), posisinya dihitung langsung dari getBoundingClientRect() canvas tanpa embel2 lain, dan SATU-SATUNYA mekanisme geser-ke-atas cuma CSS transform (offset manual di JS dihapus total).
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
