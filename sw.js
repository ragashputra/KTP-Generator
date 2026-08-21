const CACHE_NAME = 'cetak-ktp-v48'; // UPDATE v48: rombak total strategi caching Service Worker utk nutup masalah "harus hard-reload (Ctrl+Shift+R) biar data/versi terbaru kepakai". Sebelumnya SEMUA request GET (termasuk HTML/app.js DAN request ke API Statistik Penggunaan) pakai cache-first murni, jadi begitu sempat ke-cache sekali, permintaan berikutnya bisa kebaca dari cache lama terus. Sekarang: (1) request ke STATS_API_BASE / domain API SELALU network-only, gak pernah disentuh cache sama sekali -- data statistik jadi realtime murni dari jaringan (app.js jg dipasangi cache:'no-store'+param _t sbg lapis pertahanan kedua); (2) navigasi halaman & app.js/asset lain pakai stale-while-revalidate -- tetap tampil cepat dari cache dulu (app tetap kerasa instant & bisa dibuka offline), TAPI selalu langsung fetch ulang & timpa cache di background; (3) begitu SW versi baru selesai activate, otomatis postMessage 'SW_UPDATED' ke semua tab yg lagi kebuka, lalu app.js nawarin toast "Muat ulang sekarang" ke user (gak auto-reload paksa, biar gak motong proses yg lagi jalan) -- jadi user gak perlu ngeh sendiri & hard-reload manual lagi. Ditambah app.js registrasi SW skrg pakai updateViaCache:'none' (file sw.js sendiri gak boleh kebaca dari HTTP cache) + reg.update() otomatis tiap tab balik fokus & tiap 10 menit, supaya versi baru cepat kedeteksi. Lihat listener 'message'+'controllerchange' & fungsi showSwUpdateToast() di app.js utk sisi client-nya.
const ASSETS = ['./index.html', './app.js', './manifest.json', './icon.svg'];

// Domain/host yang TIDAK PERNAH boleh disentuh cache sama sekali --
// data dari sini (statistik penggunaan, dsb) harus realtime murni dari
// jaringan tiap kali diminta, gak boleh ada state basi yg "nyangkut".
// Dicocokkan via includes() pada hostname, jadi cukup taruh potongan
// domainnya saja (subdomain apapun di depannya tetap kena aturan ini).
const NETWORK_ONLY_HOSTS = [
  'ragashputra-ktp.workers.dev', // Cloudflare Worker Statistik Penggunaan (STATS_API_BASE di app.js)
];

function isNetworkOnly(url){
  try{
    const h = new URL(url).hostname;
    return NETWORK_ONLY_HOSTS.some(host=>h.includes(host));
  }catch(e){ return false; }
}

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
      .then(()=>{
        // Beri tahu semua tab yg lagi kebuka bahwa versi baru sudah aktif,
        // supaya app.js bisa nawarin "Muat ulang utk versi terbaru" ke user
        // alih-alih user harus ngeh sendiri & hard-reload manual.
        return self.clients.matchAll({ type:'window' }).then(clients=>{
          clients.forEach(client=> client.postMessage({ type:'SW_UPDATED', cacheName: CACHE_NAME }));
        });
      })
  );
});

self.addEventListener('fetch', e=>{
  const req = e.request;
  if(req.method !== 'GET') return;

  // ---- 1) NETWORK-ONLY utk API statistik (& host sejenis) ----
  // Gak pernah baca/tulis cache. Kalau offline/gagal, biarkan reject apa
  // adanya -- fetchUsageStats() di app.js sudah handle try/catch-nya &
  // menampilkan state gagal yg jelas, bukan diam-diam kasih data basi.
  if(isNetworkOnly(req.url)){
    e.respondWith(fetch(req));
    return;
  }

  // ---- 2) STALE-WHILE-REVALIDATE utk asset app sendiri (HTML/JS/dst) ----
  // Selalu balas cepat dari cache dulu kalau ada (biar app tetap kerasa
  // instant & tetap bisa dibuka offline), TAPI di belakang layar SELALU
  // langsung fetch versi terbaru dari jaringan & timpa cache -- beda dgn
  // strategi lama yg cuma fetch kalau cache MISS. Jadi begitu ada
  // deploy baru, permintaan BERIKUTNYA (bukan yg sekarang) langsung dapat
  // versi baru tanpa perlu nunggu cache expire atau hard-reload.
  e.respondWith(
    caches.open(CACHE_NAME).then(async cache=>{
      const cached = await cache.match(req);
      const networkFetch = fetch(req).then(resp=>{
        if(resp && resp.ok) cache.put(req, resp.clone());
        return resp;
      }).catch(()=>null);

      if(cached) return cached; // balas instant dari cache, revalidate tetap jalan di background
      const fresh = await networkFetch;
      return fresh || new Response('Offline & belum ada cache utk halaman ini.', { status: 503 });
    })
  );
});
