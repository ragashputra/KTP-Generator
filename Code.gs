/**
 * Cetak KTP Generator — Backend Statistik Penggunaan
 * ===================================================
 * Web App sederhana pakai Google Apps Script + Google Sheets sebagai
 * database counter. Sengaja HANYA pakai doGet (bukan doPost) karena GET
 * tidak memicu PREFLIGHT request (OPTIONS) seperti POST — tapi ini cuma
 * separuh cerita: response-nya TETAP wajib membawa header
 * Access-Control-Allow-Origin, kalau tidak browser akan tetap memblokir
 * fetch() membaca hasilnya (lihat jsonResponse() di bawah — sudah
 * ditangani di versi ini).
 *
 * CARA DEPLOY (lakukan sekali saja):
 * 1. Buka https://script.google.com/ → New Project
 * 2. Hapus semua isi editor, paste seluruh isi file ini
 * 3. Klik ikon Save (atau Ctrl+S), kasih nama project bebas (mis. "KTP Stats")
 * 4. Klik "Deploy" (kanan atas) → "New deployment"
 * 5. Klik ikon gear di "Select type" → pilih "Web app"
 * 6. Isi:
 *    - Description: bebas, mis. "KTP Generator stats v1"
 *    - Execute as: "Me"
 *    - Who has access: "Anyone"  <-- WAJIB "Anyone", bukan "Anyone with Google account"
 * 7. Klik "Deploy"
 * 8. Google akan minta izin akses — klik "Authorize access", pilih akun
 *    Google kamu, klik "Advanced" → "Go to [nama project] (unsafe)" kalau
 *    muncul warning (ini normal utk script buatan sendiri, bukan tanda bahaya)
 * 9. Copy URL yang muncul, bentuknya seperti:
 *    https://script.google.com/macros/s/AKfycb.../exec
 * 10. Tempel URL itu ke STATS_API_BASE di app.js (gantikan URL CountAPI lama)
 *
 * PENTING kalau nanti edit script ini lagi:
 * Untuk update kode TANPA mengubah URL /exec yang sudah aktif (supaya
 * app.js gak perlu diedit lagi), JANGAN klik "New deployment" — itu
 * bikin URL BARU yang berbeda. Caranya yang benar:
 * 1. Deploy → Manage deployments
 * 2. Pilih deployment yang aktif → klik ikon pensil (Edit)
 * 3. Di bagian "Version", pilih "New version"
 * 4. Klik Deploy
 * URL /exec tetap sama persis, hanya kode di baliknya yang ke-update.
 *
 * ⚠️ CATATAN FIX (kalau sebelumnya panel Statistik selalu gagal muat):
 * Versi Code.gs ini menambahkan header "Access-Control-Allow-Origin: *"
 * di jsonResponse() — tanpa header itu, browser MEMBLOKIR fetch() dari
 * app.js membaca hasil response (walau request-nya sendiri sukses jalan
 * & data tetap ke-update di Sheet, cuma browsernya yang nolak baca
 * hasilnya). Update script ini pakai langkah "New version" di atas
 * (BUKAN "New deployment") supaya URL /exec yang sudah dipakai di
 * app.js tetap sama & langsung kepakai kode barunya.
 *
 * Data tersimpan di Google Sheet yang otomatis dibuat script ini sendiri
 * (sheet "Stats") di dalam file/project yang sama — kamu bisa buka lewat
 * menu "Resources" atau lihat linknya di log eksekusi, isinya cuma 2 baris
 * angka (printDirect, downloadPdf) + 1 baris timestamp terakhir dipakai.
 */

// Nama sheet tempat counter disimpan. Dibuat otomatis kalau belum ada.
const SHEET_NAME = 'Stats';

// Kunci-kunci yang valid untuk di-hit — dijaga whitelist supaya endpoint
// ini tidak bisa dipakai nulis sembarang key oleh siapa pun yang tau
// URL-nya (beda dari CountAPI yang key-nya bebas apa saja).
const VALID_KEYS = ['printDirect', 'downloadPdf'];

