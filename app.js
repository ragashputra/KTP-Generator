/* =========================================================
   Cetak KTP Generator — CDN Internal Tools
   - Auto-detect & crop tepi KTP dari foto (deteksi kontur +
     perspective unwarp, bukan cuma bounding-box)
   - Enhance/HD-kan foto buram: SMART & ADAPTIF (on-device) — otomatis
     mendeteksi tingkat blur/noise/kecerahan foto lalu menyesuaikan
     kekuatan sharpen, radius unsharp-mask, noise-reduction & upscale
     sendiri per foto (bukan angka filter tetap utk semua foto). Ada
     juga opsi "AI Enhance" (cloud, opsional) yg mengirim foto ke model
     AI super-resolution eksternal utk hasil maksimal di foto sangat
     buram, dengan fallback otomatis ke enhance lokal kalau gagal/
     offline. Non-destruktif — original selalu tersimpan, bisa
     dibatalkan kapan saja. Lihat blok "ENHANCE / HD" di bawah.
   - Rotasi manual (putar kiri/kanan 90°) sebelum crop — mirip Windows
     Photo — supaya user bisa luruskan orientasi foto sendiri
   - Pilihan ukuran kertas (F4 default, A4, Letter, Legal, Folio)
   ========================================================= */

// ---------- Constants (real-world mm, converted at export time) ----------
// Ukuran gambar KTP hasil crop (cm) — bisa diubah user lewat input Lebar
// & Tinggi di panel Pengaturan Cetak. Default 13.5x9cm = ukuran fisik KTP
// asli, tapi disengaja bisa diubah utk kebutuhan lain (mis. mau dicetak
// lebih besar/kecil dari ukuran asli).
let CARD_W_CM = 13.5;   // sisi panjang KTP
let CARD_H_CM = 9.0;    // sisi pendek KTP
const DEFAULT_CARD_W_CM = 13.5, DEFAULT_CARD_H_CM = 9.0;
const MARGIN_MM = 3; // margin tepi kertas atas/bawah/kiri/kanan — dibuat tipis (0.3cm) supaya lebih banyak KTP muat per lembar
const GAP_MM = 5;
const PHONE_SPACE_MM = 12; // lebar strip di SAMPING KANAN KTP (bukan di bawah lagi) utk tulis no HP pakai pulpen — tegak sejajar tinggi foto. Dijaga cukup kecil (1.2cm) supaya KTP ukuran asli (13.5x9) tetap muat 2 kolom di F4 (total lebar 2x(9cm+1.2cm)+gap harus <= lebar kertas).

// Layout kolom x baris cetak: "AUTO" = dihitung otomatis (maksimal muat
// sesuai ukuran kertas & ukuran KTP), atau user bisa pilih manual
// lewat dropdown (mis. 1x1 kalau mau 1 KTP besar penuh 1 halaman,
// 2x3 kalau mau KTP lebih kecil tapi lebih banyak per lembar, dst).
let layoutMode = 'AUTO';   // 'AUTO' | 'MANUAL'
let manualCols = 2, manualRows = 2;

// Mode warna cetak: 'COLOR' (default, sesuai foto asli) atau 'BW' (hitam
// putih — hemat tinta printer, cukup buat verifikasi identitas).
let printMode = 'COLOR';

// =========================================================
// STATISTIK PENGGUNAAN (shared, semua device/user digabung)
// =========================================================
// Tujuan: supaya maintainer bisa lihat dari SEMUA user yang pakai app
// ini, berapa yang beneran pakai "Cetak Langsung" (window.print di
// dalam app) vs berapa yang cuma "Download PDF" lalu print manual dari
// luar (PC/laptop, aplikasi lain, dsb).
//
// App ini murni static/client-side (GitHub Pages, tanpa server sendiri),
// jadi backend counter-nya pakai Google Apps Script Web App + Google
// Sheet sebagai penyimpanan — bukan layanan counter pihak ketiga (yang
// sempat dicoba sebelumnya tapi gagal, kemungkinan besar krn CORS tidak
// dikonfigurasi dgn benar di layanan tsb). Keuntungan pakai Apps Script:
//   - HANYA pakai GET request (doGet) — GET tidak kena CORS preflight
//     sama sekali di browser, jadi jauh lebih reliable dipanggil dari
//     fetch() dibanding endpoint yang butuh POST.
//   - Datanya kebuka langsung sbg Google Sheet biasa yang bisa dilihat
//     manual kapan saja, bukan cuma angka di dalam modal app ini.
//   - Infra Google, availability jauh lebih terjamin drpd hobby-project
//     API gratisan pihak ketiga.
//
// GANTI URL DI BAWAH INI dengan URL /exec hasil deploy Google Apps
// Script kamu sendiri (lihat panduan lengkap di file gas/Code.gs).
// Selama masih placeholder ini, fitur statistik akan gagal dgn aman
// (fetchUsageStats mengembalikan null, trackUsage diam-diam gagal) —
// TIDAK memengaruhi fitur cetak/download utama sama sekali.
const STATS_API_BASE = 'https://cetak-ktp-stats.ragashputra-ktp.workers.dev';

// Menambah counter +1 di server (fire-and-forget). Sengaja TIDAK pernah
// melempar error atau memblokir alur utama (download/print harus tetap
// selesai walau internet lagi mati atau layanan statistik down) — makanya
// pakai .catch(()=>{}) diam-diam, bukan await di jalur kritikal.
//
// cache:'no-store' + parameter _t (timestamp) dipasang sbg DUA lapis
// pertahanan supaya request ke server statistik TIDAK PERNAH kebaca dari
// cache manapun -- baik cache HTTP browser sendiri, Service Worker (lihat
// NETWORK_ONLY_HOSTS di sw.js), maupun proxy/CDN pihak ketiga yg mungkin
// duduk di depan Worker & ikut nge-cache respons GET tanpa kita minta.
function trackUsage(kind){
  if(!STATS_API_BASE || STATS_API_BASE.startsWith('GANTI_')) return;
  fetch(`${STATS_API_BASE}?action=hit&key=${kind}&_t=${Date.now()}`, { cache:'no-store' }).catch(()=>{});
}

// Mengambil kedua angka counter + timestamp terakhir dipakai dari server
// (satu request lewat action=getAll) utk ditampilkan di panel statistik.
// Dipanggil saat panel dibuka, saat auto-polling selagi panel kebuka, DAN
// saat tab kembali aktif/online (lihat listener visibilitychange & online
// di bawah) — bukan cuma sekali doang, supaya angka yg kelihatan selalu
// representatif kondisi terkini server, bukan sekadar snapshot lama.
// Mengembalikan semua field null kalau gagal fetch (mis. offline, atau
// STATS_API_BASE belum diisi), sehingga UI bisa menampilkan pesan yang
// jelas alih-alih diam-diam menampilkan 0 yang menyesatkan.
async function fetchUsageStats(){
  if(!STATS_API_BASE || STATS_API_BASE.startsWith('GANTI_')){
    return { printDirect: null, downloadPdf: null, lastUsedAt: null };
  }
  try{
    // cache:'no-store' = permintaan browser TIDAK boleh dipenuhi dari HTTP
    // cache lokal sama sekali (beda dgn 'no-cache' yg masih boleh revalidate
    // pakai cache) + parameter _t unik tiap panggilan supaya URL-nya selalu
    // berbeda -- jaring pengaman ekstra kalau ada layer cache lain (mis.
    // CDN di depan Worker) yg mengabaikan header cache-control.
    const res = await fetch(`${STATS_API_BASE}?action=getAll&_t=${Date.now()}`, { cache:'no-store' });
    if(!res.ok){
      console.warn(`[Statistik] Server merespons HTTP ${res.status} (bukan 200). Cek apakah deployment Apps Script masih aktif & "Who has access" = Anyone.`);
      return { printDirect: null, downloadPdf: null, lastUsedAt: null };
    }
    const data = await res.json();
    if(data.error){
      console.warn('[Statistik] Server membalas dengan error:', data.error);
      return { printDirect: null, downloadPdf: null, lastUsedAt: null };
    }
    return {
      printDirect: typeof data.printDirect === 'number' ? data.printDirect : null,
      downloadPdf: typeof data.downloadPdf === 'number' ? data.downloadPdf : null,
      lastUsedAt: data.lastUsedAt || null,
    };
  }catch(e){
    // Ini nyaris selalu berarti fetch() diblokir browser (CORS: response
    // dari Apps Script tidak membawa header Access-Control-Allow-Origin),
    // BUKAN masalah internet user — lihat catatan CORS di Code.gs.
    console.warn('[Statistik] fetch() gagal total (bukan CORS) — kemungkinan besar URL STATS_API_BASE salah/typo, deployment Apps Script nonaktif, atau ada error runtime di kode Code.gs (buka URL-nya langsung di tab browser + ?action=getAll untuk lihat pesan errornya). Detail:', e);
    return { printDirect: null, downloadPdf: null, lastUsedAt: null };
  }
}


// Ukuran kertas yang didukung (mm, portrait) — dikelompokkan seperti
// dropdown ukuran kertas di Windows / Word / Excel. F4 = default
// (paling umum dipakai kantor/percetakan Indonesia untuk KTP).
const PAPER_GROUPS = [
  {
    label: 'Umum',
    sizes: {
      F4:     { label: 'F4 (21.6 × 33 cm)',       w: 216,   h: 330 },
      A4:     { label: 'A4 (21.0 × 29.7 cm)',     w: 210,   h: 297 },
      LETTER: { label: 'Letter (21.6 × 27.9 cm)', w: 215.9, h: 279.4 },
      LEGAL:  { label: 'Legal (21.6 × 35.6 cm)',  w: 215.9, h: 355.6 },
      FOLIO:  { label: 'Folio (21.6 × 33.0 cm)',  w: 216,   h: 330 },
    }
  },
  {
    label: 'Seri A (ISO)',
    sizes: {
      A3: { label: 'A3 (29.7 × 42 cm)',   w: 297, h: 420 },
      A5: { label: 'A5 (14.8 × 21 cm)',   w: 148, h: 210 },
      A6: { label: 'A6 (10.5 × 14.8 cm)', w: 105, h: 148 },
    }
  },
  {
    label: 'Seri B (ISO)',
    sizes: {
      B4: { label: 'B4 (25 × 35.3 cm)',   w: 250,   h: 353 },
      B5: { label: 'B5 (17.6 × 25 cm)',   w: 176,   h: 250 },
    }
  },
  {
    label: 'Amerika (US)',
    sizes: {
      TABLOID: { label: 'Tabloid (27.9 × 43.2 cm)', w: 279.4, h: 431.8 },
      EXEC:    { label: 'Executive (18.4 × 26.7 cm)', w: 184.1, h: 266.7 },
      STMT:    { label: 'Statement (14 × 21.6 cm)', w: 139.7, h: 215.9 },
    }
  },
];
// Flatten utk lookup cepat by key
const PAPER_SIZES = PAPER_GROUPS.reduce((acc,g)=>Object.assign(acc,g.sizes),{});
let currentPaperKey = 'F4';

// ---------- State ----------
let cards = []; // {id, rawImg, croppedDataURL, enhanced, rotation, phone, status}
let idCounter = 0;
let activeCropId = null;
let cropQuad = null; // {tl,tr,br,bl} in canvas-space (working/downscaled space)
let cropSourceCanvas = null;
let cropZoom = 1; // 1 = fit-to-stage (100%); actual on-screen canvas size = baseFitSize * cropZoom
let cropBaseFitW = 0, cropBaseFitH = 0; // canvas CSS size (px) at 100% zoom, i.e. fitted inside the stage
let cropDetectRunToken = 0; // dinaikkan tiap kali autoDetectCrop dipanggil; membatalkan hasil dari panggilan sebelumnya yg belum selesai (mis. user cepat ganti foto/rotasi berturut-turut)

// Antrian crop utk upload banyak sekaligus: foto dibuka satu per satu di
// editor crop, URUT dari yang pertama diupload sampai yang terakhir,
// bukan cuma foto terakhir doang yang kebuka (bug lama).
let cropQueue = [];   // id KTP yang menunggu giliran di-crop
let batchTotal = 0;   // jumlah total foto di batch upload saat ini
let batchDone = 0;    // sudah sampai foto ke berapa (termasuk yg lagi dibuka)

const el = (id) => document.getElementById(id);
const toastEl = el('toast');
const toastMsgEl = el('toastMsg');
const toastIcnEl = el('toastIcn');

const TOAST_ICONS = {
  success: '<path d="M20 6L9 17l-5-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5"/><path d="M12 8h.01"/>',
  warn: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86L1.82 18a1.5 1.5 0 001.29 2.25h17.78a1.5 1.5 0 001.29-2.25L13.71 3.86a1.5 1.5 0 00-2.42 0z"/>',
};

// Toast muncul dari ATAS layar (bukan bawah), durasi default dinaikkan
// jadi 3600ms (dari 2200ms) supaya sempat terbaca tanpa buru-buru, dan
// pesan panjang tidak lagi terpotong karena lebar toast sekarang bisa
// mengikuti isi (max-width 440px) alih-alih dipaksa 1 baris. Tipe
// ('success' default, 'info', 'warn') menentukan ikon & warna lingkaran
// kecil di kiri teks supaya pesan lebih cepat dipahami sekilas.
function toast(msg, ms=3600, type='success'){
  toastMsgEl.textContent = msg;
  toastIcnEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${TOAST_ICONS[type] || TOAST_ICONS.success}</svg>`;
  toastIcnEl.className = 'toast-icn' + (type !== 'success' ? ' ' + type : '');
  toastEl.classList.add('show');
  toastEl.classList.remove('toast-persistent');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>toastEl.classList.remove('show'), ms);
}

// Varian toast KHUSUS utk notifikasi "versi baru siap" -- beda dari
// toast() biasa krn: (1) berisi tombol aksi (bukan cuma teks polos), jadi
// perlu innerHTML; (2) TIDAK auto-hide sendiri (user harus baca & pilih
// muat ulang atau menutupnya) supaya tidak terlewat kalau user sedang
// fokus di tengah proses crop/isi data.
function toastPersistent(html, type='info'){
  toastMsgEl.innerHTML = html;
  toastIcnEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${TOAST_ICONS[type] || TOAST_ICONS.success}</svg>`;
  toastIcnEl.className = 'toast-icn' + (type !== 'success' ? ' ' + type : '');
  clearTimeout(toast._t); // batalkan auto-hide toast biasa yg mungkin masih terjadwal
  toastEl.classList.add('show', 'toast-persistent');
}

// ---------- Paper size selector ----------
function initPaperSelect(){
  const sel = el('paperSelect');
  if(!sel) return;
  sel.innerHTML = PAPER_GROUPS.map(group=>{
    const opts = Object.entries(group.sizes).map(([k,v])=>
      `<option value="${k}" ${k===currentPaperKey?'selected':''}>${v.label}</option>`
    ).join('');
    return `<optgroup label="${group.label}">${opts}</optgroup>`;
  }).join('');
  sel.addEventListener('change', e=>{
    currentPaperKey = e.target.value;
    renderGrid();
    toast(`Kertas diganti ke ${PAPER_SIZES[currentPaperKey].label}`, 3600, 'info');
  });
}

function paper(){ return PAPER_SIZES[currentPaperKey]; }

// ---------- Layout KTP/lembar selector (Otomatis vs Manual kolom x baris) ----------
// Preset manual yang ditawarkan mengikuti pola umum tata-letak cetak KTP
// (mirip pilihan "KTP per lembar" di software label printing) — dari 1
// KTP penuh 1 halaman (paling besar, mentok margin) sampai 3x4 (KTP
// kecil, banyak per lembar).
const LAYOUT_PRESETS = [
  { key:'1x1', cols:1, rows:1, label:'1 KTP / lembar (penuh 1 halaman)' },
  { key:'1x2', cols:1, rows:2, label:'2 KTP / lembar (1 kolom × 2 baris)' },
  { key:'2x1', cols:2, rows:1, label:'2 KTP / lembar (2 kolom × 1 baris)' },
  { key:'2x2', cols:2, rows:2, label:'4 KTP / lembar (2 kolom × 2 baris)' },
  { key:'2x3', cols:2, rows:3, label:'6 KTP / lembar (2 kolom × 3 baris)' },
  { key:'3x3', cols:3, rows:3, label:'9 KTP / lembar (3 kolom × 3 baris)' },
  { key:'3x4', cols:3, rows:4, label:'12 KTP / lembar (3 kolom × 4 baris)' },
];
let selectedLayoutKey = 'AUTO';

function initLayoutModeSelect(){
  const sel = el('layoutModeSelect');
  if(!sel) return;
  const autoOpt = `<option value="AUTO" selected>Otomatis (maksimal muat, ukuran KTP asli)</option>`;
  const manualOpts = LAYOUT_PRESETS.map(p=>
    `<option value="${p.key}">${p.label}</option>`
  ).join('');
  sel.innerHTML = `${autoOpt}<optgroup label="Manual — KTP dibesarkan penuh sampai margin">${manualOpts}</optgroup>`;

  sel.addEventListener('change', e=>{
    selectedLayoutKey = e.target.value;
    if(selectedLayoutKey === 'AUTO'){
      layoutMode = 'AUTO';
    } else {
      const preset = LAYOUT_PRESETS.find(p=>p.key===selectedLayoutKey);
      layoutMode = 'MANUAL';
      manualCols = preset.cols;
      manualRows = preset.rows;
    }
    renderGrid();
    toast(layoutMode === 'AUTO'
      ? 'Layout otomatis — ukuran KTP mengikuti input di panel Ukuran Gambar KTP'
      : `Layout manual: KTP dibesarkan penuh untuk ${manualCols} kolom × ${manualRows} baris`, 3600, 'info');
  });
}

// ---------- Mode warna cetak (Warna / Hitam Putih) ----------
function initColorModeToggle(){
  const wrap = el('colorModeToggle');
  if(!wrap) return;
  wrap.querySelectorAll('.cm-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      printMode = btn.dataset.mode;
      wrap.querySelectorAll('.cm-btn').forEach(b=>b.classList.toggle('active', b===btn));
      toast(printMode === 'BW' ? 'Mode cetak diubah ke Hitam Putih' : 'Mode cetak diubah ke Warna', 3600, 'info');
    });
  });
}

// ---------- Ukuran gambar KTP (editable, default 13.5x9cm) ----------
// Mengubah nilai ini hanya berlaku utk foto yang di-crop SETELAH
// perubahan (rasio dibakar ke gambar saat "Simpan Crop") dan utk layout
// cetak halaman baru — bukan me-retroaktif KTP yang udah kepalang
// di-crop dengan rasio lama.
function initCardSizeInputs(){
  const wInp = el('cardWInput'), hInp = el('cardHInput'), resetBtn = el('btnResetCardSize');
  if(!wInp || !hInp) return;

  function commit(){
    let w = parseFloat(wInp.value), h = parseFloat(hInp.value);
    if(!isFinite(w) || w <= 0) w = CARD_W_CM;
    if(!isFinite(h) || h <= 0) h = CARD_H_CM;
    w = Math.max(1, Math.min(50, w));
    h = Math.max(1, Math.min(50, h));
    wInp.value = w; hInp.value = h;
    const changed = (w !== CARD_W_CM || h !== CARD_H_CM);
    CARD_W_CM = w; CARD_H_CM = h;
    if(changed){
      renderGrid();
      toast(`Ukuran gambar KTP diubah ke ${w} × ${h} cm`, 3600, 'info');
    }
  }

  wInp.addEventListener('change', commit);
  hInp.addEventListener('change', commit);
  wInp.addEventListener('keydown', e=>{ if(e.key==='Enter') wInp.blur(); });
  hInp.addEventListener('keydown', e=>{ if(e.key==='Enter') hInp.blur(); });

  if(resetBtn){
    resetBtn.addEventListener('click', ()=>{
      wInp.value = DEFAULT_CARD_W_CM;
      hInp.value = DEFAULT_CARD_H_CM;
      commit();
    });
  }
}

// ---------- File intake ----------
const dropzone = el('dropzone');
const fileInput = el('fileInput');

dropzone.addEventListener('click', () => fileInput.click());

