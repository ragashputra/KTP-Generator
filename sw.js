const CACHE_NAME = 'cetak-ktp-v66'; // UPDATE v66: FIX judul "Cetak KTP" & subtitle "Generator Layout Cetak" di kiri header jadi kurang kontras/susah dibaca kalau duduk di atas tema header yg warna-warni/medium-brightness (mis. Aurora Mesh, Silk Mesh) -- subtitle sebelumnya pakai --ink-faint abu2 medium (#6e7681) yg gampang tenggelam. Sekarang: h1 & p diberi text-shadow gelap tipis (utk dark mode & tema header berwarna) dan override text-shadow terang khusus saat html[data-mode="light"] (biar tetap kebaca di header terang polos), plus token baru --header-sub-ink (dark: putih ~82% opacity, light: gelap ~72% opacity) yg lebih terang/tegas drpd --ink-faint biasa, khusus dipakai subtitle di header. Sama pendekatannya dgn fix badge "Capella Honda" di v65. Hanya index.html yg berubah -- app.js, manifest.json, icon.svg tidak disentuh.
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
