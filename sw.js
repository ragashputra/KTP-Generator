const CACHE_NAME = 'cetak-ktp-v42'; // FIX AKURASI lanjutan: laporan baru -- sisi ATAS kotak hijau kadang "kelewatan" jauh ke atas kartu, nangkep garis serat meja/pantulan sleeve plastik yg kuat & panjang scr kontras, bukan tepi kartu asli. Ini LOLOS dari semua pengecekan v41 krn 2 alasan: (1) garis background itu memang garis nyata & panjang, jadi line-support-nya (v41) tinggi -- bukan noise pendek yg mestinya disaring; (2) cardColorScore lama itu RATA-RATA seluruh isi quad, dan krn sebagian besar isi quad tetap kartu asli (cuma sisi atasnya yg salah), rata2 keseluruhan tetap lolos ambang. Root cause: tidak ada sinyal yg mengecek warna KHUSUS tepat di tepi DALAM tiap sisi (bukan rata2 keseluruhan). FIX v42: (1) nearEdgeColorScore -- fungsi baru yg cek strip sempit tepat di dalam tiap 1 dari 4 sisi quad, ambil skor SISI TERLEMAH; dipakai sbg diskualifikasi kandidat di pickCardQuadFromLines (bobot besar di scoring + hard-reject kalau <0.15) dan sbg kondisi tambahan di cross-check akhir autoDetectCrop. (2) bboxFallback (safety-net terakhir) diperkuat sama: sekarang terima rgbData & geser tiap batas proyeksi-energi ke dalam (maks 35%) sampai ketemu baris/kolom yg warnanya cocok KTP -- supaya safety-net-nya sendiri tidak kena masalah yg sama kalau Hough gagal & jatuh ke sini. Semua fungsi warna direfactor lewat helper bersama (isCardLikePixel, bilinearQuadPoint) spy konsisten & gak duplikat logika. Dicek ulang node --check end-to-end, tidak ada regresi ke pola bug v39/v40.
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