// Target drag-and-drop diperluas ke SELURUH halaman (bukan cuma tombol
// kecil di header) — supaya walau tombol upload di header dibuat compact,
// UX "seret file ke halaman ini" tetap nyaman & gampang kena. Highlight
// visual (.drag) tetap ditampilkan di tombol header sebagai indikator.
['dragenter','dragover'].forEach(ev=>{
  document.body.addEventListener(ev, e=>{ e.preventDefault(); dropzone.classList.add('drag'); });
});
['dragleave','drop'].forEach(ev=>{
  document.body.addEventListener(ev, e=>{ e.preventDefault(); dropzone.classList.remove('drag'); });
});
document.body.addEventListener('drop', e=>{
  const files = [...e.dataTransfer.files].filter(f=>f.type.startsWith('image/'));
  handleFiles(files);
});
fileInput.addEventListener('change', e=>{ handleFiles([...e.target.files]); fileInput.value=''; });

function handleFiles(files){
  if(!files.length) return;
  // Baca file SATU-SATU secara berurutan (bukan paralel) supaya KTP
  // muncul di grid sesuai urutan upload asli, lalu antrikan semuanya ke
  // editor crop dalam urutan yang sama (foto pertama dibuka duluan).
  loadFilesSequentially([...files], 0, []);
}

function loadFilesSequentially(files, idx, newIds){
  if(idx >= files.length){
    if(newIds.length) queueCropBatch(newIds);
    return;
  }
  const file = files[idx];
  if(!file || !file.type || !file.type.startsWith('image/')){
    loadFilesSequentially(files, idx+1, newIds);
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev)=>{
    const img = new Image();
    img.onload = ()=>{
      const id = 'k'+(idCounter++);
      cards.push({
        id, rawImg: img, croppedDataURL: null, originalDataURL: null,
        enhanced:false, enhanceMeta:null, rotation:0,
        phone:'', status:'raw'
      });
      newIds.push(id);
      renderGrid();
      loadFilesSequentially(files, idx+1, newIds);
    };
    img.onerror = ()=> loadFilesSequentially(files, idx+1, newIds);
    img.src = ev.target.result;
  };
  reader.onerror = ()=> loadFilesSequentially(files, idx+1, newIds);
  reader.readAsDataURL(file);
}

// Tambahkan foto2 baru ke antrian crop, lalu langsung buka editor utk
// foto pertama yang belum di-crop (kalau modal crop sedang idle).
function queueCropBatch(newIds){
  const startingFresh = cropQueue.length === 0 && !activeCropId;
  cropQueue.push(...newIds);
  if(startingFresh){ batchTotal = newIds.length; batchDone = 0; }
  else { batchTotal += newIds.length; }
  if(!activeCropId) advanceCropQueue();
}

// Lanjut ke foto berikutnya dalam antrian crop. Dipanggil tiap kali
// editor crop ditutup (baik krn disimpan maupun dilewati), supaya user
// otomatis diarahkan ke foto berikutnya sampai semua kebagian giliran.
function advanceCropQueue(){
  if(!cropQueue.length){
    if(batchTotal > 1) toast(`Semua ${batchTotal} foto sudah diproses, siap dicetak`);
    batchTotal = 0; batchDone = 0;
    updateCropProgress();
    return;
  }
  const nextId = cropQueue.shift();
  batchDone++;
  openCropModal(nextId);
}

function updateCropProgress(){
  const badge = el('cropProgress');
  const skipBtn = el('btnSkipCrop');
  const inBatch = batchTotal > 1;
  if(badge){
    badge.style.display = inBatch ? '' : 'none';
    if(inBatch) badge.textContent = `Foto ${batchDone} dari ${batchTotal}`;
  }
  if(skipBtn) skipBtn.style.display = inBatch ? '' : 'none';
}

// ---------- Grid rendering ----------
// KTP baru diupload TIDAK langsung tampil di daftar — mereka nunggu
// di antrian crop (cropQueue) dan hanya masuk ke grid begitu user
// menekan "Simpan Crop". Ini mencegah daftar kepenuhan foto mentah yang
// belum diproses / masih miring sebelum sempat di-crop.
function renderGrid(){
  const grid = el('cardGrid');
  const empty = el('emptyState');
  grid.innerHTML = '';
  const visibleCards = cards.filter(c=>c.croppedDataURL);
  empty.style.display = visibleCards.length ? 'none' : 'block';
  el('headerCount').textContent = visibleCards.length + ' KTP';
  el('listSub').textContent = visibleCards.length ? `${visibleCards.length} KTP dimuat` : 'belum ada data';
  // Tombol "Hapus Semua" cuma relevan kalau ada minimal 1 KTP di daftar
  // (termasuk yang masih raw/belum di-crop, bukan cuma visibleCards, biar
  // tombol tidak hilang saat semua foto masih nunggu giliran crop).
  const clearAllBtn = el('btnClearAll');
  if(clearAllBtn) clearAllBtn.style.display = cards.length ? 'inline-flex' : 'none';
  el('layoutInfo').textContent = layoutDescription();
  const specW = el('specPaperName'); if(specW) specW.textContent = paper().label.split(' (')[0];
  const specDim = el('specPaperDim'); if(specDim) specDim.textContent = paper().label.match(/\(([^)]+)\)/)?.[1] || '';

  const readyCount = visibleCards.length;
  const previewBtns = [el('btnPreview'), el('btnPreviewMobile')];
  previewBtns.forEach(b=> b.disabled = readyCount === 0);

  visibleCards.forEach(c=>{
    const div = document.createElement('div');
    div.className = 'ktp-card';
    const statusLabel = c.status === 'enhanced' ? 'HD' : (c.status === 'cropped' ? 'Cropped' : 'Belum Dicrop');
    const statusClass = c.status === 'enhanced' ? 'enhanced' : (c.status === 'cropped' ? 'cropped' : 'raw');
    const thumbClass = c.croppedDataURL ? 'thumb-ready' : 'thumb-raw';
    // Grid selalu pakai thumbnail ringan (thumbDataURL) kalau sudah ada
    // -- fallback ke croppedDataURL/rawImg.src cuma sbg jaring pengaman
    // di frame pertama sebelum thumbnail sempat digenerate (harusnya
    // hampir tidak pernah kepakai krn thumbDataURL selalu dibuat
    // bebarengan dgn croppedDataURL).
    const thumbSrc = c.thumbDataURL || c.croppedDataURL || c.rawImg.src;
    // KTP sudah di-crop selalu tersimpan landscape (utk layout cetak),
    // jadi khusus di preview UI dibungkus wrapper .rot90 supaya tampil
    // tegak seperti KTP fisik. KTP raw (belum crop) tampil apa adanya.
    const thumbInner = c.croppedDataURL
      ? `<div class="rot90"><img src="${thumbSrc}" alt="KTP"></div>`
      : `<img src="${thumbSrc}" alt="KTP">`;
    div.innerHTML = `
      <div class="thumb ${thumbClass}" data-act="zoom" data-id="${c.id}">
        <span class="status ${statusClass}">${statusLabel}</span>
        <div class="frame">
          ${thumbInner}
        </div>
        <div class="zoom-hint">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35M11 8v6M8 11h6"/></svg>
        </div>
      </div>
      <div class="body">
        <div class="actions">
          <button class="icnbtn" title="Crop ulang" data-act="crop" data-id="${c.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2v14a2 2 0 002 2h14M18 22V8a2 2 0 00-2-2H2"/></svg>
            <span>Crop</span>
          </button>
          <button class="icnbtn" title="Duplikat — cetak KTP ini lebih dari 1x dalam 1 lembar" data-act="duplicate" data-id="${c.id}" ${!c.croppedDataURL ? 'disabled':''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            <span>Duplikat</span>
          </button>
          <button class="icnbtn" title="Putar 90°" data-act="rotate" data-id="${c.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 004 14.5v0A5.5 5.5 0 009.5 20H13"/></svg>
            <span>Putar</span>
          </button>
          <button class="icnbtn" title="${c.enhanced ? 'Perjelas ulang (analisis ulang otomatis)' : 'HD-kan foto buram — deteksi otomatis tingkat blur'}" data-act="enhance" data-id="${c.id}" ${!c.croppedDataURL ? 'disabled':''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
            <span>HD-kan</span>
          </button>
          ${AI_ENHANCE_ENABLED ? `
          <button class="icnbtn ai" title="AI Enhance — upscaling pakai model AI (cloud), hasil maksimal utk foto sangat buram" data-act="enhance-ai" data-id="${c.id}" ${!c.croppedDataURL ? 'disabled':''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z"/></svg>
            <span>AI Enhance</span>
          </button>` : ''}
          ${c.enhanced && c.originalDataURL ? `
          <button class="icnbtn" title="Kembalikan ke foto sebelum HD-kan" data-act="revert-enhance" data-id="${c.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            <span>Batalkan HD</span>
          </button>` : ''}
          <button class="icnbtn danger" title="Hapus" data-act="delete" data-id="${c.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
            <span>Hapus</span>
          </button>
        </div>
      </div>
    `;
    grid.appendChild(div);
  });

  // bind field inputs
  grid.querySelectorAll('input[data-field]').forEach(inp=>{
    inp.addEventListener('input', e=>{
      const c = cards.find(x=>x.id===e.target.dataset.id);
      if(c) c[e.target.dataset.field] = e.target.value;
    });
  });
  grid.querySelectorAll('button[data-act]').forEach(btn=>{
    btn.addEventListener('click', e=>{
      const b = e.currentTarget;
      const id = b.dataset.id, act = b.dataset.act;
      if(act==='crop') openCropModal(id);
      if(act==='duplicate') duplicateCard(id);
      if(act==='rotate') rotateCardResult(id);
      if(act==='enhance') runEnhance(id, b);
      if(act==='enhance-ai') runEnhanceAI(id, b);
      if(act==='revert-enhance') revertEnhance(id);
      if(act==='delete'){ cards = cards.filter(c=>c.id!==id); renderGrid(); }
    });
  });
  // bind thumbnail tap-to-zoom (lihat hasil crop besar)
  grid.querySelectorAll('.thumb[data-act="zoom"]').forEach(t=>{
    t.addEventListener('click', e=>{
      openZoomModal(e.currentTarget.dataset.id);
    });
  });
}

