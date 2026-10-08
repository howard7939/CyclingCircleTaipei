#!/usr/bin/env node
/**
 * 從 OSM (Overpass) 抓取路線範圍內的水域多邊形與河道中心線，存成
 * data/osm-water.json 供路段曝露度分類使用。
 *
 * 為什麼要河岸「多邊形」而不只是中心線：淡水河寬 500~1000 m，若用
 * waterway=river 的中心線算距離，河濱自行車道會被算成離水 400 m 以上，
 * 完全失去判別力。多邊形邊界才是真正的水岸線。
 *
 * 成功一次就快取；之後執行會直接沿用，除非加 --force。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/osm-water.json');
const ROUTE = resolve(ROOT, 'data/route.json');

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];

const FORCE = process.argv.includes('--force');
const BUFFER_DEG = 0.02; // bbox 外擴，約 2 km

function die(msg) { console.error('\n[FATAL] ' + msg + '\n'); process.exit(1); }

if (!existsSync(ROUTE)) die('找不到 ' + ROUTE + '，先執行 npm run preprocess');
if (existsSync(OUT) && !FORCE) {
  const c = JSON.parse(readFileSync(OUT, 'utf8'));
  console.log('已有快取 ' + OUT);
  console.log('  水域多邊形 ' + c.polygons.length + ' 個、河道中心線 ' + c.lines.length + ' 條（抓取於 ' + c.fetchedAt + '）');
  console.log('  要重新抓取請加 --force');
  process.exit(0);
}

const { meta } = JSON.parse(readFileSync(ROUTE, 'utf8'));
const bb = [
  (meta.bbox.minLat - BUFFER_DEG).toFixed(4),
  (meta.bbox.minLon - BUFFER_DEG).toFixed(4),
  (meta.bbox.maxLat + BUFFER_DEG).toFixed(4),
  (meta.bbox.maxLon + BUFFER_DEG).toFixed(4),
].join(',');

// 只要「大」水體與主要河道，避免把全台北的小池塘都拉下來
const QUERY = `[out:json][timeout:180];
(
  way["natural"="water"](${bb});
  way["waterway"="riverbank"](${bb});
  relation["natural"="water"](${bb});
  way["waterway"~"^(river|canal)$"](${bb});
);
out geom;`;

async function tryMirror(url) {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'CyclingCircleTaipei/0.1 (route exposure classification)',
    },
    body: 'data=' + encodeURIComponent(QUERY),
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error('HTTP ' + res.status + ' after ' + ms + 'ms: ' + text.slice(0, 200));
  if (!text.trimStart().startsWith('{')) {
    const m = /<strong[^>]*>Error<\/strong>:([^<]*)/.exec(text);
    throw new Error('非 JSON 回應 after ' + ms + 'ms: ' + (m ? m[1].trim() : text.slice(0, 200)));
  }
  const json = JSON.parse(text);
  if (!Array.isArray(json.elements)) throw new Error('回應缺少 elements 陣列');
  return { json, ms };
}

let result = null;
const failures = [];
for (const url of MIRRORS) {
  const host = new URL(url).host;
  process.stdout.write('嘗試 ' + host + ' ... ');
  try {
    const r = await tryMirror(url);
    console.log('OK ' + r.ms + 'ms, ' + r.json.elements.length + ' elements');
    result = { ...r, host };
    break;
  } catch (e) {
    console.log('失敗');
    console.log('   ' + e.message.replace(/\s+/g, ' ').slice(0, 220));
    failures.push(host + ': ' + e.message.slice(0, 120));
  }
}

if (!result) {
  die('所有 ' + MIRRORS.length + ' 個 Overpass 鏡像都失敗：\n  ' + failures.join('\n  ') +
      '\n\n這是外部服務問題，不是程式錯誤。稍後重試，或改用手動下載的 OSM 資料。');
}

// --- 整理成 polygons / lines ---
const polygons = [];
const lines = [];
let skipped = 0;

function ringOf(el) {
  if (Array.isArray(el.geometry)) {
    return el.geometry.filter((g) => g && Number.isFinite(g.lat)).map((g) => [g.lat, g.lon]);
  }
  return null;
}

for (const el of result.json.elements) {
  const tags = el.tags || {};
  const isWaterArea = tags.natural === 'water' || tags.waterway === 'riverbank';

  if (el.type === 'relation') {
    // multipolygon：取 outer 成員的 geometry
    const members = (el.members || []).filter((m) => m.role === 'outer' && Array.isArray(m.geometry));
    for (const m of members) {
      const ring = m.geometry.filter((g) => g && Number.isFinite(g.lat)).map((g) => [g.lat, g.lon]);
      if (ring.length >= 4) polygons.push({ name: tags.name || null, ring });
      else skipped++;
    }
    continue;
  }

  const ring = ringOf(el);
  if (!ring || ring.length < 2) { skipped++; continue; }

  if (isWaterArea) {
    const closed = ring.length >= 4 &&
      Math.abs(ring[0][0] - ring[ring.length - 1][0]) < 1e-7 &&
      Math.abs(ring[0][1] - ring[ring.length - 1][1]) < 1e-7;
    if (closed) polygons.push({ name: tags.name || null, ring });
    else lines.push({ name: tags.name || null, kind: 'waterEdge', pts: ring });
  } else {
    lines.push({ name: tags.name || null, kind: tags.waterway || 'waterway', pts: ring });
  }
}

// --- 一律當成折線處理 ---
// 距離分析只需要「水岸折線」，不需要拼接成合法多邊形：點到折線的距離
// 與折線是否閉合無關。唯一還需要的是尺度，用來濾掉小池塘（巷口池塘
// 沒有風程，不該讓市區路段被判成河濱）。尺度用外接框對角線即可，
// 不必算面積——避免未閉合環套進 shoelace 產生假面積。
const R = 6371008.8, D2R = Math.PI / 180;

function extentM(pts) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [la, lo] of pts) {
    if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
    if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
  }
  const latMean = (minLat + maxLat) / 2;
  const dy = (maxLat - minLat) * R * D2R;
  const dx = (maxLon - minLon) * R * D2R * Math.cos(latMean * D2R);
  return { spanM: Math.hypot(dx, dy), dxM: dx, dyM: dy };
}

const MIN_EXTENT_M = 150; // 小於此尺度的水體視為池塘，無風程意義

const edges = [];   // 水體邊界（面狀水域的輪廓）
const centers = []; // 河道中心線（waterway=river/canal）
let dropped = 0;

for (const p of polygons) {
  const e = extentM(p.ring);
  if (e.spanM < MIN_EXTENT_M) { dropped++; continue; }
  edges.push({ name: p.name, spanM: Math.round(e.spanM), pts: p.ring });
}
for (const l of lines) {
  const e = extentM(l.pts);
  if (l.kind === 'waterEdge') {
    if (e.spanM < MIN_EXTENT_M) { dropped++; continue; }
    edges.push({ name: l.name, spanM: Math.round(e.spanM), pts: l.pts });
  } else {
    centers.push({ name: l.name, kind: l.kind, spanM: Math.round(e.spanM), pts: l.pts });
  }
}
edges.sort((a, b) => b.spanM - a.spanM);

const payload = {
  fetchedAt: new Date().toISOString(),
  mirror: result.host,
  bbox: bb,
  minExtentM: MIN_EXTENT_M,
  edges,    // 用於「到水岸的距離」
  centers,  // 用於河道走向（河谷槽化風向的參考）
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload));

const nEdgePts = edges.reduce((a, l) => a + l.pts.length, 0);
const nCtrPts = centers.reduce((a, l) => a + l.pts.length, 0);
console.log('');
console.log('=== OSM 水域資料 ===');
console.log('鏡像          ' + result.host);
console.log('水岸折線      ' + edges.length + ' 條 / ' + nEdgePts + ' 點');
console.log('河道中心線    ' + centers.length + ' 條 / ' + nCtrPts + ' 點');
console.log('濾除小水體    ' + dropped + ' 個（外接框 < ' + MIN_EXTENT_M + ' m）');
if (skipped) console.log('幾何不完整    ' + skipped + ' 個 element 已略過');
console.log('');
console.log('尺度最大的 12 條水岸折線（確認主要河川都在）：');
for (const e of edges.slice(0, 12)) {
  console.log('  ' + String(e.spanM).padStart(6) + ' m span  ' + String(e.pts.length).padStart(5) + ' pts   ' +
              (e.name || '(無名)'));
}
const named = [...new Set(centers.map((l) => l.name).filter(Boolean))];
console.log('');
console.log('河道中心線名稱（' + named.length + ' 個）：');
console.log('  ' + named.slice(0, 24).join('、'));
console.log('');
console.log('已寫出 ' + OUT);
console.log('');
