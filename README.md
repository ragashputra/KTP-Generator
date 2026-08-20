# Cetak KTP — Statistik Penggunaan (Cloudflare Worker)

Pengganti Google Apps Script yang lebih stabil, tanpa cold-start, dan CORS
diatur eksplisit di kode sendiri. **Tidak perlu ubah app.js** — cukup ganti
`STATS_API_BASE` di akhir setup.

## Prasyarat

- Akun Cloudflare (gratis): https://dash.cloudflare.com/sign-up
- Node.js terinstall (buat jalanin `wrangler`, CLI resmi Cloudflare)

## Langkah setup (±5 menit)

### 1. Install Wrangler & login

```bash
npm install -g wrangler
wrangler login
```

Ini akan buka browser buat login/authorize akun Cloudflare kamu.

### 2. Buat KV namespace (tempat nyimpen angka counter)

Dari dalam folder `cetak-ktp-stats-worker/`:

```bash
wrangler kv namespace create STATS_KV
```

Outputnya kira-kira begini:

```
🌀 Creating namespace with title "cetak-ktp-stats-STATS_KV"
✨ Success!
Add the following to your configuration file:
[[kv_namespaces]]
binding = "STATS_KV"
id = "a1b2c3d4e5f6..."
```

### 3. Isi `wrangler.toml`

Buka `wrangler.toml`, ganti `REPLACE_WITH_KV_ID` dengan `id` yang barusan
muncul di step 2.

### 4. Deploy

```bash
wrangler deploy
```

Kalau berhasil, akan muncul URL kira-kira:

```
https://cetak-ktp-stats.<username-kamu>.workers.dev
```

**Simpan URL ini** — itu yang bakal jadi `STATS_API_BASE` baru.

### 5. Test langsung di browser

Buka di tab baru (ganti sesuai URL kamu):

```
https://cetak-ktp-stats.<username>.workers.dev?action=getAll
```

Harus muncul JSON:

```json
{"printDirect":0,"downloadPdf":0,"lastUsedAt":null}
```

Kalau muncul itu → worker sudah jalan dengan benar.

### 6. Update `app.js`

Di `app.js`, cari baris:

```js
const STATS_API_BASE = 'https://script.google.com/macros/s/...';
```

Ganti jadi:

```js
const STATS_API_BASE = 'https://cetak-ktp-stats.<username>.workers.dev';
```

Push ke GitHub Pages seperti biasa. Selesai — gak ada perubahan lain yang
dibutuhkan di app.js, karena format response worker ini sengaja dibikin
identik dengan yang Apps Script kirim sebelumnya.

## Update kode nanti

Kalau mau ubah logic di `src/worker.js` (misal nambah jenis counter baru),
tinggal edit filenya lalu `wrangler deploy` lagi — TIDAK ada isu
"versioning" atau "harus New version" kayak Apps Script. Setiap `deploy`
langsung live di URL yang sama.

## Kenapa lebih stabil dari Apps Script?

- Tidak ada cold-start lambat (Workers jalan di edge, selalu "warm")
- CORS header diatur eksplisit di kode (`Access-Control-Allow-Origin`),
  bukan bergantung ke behavior default Apps Script yang kadang berubah
- Tidak ada isu "deployment lama vs baru" — sekali `deploy`, langsung aktif
- Free tier: 100,000 request/hari — jauh lebih dari cukup buat counter ini
