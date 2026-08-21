const CACHE_NAME = 'cetak-ktp-v47'; // UPDATE v47: fitur "HD-kan" dirombak jadi SMART & ADAPTIF — sebelum memproses, foto dianalisis dulu (level blur via Laplacian variance, noise, kecerahan) lalu kekuatan sharpen/radius/noise-reduction/upscale menyesuaikan otomatis per foto (bukan angka filter tetap kayak v46 dulu, yg gampang oversharpen/halo di foto sudah tajam & kurang mempan di foto sangat buram). Enhance sekarang NON-DESTRUKTIF: original hasil crop disimpan terpisah, enhance selalu diproses ULANG dari original (bukan numpuk di atas hasil enhance sebelumnya spt bug lama), dan ada tombol "Batalkan HD" utk kembali ke foto semula kapan saja. Ditambah opsi "AI Enhance" (cloud, opsional lewat AI_ENHANCE_API_BASE di app.js) yg mengirim foto ke model AI super-resolution eksternal utk hasil maksimal di foto sangat buram/pecah — tombolnya cuma muncul kalau endpoint sudah dikonfigurasi, dan otomatis fallback ke enhance lokal kalau gagal/timeout/offline supaya user tetap dapat hasil, bukan error mentah. Perubahan di app.js (fungsi enhance dirombak total) & index.html (style tombol AI Enhance + progress indicator). Cache di-bump supaya versi baru langsung ke-fetch & dipakai user existing, bukan nyangkut di file lama yang sudah ter-cache (lihat strategi cache-first di fetch handler bawah).
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