function escapeHtml(s){
  return (s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---- Thumbnail ringan khusus buat grid kartu ----
// PENTING (fix performa): dulu grid card langsung pakai croppedDataURL
// (resolusi cetak penuh 1350x900px, JPEG kualitas 0.95) sbg src <img>
// thumbnail -- padahal di layar cuma dirender kecil (~160px lebar).
// Browser tetap harus decode gambar resolusi tinggi itu PENUH tiap kali
// renderGrid() dipanggil ulang, utk SEMUA kartu yg ada di grid, bukan
// cuma yg berubah. Makin banyak KTP diupload, makin berat setiap render
// -- inilah kenapa app terasa "makin lambat" dibanding pas awal baru
// upload 1-2 foto, dan kenapa rotate 1 kartu ikut kerasa berat (rotate
// -> renderGrid() -> semua thumbnail resolusi tinggi lain ikut didecode
// ulang jg).
//
// Solusinya: simpan thumbnail TERPISAH (thumbDataURL, ~280px lebar,
// kualitas JPEG lebih rendah) khusus buat ditampilkan di grid.
// croppedDataURL (resolusi cetak penuh) TETAP dipakai apa adanya utk
// zoom modal, preview, dan proses cetak/print -- kualitas hasil akhir
// tidak berkurang sedikit pun, cuma tampilan grid yg dibikin jauh lebih
// ringan.
const THUMB_MAX_DIM = 280;
function makeThumbDataURL(source, srcW, srcH){
  const scale = Math.min(1, THUMB_MAX_DIM / Math.max(srcW, srcH));
  const tw = Math.max(1, Math.round(srcW*scale));
  const th = Math.max(1, Math.round(srcH*scale));
  const tc = document.createElement('canvas');
  tc.width = tw; tc.height = th;
  const tctx = tc.getContext('2d');
  tctx.drawImage(source, 0, 0, tw, th);
  return tc.toDataURL('image/jpeg', 0.82);
}

// Duplikat KTP yang sudah di-crop — berguna kalau user cuma punya 1 KTP
// tapi mau cetak beberapa salinan sekaligus dalam 1 lembar (misal layout
// 2x2 muat 4 slot, tapi cuma ada 1 KTP: duplikat 3x biar 1 lembar penuh,
// nggak ada slot kosong yang kebuang kertas). Salinan disisipkan TEPAT
// SETELAH kartu aslinya (bukan di ujung daftar) supaya di grid & di
// hasil cetak posisinya berdekatan — gampang digunting berurutan.
// rawImg (objek Image) aman di-share antar salinan karena read-only
// setelah crop tersimpan, tidak pernah dimodifikasi lagi in-place.
function duplicateCard(id){
  const idx = cards.findIndex(c=>c.id===id);
  if(idx === -1) return;
  const original = cards[idx];
  if(!original.croppedDataURL){ toast('Crop KTP ini dulu sebelum diduplikat', 3600, 'warn'); return; }
  const copy = {
    ...original,
    id: 'k'+(idCounter++),
  };
  cards.splice(idx+1, 0, copy);
  renderGrid();
  toast('KTP diduplikat — salinan baru ditambahkan tepat di sebelahnya');
}

// Putar hasil crop (KTP yang sudah tersimpan di daftar) 90° searah
// jarum jam, langsung di tempat — tanpa perlu buka ulang editor crop.
// Berguna kalau hasil crop kebalik/miring 90° setelah disimpan.
function rotateCardResult(id){
  const card = cards.find(c=>c.id===id);
  if(!card || !card.croppedDataURL) return;
  const img = new Image();
  img.onload = ()=>{
    const canvas = document.createElement('canvas');
    canvas.width = img.height;
    canvas.height = img.width;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width/2, canvas.height/2);
    ctx.rotate(90*Math.PI/180);
    ctx.drawImage(img, -img.width/2, -img.height/2);
    card.croppedDataURL = canvas.toDataURL('image/jpeg', 0.95);
    card.thumbDataURL = makeThumbDataURL(canvas, canvas.width, canvas.height);
    renderGrid();
    toast('Foto diputar 90°');
  };
  img.src = card.croppedDataURL;
}

// ---------- Zoom preview modal (tap KTP utk lihat hasil crop besar) ----------
function openZoomModal(id){
  const card = cards.find(c=>c.id===id);
  if(!card) return;
  const src = card.croppedDataURL || card.rawImg.src;
  const plainImg = el('zoomImage');
  const rotWrap = el('zoomRotWrap');
  const rotImg = el('zoomImageRot');
  // Hasil crop tersimpan landscape (utk layout cetak) — tampilkan lewat
  // wrapper rot90 supaya berdiri tegak seperti KTP fisik. Foto raw
  // (belum crop) ditampilkan apa adanya.
  if(card.croppedDataURL){
    rotImg.src = src;
    rotWrap.style.display = 'block';
    plainImg.style.display = 'none';
  } else {
    plainImg.src = src;
    plainImg.style.display = 'block';
    rotWrap.style.display = 'none';
  }
  el('zoomStatusHint').textContent = card.croppedDataURL
    ? (card.enhanced ? zoomEnhanceHint(card) : 'Tampilan penuh sesuai hasil crop saat ini.')
    : 'Foto ini belum di-crop — tampilan asli sebelum diproses.';
  el('zoomModal').style.display = 'flex';
}
function closeZoomModal(){
  el('zoomModal').style.display = 'none';
}

// Ringkasan hasil enhance yg ditampilkan di modal zoom, supaya user
// tahu mesin apa yang dipakai (AI cloud vs on-device) & seberapa buram
// foto aslinya terdeteksi — sekadar transparansi, bukan wajib dibaca.
function zoomEnhanceHint(card){
  const meta = card.enhanceMeta;
  if(!meta) return 'Tampilan penuh — foto ini sudah diperjelas (HD).';
  if(meta.engine === 'ai-cloud'){
    return 'Tampilan penuh — foto ini sudah diperjelas dengan AI Enhance (cloud).';
  }
  const level = meta.blurLevel || 'tidak diketahui';
  return `Tampilan penuh — foto ini sudah diperjelas (HD) secara otomatis, terdeteksi tingkat blur: ${level}.`;
}

// ---------- Modal Statistik Penggunaan ----------
function formatRelativeTime(isoString){
  const then = new Date(isoString);
  const diffMs = Date.now() - then.getTime();
  const diffMin = Math.floor(diffMs/60000);
  if(diffMin < 1) return 'baru saja';
  if(diffMin < 60) return `${diffMin} menit lalu`;
  const diffHour = Math.floor(diffMin/60);
  if(diffHour < 24) return `${diffHour} jam lalu`;
  const diffDay = Math.floor(diffHour/24);
  if(diffDay < 30) return `${diffDay} hari lalu`;
  return then.toLocaleDateString('id-ID', { day:'numeric', month:'long', year:'numeric' });
}

// ---------- Auto-refresh statistik (polling ringan selagi modal kebuka) ----------
// Kenapa polling, bukan websocket/SSE: backend-nya cuma Cloudflare Worker
// simpel dgn endpoint GET biasa (lihat STATS_API_BASE di atas), gak ada
// infra realtime. Polling tiap beberapa detik itu paling murah & robust
// utk kasus ini -- cukup utk "kerasa hidup" tanpa perlu bikin infra baru.
const STATS_POLL_MS = 6000; // 6 detik -- di tengah 5-10 detik yg wajar, gak spam server tapi masih kerasa realtime
let statsPollTimer = null;
let statsDisplayed = { printDirect: null, downloadPdf: null }; // angka yg lagi kelihatan di layar, jadi basis animasi count-up berikutnya
let statsCountUpToken = 0; // dinaikkan tiap kali animasi baru mulai; membatalkan animasi count-up sebelumnya yg mungkin masih jalan (mis. refresh manual dipencet pas polling lagi jalan)

// Animasi angka naik/turun halus dari fromVal ke toVal (bukan langsung
// loncat) -- ease-out cubic supaya kerasa "settle" di akhir, mirip
// dashboard/analytics app profesional (Stripe, Vercel, dsb).
function animateStatNumber(node, fromVal, toVal){
  if(fromVal === null || fromVal === undefined || isNaN(fromVal) || fromVal === toVal){
    node.textContent = toVal.toLocaleString('id-ID');
    return;
  }
  const token = ++statsCountUpToken;
  const duration = 550;
  const startTime = performance.now();
  node.classList.remove('is-updating'); void node.offsetWidth; node.classList.add('is-updating'); // retrigger flash CSS animation
  function step(now){
    if(token !== statsCountUpToken) return; // ada animasi/refresh lain yg lebih baru, batalkan yg ini
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = Math.round(fromVal + (toVal - fromVal) * eased).toLocaleString('id-ID');
    if(t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function startStatsPolling(){
  stopStatsPolling(); // safety-net -- jangan sampai ada interval numpuk kalau openStatsModal kepanggil dobel
  statsPollTimer = setInterval(()=>{
    // Skip kalau tab lagi di background (mis. user pindah tab) -- hemat
    // request percuma buat data yg toh gak lagi dilihat siapapun.
    if(document.hidden) return;
    loadStatsIntoModal({ silent:true });
  }, STATS_POLL_MS);
}
function stopStatsPolling(){
  if(statsPollTimer){ clearInterval(statsPollTimer); statsPollTimer = null; }
}

// ---------- Refresh statistik saat tab kembali aktif / koneksi pulih ----------
// Selain polling tiap 6 detik SELAGI modal kebuka, kita juga refresh
// begitu tab balik fokus atau internet baru nyambung lagi -- ini yg
// nutup celah "buka panel, pindah tab lama, balik lagi -> data masih
// keliatan basi sampai nunggu interval berikutnya". Guard `statsModal`
// harus kebuka dulu supaya tidak diam-diam fetch data yg toh tidak
// sedang dilihat siapapun.
document.addEventListener('visibilitychange', ()=>{
  if(!document.hidden && el('statsModal').style.display !== 'none'){
    loadStatsIntoModal({ silent:true });
  }
});
window.addEventListener('online', ()=>{
  if(el('statsModal').style.display !== 'none'){
    loadStatsIntoModal({ silent:true });
  }
});

function openStatsModal(){
  el('statsModal').style.display = 'flex';
  statsDisplayed = { printDirect: null, downloadPdf: null }; // reset basis animasi tiap modal dibuka ulang, biar angka pertama tampil apa adanya (gak animasi dari 0)
  loadStatsIntoModal();
  startStatsPolling();
}
function closeStatsModal(){
  el('statsModal').style.display = 'none';
  stopStatsPolling(); // stop auto-polling begitu modal ditutup -- gak ada gunanya nge-fetch data yg gak dilihat
}

// ---------- Modal konfirmasi "Hapus Semua KTP" ----------
// Tombol "Hapus Semua" cuma menampilkan modal konfirmasi (tidak langsung
// menghapus) supaya user tidak kehilangan data secara tidak sengaja krn
// salah tap/klik. Penghapusan sungguhan baru terjadi di confirmDeleteAll().
function openDeleteAllModal(){
  const total = cards.length;
  if(total === 0) return; // safety-net -- tombol memang sudah disembunyikan saat kosong, tapi dijaga dua kali
  el('deleteAllCount').textContent = `${total} KTP akan dihapus`;
  el('deleteAllModal').style.display = 'flex';
}
function closeDeleteAllModal(){
  el('deleteAllModal').style.display = 'none';
}
function confirmDeleteAll(){
  const btn = el('btnConfirmDeleteAll');
  // Kosongkan seluruh state KTP + antrian crop yang mungkin masih berjalan,
  // supaya tidak ada sisa foto "menyelinap" balik ke grid lewat cropQueue
  // setelah modal ditutup.
  const total = cards.length;
  cards = [];
  cropQueue = [];
  batchTotal = 0;
  batchDone = 0;
  activeCropId = null;
  // Kalau modal crop kebetulan lagi kebuka (edge case: user buka Hapus
  // Semua dari state lain), tutup juga supaya tidak nyangkut di layar.
  const cropModalEl = el('cropModal');
  if(cropModalEl && cropModalEl.style.display !== 'none') cropModalEl.style.display = 'none';

  renderGrid();
  closeDeleteAllModal();
  toast(`${total} KTP berhasil dihapus dari daftar`, 3600, 'success');
}
el('btnClearAll').addEventListener('click', openDeleteAllModal);

// opts.silent = true kalau ini panggilan auto-polling di background (bukan
// dari klik user) -- bedanya: gak nampilin state "Memuat..." yg bikin kedip,
// gak nyalain spinner tombol Muat Ulang, dan kalau fetch gagal, gak menimpa
// angka terakhir yg sudah berhasil tampil dgn tanda error (biar gak "kedip"
// jadi strip (—) padahal cuma koneksi kepleset sesaat). Refresh manual
// (silent=false, dari buka modal atau klik Muat Ulang) tetap tampilkan
// semua state termasuk error, spt semula.
async function loadStatsIntoModal(opts = {}){
  const silent = !!opts.silent;
  const refreshBtn = el('btnRefreshStats');
  const printEl = el('statPrintDirect');
  const pdfEl = el('statDownloadPdf');
  const lastUsedEl = el('statsLastUsed');
  const liveDotEl = el('statsLiveDot');

  if(!silent){
    refreshBtn.classList.add('is-loading');
    refreshBtn.disabled = true;
    printEl.textContent = '–';
    printEl.classList.remove('stats-num-error');
    pdfEl.textContent = '–';
    pdfEl.classList.remove('stats-num-error');
    lastUsedEl.textContent = 'Memuat data statistik...';
  }

  const notConfigured = !STATS_API_BASE || STATS_API_BASE.startsWith('GANTI_');
  const stats = await fetchUsageStats();

  // Kalau modal sudah ditutup selagi fetch ini masih di-await (mis. polling
  // yg nyangkut pas user buru-buru klik Tutup), jangan sentuh DOM lagi --
  // percuma & closeStatsModal() sudah menghentikan polling berikutnya.
  if(el('statsModal').style.display === 'none') return;

  const printOk = typeof stats.printDirect === 'number';
  const pdfOk = typeof stats.downloadPdf === 'number';

  if(printOk){
    animateStatNumber(printEl, statsDisplayed.printDirect, stats.printDirect);
    statsDisplayed.printDirect = stats.printDirect;
    printEl.classList.remove('stats-num-error');
  } else if(!silent){
    printEl.textContent = '—';
    printEl.classList.add('stats-num-error');
  }

  if(pdfOk){
    animateStatNumber(pdfEl, statsDisplayed.downloadPdf, stats.downloadPdf);
    statsDisplayed.downloadPdf = stats.downloadPdf;
    pdfEl.classList.remove('stats-num-error');
  } else if(!silent){
    pdfEl.textContent = '—';
    pdfEl.classList.add('stats-num-error');
  }

  if(notConfigured){
    lastUsedEl.textContent = 'Statistik belum aktif — backend penyimpanan data belum dikonfigurasi.';
    if(liveDotEl) liveDotEl.style.display = 'none';
  } else if(!printOk && !pdfOk){
    // Gagal total: kalau manual, tampilkan pesan error spt semula. Kalau
    // silent (polling di background), biarkan teks footer & angka terakhir
    // apa adanya -- graceful, gak nakut-nakutin user dgn pesan error tiap
    // 6 detik gara-gara koneksi kedip sesaat.
    if(!silent){
      lastUsedEl.textContent = 'Gagal memuat data dari server statistik. Coba "Muat Ulang" dulu — kalau masih gagal, kemungkinan besar ada masalah di backend (deployment Apps Script), bukan koneksi internet kamu. Cek Console (F12) untuk detail error, atau hubungi pengelola aplikasi.';
      if(liveDotEl) liveDotEl.style.display = 'none';
    }
  } else {
    if(liveDotEl) liveDotEl.style.display = '';
    if(stats.lastUsedAt){
      lastUsedEl.textContent = `Terakhir digunakan ${formatRelativeTime(stats.lastUsedAt)}`;
    } else {
      lastUsedEl.textContent = 'Belum ada aktivitas cetak atau unduh yang tercatat.';
    }
  }

  if(!silent){
    refreshBtn.classList.remove('is-loading');
    refreshBtn.disabled = false;
  }
}

el('btnOpenStats').addEventListener('click', openStatsModal);

// KTP dicetak apa adanya sesuai hasil crop (orientasi diatur manual
// oleh user lewat tombol putar kiri/kanan di editor crop).
function layoutDescription(){
  const layout = computeLayout();
  return `${layout.cols} kolom × ${layout.rows} baris (${layout.perPage} KTP/lembar)`;
}

// =========================================================
// AUTO-DETECT & CROP — v2, akurasi & robustness ditingkatkan jauh
// Pipeline:
//   1. Grayscale + blur adaptif (kernel menyesuaikan resolusi) + Sobel
//      gradient magnitude & orientasi.
//   2. Threshold Otsu asli (dihitung dari histogram magnitude, bukan
//      persentase magic-number dari nilai maksimum) -> jauh lebih tahan
//      terhadap foto gelap/terang/silau dibanding threshFrac tetap.
//   3. Hough-transform utk garis dominan (rho/theta, resolusi 0.5°),
//      dicoba di BEBERAPA level threshold (ketat -> longgar) secara
//      berurutan sampai ketemu 4 sisi yang valid -- bukan cuma 1x coba.
//   4. Kelompokkan garis jadi klaster nyaris-horizontal & nyaris-vertikal,
//      lalu untuk tiap sisi pilih KANDIDAT TERBAIK (bukan cuma ekstrem
//      atas/bawah) berdasar jumlah vote & keselarasan dgn sisi seberang.
//   5. Hitung 4 titik potong (intersection) sbg quad kasar.
//   6. REFINE tiap sudut: cari titik gradient-magnitude terkuat di
//      jendela kecil di sekitar hasil intersection Hough -> menempel ke
//      tepi fisik kartu yang sebenarnya, bukan cuma estimasi garis
//      statistik (mengoreksi kartu yang sedikit melengkung/lensa distorsi).
//   7. VALIDASI RASIO ASPEK: kartu ID Indonesia mengikuti standar ID-1
//      (85.6mm x 53.98mm, rasio ~1.586:1). Quad yang dihasilkan dicek
//      terhadap rasio ini (toleransi ±22% utk perspektif miring) di KEDUA
//      kemungkinan orientasi (landscape/portrait). Quad yang rasionya
//      jauh meleset (mis. kena pinggiran meja/dompet) otomatis ditolak.
//   8. Fallback bertingkat: kalau Hough gagal total di semua level
//      threshold, atau hasil quad gagal validasi rasio, jatuh ke
//      proyeksi bounding-box row/col energy (metode lama, lebih kasar
//      tapi robust utk kasus KTP nyaris memenuhi seluruh frame foto).
// =========================================================

function openCropModal(id){
  activeCropId = id;
  const card = cards.find(c=>c.id===id);
  if(card.rotation === undefined) card.rotation = 0; // 0/90/180/270, applied before crop detection
  el('cropModal').style.display = 'flex';
  updateCropProgress();

  cropZoom = 1;
  bindRotateButtons(card);
  bindZoomButtons();
  rebuildCropStage(card);
}

// Draws card.rawImg onto an offscreen canvas rotated by card.rotation degrees,
// then uses that as the working image for auto-detect + manual crop handles.
function rebuildCropStage(card){
  const maxDim = 900;
  const rot = ((card.rotation % 360) + 360) % 360;
  const swapped = (rot === 90 || rot === 270);
  const srcW = card.rawImg.width, srcH = card.rawImg.height;
  const rotatedW = swapped ? srcH : srcW;
  const rotatedH = swapped ? srcW : srcH;

  const scale = Math.min(1, maxDim / Math.max(rotatedW, rotatedH));
  const w = Math.round(rotatedW*scale);
  const h = Math.round(rotatedH*scale);

  const canvas = el('cropCanvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(w/2, h/2);
  ctx.rotate(rot*Math.PI/180);
  if(swapped){
    ctx.drawImage(card.rawImg, -h/2, -w/2, h, w);
  } else {
    ctx.drawImage(card.rawImg, -w/2, -h/2, w, h);
  }
  ctx.restore();

  cropSourceCanvas = canvas;
  autoDetectCrop();
  bindCropDrag(canvas);
  computeCropBaseFitSize();
  applyCropZoom();
}

const ZOOM_MIN = 0.5, ZOOM_MAX = 2, ZOOM_STEP = 0.25;

// ---- Zoom (perbesar/perkecil area kerja crop, biar geser sudut kotak
// hijau bisa lebih presisi terutama di foto beresolusi tinggi). Rentang
// 50%-200% (100% = ukuran pas/fit awal).
//
// PENTING: canvas di-resize LANGSUNG lewat CSS width/height (bukan cuma
// transform:scale), supaya kotak layoutnya ikut mengecil/membesar sesuai
// isinya. Kalau cuma pakai transform:scale, ukuran elemen di DOM tetap
// sebesar semula walau tampilan visualnya ngecil — makanya sebelumnya
// waktu di-zoom-out selalu nyisain area kosong item di sebelahnya.
function computeCropBaseFitSize(){
  const stage = el('cropStage');
  const canvas = cropSourceCanvas;
  // Ukuran stage yang tersedia utk menampung canvas di 100% (sebelum ada
  // scrollbar dari zoom), pakai lebar stage & tinggi max yg sama dgn CSS
  // max-height. Style CSS max-height:58vh sudah diatur di stylesheet,
  // jadi kita baca langsung dari elemen supaya konsisten di semua layar.
  const availW = stage.clientWidth || stage.getBoundingClientRect().width;
  const cs = getComputedStyle(stage);
  const availH = parseFloat(cs.maxHeight) || 500;
  const naturalRatio = canvas.width / canvas.height;
  let fitW = availW, fitH = fitW / naturalRatio;
  if(fitH > availH){ fitH = availH; fitW = fitH*naturalRatio; }
  cropBaseFitW = Math.round(fitW);
  cropBaseFitH = Math.round(fitH);
}

function applyCropZoom(){
  const canvas = el('cropCanvas');
  const stage = el('cropStage');
  const dispW = Math.round(cropBaseFitW*cropZoom);
  const dispH = Math.round(cropBaseFitH*cropZoom);
  canvas.style.width = dispW + 'px';
  canvas.style.height = dispH + 'px';
  // Mode "zoomed" (scrollable) cuma perlu begitu kontennya lebih besar
  // dari area stage — yaitu waktu diperbesar di atas 100%. Di 100% ke
  // bawah, kontennya selalu muat penuh jadi cukup flex-center biasa.
  stage.classList.toggle('zoomed', cropZoom > 1.001);
  const pctEl = el('zoomPct');
  if(pctEl) pctEl.textContent = Math.round(cropZoom*100) + '%';
  const outBtn = el('btnZoomOut');
  const inBtn = el('btnZoomIn');
  if(outBtn) outBtn.disabled = cropZoom <= ZOOM_MIN + 0.001;
  if(inBtn) inBtn.disabled = cropZoom >= ZOOM_MAX - 0.001;
}

function setCropZoom(next){
  const stage = el('cropStage');
  // Keep the point currently at the stage's visual center anchored while
  // zooming, so zooming in/out doesn't yank the view somewhere unexpected.
  const rect = stage.getBoundingClientRect();
  const midX = stage.scrollLeft + rect.width/2;
  const midY = stage.scrollTop + rect.height/2;
  const ratio = next / cropZoom;
  cropZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
  applyCropZoom();
  stage.scrollLeft = midX*ratio - rect.width/2;
  stage.scrollTop = midY*ratio - rect.height/2;
}

function bindZoomButtons(){
  const inBtn = el('btnZoomIn'), outBtn = el('btnZoomOut'), resetBtn = el('btnZoomReset');
  if(inBtn) inBtn.onclick = ()=> setCropZoom(cropZoom + ZOOM_STEP);
  if(outBtn) outBtn.onclick = ()=> setCropZoom(cropZoom - ZOOM_STEP);
  if(resetBtn) resetBtn.onclick = ()=> setCropZoom(1);
}

let rotateDebounceTimer = null;
function bindRotateButtons(card){
  // Debounce: kalau user pencet rotate cepat berturut-turut (mis. tap
  // 3x buat muter 270°), rebuildCropStage (yg didalamnya ada
  // autoDetectCrop, paling berat di seluruh alur crop) cuma dijalankan
  // SEKALI, ~180ms setelah klik terakhir -- bukan tiap klik. Ini yg
  // paling kerasa bikin "berat/nge-lag" sebelumnya: tiap klik numpuk
  // kerjaan baru sebelum yg lama sempat selesai, jadi beberapa proses
  // Sobel+Hough berat jalan bertumpuk di main thread yg sama.
  function rotate(delta){
    card.rotation = (((card.rotation||0) + delta) % 360 + 360) % 360;
    clearTimeout(rotateDebounceTimer);
    rotateDebounceTimer = setTimeout(()=>rebuildCropStage(card), 180);
  }
  el('btnRotateLeft').onclick = ()=> rotate(-90);
  el('btnRotateRight').onclick = ()=> rotate(90);
}

function closeCropModal(){
  el('cropModal').style.display = 'none';
  activeCropId = null;
  dragCorner = null;
  hideLoupe(); // jaga-jaga kalau modal ditutup di tengah drag sudut, loupe (skrg child <body>) gak nyangkut kelihatan
  // Kalau ini bagian dari upload banyak sekaligus, lanjut otomatis ke
  // foto berikutnya dalam antrian (baik setelah simpan maupun dilewati).
  advanceCropQueue();
}

// ---- Core edge/gradient computation, shared by detectors ----
// Kernel blur menyesuaikan resolusi kerja: foto lebih besar -> radius blur
// lebih besar juga, supaya tekstur halus (hologram, motif KTP, serat kertas)
// teredam proporsional dan tidak membanjiri Hough dgn garis-garis palsu.
//
// CATATAN: sempat dicoba menggabung channel warna (blueness) LANGSUNG ke
// magnitude gradient di sini -- itu DIBATALKAN krn mengubah skala &
// karakteristik data magnitude scr keseluruhan (bisa naik sampai ~1.9x
// di area yg blueness-nya kuat), yg bikin otsuThreshold & parameter
// Hough yg sudah di-tuning jadi tidak proporsional lagi thd data baru --
// hasilnya malah REGRESI (kotak hijau gagal total, jatuh ke bbox
// fallback yg salah pilih full-frame). Sinyal warna KTP (biru muda
// khas) sekarang HANYA dipakai di cardColorScore sbg tie-breaker
// scoring kandidat quad (lihat pickCardQuadFromLines) -- itu tidak
// mengubah data gradient/threshold sama sekali, jadi jauh lebih aman:
// cuma mempengaruhi kandidat MANA yg menang di antara yg sudah lolos
// filter, bukan mengubah proses deteksi tepi itu sendiri.
function computeEdges(canvas){
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const src = ctx.getImageData(0,0,w,h);

  const gray = new Float32Array(w*h);
  for(let i=0;i<w*h;i++){
    const r=src.data[i*4], g=src.data[i*4+1], b=src.data[i*4+2];
    gray[i] = 0.299*r+0.587*g+0.114*b;
  }

  const blurR = Math.max(1, Math.round(Math.min(w,h)/450));
  const blurred = boxBlur(gray, w, h, blurR);

  const mag = new Float32Array(w*h);
  const ang = new Float32Array(w*h);
  const gx = [-1,0,1,-2,0,2,-1,0,1], gy=[-1,-2,-1,0,0,0,1,2,1];
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      let sx=0, sy=0, k=0;
      for(let dy=-1;dy<=1;dy++){
        for(let dx=-1;dx<=1;dx++){
          const v = blurred[(y+dy)*w+(x+dx)];
          sx += v*gx[k]; sy += v*gy[k]; k++;
        }
      }
      const idx = y*w+x;
      mag[idx] = Math.sqrt(sx*sx+sy*sy);
      ang[idx] = Math.atan2(sy,sx);
    }
  }
  return { w, h, mag, ang, gray, rgbData: src.data };
}

// Separable box blur (horizontal pass lalu vertical pass) -- jauh lebih
// murah dari kernel NxN penuh utk radius besar, sehingga blur adaptif di
// atas tetap cepat walau radius membesar pada foto beresolusi tinggi.
function boxBlur(src, w, h, radius){
  if(radius <= 0) return src.slice();
  const tmp = new Float32Array(w*h);
  const out = new Float32Array(w*h);
  const size = radius*2+1;

  for(let y=0;y<h;y++){
    let sum=0;
    for(let x=-radius;x<=radius;x++){
      sum += src[y*w + Math.min(w-1,Math.max(0,x))];
    }
    for(let x=0;x<w;x++){
      tmp[y*w+x] = sum/size;
      const addX = Math.min(w-1, x+radius+1);
      const remX = Math.max(0, x-radius);
      sum += src[y*w+addX] - src[y*w+remX];
    }
  }
  for(let x=0;x<w;x++){
    let sum=0;
    for(let y=-radius;y<=radius;y++){
      sum += tmp[Math.min(h-1,Math.max(0,y))*w + x];
    }
    for(let y=0;y<h;y++){
      out[y*w+x] = sum/size;
      const addY = Math.min(h-1, y+radius+1);
      const remY = Math.max(0, y-radius);
      sum += tmp[addY*w+x] - tmp[remY*w+x];
    }
  }
  return out;
}

// ---- Threshold Otsu asli dari histogram magnitude gradient ----
// Jauh lebih akurat drpd persentase tetap dari nilai maksimum: nilai
// maksimum gampang jadi outlier (satu piksel silau/pantulan bisa
// mendominasi), sedangkan Otsu mencari titik pemisah yang benar-benar
// memaksimalkan pemisahan antara populasi "tepi" vs "bukan tepi".
// Cari max & build histogram digabung jadi SATU pass (dulu 2 pass
// terpisah) -- optimasi kecil tapi gratis, gak ada trade-off apapun.
function otsuThreshold(mag, w, h){
  let maxMag = 0;
  for(let i=0;i<mag.length;i++) if(mag[i]>maxMag) maxMag=mag[i];
  if(maxMag <= 0) return 0;

  const bins = 256;
  const hist = new Float64Array(bins);
  const scale = (bins-1)/maxMag;
  for(let i=0;i<mag.length;i++){
    hist[(mag[i]*scale)|0]++; // |0 lebih cepat dari Math.round utk truncate ke integer
  }
  const total = w*h;
  let sumAll = 0;
  for(let i=0;i<bins;i++) sumAll += i*hist[i];

  let sumB=0, wB=0, maxVar=0, bestT=0;
  for(let t=0;t<bins;t++){
    wB += hist[t];
    if(wB===0) continue;
    const wF = total-wB;
    if(wF===0) break;
    sumB += t*hist[t];
    const mB = sumB/wB;
    const mF = (sumAll-sumB)/wF;
    const varBetween = wB*wF*(mB-mF)*(mB-mF);
    if(varBetween > maxVar){ maxVar = varBetween; bestT = t; }
  }
  return bestT/scale;
}

// ---- Hough line transform restricted to strong-edge pixels ----
// Dua optimasi penting drpd versi sebelumnya (efek nyata di kecepatan,
// TANPA mengurangi akurasi hasil akhir):
//   1. Titik tepi yg divote DIBATASI ke MAX_EDGE_POINTS terkuat (diambil
//      berdasar magnitude gradient tertinggi), bukan SEMUA titik di atas
//      threshold. Di foto dgn banyak tekstur/noise (background ramai,
//      hologram KTP), jumlah edge point bisa jauh lebih banyak dari yg
//      benar2 dibutuhkan utk menemukan 4 garis lurus dominan -- vote dari
//      titik ke-3001 dst itu kontribusinya marjinal krn garis kartu yg
//      asli sudah pasti kena vote dari titik terkuat duluan. Ini mengubah
//      kompleksitas voting dari "sebanyak apapun edge point yg lolos
//      threshold" (bisa meledak di foto berisik) jadi punya batas atas
//      pasti, tanpa mengorbankan garis yg penting.
//   2. Radius local-maxima suppression diperkecil (5x7, dari 9x13) --
//      cukup utk resolusi kerja 480px yg sudah kecil, mengurangi kerja
//      peak-finding di step berikutnya.
const MAX_EDGE_POINTS = 2000;

function houghLines(mag, w, h, thresh){
  const diag = Math.ceil(Math.sqrt(w*w+h*h));
  const thetaSteps = 180; // 1 degree resolution -- cukup krn refineQuadCorners menempelkan sudut ke tepi tajam setelahnya, jadi presisi sub-derajat di tahap Hough tidak terlalu menentukan hasil akhir.
  const rhoOffset = diag;
  const rhoSize = diag*2;
  const acc = new Int32Array(thetaSteps*rhoSize);

  const cosT = new Float32Array(thetaSteps);
  const sinT = new Float32Array(thetaSteps);
  for(let t=0;t<thetaSteps;t++){
    const rad = (t*Math.PI/thetaSteps);
    cosT[t] = Math.cos(rad);
    sinT[t] = Math.sin(rad);
  }

  // Kumpulkan kandidat edge point (di atas threshold) dgn subsample
  // spasial ringan dulu (step=2 kalau gambar kerja masih >500k piksel --
  // jarang kena krn DETECT_WORK_DIM=480 -> maks ~230k piksel, jadi
  // step=1 di kondisi normal), LALU cap ke MAX_EDGE_POINTS titik
  // terkuat via partial selection (bukan full sort -- lebih murah).
  const step = (w*h > 500000) ? 2 : 1;
  const candX = [], candY = [], candMag = [];
  for(let y=0;y<h;y+=step){
    for(let x=0;x<w;x+=step){
      const m = mag[y*w+x];
      if(m <= thresh) continue;
      candX.push(x); candY.push(y); candMag.push(m);
    }
  }

  let idxList;
  if(candX.length > MAX_EDGE_POINTS){
    // Ambil MAX_EDGE_POINTS indeks dgn magnitude tertinggi lewat full
    // sort (bukan partial-selection sesungguhnya, tp built-in sort
    // engine V8 utk array primitif sudah sangat cepat) -- utk jumlah
    // kandidat yg realistis (puluhan ribu maks stlh subsample), O(n log
    // n) di sini masih jauh lebih murah drpd nge-vote SEMUA titik itu ke
    // akumulator 180 sudut (yg costnya O(n*180)).
    idxList = Array.from(candX, (_,i)=>i);
    idxList.sort((a,b)=>candMag[b]-candMag[a]);
    idxList.length = MAX_EDGE_POINTS;
  }

  const n = idxList ? MAX_EDGE_POINTS : candX.length;
  for(let i=0;i<n;i++){
    const j = idxList ? idxList[i] : i;
    const x = candX[j], y = candY[j];
    for(let t=0;t<thetaSteps;t++){
      const rho = Math.round(x*cosT[t] + y*sinT[t]) + rhoOffset;
      if(rho<0||rho>=rhoSize) continue;
      acc[t*rhoSize+rho]++;
    }
  }

  // find local maxima (peaks) in accumulator -- radius diperkecil (5x7)
  // krn resolusi kerja sudah kecil, peak yg berdekatan jaraknya jg
  // proporsional kecil; tidak mengurangi akurasi, cuma memangkas kerja
  // pencarian yg berlebihan di radius lama (9x13).
  const peaks = [];
  const minVotes = Math.max(18, Math.round(Math.min(w,h)*0.10));
  for(let t=0;t<thetaSteps;t++){
    for(let r=0;r<rhoSize;r++){
      const v = acc[t*rhoSize+r];
      if(v < minVotes) continue;
      let isMax = true;
      for(let dt=-2; dt<=2 && isMax; dt++){
        for(let dr=-3; dr<=3 && isMax; dr++){
          if(dt===0 && dr===0) continue;
          const nt = t+dt, nr = r+dr;
          if(nt<0||nt>=thetaSteps||nr<0||nr>=rhoSize) continue;
          if(acc[nt*rhoSize+nr] > v) isMax = false;
        }
      }
      if(isMax){
        peaks.push({ theta: t*Math.PI/thetaSteps, rho: r-rhoOffset, votes: v });
      }
    }
  }
  peaks.sort((a,b)=>b.votes-a.votes);
  return peaks.slice(0, 80); // keep top candidates
}

// ---- v41 FIX: verifikasi "line support" tiap garis Hough ----
// MASALAH yg dipecahkan: sebuah garis bisa dapat vote lumayan tinggi di
// akumulator Hough padahal cuma didukung oleh SEBAGIAN KECIL titik di
// sepanjang lintasannya (mis. satu blok teks NIK/nama, tepi hologram,
// atau lipatan kertas) -- bukan tepi fisik kartu yg utuh dari ujung ke
// ujung. Vote-based ranking saja tidak bisa membedakan "garis pendek yg
// padat" dari "garis panjang yg didukung tepi asli sepanjang sisi
// kartu", krn akumulator Hough cuma menjumlah, tidak peduli sebaran
// spasialnya. Inilah salah satu penyebab kotak hijau "nyasar" ke garis
// internal kartu (spt kasus KTP yg kedeteksi jadi kotak kecil/miring,
// bukan seluruh badan kartu).
//
// FIX: jalan sepanjang lintasan tiap garis kandidat (step 2px sepanjang
// sumbu yg lebih stabil numeriknya utk orientasi garis tsb) dan hitung
// berapa persen titik yg BENAR2 punya sinyal tepi (magnitude > thresh)
// di sekitarnya (window ±2px tegak lurus). Hasilnya "support ratio"
// 0..1 -- garis tepi kartu asli akan py support tinggi (didukung
// hampir sepanjang lintasan di dalam frame), sedangkan garis dari
// tekstur internal akan py support rendah (cuma padat di satu segmen
// pendek, kosong di sisanya). Dipakai sbg FILTER tambahan sebelum garis
// masuk jadi kandidat sisi kartu di pickCardQuadFromLines -- murah
// (maks 80 peaks x ~240 sample = ~19rb operasi, sekali per deteksi).
function computeLineSupport(peak, mag, w, h, thresh){
  const cosT = Math.cos(peak.theta), sinT = Math.sin(peak.theta);
  let hit = 0, total = 0;
  // Sample di sepanjang sumbu yg py resolusi lebih stabil utk orientasi
  // garis ini (hindari pembagian dgn sin/cos yg mendekati nol).
  if(Math.abs(sinT) >= Math.abs(cosT)){
    for(let x=0; x<w; x+=2){
      const y = (peak.rho - x*cosT)/sinT;
      if(y<0 || y>=h) continue;
      total++;
      const yi = Math.round(y);
      let found = false;
      for(let dy=-2; dy<=2 && !found; dy++){
        const yy = yi+dy;
        if(yy<0||yy>=h) continue;
        if(mag[yy*w+x] > thresh) found = true;
      }
      if(found) hit++;
    }
  } else {
    for(let y=0; y<h; y+=2){
      const x = (peak.rho - y*sinT)/cosT;
      if(x<0 || x>=w) continue;
      total++;
      const xi = Math.round(x);
      let found = false;
      for(let dx=-2; dx<=2 && !found; dx++){
        const xx = xi+dx;
        if(xx<0||xx>=w) continue;
        if(mag[y*w+xx] > thresh) found = true;
      }
      if(found) hit++;
    }
  }
  return total>0 ? hit/total : 0;
}

// Rasio kartu ID-1 (ISO/IEC 7810) yang dipakai KTP Indonesia: 85.6mm x
// 53.98mm. Dipakai buat memvalidasi quad hasil deteksi -- kalau bentuknya
// jauh dari rasio ini, kemungkinan besar itu bukan tepi kartu (mis. tepi
// meja, buku, atau dompet yang ikut kefoto).
const ID_CARD_RATIO = 85.6/53.98; // ~1.586

function quadSideLengths(q){
  const top = Math.hypot(q.tr.x-q.tl.x, q.tr.y-q.tl.y);
  const bottom = Math.hypot(q.br.x-q.bl.x, q.br.y-q.bl.y);
  const left = Math.hypot(q.bl.x-q.tl.x, q.bl.y-q.tl.y);
  const right = Math.hypot(q.br.x-q.tr.x, q.br.y-q.tr.y);
  return { top, bottom, left, right };
}

// Shoelace formula utk luas quad sembarang (bukan cuma jajaran genjang) --
// dipakai buat cross-check luas hasil deteksi Hough thd bboxFallback.
function quadArea(q){
  const pts = [q.tl, q.tr, q.br, q.bl];
  let sum = 0;
  for(let i=0;i<4;i++){
    const a = pts[i], b = pts[(i+1)%4];
    sum += a.x*b.y - b.x*a.y;
  }
  return Math.abs(sum)/2;
}

// Terima quad kalau rasio sisi-panjang/sisi-pendek mendekati rasio kartu
// ID (di orientasi manapun), dgn toleransi longgar krn perspektif miring
// bisa memampatkan salah satu pasangan sisi.
function isPlausibleCardQuad(q){
  const { top, bottom, left, right } = quadSideLengths(q);
  const avgH = (top+bottom)/2, avgV = (left+right)/2;
  if(avgH < 2 || avgV < 2) return false;
  const ratio = Math.max(avgH,avgV) / Math.min(avgH,avgV);
  const tol = 0.30; // ±30% dari rasio ID-1, cukup longgar utk perspektif miring
  if(Math.abs(ratio - ID_CARD_RATIO) > ID_CARD_RATIO*tol) return false;
  // Pasangan sisi berlawanan tidak boleh terlalu njomplang panjangnya
  // (indikasi quad "miring parah"/salah tangkap garis, bukan perspektif wajar)
  if(Math.max(top,bottom)/Math.min(top,bottom) > 1.6) return false;
  if(Math.max(left,right)/Math.min(left,right) > 1.6) return false;
  return true;
}

// ---- Skor kecocokan warna KTP (biru muda-putih khas) ----
// KTP Indonesia py warna dasar yg konsisten & khas: dominan biru muda
// dgn area putih (foto, teks). Fungsi ini sample sejumlah titik di
// dalam quad (grid 6x6=36 titik, MURAH -- bukan scan tiap piksel) dan
// hitung berapa persen yg "masuk akal sbg warna KTP" (biru ATAU putih/
// abu terang netral, BUKAN warna kulit/kayu/kertas cokelat-oranye).
// Dipakai sbg TIE-BREAKER tambahan di scoring kandidat quad -- quad yg
// isinya emang didominasi warna kartu dpt skor lebih tinggi drpd quad
// yg "ketarik" ke area kulit/background di sekitarnya, walau kandidat
// itu py total vote Hough yg mirip.
//
// PENTING (performa): rgbData adalah Uint8ClampedArray HASIL SATU KALI
// ctx.getImageData() utk SELURUH canvas kerja, diambil SEKALI di
// autoDetectCrop lalu di-pass ke sini -- BUKAN dipanggil ulang per
// piksel per kandidat quad. Manggil ctx.getImageData(x,y,1,1) di dalam
// loop (bisa ribuan kali utk ratusan kandidat quad) py overhead API
// yg jauh lebih mahal drpd index array biasa.
// Klasifikasi satu piksel: "masuk akal sbg warna KTP" (biru muda dominan
// ATAU netral terang) vs bukan. Dipakai bareng oleh cardColorScore
// (rata-rata seluruh isi quad) dan nearEdgeColorScore (strip sempit di
// tepi dalam tiap sisi, lihat komentar di bawah).
function isCardLikePixel(rgbData, canvasW, canvasH, px, py){
  if(px<0||px>=canvasW||py<0||py>=canvasH) return null;
  const idx = (py*canvasW + px)*4;
  const r=rgbData[idx], g=rgbData[idx+1], b=rgbData[idx+2];
  const isBluish = (b - r) > 8;
  const isNeutralLight = (Math.max(r,g,b)-Math.min(r,g,b) < 25) && (r+g+b)/3 > 110;
  return isBluish || isNeutralLight;
}

function bilinearQuadPoint(q, u, v){
  const topX = q.tl.x + (q.tr.x-q.tl.x)*u, topY = q.tl.y + (q.tr.y-q.tl.y)*u;
  const botX = q.bl.x + (q.br.x-q.bl.x)*u, botY = q.bl.y + (q.br.y-q.bl.y)*u;
  return { x: Math.round(topX + (botX-topX)*v), y: Math.round(topY + (botY-topY)*v) };
}

function cardColorScore(rgbData, canvasW, canvasH, q){
  const GRID = 6;
  let hit = 0, total = 0;
  for(let iy=0; iy<GRID; iy++){
    for(let ix=0; ix<GRID; ix++){
      // interpolasi bilinear posisi (ix,iy) dlm grid ke koordinat quad
      const u = (ix+0.5)/GRID, v = (iy+0.5)/GRID;
      const pt = bilinearQuadPoint(q, u, v);
      const ok = isCardLikePixel(rgbData, canvasW, canvasH, pt.x, pt.y);
      if(ok===null) continue;
      total++;
      if(ok) hit++;
    }
  }
  return total > 0 ? hit/total : 0;
}

// ---- v42 FIX: verifikasi warna "tepi dalam" per sisi (bukan cuma rata2 seluruh isi quad) ----
// MASALAH yg dipecahkan: cardColorScore lama itu RATA-RATA seluruh isi
// quad. Ini gagal mendeteksi kasus "sisi atas kotak kelewatan jauh ke
// atas kartu (nangkep garis serat meja / pantulan sleeve plastik yg
// kuat & panjang scr kontras, bukan tepi kartu asli)" -- krn walau sisi
// atasnya salah total, SEBAGIAN BESAR isi quad tetap area kartu asli yg
// ikut kebawa (KTP-nya sendiri masih ada di bagian bawah quad), jadi
// rata2 keseluruhan tetap lolos ambang. Garis background yg panjang &
// tegas ini jg py "line support" tinggi (memang garis nyata & terus-
// menerus), jadi lolos jg filter line-support v41 -- makanya perlu
// sinyal independen lain di lapisan berbeda.
//
// FIX: cek warna KHUSUS di jalur sempit TEPAT DI DALAM tiap 1 dari 4
// sisi quad (bukan keseluruhan isi). Kalau sisi kartu terdeteksi benar,
// area sedikit di dalam garis itu HARUS langsung terlihat spt KTP
// (biru/putih) -- kalau sisi itu kelewatan (spt kasus di atas), area
// tepat di dalamnya masih background/meja/pantulan, BUKAN kartu, dan
// itu ketahuan di sini walau rata2 keseluruhan quad masih tinggi.
// Return: skor sisi TERLEMAH (minimum dari 4 sisi) -- satu sisi yg jelas
// salah sudah cukup utk menjatuhkan skor gabungan, sesuai tujuannya sbg
// pendeteksi sisi yg "kelewatan".
function nearEdgeColorScore(rgbData, canvasW, canvasH, q){
  if(!rgbData) return 1; // tanpa data warna, jangan menghukum (netral)
  const ALONG = 6, DEPTH = 2;
  function stripScore(alongIsU, near0){
    let hit=0, total=0;
    for(let i=0;i<ALONG;i++){
      const t = (i+0.5)/ALONG; // posisi sepanjang sisi, 0..1
      for(let j=0;j<DEPTH;j++){
        // masuk sedikit ke DALAM quad dari sisi ini (5% dan 13% dari lebar/tinggi quad)
        const depth = near0 ? (0.05 + j*0.08) : (1 - (0.05 + j*0.08));
        const u = alongIsU ? t : depth;
        const v = alongIsU ? depth : t;
        const pt = bilinearQuadPoint(q, u, v);
        const ok = isCardLikePixel(rgbData, canvasW, canvasH, pt.x, pt.y);
        if(ok===null) continue;
        total++; if(ok) hit++;
      }
    }
    return total>0 ? hit/total : 0;
  }
  const topScore    = stripScore(true, true);   // sepanjang u (horizontal), dekat v=0 (atas)
  const bottomScore = stripScore(true, false);  // dekat v=1 (bawah)
  const leftScore   = stripScore(false, true);  // sepanjang v (vertikal), dekat u=0 (kiri)
  const rightScore  = stripScore(false, false); // dekat u=1 (kanan)
  return Math.min(topScore, bottomScore, leftScore, rightScore);
}



// classify peaks into near-horizontal / near-vertical, then for each side
// try several of the strongest candidate lines (not just the extreme-most
// one) and keep whichever combination yields the most plausible ID-card
// quad. This is far more robust against a single stray strong line (e.g.
// a fold, shadow, or background edge) hijacking the whole detection.
//
// rgbData (opsional): Uint8ClampedArray dari SATU KALI getImageData
// canvas kerja, dipakai cardColorScore sbg tie-breaker warna. Kalau
// tidak di-pass (null), scoring jalan tanpa komponen warna spt
// sebelumnya -- tetap valid, cuma gak dpt bonus akurasi warna.
//
// mag, edgeThresh (opsional): dipakai computeLineSupport utk memfilter
// garis yg vote-nya lumayan tapi tdk benar2 didukung tepi di sepanjang
// lintasannya (lihat komentar computeLineSupport di atas). Kalau tidak
// di-pass, filter ini dilewati (perilaku sama spt sebelum v41).
function pickCardQuadFromLines(peaks, w, h, rgbData, mag, edgeThresh){
  if(!peaks.length) return null;

  // ---- v41 FIX (bug klasifikasi sudut): sebelumnya ada "zona mati"
  // antara 32°-58° dari horizontal yg TIDAK masuk horiz maupun vert --
  // garis apapun yg jatuh di rentang itu dibuang sepenuhnya. Ini fatal
  // utk KTP yg difoto miring/rotasi (umum terjadi krn dipegang tangan):
  // begitu sisi kartu terotasi ke rentang itu, sisi ASLI kartu hilang
  // dari kandidat, dan algoritma terpaksa memilih dari garis internal
  // (teks, hologram, lipatan) yg kebetulan jatuh di bucket horiz/vert --
  // persis pola kegagalan "kotak hijau jadi kecil/miring, nggak nutupin
  // seluruh kartu" yg dilaporkan. FIX: split tegas di 45° tanpa celah,
  // jadi SETIAP garis pasti masuk salah satu bucket (yg mana pun lebih
  // dekat sifatnya thd garis itu), berapapun rotasi kartunya di foto.
  const horiz = [], vert = [];
  for(const p of peaks){
    // theta near 90deg (pi/2) => line ~horizontal; theta near 0/pi => vertical
    const degFromHoriz = Math.abs((p.theta*180/Math.PI) - 90);
    if(degFromHoriz <= 45) horiz.push(p);
    else vert.push(p);
  }

  // ---- v41: filter garis lewat line-support (lihat computeLineSupport) ----
  // Dilakukan SETELAH klasifikasi horiz/vert (bukan sebelum) supaya kalau
  // filter ini membuang terlalu banyak garis di satu sisi, kita masih
  // punya cara aman utk mundur (fallback) ke set yg belum difilter,
  // BUKAN gagal total spt bug lama. Threshold 0.32 dipilih longgar --
  // tujuannya cuma buang garis yg JELAS cuma didukung tekstur lokal
  // (support sangat rendah), bukan menyaring ketat semua kandidat.
  const MIN_LINE_SUPPORT = 0.32;
  let horizFiltered = horiz, vertFiltered = vert;
  if(mag && edgeThresh != null){
    const withSupport = arr => arr.map(p=>{
      if(p.support === undefined) p.support = computeLineSupport(p, mag, w, h, edgeThresh);
      return p;
    }).filter(p=>p.support >= MIN_LINE_SUPPORT);
    const hf = withSupport(horiz);
    const vf = withSupport(vert);
    // Cuma pakai hasil filter kalau MASIH cukup kandidat di kedua sisi --
    // kalau filter terlalu agresif (mis. semua garis kartu emang lemah
    // krn kontras rendah), lebih aman mundur ke set asli drpd gagal total.
    if(hf.length >= 2) horizFiltered = hf;
    if(vf.length >= 2) vertFiltered = vf;
  }
  const horizFinal = horizFiltered.length >= 2 ? horizFiltered : horiz;
  const vertFinal = vertFiltered.length >= 2 ? vertFiltered : vert;

  if(horizFinal.length < 2 || vertFinal.length < 2) return null;

  const withY = horizFinal.map(p=>({...p, yAt0: p.rho / (Math.sin(p.theta)||1e-6) }));
  withY.sort((a,b)=>a.yAt0-b.yAt0);
  const withX = vertFinal.map(p=>({...p, xAt0: p.rho / (Math.cos(p.theta)||1e-6) }));
  withX.sort((a,b)=>a.xAt0-b.xAt0);

  function intersect(l1, l2){
    // l: x*cos(theta)+y*sin(theta) = rho
    const a1=Math.cos(l1.theta), b1=Math.sin(l1.theta), c1=l1.rho;
    const a2=Math.cos(l2.theta), b2=Math.sin(l2.theta), c2=l2.rho;
    const det = a1*b2 - a2*b1;
    if(Math.abs(det) < 1e-6) return null;
    const x = (c1*b2 - c2*b1)/det;
    const y = (a1*c2 - a2*c1)/det;
    return {x,y};
  }

  const pad = Math.max(w,h)*0.06;
  function withinBounds(pt){
    return pt.x >= -pad && pt.x <= w+pad && pt.y >= -pad && pt.y <= h+pad;
  }

  // Kandidat sisi atas: beberapa garis paling atas (yAt0 terkecil) yg
  // punya vote lumayan; sisi bawah: beberapa garis paling bawah. Sama utk
  // kiri/kanan. Membatasi ke ~6 kandidat teratas per sisi (v41: dinaikkan
  // dari 4 -- sekarang aman krn garis lemah/noise sudah disaring duluan
  // oleh line-support filter di atas, jadi menambah kandidat menaikkan
  // peluang nemu kombinasi yg benar tanpa menambah risiko salah pilih).
  // Kombinasi maks 6x6x6x6=1296, masih murah (tiap kombinasi cuma
  // intersect + beberapa perbandingan angka).
  const topCandidates = withY.slice(0, Math.min(6, withY.length));
  const bottomCandidates = withY.slice(-Math.min(6, withY.length)).reverse();
  const leftCandidates = withX.slice(0, Math.min(6, withX.length));
  const rightCandidates = withX.slice(-Math.min(6, withX.length)).reverse();

  let best = null, bestScore = -Infinity;

  for(const top of topCandidates){
    for(const bottom of bottomCandidates){
      if(bottom.yAt0 - top.yAt0 < h*0.3) continue;
      for(const left of leftCandidates){
        for(const right of rightCandidates){
          if(right.xAt0 - left.xAt0 < w*0.3) continue;

          const tl = intersect(top, left);
          const tr = intersect(top, right);
          const br = intersect(bottom, right);
          const bl = intersect(bottom, left);
          if(!tl||!tr||!br||!bl) continue;
          if(![tl,tr,br,bl].every(withinBounds)) continue;

          const area = Math.abs((tr.x-tl.x)*(bl.y-tl.y) - (bl.x-tl.x)*(tr.y-tl.y));
          if(area > w*h*1.15 || area < w*h*0.10) continue;

          const quad = { tl, tr, br, bl };
          if(!isPlausibleCardQuad(quad)) continue;

          // Score: total Hough votes (garis yg lebih kuat/panjang lebih
          // dipercaya) + bonus utk quad yg rasio aspeknya paling dekat
          // ke rasio kartu ID sebenarnya + bonus warna rata2 isi quad +
          // bonus warna TEPI DALAM per sisi (v42, lihat nearEdgeColorScore
          // -- ini penentu utama utk menolak sisi yg "kelewatan" ke garis
          // background yg kuat/panjang, spt garis serat meja/pantulan
          // sleeve plastik, krn sinyal itu tdk tertangkap rata2 keseluruhan).
          const { top:t2, bottom:b2, left:l2, right:r2 } = quadSideLengths(quad);
          const avgH = (t2+b2)/2, avgV = (l2+r2)/2;
          const ratio = Math.max(avgH,avgV)/Math.min(avgH,avgV);
          const ratioScore = 1 - Math.min(1, Math.abs(ratio-ID_CARD_RATIO)/(ID_CARD_RATIO*0.30));
          const voteScore = (top.votes+bottom.votes+left.votes+right.votes);
          let score = voteScore + ratioScore*voteScore*0.5;
          if(rgbData){
            const colorScore = cardColorScore(rgbData, w, h, quad);
            const edgeScore = nearEdgeColorScore(rgbData, w, h, quad);
            score += colorScore*voteScore*0.6;
            // Bobot edgeScore dibuat LEBIH BESAR drpd colorScore biasa --
            // ini sinyal paling langsung utk membedakan "sisi pas di tepi
            // kartu" dari "sisi kelewatan ke background", jadi harus jadi
            // faktor penentu, bukan sekadar tie-breaker kecil.
            score += edgeScore*voteScore*1.1;
            // Kalau tepi dalam salah satu sisi jelas2 bukan warna kartu
            // sama sekali (mis. sisi itu masih murni meja/pantulan),
            // diskualifikasi total drpd cuma dikurangi skornya -- kandidat
            // sekelewatan itu tidak boleh menang lawan kandidat yg lebih
            // masuk akal walau vote Hough-nya lebih rendah.
            if(edgeScore < 0.15) continue;
          }

          if(score > bestScore){ bestScore = score; best = quad; }
        }
      }
    }
  }

  return best;
}

// ---- Refine tiap sudut quad hasil Hough dgn mencari titik gradient
// magnitude terkuat di jendela kecil di sekitarnya. Garis Hough adalah
// estimasi statistik dari keseluruhan sisi -- sudut kartu fisik yang
// sebenarnya (terutama kalau kartu sedikit melengkung / foto dari sudut)
// bisa meleset beberapa piksel dari titik potong murni. Ini "menempelkan"
// tiap sudut ke tepi tajam terdekat, hasilnya jauh lebih presisi. ----
function refineCorner(pt, mag, w, h, radius){
  let bestX = pt.x, bestY = pt.y, bestMag = -1;
  const x0 = Math.max(1, Math.round(pt.x-radius));
  const x1 = Math.min(w-2, Math.round(pt.x+radius));
  const y0 = Math.max(1, Math.round(pt.y-radius));
  const y1 = Math.min(h-2, Math.round(pt.y+radius));
  for(let y=y0;y<=y1;y++){
    for(let x=x0;x<=x1;x++){
      const v = mag[y*w+x];
      if(v > bestMag){ bestMag = v; bestX = x; bestY = y; }
    }
  }
  // Kalau tidak ada sinyal tepi yang berarti di jendela ini, jangan
  // geser sama sekali -- lebih aman pakai estimasi Hough drpd nyasar ke
  // noise.
  if(bestMag <= 0) return pt;
  return { x: bestX, y: bestY };
}

function refineQuadCorners(quad, mag, w, h){
  const radius = Math.max(4, Math.round(Math.min(w,h)*0.012));
  const refined = {};
  for(const k of ['tl','tr','br','bl']){
    refined[k] = refineCorner(quad[k], mag, w, h, radius);
  }
  return refined;
}

// Fallback: robust bounding box via row/col energy projection (previous method)
// rgbData (opsional, v42): dipakai utk refine batas hasil proyeksi energi
// tepi dgn sinyal warna KTP -- lihat komentar di blok refinement di bawah.
function bboxFallback(mag, w, h, rgbData){
  let maxMag = 0;
  for(let i=0;i<mag.length;i++) if(mag[i]>maxMag) maxMag=mag[i];
  const thresh = maxMag*0.18;

  const colSum = new Float32Array(w);
  const rowSum = new Float32Array(h);
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const v = mag[y*w+x] > thresh ? 1 : 0;
      colSum[x]+=v; rowSum[y]+=v;
    }
  }

  // Kalau nyaris nggak ada sinyal tepi di sumbu ini (mis. bagian
  // atas/bawah foto sudah full KTP, nggak ada background yang
  // kelihatan), itu artinya KTP MEMENUHI frame di sumbu tsb — jadi
  // batasnya harus full 0..len, BUKAN dipotong paksa ke 6%/94% (itu
  // yang bikin hasil crop kepotong dikit padahal fotonya udah pas/full).
  function findBounds(arr, len){
    const total = arr.reduce((a,b)=>a+b,0);
    if(total < 5) return [0, len];
    const target = total*0.02;
    let acc=0, start=0;
    for(let i=0;i<len;i++){ acc+=arr[i]; if(acc>=target){ start=i; break; } }
    acc=0; let end=len-1;
    for(let i=len-1;i>=0;i--){ acc+=arr[i]; if(acc>=target){ end=i; break; } }
    if(end<=start) return [0, len];
    return [start,end];
  }

  let [x0,x1] = findBounds(colSum, w);
  let [y0,y1] = findBounds(rowSum, h);

  const detW = x1-x0, detH = y1-y0;
  const isFullFrameX = (x0===0 && x1===w) || detW < w*0.25;
  const isFullFrameY = (y0===0 && y1===h) || detH < h*0.25;
  if(detW < w*0.25 || detH < h*0.25){
    x0 = 0; x1 = w;
    y0 = 0; y1 = h;
  }

  // ---- v42 FIX: refine tiap batas dgn sinyal warna KTP ----
  // MASALAH yg dipecahkan: proyeksi energi tepi (colSum/rowSum di atas)
  // memotong berdasar "2% pertama energi tepi dari tiap ujung" -- itu
  // TIDAK PEDULI apakah tepi itu tepi kartu asli atau garis background
  // yg kuat (serat meja, pantulan sleeve plastik). Kalau garis
  // background itu ada dekat salah satu ujung foto, bbox ini bisa
  // "kebawa" sama persis spt masalah yg terjadi di Hough (bboxFallback
  // ini kan jadi safety-net terakhir kalau Hough dianggap tidak
  // dipercaya -- percuma kalau safety-net-nya py kelemahan yg sama).
  //
  // FIX: geser tiap batas ke DALAM (maks ~35% dari lebar/tinggi
  // terdeteksi) sampai ketemu baris/kolom yg isinya sudah cukup terlihat
  // spt warna khas KTP (biru muda/putih). Kalau baris/kolom awal SUDAH
  // spt itu, tidak digeser sama sekali (tidak ada regresi). Kalau tidak
  // ketemu sampai batas maksimal geser, biarkan batas asli (lebih aman
  // drpd menggeser tanpa dasar yg jelas). Dilewati kalau axis itu sudah
  // "full frame" (kartu memenuhi sisi tsb, tidak ada yg perlu digeser).
  if(rgbData){
    const isCardAt = (x,y) => isCardLikePixel(rgbData, w, h, x, y);
    function rowCardFraction(y, xa, xb){
      let hit=0, total=0;
      for(let x=Math.round(xa); x<=Math.round(xb); x+=3){
        const ok = isCardAt(x, y);
        if(ok===null) continue;
        total++; if(ok) hit++;
      }
      return total>0 ? hit/total : 0;
    }
    function colCardFraction(x, ya, yb){
      let hit=0, total=0;
      for(let y=Math.round(ya); y<=Math.round(yb); y+=3){
        const ok = isCardAt(x, y);
        if(ok===null) continue;
        total++; if(ok) hit++;
      }
      return total>0 ? hit/total : 0;
    }
    const CARD_ROW_FRAC = 0.35;
    if(!isFullFrameY){
      const maxShift = Math.round((y1-y0)*0.35);
      if(rowCardFraction(y0, x0, x1) < CARD_ROW_FRAC){
        for(let dy=1; dy<=maxShift; dy++){
          if(rowCardFraction(y0+dy, x0, x1) >= CARD_ROW_FRAC){ y0 = y0+dy; break; }
        }
      }
      if(rowCardFraction(y1, x0, x1) < CARD_ROW_FRAC){
        for(let dy=1; dy<=maxShift; dy++){
          if(rowCardFraction(y1-dy, x0, x1) >= CARD_ROW_FRAC){ y1 = y1-dy; break; }
        }
      }
    }
    if(!isFullFrameX){
      const maxShift = Math.round((x1-x0)*0.35);
      if(colCardFraction(x0, y0, y1) < CARD_ROW_FRAC){
        for(let dx=1; dx<=maxShift; dx++){
          if(colCardFraction(x0+dx, y0, y1) >= CARD_ROW_FRAC){ x0 = x0+dx; break; }
        }
      }
      if(colCardFraction(x1, y0, y1) < CARD_ROW_FRAC){
        for(let dx=1; dx<=maxShift; dx++){
          if(colCardFraction(x1-dx, y0, y1) >= CARD_ROW_FRAC){ x1 = x1-dx; break; }
        }
      }
    }
  }

  // Padding tipis ke dalam supaya nggak makan tepi fisik KTP — tapi
  // kalau bound sudah full frame (0..len, artinya KTP memenuhi sisi
  // itu), jangan dipangkas lagi, biar hasil crop-nya full sesuai foto.
  const padX = (x0===0 && x1===w) ? 0 : (x1-x0)*0.012;
  const padY = (y0===0 && y1===h) ? 0 : (y1-y0)*0.012;
  x0+=padX; x1-=padX; y0+=padY; y1-=padY;

  return { tl:{x:x0,y:y0}, tr:{x:x1,y:y0}, br:{x:x1,y:y1}, bl:{x:x0,y:y1} };
}

// Threshold Hough SATU level (bukan coba ketat-dulu-baru-longgar spt
// versi sebelumnya, yg bisa menjalankan Hough voting 2x penuh) -- dgn
// MAX_EDGE_POINTS di houghLines yg membatasi jumlah titik yg divote ke
// titik2 magnitude TERKUAT, threshold menengah-longgar (0.15) sudah
// cukup robust utk kedua kondisi kontras: kalau kontras KTP-vs-
// background bagus, titik terkuat yg masuk otomatis didominasi tepi
// kartu asli; kalau kontras lemah, threshold longgar ini tetap
// menangkap tepi yg agak samar. Ini memangkas beban Hough voting sampai
// HALF di kasus yg dulu perlu 2 percobaan, tanpa mengurangi akurasi.
const HOUGH_THRESH_LEVEL = 0.15;

// Deteksi tepi (Sobel+Hough) dijalankan di resolusi kerja terpisah yang
// JAUH lebih kecil dari canvas tampilan (900px) -- proses O(w*h) Sobel
// dan O(edge_pixels * 180_sudut) Hough itu kuadratik terhadap resolusi,
// jadi turun dari 900px ke 480px saja sudah memangkas beban kerja
// sekitar 3.5x (900²/480² ≈ 3.5). Hasil quad lalu di-scale balik ke
// resolusi 900px sebelum dipakai sbg overlay/crop -- akurasi akhir tidak
// berkurang berarti karena refineQuadCorners tetap menempelkan sudut ke
// tepi tajam, dan crop final selalu diambil dari rawImg beresolusi penuh
// (lihat applyPerspectiveCrop), bukan dari canvas kerja 480px ini.
const DETECT_WORK_DIM = 480;

function buildDetectionCanvas(canvas){
  const scale = Math.min(1, DETECT_WORK_DIM / Math.max(canvas.width, canvas.height));
  if(scale >= 1) return { detCanvas: canvas, detScale: 1 };
  const detCanvas = document.createElement('canvas');
  detCanvas.width = Math.max(1, Math.round(canvas.width*scale));
  detCanvas.height = Math.max(1, Math.round(canvas.height*scale));
  const dctx = detCanvas.getContext('2d');
  dctx.drawImage(canvas, 0, 0, detCanvas.width, detCanvas.height);
  return { detCanvas, detScale: scale };
}

function scaleQuad(quad, factor){
  const out = {};
  for(const k of ['tl','tr','br','bl']){
    out[k] = { x: quad[k].x/factor, y: quad[k].y/factor };
  }
  return out;
}

function autoDetectCrop(){
  const canvas = cropSourceCanvas;
  const runToken = ++cropDetectRunToken; // batalkan hasil kalau modal sudah pindah foto/rotasi sebelum proses ini selesai
  setCropDetecting(true);

  // requestAnimationFrame supaya browser sempat render badge "mendeteksi"
  // dulu sebelum komputasi Sobel+Hough mem-blok main thread sesaat --
  // tanpa ini UI terasa nge-freeze walau cuma beberapa puluh ms.
  requestAnimationFrame(()=>{
    if(runToken !== cropDetectRunToken) return;

    let quad = null;
    try{
      const { detCanvas, detScale } = buildDetectionCanvas(canvas);
      const { w, h, mag, rgbData } = computeEdges(detCanvas);
      const otsu = otsuThreshold(mag, w, h);

      const edgeThresh = otsu*HOUGH_THRESH_LEVEL;
      const peaks = houghLines(mag, w, h, edgeThresh);
      quad = pickCardQuadFromLines(peaks, w, h, rgbData, mag, edgeThresh);

      // ---- v41 FIX: cross-check quad Hough thd bboxFallback ----
      // MASALAH yg dipecahkan: pickCardQuadFromLines bisa saja menemukan
      // 4 garis yg SECARA INTERNAL konsisten (lolos rasio ID-card, lolos
      // area 10%-115%) tapi SALAH SECARA GLOBAL -- mis. quad kecil yg
      // cuma menutupi sebagian kartu, krn 4 garis itu kebetulan cocok
      // satu sama lain walau bukan tepi kartu yg sebenarnya. Vote +
      // rasio + warna dari pickCardQuadFromLines semua "self-referential"
      // (dihitung dari quad itu sendiri) sehingga tidak bisa menangkap
      // kesalahan sistemik jenis ini.
      //
      // FIX: bboxFallback pakai metode yg SAMA SEKALI independen (proyeksi
      // energi tepi per baris/kolom, bukan Hough+garis), jadi cocok jadi
      // pembanding silang yg jujur. Kalau luas quad Hough jauh lebih kecil
      // / lebih besar drpd estimasi bbox (rentang longgar 0.5x-1.7x, krn
      // bbox itu sendiri cuma axis-aligned & bisa sedikit meleset di kartu
      // yg miring), ATAU skor warna isi quad terlalu rendah utk terlihat
      // spt KTP (dominan biru-putih), quad Hough dianggap tidak
      // dipercaya dan kita pakai bboxFallback yg lebih aman sbg gantinya.
      // bbox dihitung SEKALI di sini dan dipakai ulang di bawah (overshoot
      // check) supaya tidak menghitung proyeksi energi dua kali.
      const bboxCandidate = bboxFallback(mag, w, h, rgbData);
      if(quad){
        const bboxArea = Math.abs(bboxCandidate.tr.x-bboxCandidate.tl.x) * Math.abs(bboxCandidate.bl.y-bboxCandidate.tl.y);
        const hArea = quadArea(quad);
        const areaRatio = bboxArea > 0 ? hArea/bboxArea : 1;
        const colorScore = rgbData ? cardColorScore(rgbData, w, h, quad) : 1;
        // v42: tambah nearEdgeColorScore sbg kondisi kecurigaan tambahan --
        // ini menangkap kasus "salah satu sisi kelewatan ke garis
        // background yg kuat" yg lolos dari areaRatio & colorScore rata2
        // (krn sebagian besar isi quad tetap kartu asli, cuma satu sisi
        // yg salah). Threshold di sini (0.2) sedikit lebih longgar drpd
        // yg dipakai sbg diskualifikasi kandidat di pickCardQuadFromLines
        // (0.15), krn ini pengecekan terakhir stlh quad "terbaik" terpilih
        // -- kalau msh serendah ini stlh lolos seleksi, memang patut curiga.
        const edgeScore = rgbData ? nearEdgeColorScore(rgbData, w, h, quad) : 1;
        const suspicious = areaRatio < 0.5 || areaRatio > 1.7 || colorScore < 0.4 || edgeScore < 0.2;
        if(suspicious) quad = null;
      }

      if(quad){
        quad = refineQuadCorners(quad, mag, w, h);
      } else {
        quad = bboxCandidate;
      }

      // Scale balik ke resolusi canvas tampilan (900px) kalau deteksi
      // tadi dijalankan di canvas kerja yg lebih kecil.
      if(detScale < 1){
        quad = scaleQuad(quad, detScale);
      }

      const cx = (quad.tl.x+quad.tr.x+quad.br.x+quad.bl.x)/4;
      const cy = (quad.tl.y+quad.tr.y+quad.br.y+quad.bl.y)/4;
      const padFactor = 0.985;
      for(const k of ['tl','tr','br','bl']){
        quad[k].x = cx + (quad[k].x-cx)*padFactor;
        quad[k].y = cy + (quad[k].y-cy)*padFactor;
      }

      // clamp ke bound canvas tampilan -- kalau masih overshoot stlh
      // clamp (tanda garis yg kedeteksi memang bermasalah), lebih aman
      // jatuh ke bbox fallback drpd nampilin kotak yg jelas salah.
      const overshoots = ['tl','tr','br','bl'].some(k=>
        quad[k].x < -2 || quad[k].x > canvas.width+2 || quad[k].y < -2 || quad[k].y > canvas.height+2
      );
      if(overshoots){
        // Pakai bboxCandidate yg sudah dihitung di atas (JANGAN panggil
        // bboxFallback/computeEdges ulang -- proyeksi energi & Sobel itu
        // proses yg cukup mahal, gak perlu dihitung dua kali cuma buat
        // fallback ini).
        let bb = bboxCandidate;
        if(detScale < 1) bb = scaleQuad(bb, detScale);
        quad = bb;
      }
      for(const k of ['tl','tr','br','bl']){
        quad[k].x = Math.max(0, Math.min(canvas.width, quad[k].x));
        quad[k].y = Math.max(0, Math.min(canvas.height, quad[k].y));
      }
    }catch(err){
      console.error('autoDetectCrop gagal, fallback ke crop penuh:', err);
      quad = { tl:{x:0,y:0}, tr:{x:canvas.width,y:0}, br:{x:canvas.width,y:canvas.height}, bl:{x:0,y:canvas.height} };
    }

    if(runToken !== cropDetectRunToken) return;
    cropQuad = quad;
    setCropDetecting(false);
    drawCropOverlay();
  });
}

// ---- Indikator "mendeteksi tepi..." di crop stage. Deteksi otomatis
// bisa makan beberapa ratus ms pada foto resolusi tinggi -- tanpa
// indikator ini, jeda tsb terasa seperti aplikasi macet, terutama di HP
// yg kurang kencang. ----
function setCropDetecting(isDetecting){
  const stage = el('cropStage');
  if(!stage) return;
  let badge = el('cropDetectingBadge');
  if(isDetecting){
    if(!badge){
      badge = document.createElement('div');
      badge.id = 'cropDetectingBadge';
      badge.className = 'crop-detecting-badge';
      badge.innerHTML = '<span class="crop-detecting-dot"></span> Mendeteksi tepi KTP...';
      stage.appendChild(badge);
    }
    badge.style.display = 'flex';
  } else if(badge){
    badge.style.display = 'none';
  }
}

function drawCropOverlay(){
  const canvas = cropSourceCanvas;
  const ctx = canvas.getContext('2d');
  const card = cards.find(c=>c.id===activeCropId);
  const w = canvas.width, h = canvas.height;

  ctx.clearRect(0,0,w,h);
  const rot = ((card.rotation||0) % 360 + 360) % 360;
  const swapped = (rot === 90 || rot === 270);
  ctx.save();
  ctx.translate(w/2, h/2);
  ctx.rotate(rot*Math.PI/180);
  if(swapped){
    ctx.drawImage(card.rawImg, -h/2, -w/2, h, w);
  } else {
    ctx.drawImage(card.rawImg, -w/2, -h/2, w, h);
  }
  ctx.restore();

  // draw quad
  const q = cropQuad;
  ctx.save();
  ctx.strokeStyle = '#238636';
  ctx.lineWidth = 2.5;
  ctx.fillStyle = 'rgba(35,134,54,0.16)';
  ctx.beginPath();
  ctx.moveTo(q.tl.x,q.tl.y);
  ctx.lineTo(q.tr.x,q.tr.y);
  ctx.lineTo(q.br.x,q.br.y);
  ctx.lineTo(q.bl.x,q.bl.y);
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  // corner handles
  ctx.fillStyle = '#238636';
  [q.tl,q.tr,q.br,q.bl].forEach(pt=>{
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 9, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.stroke();
  });
  ctx.restore();
}

let dragCorner = null;

// ---- Magnifier loupe: kaca pembesar kecil yg muncul & mengikuti
// jari/kursor selagi drag sudut kotak hijau, menampilkan area di sekitar
// titik yg digeser dalam pembesaran 3x. Ini standar UX crop-tool kelas
// atas (iOS Files/Photos, Adobe Scan) -- tanpa ini, presisi drag di HP
// terbatas oleh ukuran jari yg menutupi area kecil yg mau dipas-kan;
// dengan loupe, user bisa lihat persis pixel tepi kartu walau jari
// menutupi titik aslinya. ----
const LOUPE_SIZE = 132;   // diameter loupe on-screen (px CSS) — HARUS sama dgn width/height di CSS .crop-loupe
const LOUPE_ZOOM = 3;     // faktor pembesaran konten di dalam loupe
// Catatan: geser loupe ke atas titik sentuh (biar gak ketutup jari)
// SEPENUHNYA diatur lewat CSS transform di .crop-loupe (translate
// -100% + jarak tambahan), BUKAN di sini -- dulu ada offset manual di
// JS yg tumpang tindih dgn transform CSS, itu bikin loupe nongol
// melenceng jauh dari titik yg digeser (dobel-geser).

function ensureLoupeEl(){
  let loupe = el('cropLoupe');
  if(!loupe){
    // Ditempel ke <body> (bukan sbg child #cropStage) dgn position:fixed
    // -- ini SENGAJA, bukan sembarang pilihan. #cropStage py overflow:auto
    // (bisa discroll manual), dan elemen position:absolute di dalam
    // container yg scrollable dihitung relatif thd CONTENT BOX container
    // (termasuk area yg sudah discroll keluar dari pandangan), BUKAN
    // relatif thd viewport yg keliatan. getBoundingClientRect() yg
    // dipakai buat menghitung posisi loupe itu selalu berbasis viewport
    // -- kalau loupe taruh di dalam #cropStage sbg absolute, dua sistem
    // koordinat itu gak nyambung begitu user scroll/zoom crop-stage,
    // hasilnya loupe nongol di tempat yg salah (persis bug yg kejadian).
    // Solusinya: position:fixed langsung ke body, sistem koordinatnya
    // otomatis selalu berbasis viewport, sama persis dgn
    // getBoundingClientRect() -- gak ada lagi konversi yg bisa meleset.
    loupe = document.createElement('div');
    loupe.id = 'cropLoupe';
    loupe.className = 'crop-loupe';
    loupe.innerHTML = '<canvas id="cropLoupeCanvas"></canvas><div class="crop-loupe-cross"></div>';
    document.body.appendChild(loupe);
  }
  return loupe;
}

function showLoupe(canvas, pos){
  const loupe = ensureLoupeEl();
  const loupeCanvas = el('cropLoupeCanvas');
  loupeCanvas.width = LOUPE_SIZE;
  loupeCanvas.height = LOUPE_SIZE;
  const lctx = loupeCanvas.getContext('2d');
  lctx.imageSmoothingEnabled = false; // pixelated crisp, biar tepi kartu kelihatan tajam bukan blur

  const srcSize = LOUPE_SIZE/LOUPE_ZOOM;
  const sx = pos.x - srcSize/2, sy = pos.y - srcSize/2;
  lctx.clearRect(0,0,LOUPE_SIZE,LOUPE_SIZE);
  lctx.drawImage(canvas, sx, sy, srcSize, srcSize, 0, 0, LOUPE_SIZE, LOUPE_SIZE);

  // Gambar ulang posisi quad (relatif ke crop area yg diperbesar) di atas
  // konten loupe, supaya user lihat persis sudut hijau vs tepi fisik
  // kartu dalam pembesaran -- bukan cuma foto polos tanpa marker.
  const q = cropQuad;
  if(q && dragCorner){
    const pt = q[dragCorner];
    const lx = (pt.x - sx) * LOUPE_ZOOM;
    const ly = (pt.y - sy) * LOUPE_ZOOM;
    lctx.strokeStyle = '#238636';
    lctx.lineWidth = 2;
    lctx.beginPath();
    lctx.arc(lx, ly, 7, 0, Math.PI*2);
    lctx.stroke();
    lctx.fillStyle = 'rgba(35,134,54,0.9)';
    lctx.beginPath();
    lctx.arc(lx, ly, 2.5, 0, Math.PI*2);
    lctx.fill();
  }

  // Posisi loupe di layar: position:fixed thd viewport, jadi cukup
  // pakai getBoundingClientRect() canvas langsung -- gak perlu lagi
  // ngurusin offset/scroll #cropStage sama sekali (lihat catatan di
  // ensureLoupeEl kenapa loupe ditempel ke <body>, bukan ke stage).
  const rect = canvas.getBoundingClientRect();
  const cssX = rect.left + (pos.x / canvas.width) * rect.width;
  const cssY = rect.top + (pos.y / canvas.height) * rect.height;

  loupe.style.left = cssX + 'px';
  loupe.style.top = cssY + 'px';
  loupe.style.display = 'block';
}

function hideLoupe(){
  const loupe = el('cropLoupe');
  if(loupe) loupe.style.display = 'none';
}

function bindCropDrag(canvas){
  function getPos(e){
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width/rect.width, scaleY = canvas.height/rect.height;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x:(clientX-rect.left)*scaleX, y:(clientY-rect.top)*scaleY };
  }
  function nearestCorner(pos){
    const q = cropQuad;
    let best=null, bestD=Infinity;
    for(const key of ['tl','tr','br','bl']){
      const d = Math.hypot(q[key].x-pos.x, q[key].y-pos.y);
      if(d<bestD){bestD=d;best=key;}
    }
    return bestD < 40 ? best : null;
  }
  function start(e){
    const pos = getPos(e);
    dragCorner = nearestCorner(pos);
    if(dragCorner) showLoupe(canvas, pos);
  }
  let moveRaf = null;
  function move(e){
    if(!dragCorner) return;
    e.preventDefault();
    const pos = getPos(e);
    cropQuad[dragCorner].x = Math.max(0, Math.min(canvas.width, pos.x));
    cropQuad[dragCorner].y = Math.max(0, Math.min(canvas.height, pos.y));
    // Throttle lewat requestAnimationFrame -- event mousemove/touchmove
    // bisa nembak jauh lebih cepat dari refresh rate layar (terutama di
    // trackpad/mouse presisi tinggi), redraw+loupe tiap event numpuk
    // kerjaan yg gak perlu. rAF memastikan cuma 1 redraw per frame.
    if(moveRaf) return;
    moveRaf = requestAnimationFrame(()=>{
      moveRaf = null;
      drawCropOverlay();
      showLoupe(canvas, pos);
    });
  }
  function end(){ dragCorner = null; hideLoupe(); if(moveRaf){ cancelAnimationFrame(moveRaf); moveRaf=null; } }

  canvas.onmousedown = start;
  canvas.onmousemove = move;
  window.onmouseup = end;
  canvas.ontouchstart = start;
  canvas.ontouchmove = move;
  canvas.ontouchend = end;
}