function doGet(e) {
  const action = e.parameter.action;
  const key = e.parameter.key;

  try {
    if (action === 'hit') {
      return handleHit(key);
    } else if (action === 'get') {
      return handleGet(key);
    } else if (action === 'getAll') {
      return handleGetAll();
    } else {
      return jsonResponse({ error: 'Unknown action. Use action=hit, action=get, or action=getAll.' });
    }
  } catch (err) {
    return jsonResponse({ error: String(err) });
  }
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['key', 'value']);
    sheet.appendRow(['printDirect', 0]);
    sheet.appendRow(['downloadPdf', 0]);
    sheet.appendRow(['lastUsedAt', '']);
  }
  return sheet;
}

// Mencari baris untuk sebuah key. Mengembalikan nomor baris (1-indexed,
// termasuk header), atau -1 kalau tidak ketemu.
function findRow(sheet, key) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) return i + 1;
  }
  return -1;
}

function handleHit(key) {
  if (VALID_KEYS.indexOf(key) === -1) {
    return jsonResponse({ error: 'Invalid key. Must be one of: ' + VALID_KEYS.join(', ') });
  }

  // Lock supaya aman kalau ada 2 request masuk bersamaan (race condition)
  // — jarang terjadi di app kecil begini tapi tetap best practice.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sheet = getSheet();
    let row = findRow(sheet, key);
    let newValue;
    if (row === -1) {
      sheet.appendRow([key, 1]);
      newValue = 1;
    } else {
      const current = Number(sheet.getRange(row, 2).getValue()) || 0;
      newValue = current + 1;
      sheet.getRange(row, 2).setValue(newValue);
    }

    // Update juga timestamp "terakhir dipakai" (shared, bukan per-device)
    const tsRow = findRow(sheet, 'lastUsedAt');
    const nowIso = new Date().toISOString();
    if (tsRow === -1) {
      sheet.appendRow(['lastUsedAt', nowIso]);
    } else {
      sheet.getRange(tsRow, 2).setValue(nowIso);
    }

    return jsonResponse({ key: key, value: newValue });
  } finally {
    lock.releaseLock();
  }
}

function handleGet(key) {
  if (VALID_KEYS.indexOf(key) === -1 && key !== 'lastUsedAt') {
    return jsonResponse({ error: 'Invalid key. Must be one of: ' + VALID_KEYS.concat(['lastUsedAt']).join(', ') });
  }
  const sheet = getSheet();
  const row = findRow(sheet, key);
  if (row === -1) {
    return jsonResponse({ key: key, value: key === 'lastUsedAt' ? null : 0 });
  }
  const value = sheet.getRange(row, 2).getValue();
  return jsonResponse({ key: key, value: value });
}

// Endpoint praktis untuk ambil semua angka sekaligus dalam SATU request
// (dipakai panel Statistik di app.js supaya cuma perlu 1x fetch, bukan
// 3x fetch terpisah seperti kalau pakai action=get satu-satu).
function handleGetAll() {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const result = { printDirect: 0, downloadPdf: 0, lastUsedAt: null };
  for (let i = 1; i < data.length; i++) {
    const k = data[i][0];
    const v = data[i][1];
    if (k === 'printDirect') result.printDirect = Number(v) || 0;
    else if (k === 'downloadPdf') result.downloadPdf = Number(v) || 0;
    else if (k === 'lastUsedAt') result.lastUsedAt = v || null;
  }
  return jsonResponse(result);
}

function jsonResponse(obj) {
  // PENTING: tanpa header CORS ini, fetch() dari browser (GitHub Pages,
  // dsb) akan GAGAL walau request-nya sendiri sukses dieksekusi di
  // server (data tetap ke-update di Sheet!). GET memang tidak kena
  // PREFLIGHT (request OPTIONS terpisah), tapi response-nya tetap wajib
  // punya Access-Control-Allow-Origin supaya browser MENGIZINKAN
  // JavaScript membaca isi response tsb — dua hal yang berbeda. Tanpa
  // header ini, browser melempar "TypeError: Failed to fetch" yang
  // keliatannya kayak masalah internet, padahal sebenarnya cuma header
  // response yang kurang.
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON)
    .setHeaders({ 'Access-Control-Allow-Origin': '*' });
}
