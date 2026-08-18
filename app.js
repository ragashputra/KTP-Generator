/* =========================================================
   Cetak KTP Generator — CDN Internal Tools
   - Auto-detect & crop tepi kartu KTP dari foto (deteksi kontur +
     perspective unwarp, bukan cuma bounding-box)
   - Enhance/HD-kan foto buram (sharpen + upscale + contrast, on-device)
   - Rotasi manual (putar kiri/kanan 90°) sebelum crop — mirip Windows
     Photo — supaya user bisa luruskan orientasi foto sendiri
   - Pilihan ukuran kertas (F4 default, A4, Letter, Legal, Folio)
   ========================================================= */

// ---------- Constants (real-world mm, converted at export time) ----------
const CARD_W_CM = 13.5;   // sisi panjang KTP
const CARD_H_CM = 9.0;    // sisi pendek KTP
const MARGIN_MM = 6;
const GAP_MM = 5;
const PHONE_SPACE_MM = 14; // ruang kosong bawah tiap kartu utk tulis no HP pakai pulpen

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

// Antrian crop utk upload banyak sekaligus: foto dibuka satu per satu di
// editor crop, URUT dari yang pertama diupload sampai yang terakhir,
// bukan cuma foto terakhir doang yang kebuka (bug lama).
let cropQueue = [];   // id kartu yang menunggu giliran di-crop
let batchTotal = 0;   // jumlah total foto di batch upload saat ini
let batchDone = 0;    // sudah sampai foto ke berapa (termasuk yg lagi dibuka)

const el = (id) => document.getElementById(id);
const toastEl = el('toast');

function toast(msg, ms=2200){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>toastEl.classList.remove('show'), ms);
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
    toast(`Kertas diganti ke ${PAPER_SIZES[currentPaperKey].label}`);
  });
}

function paper(){ return PAPER_SIZES[currentPaperKey]; }

// ---------- File intake ----------
const dropzone = el('dropzone');
const fileInput = el('fileInput');

dropzone.addEventListener('click', () => fileInput.click());
['dragenter','dragover'].forEach(ev=>{
  dropzone.addEventListener(ev, e=>{ e.preventDefault(); dropzone.classList.add('drag'); });
});
['dragleave','drop'].forEach(ev=>{
  dropzone.addEventListener(ev, e=>{ e.preventDefault(); dropzone.classList.remove('drag'); });
});
dropzone.addEventListener('drop', e=>{
  const files = [...e.dataTransfer.files].filter(f=>f.type.startsWith('image/'));
  handleFiles(files);
});
fileInput.addEventListener('change', e=>{ handleFiles([...e.target.files]); fileInput.value=''; });

