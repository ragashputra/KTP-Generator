const CACHE_NAME = 'cetak-ktp-v26'; // fitur baru: tombol "Duplikat" di tiap KTP yang sudah di-crop — bikin salinan persis di sebelah aslinya di daftar (dan otomatis ikut tercetak berdekatan di lembar F4), supaya user yang cuma punya 1 KTP tapi mau isi penuh 1 lembar (misal 4 slot di layout 2x2) tinggal duplikat berkali-kali tanpa upload ulang
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