// Perspective-correct unwarp: maps the (possibly skewed) quad to a
// perfect rectangle using a full projective transform, instead of
// the old axis-aligned bbox+rotate approach. This straightens KTP
// photos taken at an angle far better than a simple crop+rotate.
function computePerspectiveTransform(src, dst){
  // src, dst: arrays of 4 {x,y} points (tl,tr,br,bl)
  // Solve for 8-parameter homography mapping src->dst using DLT (4 point pairs, 8 eqns)
  const A = [];
  const bvec = [];
  for(let i=0;i<4;i++){
    const {x:sx, y:sy} = src[i];
    const {x:dx, y:dy} = dst[i];
    A.push([sx, sy, 1, 0, 0, 0, -sx*dx, -sy*dx]); bvec.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -sx*dy, -sy*dy]); bvec.push(dy);
  }
  const h = solveLinearSystem(A, bvec); // [a,b,c,d,e,f,g,h_]
  if(!h) return null;
  return [h[0],h[1],h[2], h[3],h[4],h[5], h[6],h[7], 1];
}

function solveLinearSystem(A, b){
  const n = A.length;
  const M = A.map((row,i)=>[...row, b[i]]);
  for(let col=0; col<n; col++){
    let pivot = col;
    for(let r=col+1;r<n;r++) if(Math.abs(M[r][col])>Math.abs(M[pivot][col])) pivot=r;
    if(Math.abs(M[pivot][col]) < 1e-10) return null;
    [M[col],M[pivot]] = [M[pivot],M[col]];
    const pv = M[col][col];
    for(let c=col;c<=n;c++) M[col][c] /= pv;
    for(let r=0;r<n;r++){
      if(r===col) continue;
      const factor = M[r][col];
      if(factor===0) continue;
      for(let c=col;c<=n;c++) M[r][c] -= factor*M[col][c];
    }
  }
  return M.map(row=>row[n]);
}

