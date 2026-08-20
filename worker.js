/**
 * Cetak KTP — Statistik Penggunaan API
 * Cloudflare Worker + KV, pengganti Google Apps Script.
 *
 * Kompatibel 1:1 dengan app.js yang sudah ada — TIDAK perlu ubah kode
 * app.js sama sekali, cukup ganti nilai STATS_API_BASE ke URL worker ini.
 *
 * Endpoint (semua GET, tanpa CORS preflight):
 *   ?action=hit&key=printDirect      -> +1 counter "Cetak Langsung"
 *   ?action=hit&key=downloadPdf      -> +1 counter "Download PDF"
 *   ?action=getAll                   -> { printDirect, downloadPdf, lastUsedAt }
 *
 * Setup KV (lihat README.md untuk detail step-by-step):
 *   1. wrangler kv namespace create STATS_KV
 *   2. Tempel id yang dihasilkan ke wrangler.toml
 *   3. wrangler deploy
 */

const ALLOWED_KEYS = new Set(['printDirect', 'downloadPdf']);

// Ganti '*' dengan origin spesifik (mis. 'https://username.github.io')
// kalau mau lebih ketat. '*' aman di sini karena endpoint ini read/increment
// only, tidak ada data sensitif atau auth yang bisa disalahgunakan.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed, gunakan GET' }, 405);
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    try {
      if (action === 'hit') {
        const key = url.searchParams.get('key');
        if (!ALLOWED_KEYS.has(key)) {
          return json({ error: `key tidak dikenal: ${key}` }, 400);
        }

        // Baca nilai lama, +1, simpan lagi. KV eventually-consistent, tapi
        // untuk counter statistik non-kritis ini cukup aman (worst case:
        // ada 2 hit nyaris bersamaan detik yang sama di region berbeda
        // ke-skip 1 hitungan — bukan masalah utk angka agregat kasar).
        const current = parseInt((await env.STATS_KV.get(key)) || '0', 10);
        const next = current + 1;

        await Promise.all([
          env.STATS_KV.put(key, String(next)),
          env.STATS_KV.put('lastUsedAt', new Date().toISOString()),
        ]);

        return json({ ok: true, key, value: next });
      }

      if (action === 'getAll') {
        const [printDirect, downloadPdf, lastUsedAt] = await Promise.all([
          env.STATS_KV.get('printDirect'),
          env.STATS_KV.get('downloadPdf'),
          env.STATS_KV.get('lastUsedAt'),
        ]);

        return json({
          printDirect: parseInt(printDirect || '0', 10),
          downloadPdf: parseInt(downloadPdf || '0', 10),
          lastUsedAt: lastUsedAt || null,
        });
      }

      return json({ error: `action tidak dikenal: ${action}` }, 400);
    } catch (e) {
      return json({ error: `Server error: ${e.message}` }, 500);
    }
  },
};
