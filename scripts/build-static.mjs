#!/usr/bin/env node
/**
 * 產生靜態快照 -> web/data/
 *
 * 用途：GitHub Pages 這類純靜態空間沒有後端。改由 GitHub Actions 定時執行
 * 本腳本，把算好的結果推上去，前端只讀 JSON。授權碼留在 Actions Secrets，
 * 永遠不會出現在前端原始碼裡。
 *
 * 刻意不用磁碟快取：cron 本身就是節流機制（每次執行都抓最新的），
 * 而 Actions 的檔案系統是暫存的，快取也活不過一次執行。
 *
 * 輸出兩個檔：
 *   route.min.json    路線幾何 + 分段（只留前端需要的欄位，1152 -> 約 500 KB）
 *   conditions.json   觀測資料與各項摘要
 *
 * 不輸出「方向分析的逐段結果」—— 那部分由前端用 physics.mjs 自己算，
 * 這樣參數滑桿才能即時反應，不必為每組參數預先產生一份快照。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { getConditions } from '../server/conditions.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'web/data');

const rnd = (v, n) => (typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(n) : v);
const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(0).padStart(6) + ' KB';
const sizes = (s) => {
  const b = Buffer.from(s);
  return kb(s) + '   gzip ' + (gzipSync(b).length / 1024).toFixed(0).padStart(4) +
         ' KB   brotli ' + (brotliCompressSync(b).length / 1024).toFixed(0).padStart(4) + ' KB';
};

function die(msg) { console.error('\n[FATAL] ' + msg + '\n'); process.exit(1); }

console.log('');
console.log('=== 產生靜態快照 ===');
if (!process.env.CWA_API_KEY) die('CWA_API_KEY 未設定。GitHub Actions 請設在 repository secrets。');

// ---------- 1. 路線：只留前端需要的欄位 ----------
const route = JSON.parse(await readFile(join(ROOT, 'data/route.json'), 'utf8'));
if (!route.segments?.length) die('data/route.json 沒有 segments，先執行 npm run build:data');
if (route.segments.some((s) => !s.exposure)) die('有路段缺 exposure，先執行 npm run sections');

// 路段標籤重複出現兩千多次，改成索引
const labels = [...new Set(route.segments.map((s) => s.sectionLabel))];
const slimSegments = route.segments.map((s) => ({
  // len / bearing / gradePct 直接進入方向分析，精度不足會讓前端算出的
  // 總時間與後端有系統性落差。實測 len 只留 1 位小數時，每段差 0.02 m
  // x 2630 段 = 53 m（總長的 0.08%），剛好造成 0.1 min 的差異。
  s0: rnd(s.s0, 1),
  len: rnd(s.len, 3),
  a: [rnd(s.a[0], 5), rnd(s.a[1], 5)],       // 5 位小數約 1 m，繪圖綽綽有餘
  b: [rnd(s.b[0], 5), rnd(s.b[1], 5)],
  bearing: rnd(s.bearing, 3),
  gradePct: rnd(s.gradePct, 4),
  ele: rnd(s.ele, 1),
  exposure: s.exposure,
  sec: labels.indexOf(s.sectionLabel),
  phase: s.phase ?? null,
  kFactor: s.kFactor ?? 1,
}));
const routeMin = {
  meta: { ...route.meta, sectionLabels: labels },
  segments: slimSegments,
};

// ---------- 2. 目前條件 ----------
console.log('抓取氣象資料（不使用磁碟快取）…');
const t0 = Date.now();
let cond;
try {
  cond = await getConditions({ full: true });
} catch (e) {
  die('取得騎乘條件失敗：' + e.message);
}
console.log('  耗時 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');

// 大聲檢查：這些缺一不可，缺了就不要產出半成品快照
if (!cond.wind?.openTerrain) die('快照缺少風場資料');
if (!cond.direction?.byDirection) die('快照缺少方向分析');
if (!cond.segments?.length) die('快照缺少逐段資料');

// 逐段只保留「觀測」—— 方向分析由前端自己算
// 欄位名刻意極短：2630 段 x 每個鍵都會重複兩千多次，名稱長度直接反映在檔案大小上
const segs = cond.segments.map((c) => ({
  // 存 u/v 而非「風速+風向」：後者在前端還原時會累積三角函數的捨入誤差，
  // 實測造成前後端 0.1 min 的落差。存分量就完全一致。
  u: rnd(c.windU, 4), v: rnd(c.windV, 4),
  g: rnd(c.openGustSigmaMs, 3),       // 開闊地陣風 σ（未折減）
  f: c.surf ? rnd(c.surf.filmMm, 3) : 0,
  z: c.surf?.radarDbz ?? null,        // 雷達回波 dBZ
  r: c.surf ? rnd(c.surf.rainNowMmPerH, 2) : 0,
  fc: c.fc?.rain ?? null,             // 臨近預報逐時刻雨強
}));

const snapshot = {
  generatedAt: cond.generatedAt,
  route: cond.route,
  wind: cond.wind,
  radar: cond.radar,
  nowcast: cond.nowcast,
  outlook: cond.outlook,
  uv: cond.uv,
  surface: { ...cond.surface, wettest: cond.surface.wettest },
  stations: cond.stations,
  params: cond.params,
  sources: cond.sources,
  // 前端自己跑方向分析所需的逐段輸入
  segments: segs,
  // 伺服器算好的那一份，供前端對照（確認前後端物理一致）
  serverDirection: {
    deltaSec: cond.direction.deltaSec,
    recommend: cond.direction.recommend,
    byDirection: Object.fromEntries(Object.entries(cond.direction.byDirection)
      .map(([k, v]) => [k, { timeMin: v.timeMin, avgSpeedKmh: v.avgSpeedKmh }])),
  },
  static: true,
};

await mkdir(OUT, { recursive: true });
const rj = JSON.stringify(routeMin), cj = JSON.stringify(snapshot);
await writeFile(join(OUT, 'route.min.json'), rj);
await writeFile(join(OUT, 'conditions.json'), cj);

console.log('');
console.log('輸出：');
console.log('  route.min.json     ' + sizes(rj));
console.log('  conditions.json    ' + sizes(cj));
console.log('');
console.log('摘要：');
console.log('  風 ' + cond.wind.openTerrain.speedMs + ' m/s @ ' + cond.wind.openTerrain.fromDeg +
            '°   ' + (cond.wind.gustClass?.label ?? ''));
console.log('  建議 ' + cond.direction.recommend + '   Δt ' + cond.direction.deltaSec + ' s');
console.log('  路面 濕 ' + cond.surface.wetKm + ' / 潮濕 ' + cond.surface.dampKm + ' / 乾 ' + cond.surface.dryKm + ' km');
console.log('  雷達 ' + (cond.radar?.available ? '可用（' + cond.radar.obsTime?.slice(11, 16) + '）' : '不可用') +
            '   臨近預報 ' + (cond.nowcast?.available ? '可用' : '不可用：' + (cond.nowcast?.reason ?? '')));
console.log('  逐時雨量實測 ' + (cond.surface.sources?.pastHourlyExact ?? 0) + '/' +
            (cond.surface.sources?.pastHourlyWindow ?? 0) + ' 小時');
console.log('');