function warpPerspective(srcCanvas, srcQuad, outW, outH){
  const dst = [ {x:0,y:0}, {x:outW,y:0}, {x:outW,y:outH}, {x:0,y:outH} ];
  const src = [ srcQuad.tl, srcQuad.tr, srcQuad.br, srcQuad.bl ];
  const H = computePerspectiveTransform(dst, src); // dst->src (inverse mapping for sampling)
  if(!H) return null;

  const sctx = srcCanvas.getContext('2d');
  const srcData = sctx.getImageData(0,0,srcCanvas.width,srcCanvas.height);
  const sw = srcCanvas.width, sh = srcCanvas.height;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW; outCanvas.height = outH;
  const octx = outCanvas.getContext('2d');
  const outData = octx.createImageData(outW, outH);

  for(let y=0;y<outH;y++){
    for(let x=0;x<outW;x++){
      const denom = H[6]*x + H[7]*y + H[8];
      const sx = (H[0]*x + H[1]*y + H[2]) / denom;
      const sy = (H[3]*x + H[4]*y + H[5]) / denom;

      const oi = (y*outW+x)*4;
      if(sx<0||sx>=sw-1||sy<0||sy>=sh-1){
        outData.data[oi]=255; outData.data[oi+1]=255; outData.data[oi+2]=255; outData.data[oi+3]=255;
        continue;
      }
      // bilinear sample
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(x0+1, sw-1), y1 = Math.min(y0+1, sh-1);
      const fx = sx-x0, fy = sy-y0;
      for(let c=0;c<4;c++){
        const p00 = srcData.data[(y0*sw+x0)*4+c];
        const p10 = srcData.data[(y0*sw+x1)*4+c];
        const p01 = srcData.data[(y1*sw+x0)*4+c];
        const p11 = srcData.data[(y1*sw+x1)*4+c];
        const top = p00*(1-fx)+p10*fx;
        const bot = p01*(1-fx)+p11*fx;
        outData.data[oi+c] = top*(1-fy)+bot*fy;
      }
    }
  }
  octx.putImageData(outData, 0, 0);
  return outCanvas;
}

