const CACHE_NAME = 'cetak-ktp-v68'; // UPDATE v68: FIX drag slider "Sesuaikan Foto" (v67) yg kerasa patah-patah/lag -- root cause: tiap event 'input' slider memproses gambar di RESOLUSI CETAK PENUH (1350x900px, getImageData/putImageData + alokasi array baru tiap frame), walau sudah di-throttle pakai requestAnimationFrame throttle itu cuma cegah numpuk, tiap kerjaan yg jalan tetap berat. Sekarang dipecah 2 jalur: (1) LIVE PREVIEW selama drag pakai buffer KECIL yg di-downsample sekali saat modal dibuka (420px, bukan 1350px) + LUT (lookup table) 256-entry utk brightness/kontras/bayangan/highlight sekaligus (loop pixel jadi 1 array-lookup, bukan rangkaian operasi matematika), plus buffer kerja Uint8ClampedArray yg DIPAKAI ULANG tiap frame (bukan realokasi) -- sharpen (satu2nya operasi yg butuh baca pixel tetangga, tidak bisa di-LUT) dipisah ke idle-debounce 120ms tersendiri biar drag brightness/dll tetap instan walau ketajaman >0; (2) HASIL AKHIR (Terapkan/cetak/PDF/print) tetap proses resolusi PENUH spy kualitas cetak tidak berkurang -- cuma dipanggil saat benar2 dibutuhkan, bukan tiap frame drag. Juga tambah touch-action:none & active-state di CSS slider utk drag lebih presisi/stabil terutama di HP. Hanya app.js & index.html yg berubah -- manifest.json, icon.svg tidak disentuh.
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