function handleFiles(files){
  if(!files.length) return;
  // Baca file SATU-SATU secara berurutan (bukan paralel) supaya kartu
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
        id, rawImg: img, croppedDataURL: null, enhanced:false, rotation:0,
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
    if(batchTotal > 1) toast(`Semua ${batchTotal} foto sudah diproses ✓`);
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
function renderGrid(){
  const grid = el('cardGrid');
  const empty = el('emptyState');
  grid.innerHTML = '';
  empty.style.display = cards.length ? 'none' : 'block';
  el('headerCount').textContent = cards.length + ' kartu';
  el('listSub').textContent = cards.length ? `${cards.length} KTP dimuat` : 'belum ada data';
  el('layoutInfo').textContent = layoutDescription();
  const specW = el('specPaperName'); if(specW) specW.textContent = paper().label.split(' (')[0];
  const specDim = el('specPaperDim'); if(specDim) specDim.textContent = paper().label.match(/\(([^)]+)\)/)?.[1] || '';

  const readyCount = cards.filter(c=>c.croppedDataURL).length;
  const previewBtns = [el('btnPreview'), el('btnPreviewMobile')];
  previewBtns.forEach(b=> b.disabled = readyCount === 0);

  cards.forEach(c=>{
    const div = document.createElement('div');
    div.className = 'kcard';
    const statusLabel = c.status === 'enhanced' ? 'HD' : (c.status === 'cropped' ? 'Cropped' : 'Belum Dicrop');
    const statusClass = c.status === 'enhanced' ? 'enhanced' : (c.status === 'cropped' ? 'cropped' : 'raw');
    const thumbClass = c.croppedDataURL ? 'thumb-ready' : 'thumb-raw';
    div.innerHTML = `
      <div class="thumb ${thumbClass}">
        <span class="status ${statusClass}">${statusLabel}</span>
        <img src="${c.croppedDataURL || c.rawImg.src}" alt="KTP">
      </div>
      <div class="body">
        <div class="phone-row">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.8 19.8 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.362 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
          <input type="text" placeholder="No. HP (opsional)" value="${escapeHtml(c.phone)}" data-field="phone" data-id="${c.id}">
        </div>
        <div class="actions">
          <button class="icnbtn" title="Crop ulang" data-act="crop" data-id="${c.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2v14a2 2 0 002 2h14M18 22V8a2 2 0 00-2-2H2"/></svg>
          </button>
          <button class="icnbtn" title="HD-kan foto buram" data-act="enhance" data-id="${c.id}" ${!c.croppedDataURL ? 'disabled':''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
          </button>
          <button class="icnbtn danger" title="Hapus" data-act="delete" data-id="${c.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/></svg>
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
      if(act==='enhance') runEnhance(id, b);
      if(act==='delete'){ cards = cards.filter(c=>c.id!==id); renderGrid(); }
    });
  });
}

function escapeHtml(s){
  return (s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Kartu dicetak apa adanya sesuai hasil crop (orientasi diatur manual
// oleh user lewat tombol putar kiri/kanan di editor crop).
function layoutDescription(){
  const layout = computeLayout();
  return `${layout.cols} kolom × ${layout.rows} baris (${layout.perPage} kartu/lembar)`;
}

// =========================================================
// AUTO-DETECT & CROP — versi ditingkatkan
// Pipeline:
//   1. Grayscale + Sobel gradient magnitude & orientation
//   2. Non-max suppression tipis + threshold adaptif (Otsu-like)
//   3. Hough-transform sederhana utk garis dominan (rho/theta)
//   4. Kelompokkan garis jadi 2 klaster nyaris-horizontal &
//      2 klaster nyaris-vertikal -> 4 sisi kartu
//   5. Hitung 4 titik potong (intersection) sbg quad -> lebih presisi
//      dan tahan terhadap background yang berisik dibanding bounding-box
//      berbasis proyeksi baris/kolom (metode versi lama).
//   6. Fallback ke proyeksi bounding-box kalau Hough gagal menemukan
//      4 sisi yang jelas (mis. kartu nyaris memenuhi seluruh frame).
// =========================================================

function openCropModal(id){
  activeCropId = id;
  const card = cards.find(c=>c.id===id);
  if(card.rotation === undefined) card.rotation = 0; // 0/90/180/270, applied before crop detection
  el('cropModal').style.display = 'flex';
  updateCropProgress();

  bindRotateButtons(card);
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
}

function bindRotateButtons(card){
  el('btnRotateLeft').onclick = ()=>{
    card.rotation = (((card.rotation||0) - 90) % 360 + 360) % 360;
    rebuildCropStage(card);
  };
  el('btnRotateRight').onclick = ()=>{
    card.rotation = (((card.rotation||0) + 90) % 360 + 360) % 360;
    rebuildCropStage(card);
  };
}

function closeCropModal(){
  el('cropModal').style.display = 'none';
  activeCropId = null;
  // Kalau ini bagian dari upload banyak sekaligus, lanjut otomatis ke
  // foto berikutnya dalam antrian (baik setelah simpan maupun dilewati).
  advanceCropQueue();
}

// ---- Core edge/gradient computation, shared by detectors ----
function computeEdges(canvas){
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const src = ctx.getImageData(0,0,w,h);

  const gray = new Float32Array(w*h);
  for(let i=0;i<w*h;i++){
    const r=src.data[i*4], g=src.data[i*4+1], b=src.data[i*4+2];
    gray[i] = 0.299*r+0.587*g+0.114*b;
  }
  // light blur first to suppress texture noise (helps Hough a lot)
  const blurred = new Float32Array(w*h);
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      let sum=0, cnt=0;
      for(let dy=-1;dy<=1;dy++){
        const ny=y+dy; if(ny<0||ny>=h) continue;
        for(let dx=-1;dx<=1;dx++){
          const nx=x+dx; if(nx<0||nx>=w) continue;
          sum += gray[ny*w+nx]; cnt++;
        }
      }
      blurred[y*w+x] = sum/cnt;
    }
  }

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
  return { w, h, mag, ang };
}

// ---- Simple Hough line transform restricted to strong-edge pixels ----
function houghLines(mag, w, h, threshFrac){
  let maxMag = 0;
  for(let i=0;i<mag.length;i++) if(mag[i]>maxMag) maxMag=mag[i];
  const thresh = maxMag*threshFrac;

  const diag = Math.ceil(Math.sqrt(w*w+h*h));
  const thetaSteps = 180; // 1 degree resolution
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

  // subsample edge pixels for speed on larger images
  const step = (w*h > 500000) ? 2 : 1;
  for(let y=0;y<h;y+=step){
    for(let x=0;x<w;x+=step){
      if(mag[y*w+x] <= thresh) continue;
      for(let t=0;t<thetaSteps;t++){
        const rho = Math.round(x*cosT[t] + y*sinT[t]) + rhoOffset;
        if(rho<0||rho>=rhoSize) continue;
        acc[t*rhoSize+rho]++;
      }
    }
  }

  // find local maxima (peaks) in accumulator
  const peaks = [];
  const minVotes = Math.max(20, Math.round(Math.min(w,h)*0.12));
  for(let t=0;t<thetaSteps;t++){
    for(let r=0;r<rhoSize;r++){
      const v = acc[t*rhoSize+r];
      if(v < minVotes) continue;
      // local max check in small neighborhood
      let isMax = true;
      for(let dt=-2; dt<=2 && isMax; dt++){
        for(let dr=-6; dr<=6 && isMax; dr++){
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
  return peaks.slice(0, 60); // keep top candidates
}

// classify peaks into near-horizontal / near-vertical, pick best 2 of each
// forming top/bottom and left/right edges of the card
function pickCardQuadFromLines(peaks, w, h){
  if(!peaks.length) return null;

  const horiz = [], vert = [];
  for(const p of peaks){
    // theta near 90deg (pi/2) => line ~horizontal; theta near 0/pi => vertical
    const degFromHoriz = Math.abs((p.theta*180/Math.PI) - 90);
    if(degFromHoriz < 30) horiz.push(p);
    else if(degFromHoriz > 60) vert.push(p);
  }
  if(horiz.length < 2 || vert.length < 2) return null;

  // among horizontal lines, find one closest to top region and one closest to bottom
  const withY = horiz.map(p=>({...p, yAt0: p.rho / (Math.sin(p.theta)||1e-6) }));
  withY.sort((a,b)=>a.yAt0-b.yAt0);
  const top = withY[0];
  const bottom = withY[withY.length-1];
  if(bottom.yAt0 - top.yAt0 < h*0.3) return null; // too close, unreliable

  const withX = vert.map(p=>({...p, xAt0: p.rho / (Math.cos(p.theta)||1e-6) }));
  withX.sort((a,b)=>a.xAt0-b.xAt0);
  const left = withX[0];
  const right = withX[withX.length-1];
  if(right.xAt0 - left.xAt0 < w*0.3) return null;

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

  const tl = intersect(top, left);
  const tr = intersect(top, right);
  const br = intersect(bottom, right);
  const bl = intersect(bottom, left);
  if(!tl||!tr||!br||!bl) return null;

  // sanity: points should be roughly within (padded) image bounds
  const pad = Math.max(w,h)*0.25;
  for(const pt of [tl,tr,br,bl]){
    if(pt.x < -pad || pt.x > w+pad || pt.y < -pad || pt.y > h+pad) return null;
  }

  return { tl, tr, br, bl };
}

// Fallback: robust bounding box via row/col energy projection (previous method)
function bboxFallback(mag, w, h){
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

  function findBounds(arr, len){
    const total = arr.reduce((a,b)=>a+b,0);
    if(total < 5) return [Math.round(len*0.06), Math.round(len*0.94)];
    const target = total*0.02;
    let acc=0, start=0;
    for(let i=0;i<len;i++){ acc+=arr[i]; if(acc>=target){ start=i; break; } }
    acc=0; let end=len-1;
    for(let i=len-1;i>=0;i--){ acc+=arr[i]; if(acc>=target){ end=i; break; } }
    if(end<=start){ start=Math.round(len*0.06); end=Math.round(len*0.94); }
    return [start,end];
  }

  let [x0,x1] = findBounds(colSum, w);
  let [y0,y1] = findBounds(rowSum, h);

  const detW = x1-x0, detH = y1-y0;
  if(detW < w*0.25 || detH < h*0.25){
    x0 = Math.round(w*0.05); x1 = Math.round(w*0.95);
    y0 = Math.round(h*0.05); y1 = Math.round(h*0.95);
  }

  const padX = (x1-x0)*0.012, padY=(y1-y0)*0.012;
  x0+=padX; x1-=padX; y0+=padY; y1-=padY;

  return { tl:{x:x0,y:y0}, tr:{x:x1,y:y0}, br:{x:x1,y:y1}, bl:{x:x0,y:y1} };
}

function autoDetectCrop(){
  const canvas = cropSourceCanvas;
  const { w, h, mag } = computeEdges(canvas);

  let quad = null;
  try{
    const peaks = houghLines(mag, w, h, 0.22);
    quad = pickCardQuadFromLines(peaks, w, h);
  }catch(err){
    quad = null;
  }

  if(!quad){
    quad = bboxFallback(mag, w, h);
  }else{
    // small inward pad so we don't clip the physical card edge
    const cx = (quad.tl.x+quad.tr.x+quad.br.x+quad.bl.x)/4;
    const cy = (quad.tl.y+quad.tr.y+quad.br.y+quad.bl.y)/4;
    const padFactor = 0.985;
    for(const k of ['tl','tr','br','bl']){
      quad[k].x = cx + (quad[k].x-cx)*padFactor;
      quad[k].y = cy + (quad[k].y-cy)*padFactor;
    }
  }

  // clamp to canvas bounds
  for(const k of ['tl','tr','br','bl']){
    quad[k].x = Math.max(0, Math.min(w, quad[k].x));
    quad[k].y = Math.max(0, Math.min(h, quad[k].y));
  }

  cropQuad = quad;
  drawCropOverlay();
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
  ctx.strokeStyle = '#3fb27f';
  ctx.lineWidth = 2.5;
  ctx.fillStyle = 'rgba(63,178,127,0.12)';
  ctx.beginPath();
  ctx.moveTo(q.tl.x,q.tl.y);
  ctx.lineTo(q.tr.x,q.tr.y);
  ctx.lineTo(q.br.x,q.br.y);
  ctx.lineTo(q.bl.x,q.bl.y);
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  // corner handles
  ctx.fillStyle = '#3fb27f';
  [q.tl,q.tr,q.br,q.bl].forEach(pt=>{
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 9, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.stroke();
  });
  ctx.restore();
}

let dragCorner = null;
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
  }
  function move(e){
    if(!dragCorner) return;
    e.preventDefault();
    const pos = getPos(e);
    cropQuad[dragCorner].x = Math.max(0, Math.min(canvas.width, pos.x));
    cropQuad[dragCorner].y = Math.max(0, Math.min(canvas.height, pos.y));
    drawCropOverlay();
  }
  function end(){ dragCorner = null; }

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
  card.status = 'cropped';
  card.enhanced = false;
  closeCropModal();
  renderGrid();
  toast('Crop tersimpan — tepi kartu diluruskan otomatis ✓');
}

// =========================================================
// ENHANCE / HD (on-device): unsharp mask + adaptive contrast +
// high-quality 2x upscale (bicubic-ish via multi-pass canvas
// smoothing). Ini memperjelas foto buram tanpa mengganti data asli
// KTP — murni pertajam & upscale, tidak menghasilkan konten baru.
// =========================================================

function runEnhance(id, btnEl){
  const card = cards.find(c=>c.id===id);
  if(!card || !card.croppedDataURL) return;

  const origSvg = btnEl.innerHTML;
  btnEl.disabled = true;
  btnEl.innerHTML = `<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-9-9"/></svg>`;

  setTimeout(()=>{ // allow UI to paint spinner before heavy sync work
    const img = new Image();
    img.onload = ()=>{
      const enhancedURL = enhanceImage(img);
      card.croppedDataURL = enhancedURL;
      card.status = 'enhanced';
      card.enhanced = true;
      btnEl.disabled = false;
      btnEl.innerHTML = origSvg;
      renderGrid();
      toast('Foto berhasil diperjelas (HD) ✓');
    };
    img.src = card.croppedDataURL;
  }, 30);
}

function enhanceImage(img){
  const scaleFactor = 1.6; // upscale for extra sharpness headroom, then we keep native print size
  const w = img.width, h = img.height;
  const upW = Math.round(w*scaleFactor), upH = Math.round(h*scaleFactor);

  // Step 1: high-quality upscale via staged smoothing (reduces blockiness vs single-step)
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
  const data = imgData.data;

  // Step 2: unsharp mask (gaussian blur approx via box blur x3, then subtract)
  const blurred = boxBlur3(data, curW, curH);
  const amount = 0.9; // sharpen strength
  for(let i=0;i<data.length;i+=4){
    for(let c=0;c<3;c++){
      const orig = data[i+c];
      const blur = blurred[i+c];
      let v = orig + (orig-blur)*amount;
      data[i+c] = clamp(v);
    }
  }

  // Step 3: adaptive contrast + slight saturation lift (helps faded/washed-out card photos)
  const contrast = 1.12;
  const brightness = 6;
  for(let i=0;i<data.length;i+=4){
    for(let c=0;c<3;c++){
      let v = (data[i+c]-128)*contrast + 128 + brightness;
      data[i+c] = clamp(v);
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return stageCanvas.toDataURL('image/jpeg', 0.95);
}

function clamp(v){ return v<0?0:(v>255?255:v); }

function boxBlur3(data, w, h){
  let out = boxBlurPass(data, w, h);
  out = boxBlurPass(out, w, h);
  out = boxBlurPass(out, w, h);
  return out;
}
function boxBlurPass(data, w, h){
  const out = new Uint8ClampedArray(data.length);
  const radius = 1;
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
// PRINT LAYOUT — kartu KTP (13.5 x 9cm, landscape) dirotasi 90°
// KHUSUS saat digambar ke lembar cetak (bukan diubah di data hasil
// crop) supaya jejak di kertas jadi 9cm lebar x 13.5cm tinggi
// (+ ruang no HP). Ini memungkinkan 2 kolom x 2 baris = 4 kartu per
// lembar F4 — sama seperti layout referensi Word (gambar diputar
// 270°, disusun 2x2). Rotasi manual yang user atur di editor crop
// (putar kiri/kanan) TIDAK memengaruhi ini — itu cuma untuk
// meluruskan orientasi foto sebelum crop; hasil crop akhir selalu
// disimpan landscape (rasio 13.5:9), dan rotasi 90° cetak ini
// diterapkan terpisah, konsisten untuk semua kartu.
// Sizing presisi dalam mm, dirender ke canvas print-DPI, diekspor
// ke PDF via jsPDF (unit mm, ukuran fisik akurat di kertas manapun).
// =========================================================

const DPI = 203; // good balance: crisp print, manageable canvas size
const MM_TO_PX = DPI/25.4;

function closePreviewModal(){ el('previewModal').style.display='none'; }

el('btnPreview').addEventListener('click', openPreview);
el('btnPreviewMobile').addEventListener('click', openPreview);

// Blok kartu di kertas: lebar = sisi pendek KTP (9cm, karena kartu
// diputar 90° saat dicetak), tinggi = sisi panjang KTP (13.5cm) +
// ruang tulis no HP.
function computeLayout(){
  const p = paper();
  const blockWmm = CARD_H_CM*10;                    // 90mm (sisi pendek jadi lebar kolom)
  const blockHmm = CARD_W_CM*10 + PHONE_SPACE_MM;    // 135+14 = 149mm (sisi panjang + ruang HP)
  const usableW = p.w - 2*MARGIN_MM;
  const usableH = p.h - 2*MARGIN_MM;
  const cols = Math.max(1, Math.floor((usableW+GAP_MM)/(blockWmm+GAP_MM)));
  const rows = Math.max(1, Math.floor((usableH+GAP_MM)/(blockHmm+GAP_MM)));
  return { blockWmm, blockHmm, cols, rows, perPage: cols*rows, paperW: p.w, paperH: p.h };
}

let previewReadyCards = [];
let previewPageIndex = 0;

function openPreview(){
  const ready = cards.filter(c=>c.croppedDataURL);
  if(!ready.length){ toast('Belum ada KTP yang di-crop'); return; }
  previewReadyCards = ready;
  previewPageIndex = 0;
  renderSheetPreview();
  el('previewModal').style.display = 'flex';

  el('btnPrevPage').onclick = ()=>{ if(previewPageIndex>0){ previewPageIndex--; renderSheetPreview(); } };
  el('btnNextPage').onclick = ()=>{
    const layout = computeLayout();
    const totalPages = Math.ceil(previewReadyCards.length/layout.perPage);
    if(previewPageIndex < totalPages-1){ previewPageIndex++; renderSheetPreview(); }
  };
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

function drawPageOfCards(ctx, pageCards, layout, pageWpx, pageHpx, onImagesReady){
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0,0,pageWpx,pageHpx);

  const marginPx = MARGIN_MM*MM_TO_PX;
  const gapPx = GAP_MM*MM_TO_PX;
  const blockWpx = layout.blockWmm*MM_TO_PX;      // printed block width (9cm, post-rotation)
  const blockHpx = layout.blockHmm*MM_TO_PX;      // printed block height (13.5cm photo + phone space)
  const photoLongPx = (CARD_W_CM*10)*MM_TO_PX;    // long side of card (13.5cm), now vertical
  const phoneHpx = (PHONE_SPACE_MM)*MM_TO_PX;

  let loaded = 0;
  const total = pageCards.length;
  if(total===0){ onImagesReady(); return; }

  pageCards.forEach((card, idx)=>{
    const col = idx % layout.cols;
    const row = Math.floor(idx/layout.cols);
    const x = marginPx + col*(blockWpx+gapPx);
    const y = marginPx + row*(blockHpx+gapPx);

    // cutting guide (dashed border around whole card block incl. phone space)
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
      // berdiri vertikal dan 2 kolom muat di kertas (persis referensi Word).
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, blockWpx, photoLongPx);
      ctx.clip();

      ctx.translate(x + blockWpx/2, y + photoLongPx/2);
      // -90° (bukan +90°) supaya foto & kop KTP berdiri persis seperti
      // referensi Word: bagian foto di ATAS, bukan malah jadi di bawah.
      ctx.rotate(-Math.PI/2);
      ctx.drawImage(img, -photoLongPx/2, -blockWpx/2, photoLongPx, blockWpx);
      ctx.restore();

      // photo border
      ctx.strokeStyle = '#888';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, blockWpx, photoLongPx);

      // phone-space area: light guide line + label
      const phoneY = y + photoLongPx;
      ctx.save();
      ctx.strokeStyle = '#333';
      ctx.setLineDash([]);
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.moveTo(x + blockWpx*0.12, phoneY + phoneHpx*0.62);
      ctx.lineTo(x + blockWpx*0.94, phoneY + phoneHpx*0.62);
      ctx.stroke();

      ctx.fillStyle = '#555';
      ctx.font = `${Math.round(phoneHpx*0.30)}px Arial`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('No. HP:', x + blockWpx*0.04, phoneY + phoneHpx*0.6);
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
  if(!ready.length){ toast('Belum ada KTP yang di-crop'); return; }

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
  pdf.save(`Cetak-KTP-${currentPaperKey}-${new Date().toISOString().slice(0,10)}.pdf`);
  toast(`PDF (${PAPER_SIZES[currentPaperKey].label}) siap cetak berhasil diunduh ✓`);
}

// ---------- Register service worker (PWA) ----------
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}

initPaperSelect();
renderGrid();