function saveCrop(){
  const card = cards.find(c=>c.id===activeCropId);
  const rot = ((card.rotation||0) % 360 + 360) % 360;
  const swapped = (rot === 90 || rot === 270);

  // Build full-resolution rotated source canvas matching the same rotation
  // applied to the working preview, so the crop quad (drawn in working-canvas
  // space) maps correctly back onto it.
  const fw = card.rawImg.width, fh = card.rawImg.height;
  const rotatedFw = swapped ? fh : fw;
  const rotatedFh = swapped ? fw : fh;

  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = rotatedFw; fullCanvas.height = rotatedFh;
  const fctx = fullCanvas.getContext('2d');
  fctx.save();
  fctx.translate(rotatedFw/2, rotatedFh/2);
  fctx.rotate(rot*Math.PI/180);
  if(swapped){
    fctx.drawImage(card.rawImg, -rotatedFh/2, -rotatedFw/2, rotatedFh, rotatedFw);
  } else {
    fctx.drawImage(card.rawImg, -rotatedFw/2, -rotatedFh/2, rotatedFw, rotatedFh);
  }
  fctx.restore();

  // Map crop quad (in working-canvas space) back to full-res rotated space
  const wc = cropSourceCanvas.width, hc = cropSourceCanvas.height;
  const sx = rotatedFw/wc, sy = rotatedFh/hc;

  const q = cropQuad;
  const fullQuad = {
    tl:{x:q.tl.x*sx, y:q.tl.y*sy},
    tr:{x:q.tr.x*sx, y:q.tr.y*sy},
    br:{x:q.br.x*sx, y:q.br.y*sy},
    bl:{x:q.bl.x*sx, y:q.bl.y*sy},
  };

  // Perspective-unwarp the (possibly skewed) quad straight into a clean
  // 13.5:9 landscape rectangle — this alone straightens tilted photos,
  // so no separate fine-rotation step is needed.
  const targetAspect = CARD_W_CM/CARD_H_CM; // KTP dicetak dalam rasio aslinya (1.5:1)
  const outW = 1350, outH = Math.round(outW/targetAspect); // high-res base for crisp printing

  let resultCanvas = warpPerspective(fullCanvas, fullQuad, outW, outH);
  if(!resultCanvas){
    // fallback: simple axis-aligned crop+stretch (previous behavior) if homography fails
    resultCanvas = document.createElement('canvas');
    resultCanvas.width = outW; resultCanvas.height = outH;
    const rctx = resultCanvas.getContext('2d');
    const x0 = Math.min(fullQuad.tl.x,fullQuad.bl.x), x1 = Math.max(fullQuad.tr.x,fullQuad.br.x);
    const y0 = Math.min(fullQuad.tl.y,fullQuad.tr.y), y1 = Math.max(fullQuad.bl.y,fullQuad.br.y);
    rctx.drawImage(fullCanvas, x0,y0,x1-x0,y1-y0, 0,0,outW,outH);
  }

  card.croppedDataURL = resultCanvas.toDataURL('image/jpeg', 0.95);
  card.thumbDataURL = makeThumbDataURL(resultCanvas, resultCanvas.width, resultCanvas.height);
  card.status = 'cropped';
  card.enhanced = false;
  // Crop baru berarti sumber gambar berubah — buang jejak enhance/original
  // lama supaya enhance berikutnya diproses dari hasil crop TERBARU ini,
  // bukan dari crop sebelumnya yang sudah tidak relevan.
  card.originalDataURL = null;
  card.enhanceMeta = null;
  closeCropModal();
  renderGrid();
  toast('Crop tersimpan — tepi KTP sudah diluruskan otomatis');
}

// =========================================================
// ENHANCE / HD — SMART, NON-DESTRUKTIF, DGN OPSI AI CLOUD
// =========================================================
// Ringkasan alur baru (v47):
//
// 1. NON-DESTRUKTIF: original hasil crop disimpan terpisah di
//    card.originalDataURL begitu pertama kali di-enhance. Enhance boleh
//    diulang berkali-kali (mis. user ganti mode) tanpa progresif merusak
//    gambar, karena selalu diproses ULANG dari original, bukan menumpuk
//    filter di atas hasil enhance sebelumnya (bug lama v46: enhance 2x
//    = sharpen dobel = artefak/halo makin parah). Ada juga tombol utk
//    kembalikan ke foto asli kapan saja.
//
// 2. SMART/ADAPTIF (on-device, default, tanpa internet): sebelum
//    memproses, gambar dianalisis dulu (analyzeImageQuality) utk
//    mengukur seberapa buram & seberapa noisy fotonya. Kekuatan
//    sharpening, radius unsharp-mask, dan besar noise-reduction
//    MENYESUAIKAN otomatis dari hasil analisis itu — foto yang sudah
//    cukup tajam tidak di-oversharpen (mencegah halo/ringing), foto yang
//    sangat buram dapat sharpening lebih agresif + upscale lebih tinggi.
//    Ditambah 1 pass noise-reduction (median-ish blur) SEBELUM sharpen
//    supaya grain/noise kamera HP tidak ikut dipertajam.
//
// 3. AI ENHANCE (cloud, opsional): kalau AI_ENHANCE_API_BASE di bawah
//    sudah diisi endpoint super-resolution (mis. deployment sendiri yang
//    membungkus model Real-ESRGAN/GFPGAN, lewat Replicate/HuggingFace
//    Space/Cloud Run), tombol "AI Enhance" akan mengirim foto ke sana utk
//    di-upscale pakai model AI sungguhan (bukan cuma filter matematis),
//    jauh lebih baik utk foto yang SANGAT buram/pecah. Kalau endpoint
//    belum diisi, gagal, timeout, atau user offline — otomatis (graceful)
//    fallback ke enhance lokal supaya user tetap dapat hasil yang lebih
//    baik, bukan error mentah. Sama seperti pola STATS_API_BASE di atas.
const AI_ENHANCE_API_BASE = ''; // GANTI dgn URL endpoint AI upscaling kamu sendiri (kosongkan utk nonaktifkan & selalu pakai enhance lokal)
const AI_ENHANCE_TIMEOUT_MS = 20000;
// Tombol "AI Enhance" HANYA muncul di UI kalau endpoint di atas sudah
// diisi — mencegah tombol nganggur/selalu-gagal bagi user yg belum
// setup cloud enhance. Enhance lokal (tombol "HD-kan") tetap selalu ada.
const AI_ENHANCE_ENABLED = !!(AI_ENHANCE_API_BASE && !AI_ENHANCE_API_BASE.startsWith('GANTI_'));

function runEnhance(id, btnEl){
  const card = cards.find(c=>c.id===id);
  if(!card || !card.croppedDataURL) return;
  enhanceCard(card, btnEl, 'auto');
}

// Enhance pakai AI cloud secara eksplisit (dipanggil dari tombol "AI
// Enhance" terpisah kalau AI_ENHANCE_API_BASE terisi).
function runEnhanceAI(id, btnEl){
  const card = cards.find(c=>c.id===id);
  if(!card || !card.croppedDataURL) return;
  enhanceCard(card, btnEl, 'ai');
}

// Kembalikan foto ke hasil crop ASLI (sebelum enhance apapun).
function revertEnhance(id){
  const card = cards.find(c=>c.id===id);
  if(!card || !card.originalDataURL) return;
  card.croppedDataURL = card.originalDataURL;
  card.status = 'cropped';
  card.enhanced = false;
  card.enhanceMeta = null;
  const img = new Image();
  img.onload = ()=>{
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    cv.getContext('2d').drawImage(img,0,0);
    card.thumbDataURL = makeThumbDataURL(cv, cv.width, cv.height);
    renderGrid();
  };
  img.src = card.croppedDataURL;
  toast('Dikembalikan ke foto hasil crop semula (sebelum HD)');
}

async function enhanceCard(card, btnEl, mode){
  // Selalu proses ULANG dari original (kalau ada), supaya enhance tidak
  // menumpuk di atas hasil enhance sebelumnya — mencegah gambar makin
  // rusak/oversharpen tiap kali tombol ditekan berkali-kali.
  const sourceDataURL = card.originalDataURL || card.croppedDataURL;
  if(!card.originalDataURL) card.originalDataURL = card.croppedDataURL;

  const origSvg = btnEl ? btnEl.innerHTML : null;
  if(btnEl){
    btnEl.disabled = true;
    btnEl.innerHTML = `<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-9-9"/></svg>`;
  }
  setEnhanceProgress(card.id, mode==='ai' ? 'Mengirim ke AI Enhance…' : 'Menganalisis ketajaman foto…');

  try{
    let result = null;
    let usedAI = false;

    if(mode==='ai' && AI_ENHANCE_API_BASE && !AI_ENHANCE_API_BASE.startsWith('GANTI_')){
      try{
        result = await enhanceImageAI(sourceDataURL, (msg)=>setEnhanceProgress(card.id, msg));
        usedAI = true;
      }catch(err){
        console.warn('[AI Enhance] Gagal, fallback ke enhance lokal:', err);
        toast('AI Enhance tidak tersedia saat ini — memakai enhance otomatis on-device', 3600, 'warn');
        setEnhanceProgress(card.id, 'Beralih ke enhance otomatis on-device…');
      }
    }

    if(!result){
      // Kasih waktu 1 frame supaya spinner sempat kepaint sebelum kerja
      // sinkron berat (analisis + filter) mulai, biar UI tidak ngefreeze
      // tanpa indikasi.
      await nextFrame();
      const img = await loadImage(sourceDataURL);
      result = enhanceImageSmart(img);
    }

    card.croppedDataURL = result.dataURL;
    card.thumbDataURL = makeThumbDataURL(result.canvas, result.canvas.width, result.canvas.height);
    card.status = 'enhanced';
    card.enhanced = true;
    card.enhanceMeta = result.meta || null;

    if(btnEl){ btnEl.disabled = false; btnEl.innerHTML = origSvg; }
    clearEnhanceProgress(card.id);
    renderGrid();

    if(usedAI){
      toast('Foto berhasil diperjelas dengan AI Enhance — kualitas HD maksimal');
    } else if(result.meta && result.meta.blurLevel === 'sangat buram'){
      toast('Foto sangat buram — sudah dipertajam maksimal, tapi hasil terbaik tetap dari foto ulang dgn cahaya cukup', 5200, 'warn');
    } else {
      toast('Foto berhasil diperjelas — kualitas HD siap dicetak');
    }
  }catch(err){
    console.error('[Enhance] Gagal total:', err);
    if(btnEl){ btnEl.disabled = false; btnEl.innerHTML = origSvg; }
    clearEnhanceProgress(card.id);
    toast('Gagal memproses HD — coba lagi, atau pakai foto dgn resolusi lebih kecil', 4200, 'warn');
  }
}

function loadImage(src){
  return new Promise((resolve,reject)=>{
    const img = new Image();
    img.onload = ()=>resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
function nextFrame(){
  return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
}

// Progress kecil di bawah tombol HD-kan/AI Enhance, dibersihkan otomatis
// setelah selesai. Dicari lewat card wrapper (bukan hanya tombol
// "enhance") supaya progress tetap muncul walau yg dipicu tombol AI
// Enhance.
function findCardBody(id){
  const anyBtn = document.querySelector(`.ktp-card [data-id="${id}"]`);
  return anyBtn ? anyBtn.closest('.body') : null;
}
function setEnhanceProgress(id, msg){
  const holder = findCardBody(id);
  if(!holder) return;
  let bar = holder.querySelector('.enhance-progress');
  if(!bar){
    bar = document.createElement('div');
    bar.className = 'enhance-progress';
    holder.appendChild(bar);
  }
  bar.textContent = msg;
}
function clearEnhanceProgress(id){
  const holder = findCardBody(id);
  const bar = holder && holder.querySelector('.enhance-progress');
  if(bar) bar.remove();
}

// ---------------------------------------------------------
// Analisis kualitas gambar: estimasi level blur & noise dari gradien
// & varians lokal (Laplacian variance — metode standar utk deteksi
// blur), plus histogram kecerahan utk deteksi foto gelap/washed-out.
// Dijalankan di resolusi kecil (downscale) supaya cepat, hasilnya lalu
// dipetakan ke parameter enhance yang sebenarnya.
// ---------------------------------------------------------
function analyzeImageQuality(img){
  const sampleW = Math.min(320, img.width);
  const sampleH = Math.round(img.height * (sampleW/img.width));
  const cv = document.createElement('canvas');
  cv.width = sampleW; cv.height = sampleH;
  const cx = cv.getContext('2d');
  cx.drawImage(img, 0, 0, sampleW, sampleH);
  const { data } = cx.getImageData(0,0,sampleW,sampleH);

  // grayscale
  const gray = new Float32Array(sampleW*sampleH);
  let brightnessSum = 0;
  for(let i=0, p=0; i<data.length; i+=4, p++){
    const g = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
    gray[p] = g;
    brightnessSum += g;
  }
  const avgBrightness = brightnessSum / gray.length; // 0-255

  // Laplacian (edge/detail) variance — indikator ketajaman standar:
  // makin rendah variansnya, makin buram fotonya.
  let sum=0, sumSq=0, count=0;
  for(let y=1; y<sampleH-1; y++){
    for(let x=1; x<sampleW-1; x++){
      const idx = y*sampleW+x;
      const lap = -4*gray[idx] + gray[idx-1] + gray[idx+1] + gray[idx-sampleW] + gray[idx+sampleW];
      sum += lap; sumSq += lap*lap; count++;
    }
  }
  const mean = sum/count;
  const variance = (sumSq/count) - mean*mean;

  // Noise estimate kasar: variansi di area yang SECARA LOKAL relatif flat
  // (gradien kecil) — kalau area "flat" masih bervariasi tinggi, kemungkinan
  // besar itu grain/noise sensor, bukan detail asli.
  let noiseSum=0, noiseCount=0;
  for(let y=1; y<sampleH-1; y+=2){
    for(let x=1; x<sampleW-1; x+=2){
      const idx = y*sampleW+x;
      const gx = gray[idx+1]-gray[idx-1];
      const gy = gray[idx+sampleW]-gray[idx-sampleW];
      const grad = Math.sqrt(gx*gx+gy*gy);
      if(grad < 12){ // area relatif datar
        noiseSum += grad; noiseCount++;
      }
    }
  }
  const noiseScore = noiseCount ? noiseSum/noiseCount : 0; // makin tinggi = makin noisy

  // Klasifikasi level blur dari Laplacian variance (threshold dikalibrasi
  // utk foto dokumen/kartu hasil kamera HP, bukan foto umum).
  let blurLevel;
  if(variance > 350) blurLevel = 'tajam';
  else if(variance > 140) blurLevel = 'cukup buram';
  else blurLevel = 'sangat buram';

  return { variance, avgBrightness, noiseScore, blurLevel };
}

// ---------------------------------------------------------
// Enhance lokal "smart": upscale + noise-reduction + unsharp-mask
// adaptif + contrast/brightness adaptif, murni pertajam & rapikan
// gambar yang sudah ada (tidak menghasilkan konten/detail baru yg tidak
// benar-benar ada di foto — beda dgn AI generative upscaling).
// ---------------------------------------------------------
function enhanceImageSmart(img){
  const quality = analyzeImageQuality(img);

  // Upscale lebih tinggi utk foto yang lebih buram (kasih lebih banyak
  // "ruang" piksel utk sharpening bekerja tanpa pecah), dibatasi supaya
  // tidak membengkak berlebihan di foto yang aslinya sudah besar.
  const megapixels = (img.width*img.height)/1e6;
  let scaleFactor = quality.blurLevel==='sangat buram' ? 1.9
                   : quality.blurLevel==='cukup buram' ? 1.6
                   : 1.3;
  if(megapixels > 4) scaleFactor = Math.min(scaleFactor, 1.4); // foto sudah besar, jangan berlebihan upscale

  const w = img.width, h = img.height;
  const upW = Math.round(w*scaleFactor), upH = Math.round(h*scaleFactor);

  // Step 1: high-quality upscale via staged smoothing (mengurangi
  // blocky/aliasing dibanding upscale 1 langkah besar).
  let stage = img;
  let curW = w, curH = h;
  const steps = 2;
  let stageCanvas;
  for(let i=1;i<=steps;i++){
    const t = i/steps;
    const targetW = Math.round(w + (upW-w)*t);
    const targetH = Math.round(h + (upH-h)*t);
    stageCanvas = document.createElement('canvas');
    stageCanvas.width = targetW; stageCanvas.height = targetH;
    const sctx = stageCanvas.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(stage, 0, 0, targetW, targetH);
    stage = stageCanvas;
    curW = targetW; curH = targetH;
  }

  const ctx = stageCanvas.getContext('2d');
  const imgData = ctx.getImageData(0,0,curW,curH);
  let data = imgData.data;

  // Step 2: noise reduction RINGAN sebelum sharpen — supaya unsharp mask
  // di step 3 tidak ikut memperkuat grain/noise sensor kamera HP. Cuma
  // dijalankan kalau noise-nya memang cukup tinggi, biar foto yang sudah
  // bersih tidak kehilangan detail asli karena diblur percuma.
  if(quality.noiseScore > 3.5){
    data = boxBlurPass(data, curW, curH, 1); // 1 pass radius-1 cukup utk meredam grain halus
  }

  // Step 3: unsharp mask ADAPTIF — radius blur & kekuatan sharpen
  // menyesuaikan level blur hasil analisis. Foto yang sudah tajam dikasih
  // sharpen ringan saja (mencegah halo/ringing berlebih di tepi teks),
  // foto sangat buram dikasih sharpen lebih kuat + radius lebih besar
  // supaya menjangkau detail yang lebih "lebar" blur-nya.
  const passes = quality.blurLevel==='sangat buram' ? 3 : (quality.blurLevel==='cukup buram' ? 2 : 1);
  let blurred = data;
  for(let i=0;i<passes;i++) blurred = boxBlurPass(blurred, curW, curH, 1);

  const amount = quality.blurLevel==='sangat buram' ? 1.35
               : quality.blurLevel==='cukup buram' ? 1.0
               : 0.55;
  const sharpened = new Uint8ClampedArray(data.length);
  for(let i=0;i<data.length;i+=4){
    for(let c=0;c<3;c++){
      const orig = data[i+c];
      const blur = blurred[i+c];
      sharpened[i+c] = clamp(orig + (orig-blur)*amount);
    }
    sharpened[i+3] = data[i+3];
  }
  data = sharpened;

  // Step 4: contrast & brightness ADAPTIF berdasar kecerahan rata-rata —
  // foto gelap/washed-out (umum pada foto KTP di dalam ruangan cahaya
  // kurang) dinaikkan lebih banyak, foto yang sudah cukup terang cukup
  // disentuh tipis supaya warna tidak over-blown/pecah.
  let contrast, brightness;
  if(quality.avgBrightness < 90){        // gelap
    contrast = 1.18; brightness = 14;
  } else if(quality.avgBrightness > 190){ // sudah terang/washed-out
    contrast = 1.08; brightness = -4;
  } else {                                // normal
    contrast = 1.12; brightness = 6;
  }
  for(let i=0;i<data.length;i+=4){
    for(let c=0;c<3;c++){
      let v = (data[i+c]-128)*contrast + 128 + brightness;
      data[i+c] = clamp(v);
    }
  }

  imgData.data.set(data);
  ctx.putImageData(imgData, 0, 0);
  return {
    dataURL: stageCanvas.toDataURL('image/jpeg', 0.95),
    canvas: stageCanvas,
    meta: { ...quality, scaleFactor, engine: 'local-smart' }
  };
}

// ---------------------------------------------------------
// AI ENHANCE (cloud, opsional) — mengirim gambar ke endpoint eksternal
// yang membungkus model super-resolution (mis. Real-ESRGAN) utk hasil
// yang jauh lebih baik dari filter matematis biasa, terutama utk foto
// yang sangat buram/kecil. TIDAK aktif kecuali AI_ENHANCE_API_BASE diisi
// endpoint sungguhan oleh maintainer (lihat konstanta di atas).
//
// Kontrak endpoint yang diharapkan (silakan sesuaikan dgn implementasi
// server kamu): POST {AI_ENHANCE_API_BASE} dgn JSON { image: dataURL },
// balasan JSON { image: dataURL_hasil } ATAU langsung binary image/*.
// ---------------------------------------------------------
async function enhanceImageAI(sourceDataURL, onProgress){
  onProgress && onProgress('Mengunggah foto ke AI Enhance…');
  const controller = new AbortController();
  const timeoutId = setTimeout(()=>controller.abort(), AI_ENHANCE_TIMEOUT_MS);

  try{
    const res = await fetch(AI_ENHANCE_API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: sourceDataURL }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if(!res.ok) throw new Error(`AI Enhance HTTP ${res.status}`);

    onProgress && onProgress('Memproses hasil AI Enhance…');
    const contentType = res.headers.get('content-type') || '';
    let resultDataURL;
    if(contentType.includes('application/json')){
      const json = await res.json();
      if(!json || !json.image) throw new Error('Respons AI Enhance tidak berisi field "image"');
      resultDataURL = json.image;
    } else if(contentType.startsWith('image/')){
      const blob = await res.blob();
      resultDataURL = await new Promise((resolve,reject)=>{
        const reader = new FileReader();
        reader.onload = ()=>resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } else {
      throw new Error('Tipe respons AI Enhance tidak dikenali: '+contentType);
    }

    const img = await loadImage(resultDataURL);
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    cv.getContext('2d').drawImage(img,0,0);
    return { dataURL: resultDataURL, canvas: cv, meta: { engine: 'ai-cloud' } };
  } finally {
    clearTimeout(timeoutId);
  }
}

function clamp(v){ return v<0?0:(v>255?255:v); }

function boxBlurPass(data, w, h, radius){
  radius = radius || 1;
  const out = new Uint8ClampedArray(data.length);
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      let r=0,g=0,b=0,a=0,count=0;
      for(let dy=-radius; dy<=radius; dy++){
        const ny = y+dy; if(ny<0||ny>=h) continue;
        for(let dx=-radius; dx<=radius; dx++){
          const nx = x+dx; if(nx<0||nx>=w) continue;
          const idx=(ny*w+nx)*4;
          r+=data[idx]; g+=data[idx+1]; b+=data[idx+2]; a+=data[idx+3];
          count++;
        }
      }
      const oidx=(y*w+x)*4;
      out[oidx]=r/count; out[oidx+1]=g/count; out[oidx+2]=b/count; out[oidx+3]=a/count;
    }
  }
  return out;
}

// =========================================================
// PRINT LAYOUT — KTP (13.5 x 9cm, landscape) dirotasi 90°
// KHUSUS saat digambar ke lembar cetak (bukan diubah di data hasil
// crop) supaya jejak di kertas jadi 9cm lebar x 13.5cm tinggi
// (+ ruang no HP). Ini memungkinkan 2 kolom x 2 baris = 4 KTP per
// lembar F4 — sama seperti layout referensi Word (gambar diputar
// 270°, disusun 2x2). Rotasi manual yang user atur di editor crop
// (putar kiri/kanan) TIDAK memengaruhi ini — itu cuma untuk
// meluruskan orientasi foto sebelum crop; hasil crop akhir selalu
// disimpan landscape (rasio 13.5:9), dan rotasi 90° cetak ini
// diterapkan terpisah, konsisten untuk semua KTP.
// Sizing presisi dalam mm, dirender ke canvas print-DPI, diekspor
// ke PDF via jsPDF (unit mm, ukuran fisik akurat di kertas manapun).
// =========================================================

const DPI = 203; // good balance: crisp print, manageable canvas size
const MM_TO_PX = DPI/25.4;

function closePreviewModal(){ el('previewModal').style.display='none'; }

el('btnPreview').addEventListener('click', openPreview);
el('btnPreviewMobile').addEventListener('click', openPreview);

// Blok KTP di kertas: KTP hasil crop selalu tersimpan LANDSCAPE dengan
// rasio CARD_W_CM : CARD_H_CM, lalu diputar 90° khusus saat dicetak supaya
// berdiri tegak. Strip "No. HP" ditempel di SAMPING KANAN foto (mengikuti
// referensi Word — teks ditulis vertikal, bukan horizontal di bawah), jadi:
//   lebar blok  = sisi pendek KTP (jadi lebar kolom setelah rotasi) + lebar strip HP
//   tinggi blok = sisi panjang KTP (jadi tinggi baris setelah rotasi)
//
// Dua mode:
//  - AUTO: hitung kolom/baris maksimal yang muat di kertas untuk ukuran
//    KTP yang di-set user (perilaku lama, dipertahankan sebagai default).
//  - MANUAL: user pilih sendiri jumlah kolom x baris dari dropdown; ukuran
//    KTP ditarik otomatis agar PAS memenuhi kertas sampai batas margin
//    (bukan lagi diambil dari CARD_W_CM/CARD_H_CM input, supaya benar2
//    "1 kertas full sampai margin" sesuai jumlah KTP yang diminta).
function computeLayout(){
  const p = paper();
  const usableW = p.w - 2*MARGIN_MM;
  const usableH = p.h - 2*MARGIN_MM;

  if(layoutMode === 'MANUAL'){
    const cols = Math.max(1, manualCols);
    const rows = Math.max(1, manualRows);
    // Ruang yang tersedia utk tiap blok KTP (termasuk gap antar KTP)
    const blockWmm = (usableW - (cols-1)*GAP_MM) / cols;
    const blockHmm = (usableH - (rows-1)*GAP_MM) / rows;
    // Strip HP ambil porsi tetap dari LEBAR blok (proporsional, supaya
    // tetap rapi walau blok besar/kecil), foto mengisi sisanya di kiri.
    const phoneWmm = Math.max(8, Math.min(PHONE_SPACE_MM, blockWmm*0.16));
    return { blockWmm, blockHmm, phoneWmm, cols, rows, perPage: cols*rows, paperW: p.w, paperH: p.h, mode:'MANUAL' };
  }

  // AUTO mode: ukuran KTP dari input user, kolom/baris dihitung
  // maksimal yang muat. Strip "No. HP" DI SAMPING KANAN foto (teks
  // vertikal), sesuai referensi Word.
  const shortSideCm = Math.min(CARD_W_CM, CARD_H_CM);
  const longSideCm  = Math.max(CARD_W_CM, CARD_H_CM);
  const photoWmm = shortSideCm*10;                  // sisi pendek -> lebar area foto (setelah rotasi)
  const blockHmm = longSideCm*10;                   // sisi panjang -> tinggi blok (setelah rotasi)
  const blockWmm = photoWmm + PHONE_SPACE_MM;       // lebar blok = foto + strip HP di kanan
  const cols = Math.max(1, Math.floor((usableW+GAP_MM)/(blockWmm+GAP_MM)));
  const rows = Math.max(1, Math.floor((usableH+GAP_MM)/(blockHmm+GAP_MM)));
  return { blockWmm, blockHmm, phoneWmm: PHONE_SPACE_MM, cols, rows, perPage: cols*rows, paperW: p.w, paperH: p.h, mode:'AUTO' };
}

let previewReadyCards = [];
let previewPageIndex = 0;

function openPreview(){
  const ready = cards.filter(c=>c.croppedDataURL);
  if(!ready.length){ toast('Belum ada KTP yang sudah di-crop — upload & crop foto KTP dulu sebelum lanjut', 4200, 'warn'); return; }
  previewReadyCards = ready;
  previewPageIndex = 0;
  buildPreviewSummary();
  renderSheetPreview();
  el('previewModal').style.display = 'flex';

  el('btnPrevPage').onclick = ()=>{ if(previewPageIndex>0){ previewPageIndex--; renderSheetPreview(); } };
  el('btnNextPage').onclick = ()=>{
    const layout = computeLayout();
    const totalPages = Math.ceil(previewReadyCards.length/layout.perPage);
    if(previewPageIndex < totalPages-1){ previewPageIndex++; renderSheetPreview(); }
  };
}

// Ringkasan pengaturan cetak yang AKAN dipakai (kertas, layout, jumlah
// lembar, mode warna), ditampilkan sbg chip data di atas preview — jadi
// user bisa cek ulang pengaturan sekali lagi sebelum download PDF beneran,
// tanpa harus scroll balik ke panel Pengaturan Cetak.
function buildPreviewSummary(){
  const box = el('previewSummary');
  if(!box) return;
  const layout = computeLayout();
  const p = paper();
  const totalPages = Math.max(1, Math.ceil(previewReadyCards.length/layout.perPage));
  const colorLabel = printMode === 'BW' ? 'Hitam Putih' : 'Warna';
  const colorIcon = printMode === 'BW'
    ? '<circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 000 20V2z" fill="currentColor" stroke="none"/>'
    : '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 011.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>';

  const chip = (iconPath, label) => `
    <span class="chip">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconPath}</svg>
      ${label}
    </span>`;

  box.innerHTML = [
    chip('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/><path d="M21 15l-5-5L5 21"/>',
      `${previewReadyCards.length} KTP · ${totalPages} lembar`),
    chip('<path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/>',
      p.label),
    chip('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
      `${layout.cols} kolom × ${layout.rows} baris / lembar`),
    chip(colorIcon, colorLabel),
    `<span class="chip chip-note">KTP diputar tegak otomatis, space No. HP di samping kanan</span>`,
  ].join('');
}

function renderSheetPreview(){
  const layout = computeLayout();
  const canvas = el('sheetCanvas');
  const pageWpx = Math.round(layout.paperW*MM_TO_PX);
  const pageHpx = Math.round(layout.paperH*MM_TO_PX);

  // Render at a crisp fixed internal resolution; CSS (max-width:100%) scales
  // it down to fit the modal, so the sheet stays sharp and the full KTP card
  // (with photo + biodata + phone-space) is clearly readable, not cramped.
  const previewScale = Math.min(1, 900/pageWpx);
  canvas.width = Math.round(pageWpx*previewScale);
  canvas.height = Math.round(pageHpx*previewScale);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(previewScale,0,0,previewScale,0,0);

  const totalPages = Math.max(1, Math.ceil(previewReadyCards.length/layout.perPage));
  const pageCards = previewReadyCards.slice(previewPageIndex*layout.perPage, (previewPageIndex+1)*layout.perPage);
  drawPageOfCards(ctx, pageCards, layout, pageWpx, pageHpx, ()=>{});

  el('pgLabel').textContent = `Halaman ${previewPageIndex+1}/${totalPages}`;
  el('btnPrevPage').disabled = previewPageIndex === 0;
  el('btnNextPage').disabled = previewPageIndex >= totalPages-1;
}

// Menggambar sebuah image ke context dalam mode hitam-putih (grayscale),
// dilakukan manual lewat manipulasi pixel (bukan ctx.filter CSS) supaya
// hasilnya konsisten di semua browser & saat export PDF — ctx.filter
// tidak didukung merata di semua environment render kanvas.
function drawImageGrayscale(ctx, img, dx, dy, dw, dh){
  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.round(img.width));
  off.height = Math.max(1, Math.round(img.height));
  const octx = off.getContext('2d');
  octx.drawImage(img, 0, 0, off.width, off.height);
  const imgData = octx.getImageData(0, 0, off.width, off.height);
  const d = imgData.data;
  for(let i=0; i<d.length; i+=4){
    // luminance-weighted grayscale (perceptual, matches print conversion norms)
    const gray = d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114;
    d[i] = d[i+1] = d[i+2] = gray;
  }
  octx.putImageData(imgData, 0, 0);
  ctx.drawImage(off, dx, dy, dw, dh);
}

function drawPageOfCards(ctx, pageCards, layout, pageWpx, pageHpx, onImagesReady){
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0,0,pageWpx,pageHpx);

  const marginPx = MARGIN_MM*MM_TO_PX;
  const gapPx = GAP_MM*MM_TO_PX;
  const blockWpx = layout.blockWmm*MM_TO_PX;   // block width = photo width + phone strip width
  const blockHpx = layout.blockHmm*MM_TO_PX;   // block height = photo height (post-rotation)
  const phoneWpx = layout.phoneWmm*MM_TO_PX;   // width of the vertical "No. HP" strip beside the photo
  const photoWpx = blockWpx - phoneWpx;        // remaining width goes to the (rotated) photo

  let loaded = 0;
  const total = pageCards.length;
  if(total===0){ onImagesReady(); return; }

  pageCards.forEach((card, idx)=>{
    const col = idx % layout.cols;
    const row = Math.floor(idx/layout.cols);
    const x = marginPx + col*(blockWpx+gapPx);
    const y = marginPx + row*(blockHpx+gapPx);

    // cutting guide (dashed border around whole card block incl. phone strip)
    ctx.save();
    ctx.strokeStyle = '#cfcabb';
    ctx.setLineDash([4,3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, blockWpx, blockHpx);
    ctx.restore();

    const img = new Image();
    img.onload = ()=>{
      // Hasil crop selalu tersimpan landscape (13.5:9). Kita putar 90°
      // khusus saat menggambar ke lembar cetak, supaya sisi panjangnya
      // berdiri vertikal dan mengisi area foto di bagian KIRI blok.
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, photoWpx, blockHpx);
      ctx.clip();

      ctx.translate(x + photoWpx/2, y + blockHpx/2);
      // -90° supaya foto & kop KTP berdiri persis seperti referensi Word:
      // bagian foto/kop provinsi di ATAS, bukan malah jadi di bawah.
      ctx.rotate(-Math.PI/2);
      if(printMode === 'BW'){
        drawImageGrayscale(ctx, img, -blockHpx/2, -photoWpx/2, blockHpx, photoWpx);
      } else {
        ctx.drawImage(img, -blockHpx/2, -photoWpx/2, blockHpx, photoWpx);
      }
      ctx.restore();

      // photo border
      ctx.strokeStyle = '#888';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, photoWpx, blockHpx);

      // ---- Strip "No. HP" DI SAMPING KANAN foto, teks vertikal —
      // mengikuti referensi Word: label "No HP:" ditulis berdiri, tegak
      // lurus sejajar sisi kanan foto, mengisi penuh tinggi blok.
      const stripX = x + photoWpx;
      ctx.save();
      ctx.strokeStyle = '#ddd8c6';
      ctx.lineWidth = 1;
      ctx.strokeRect(stripX, y, phoneWpx, blockHpx);

      ctx.translate(stripX + phoneWpx/2, y + blockHpx/2);
      ctx.rotate(-Math.PI/2);
      ctx.fillStyle = '#444';
      ctx.font = `600 ${Math.round(phoneWpx*0.34)}px Arial`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      // Setelah rotasi -90°, sumbu X lokal berjalan dari ATAS ke BAWAH
      // blok asli — jadi teks dimulai dekat tepi ATAS foto (seperti
      // contoh Word: "No HP:" dimulai dari atas, memanjang ke bawah).
      const halfLen = blockHpx/2;
      ctx.fillText('No HP:', -halfLen*0.94, 0);

      // garis tempat tulis tangan: memanjang dari setelah label sampai
      // TEPAT ke ujung bawah strip (dekat tepi bawah foto) — full ke tepi.
      const labelWidth = ctx.measureText('No HP:').width;
      const lineStartX = -halfLen*0.94 + labelWidth + (phoneWpx*0.12);
      const lineEndX = halfLen*0.92;
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(lineStartX, phoneWpx*0.16);
      ctx.lineTo(lineEndX, phoneWpx*0.16);
      ctx.stroke();
      ctx.restore();
      ctx.restore();

      loaded++;
      if(loaded===total) onImagesReady();
    };
    img.onerror = ()=>{ loaded++; if(loaded===total) onImagesReady(); };
    img.src = card.croppedDataURL;
  });
}

// ---------- PDF export ----------
async function downloadPDF(){
  const ready = cards.filter(c=>c.croppedDataURL);
  if(!ready.length){ toast('Belum ada KTP yang sudah di-crop — upload & crop foto KTP dulu sebelum lanjut', 4200, 'warn'); return; }

  el('pdfProgress').innerHTML = '<span class="dot"></span> Menyiapkan PDF...';
  el('pdfProgress').style.display = 'flex';

  const layout = computeLayout();
  const pageWpx = Math.round(layout.paperW*MM_TO_PX);
  const pageHpx = Math.round(layout.paperH*MM_TO_PX);

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit:'mm', format:[layout.paperW, layout.paperH], orientation: layout.paperW>layout.paperH?'landscape':'portrait' });

  const totalPages = Math.ceil(ready.length/layout.perPage);

  for(let p=0; p<totalPages; p++){
    const pageCards = ready.slice(p*layout.perPage, (p+1)*layout.perPage);
    const canvas = document.createElement('canvas');
    canvas.width = pageWpx; canvas.height = pageHpx;
    const ctx = canvas.getContext('2d');

    await new Promise(resolve=>{
      drawPageOfCards(ctx, pageCards, layout, pageWpx, pageHpx, resolve);
    });

    const imgData = canvas.toDataURL('image/jpeg', 0.97);
    if(p>0) pdf.addPage([layout.paperW, layout.paperH]);
    pdf.addImage(imgData, 'JPEG', 0, 0, layout.paperW, layout.paperH);
  }

  el('pdfProgress').style.display = 'none';
  const modeSuffix = printMode === 'BW' ? '-BW' : '';
  pdf.save(`Cetak-KTP-${currentPaperKey}${modeSuffix}-${new Date().toISOString().slice(0,10)}.pdf`);
  toast(`PDF (${PAPER_SIZES[currentPaperKey].label}) berhasil diunduh — siap dicetak`, 4200);
  trackUsage('downloadPdf');
}

// ---------- Cetak Langsung (window.print, tanpa PDF) ----------
// Alur: render tiap halaman ke <canvas> pakai fungsi drawPageOfCards yang
// SAMA dengan yang dipakai downloadPDF() — jadi hasil visualnya identik
// (posisi foto, strip No. HP, garis potong, dst) — cuma bedanya di sini
// hasilnya jadi <img> yang disusun di #printArea, lalu window.print()
// dipanggil supaya browser langsung munculkan dialog pilih printer bawaan
// OS (Windows/Mac/dll — mengikuti printer yang terpasang & terbaca di
// komputer/laptop user), tanpa perlu buka file PDF terpisah dulu.
//
// Ukuran & orientasi kertas fisik diatur lewat CSS @page yang di-inject
// dinamis ke #printPageStyle sesuai kertas yang dipilih user (mm persis,
// bukan estimasi) — driver printer yang mendukung custom size akan
// otomatis menyarankan ukuran ini di dialognya.
async function printDirect(){
  const ready = cards.filter(c=>c.croppedDataURL);
  if(!ready.length){ toast('Belum ada KTP yang sudah di-crop — upload & crop foto KTP dulu sebelum lanjut', 4200, 'warn'); return; }

  const btn = document.querySelector('#previewModal .btn-primary');
  if(btn) btn.disabled = true;
  el('pdfProgress').innerHTML = '<span class="dot"></span> Menyiapkan halaman cetak...';
  el('pdfProgress').style.display = 'flex';

  const layout = computeLayout();
  const pageWpx = Math.round(layout.paperW*MM_TO_PX);
  const pageHpx = Math.round(layout.paperH*MM_TO_PX);
  const totalPages = Math.ceil(ready.length/layout.perPage);

  const printArea = el('printArea');
  printArea.innerHTML = '';

  for(let p=0; p<totalPages; p++){
    const pageCards = ready.slice(p*layout.perPage, (p+1)*layout.perPage);
    const canvas = document.createElement('canvas');
    canvas.width = pageWpx; canvas.height = pageHpx;
    const ctx = canvas.getContext('2d');

    await new Promise(resolve=>{
      drawPageOfCards(ctx, pageCards, layout, pageWpx, pageHpx, resolve);
    });

    const imgData = canvas.toDataURL('image/jpeg', 0.97);
    const pageDiv = document.createElement('div');
    pageDiv.className = 'print-page';
    const img = document.createElement('img');
    img.src = imgData;
    pageDiv.appendChild(img);
    printArea.appendChild(pageDiv);
  }

  // Ukuran kertas fisik akurat (mm) + orientasi otomatis, margin 0 karena
  // margin cetak sudah diperhitungkan di dalam gambar halaman itu sendiri
  // (lihat MARGIN_MM di computeLayout) — kalau browser juga nambah margin
  // sendiri, hasil cetak jadi dobel-margin & tidak center.
  el('printPageStyle').textContent =
    `@page{size:${layout.paperW}mm ${layout.paperH}mm;margin:0;}`;

  el('pdfProgress').style.display = 'none';
  if(btn) btn.disabled = false;

  // Beri browser satu frame untuk selesai me-layout #printArea sebelum
  // dialog print dibuka, supaya gambar halaman pertama tidak terpotong
  // putih di preview print (race condition kalau print() dipanggil
  // langsung sesudah DOM diisi).
  requestAnimationFrame(()=> requestAnimationFrame(()=>{
    trackUsage('printDirect');
    window.print();
  }));
}

// Setelah dialog print ditutup (baik jadi print atau dibatalkan), bersihkan
// #printArea supaya tidak menyimpan gambar besar di memori tanpa guna.
window.addEventListener('afterprint', ()=>{
  el('printArea').innerHTML = '';
});

// ---------- Register service worker (PWA) ----------
// updateViaCache:'none' memastikan file sw.js ITU SENDIRI tidak pernah
// dibaca dari HTTP cache browser saat dicek ulang -- ini celah klasik yg
// sering kelewat: walau logic di dalam sw.js sudah benar (network-first,
// stale-while-revalidate, dsb), kalau file sw.js-nya sendiri kebaca dari
// cache lama, browser gak akan pernah tahu ada versi sw.js yg lebih baru
// utk diinstall sama sekali.
let swUpdateToastShown = false;
// Dipakai buat bedain "SW pertama kali aktif di kunjungan awal" (bukan
// update, jangan tampilkan toast) vs "SW lama diganti SW baru pas user
// lagi buka app" (ini baru update sungguhan). navigator.serviceWorker
// .controller bernilai null kalau ini kunjungan pertama tab (belum ada
// SW yg pernah mengendalikan halaman ini sebelumnya).
const hadControllerOnLoad = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(reg=>{
        // Cek ada-tidaknya versi baru tiap kali tab kembali aktif -- bukan
        // cuma mengandalkan interval browser bawaan yg bisa jarang & tidak
        // konsisten antar browser. Ini yg bikin update kerasa cepat
        // terdeteksi begitu user balik ke tab ini, tanpa perlu hard-reload.
        document.addEventListener('visibilitychange', ()=>{
          if(!document.hidden) reg.update().catch(()=>{});
        });
        // Jaga-jaga juga dicek berkala selagi tab dibiarkan terbuka lama
        // (mis. dipakai di kasir/loket yg jarang di-refresh manual).
        setInterval(()=> reg.update().catch(()=>{}), 10*60*1000); // tiap 10 menit
      })
      .catch(()=>{});

    // Sinyal utama dari sw.js begitu versi baru selesai di-activate (lihat
    // clients.matchAll(...).postMessage(...) di activate handler sw.js).
    // Guard hadControllerOnLoad sama spt di controllerchange -- mencegah
    // toast salah muncul di kunjungan pertama.
    navigator.serviceWorker.addEventListener('message', (event)=>{
      if(event.data && event.data.type === 'SW_UPDATED' && hadControllerOnLoad) showSwUpdateToast();
    });
  });

  // Fallback kedua yg lebih andal lintas-browser: begitu controller (SW
  // yg sedang mengendalikan tab ini) berganti krn ada versi baru yg
  // skipWaiting+claim, event ini SELALU terpicu -- jadi tetap kedeteksi
  // walau utk alasan apapun pesan postMessage di atas kelewat/gagal.
  // Guard hadControllerOnLoad supaya toast TIDAK muncul salah di
  // kunjungan pertama (saat itu juga terjadi "controllerchange" dari
  // null -> SW pertama, tapi itu instalasi awal, bukan update).
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{
    if(hadControllerOnLoad) showSwUpdateToast();
  });
}

// Tawarkan reload ke user begitu versi app yg lebih baru sudah siap --
// SENGAJA TIDAK auto-reload paksa tanpa izin, supaya tidak tiba-tiba
// memutus proses yg lagi jalan (mis. user lagi di tengah crop foto atau
// isi nomor HP banyak KTP sekaligus). Toast ini persisten (gak auto-hide)
// & ada tombol aksi jelas, bukan cuma notifikasi lewat sekilas.
function showSwUpdateToast(){
  if(swUpdateToastShown) return; // jangan spam toast yg sama berkali-kali
  swUpdateToastShown = true;
  toastPersistent(
    'Versi baru aplikasi sudah siap. ' +
    '<button id="btnReloadNewVersion" class="toast-action-btn">Muat ulang sekarang</button> ' +
    '<button id="btnDismissNewVersion" class="toast-dismiss-btn" aria-label="Tutup">&times;</button>',
    'info'
  );
  const reloadBtn = document.getElementById('btnReloadNewVersion');
  if(reloadBtn) reloadBtn.addEventListener('click', ()=> window.location.reload());
  const dismissBtn = document.getElementById('btnDismissNewVersion');
  if(dismissBtn) dismissBtn.addEventListener('click', ()=> toastEl.classList.remove('show','toast-persistent'));
}

initPaperSelect();
initLayoutModeSelect();
initCardSizeInputs();
initColorModeToggle();
renderGrid();
