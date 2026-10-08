#!/usr/bin/env node
/**
 * 路線前處理：route.gpx -> data/route.json
 *
 * 產出每段 100 m 的路段，附帶行進方位角、坡度、地形分類、以及從 GPX
 * 時間戳反推的實際騎乘速度。這些是風場分析的輸入。
 *
 * 設計紀律：任何解析不到預期資料的情況都直接 exit 1，不要靜默產出半成品。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CFG = {
  gpx: resolve(ROOT, 'route.gpx'),
  out: resolve(ROOT, 'data/route.json'),
  resampleM: 100,        // 路段長度
  eleSmoothM: 150,       // 高度平滑視窗（GPS/氣壓高度雜訊很大）
  gradeMountainPct: 1.5, // 判為山區的坡度門檻
  eleMountainM: 25,      // 判為山區的高度門檻
  stopSpeedKmh: 5,       // 低於此速視為停等，不計入巡航速度
  maxGapM: 60,           // 相鄰原始點間距上限，超過代表軌跡有斷點
  closeGapM: 200,        // 起終點距離上限，超過代表不是閉環
};

const R_EARTH = 6371008.8;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

function die(msg) {
  console.error('\n[FATAL] ' + msg + '\n');
  process.exit(1);
}
function need(cond, msg) { if (!cond) die(msg); }

// ---------- 幾何 ----------
function haversine(a, b) {
  const la1 = a.lat * D2R, la2 = b.lat * D2R;
  const dla = la2 - la1, dlo = (b.lon - a.lon) * D2R;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** 行進方位角：0=北, 90=東, 順時針 */
function bearing(a, b) {
  const la1 = a.lat * D2R, la2 = b.lat * D2R, dlo = (b.lon - a.lon) * D2R;
  const y = Math.sin(dlo) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dlo);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

function lerpPoint(a, b, f) {
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------- 解析 GPX ----------
function parseGpx(xml) {
  const blocks = xml.match(/<trkpt\b[^>]*>[\s\S]*?<\/trkpt>|<trkpt\b[^>]*\/>/g);
  need(blocks && blocks.length > 500,
    'route.gpx 解析失敗：只找到 ' + (blocks ? blocks.length : 0) + ' 個 <trkpt>，預期數千個。檢查檔案是否為有效 GPX。');

  const pts = [];
  for (const b of blocks) {
    const la = /lat="([-\d.]+)"/.exec(b);
    const lo = /lon="([-\d.]+)"/.exec(b);
    need(la && lo, '有 <trkpt> 缺少 lat/lon 屬性：' + b.slice(0, 120));
    const el = /<ele>([-\d.eE+]+)<\/ele>/.exec(b);
    const tm = /<time>([^<]+)<\/time>/.exec(b);
    // Strava/Garmin 擴充欄位：實測功率是校正 CdA/Crr 的關鍵，別漏掉
    const pw = /<gpxpx:PowerInWatts>([-\d.]+)<\/gpxpx:PowerInWatts>/.exec(b);
    const hr = /<gpxtpx:hr>([-\d.]+)<\/gpxtpx:hr>/.exec(b);
    const cd = /<gpxtpx:cad>([-\d.]+)<\/gpxtpx:cad>/.exec(b);
    const at = /<gpxtpx:atemp>([-\d.]+)<\/gpxtpx:atemp>/.exec(b);
    pts.push({
      lat: +la[1],
      lon: +lo[1],
      ele: el ? +el[1] : null,
      t: tm ? Date.parse(tm[1]) : null,
      powerW: pw ? +pw[1] : null,
      hr: hr ? +hr[1] : null,
      cad: cd ? +cd[1] : null,
      atempC: at ? +at[1] : null,
    });
  }

  const nEle = pts.filter((p) => p.ele !== null).length;
  const nT = pts.filter((p) => Number.isFinite(p.t)).length;
  const nPw = pts.filter((p) => p.powerW !== null).length;
  const nHr = pts.filter((p) => p.hr !== null).length;
  console.log('擴充欄位：功率 ' + nPw + '/' + pts.length + '，心率 ' + nHr + '/' + pts.length +
              '，氣溫 ' + pts.filter((p) => p.atempC !== null).length + '/' + pts.length);
  need(nEle === pts.length,
    '高度資料不完整：' + nEle + '/' + pts.length + ' 個點有 <ele>。坡度分析需要全部有高度。');
  need(nT === pts.length,
    '時間資料不完整：' + nT + '/' + pts.length + ' 個點有 <time>。速度反推需要全部有時間。');

  // 去除連續重複點（Relive 靜止時會重複輸出同一座標）
  const dedup = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (haversine(dedup[dedup.length - 1], pts[i]) > 0.3) dedup.push(pts[i]);
  }
  return { pts: dedup, rawCount: pts.length };
}

// ---------- 主流程 ----------
const xml = readFileSync(CFG.gpx, 'utf8');
const { pts, rawCount } = parseGpx(xml);
need(pts.length > 500, '去重後只剩 ' + pts.length + ' 個點，軌跡異常。');

// 閉環檢查 + 收尾
const closeGap = haversine(pts[0], pts[pts.length - 1]);
need(closeGap <= CFG.closeGapM,
  '起終點相距 ' + closeGap.toFixed(1) + ' m，超過 ' + CFG.closeGapM +
  ' m，不像閉環路線。順逆時針分析必須是閉環。');
const lastT = pts[pts.length - 1].t;
pts.push({ ...pts[0], t: lastT + Math.round((closeGap / 6.0) * 1000), closing: true });

// 累積距離 + 間距檢查
const cum = [0];
let maxGap = 0, maxGapIdx = -1;
for (let i = 1; i < pts.length; i++) {
  const d = haversine(pts[i - 1], pts[i]);
  if (d > maxGap) { maxGap = d; maxGapIdx = i; }
  cum.push(cum[i - 1] + d);
}
const totalM = cum[cum.length - 1];
need(maxGap <= CFG.maxGapM,
  '軌跡在第 ' + maxGapIdx + ' 點（km ' + (cum[maxGapIdx] / 1000).toFixed(2) + '）有 ' +
  maxGap.toFixed(1) + ' m 的跳躍，超過 ' + CFG.maxGapM + ' m。重取樣會在此處失真。');

// 繞行方向：局部等距投影 + shoelace 面積
const latMean = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
const mPerDegLat = R_EARTH * D2R;
const mPerDegLon = R_EARTH * D2R * Math.cos(latMean * D2R);
let area2 = 0;
for (let i = 0; i < pts.length - 1; i++) {
  const x1 = pts[i].lon * mPerDegLon, y1 = pts[i].lat * mPerDegLat;
  const x2 = pts[i + 1].lon * mPerDegLon, y2 = pts[i + 1].lat * mPerDegLat;
  area2 += x1 * y2 - x2 * y1;
}
const areaKm2 = Math.abs(area2 / 2) / 1e6;
// x=東, y=北 的右手座標系：面積為正 => 數學正向 => 地圖上（北朝上）逆時針
const gpxOrientation = area2 > 0 ? 'CCW' : 'CW';

// 高度平滑（距離視窗移動平均）
const eleSmooth = new Array(pts.length);
{
  const half = CFG.eleSmoothM / 2;
  let lo = 0, hi = 0, sum = 0, n = 0;
  for (let i = 0; i < pts.length; i++) {
    while (hi < pts.length && cum[hi] <= cum[i] + half) { sum += pts[hi].ele; n++; hi++; }
    while (cum[lo] < cum[i] - half) { sum -= pts[lo].ele; n--; lo++; }
    eleSmooth[i] = n > 0 ? sum / n : pts[i].ele;
  }
}

// 原始點的瞬時速度（m/s），用於反推巡航速度
const instV = new Array(pts.length).fill(null);
for (let i = 1; i < pts.length; i++) {
  const dt = (pts[i].t - pts[i - 1].t) / 1000;
  if (dt > 0 && dt < 120) instV[i] = (cum[i] - cum[i - 1]) / dt;
}

// 依距離重取樣
function interpAt(s) {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid;
  }
  const span = cum[hi] - cum[lo];
  const f = span > 0 ? (s - cum[lo]) / span : 0;
  const p = lerpPoint(pts[lo], pts[hi], f);
  p.ele = eleSmooth[lo] + (eleSmooth[hi] - eleSmooth[lo]) * f;
  p.idx = lo;
  return p;
}

const nSeg = Math.max(1, Math.round(totalM / CFG.resampleM));
const step = totalM / nSeg; // 均分，讓最後一段不會是殘段
const nodes = [];
for (let k = 0; k <= nSeg; k++) nodes.push(interpAt(Math.min(totalM, k * step)));

const segments = [];
for (let k = 0; k < nSeg; k++) {
  const a = nodes[k], b = nodes[k + 1];
  const len = haversine(a, b);
  const gradePct = len > 0 ? ((b.ele - a.ele) / len) * 100 : 0;

  // 這段路內所有原始點的移動速度中位數
  const vs = [];
  for (let i = a.idx; i <= b.idx && i < pts.length; i++) {
    if (instV[i] !== null && instV[i] >= CFG.stopSpeedKmh / 3.6) vs.push(instV[i]);
  }
  const vMed = median(vs);

  // 這段路內的實測功率/心率（只取移動中的點）
  const pw = [], hr = [];
  for (let i = a.idx; i <= b.idx && i < pts.length; i++) {
    if (instV[i] === null || instV[i] < CFG.stopSpeedKmh / 3.6) continue;
    if (pts[i].powerW !== null) pw.push(pts[i].powerW);
    if (pts[i].hr !== null) hr.push(pts[i].hr);
  }
  const pMed = median(pw), hMed = median(hr);

  const eleMid = (a.ele + b.ele) / 2;
  const terrain = (Math.abs(gradePct) >= CFG.gradeMountainPct || eleMid >= CFG.eleMountainM)
    ? 'mountain' : 'lowland';

  segments.push({
    i: k,
    s0: +(k * step).toFixed(1),
    s1: +((k + 1) * step).toFixed(1),
    len: +len.toFixed(2),
    lat: +((a.lat + b.lat) / 2).toFixed(6),
    lon: +((a.lon + b.lon) / 2).toFixed(6),
    a: [+a.lat.toFixed(6), +a.lon.toFixed(6)],
    b: [+b.lat.toFixed(6), +b.lon.toFixed(6)],
    bearing: +bearing(a, b).toFixed(2),
    gradePct: +gradePct.toFixed(2),
    ele: +eleMid.toFixed(1),
    terrain,
    exposure: terrain === 'mountain' ? 'mountain' : null, // lowland 待 step 2 區分河濱/市區
    obsSpeedKmh: vMed === null ? null : +(vMed * 3.6).toFixed(2),
    obsPowerW: pMed === null ? null : Math.round(pMed),
    obsHr: hMed === null ? null : Math.round(hMed),
  });
}

// 山區段形態學閉合：填補被短平路打斷的山區，避免分類碎片化
{
  const isM = segments.map((s) => s.terrain === 'mountain');
  const CLOSE = 5; // <=5 段（500 m）的 lowland 若被山區包夾，視為山區
  for (let i = 0; i < isM.length; i++) {
    if (isM[i]) continue;
    let j = i;
    while (j < isM.length && !isM[j]) j++;
    if ((j - i) <= CLOSE && i > 0 && isM[i - 1] && j < isM.length && isM[j]) {
      for (let k = i; k < j; k++) {
        segments[k].terrain = 'mountain';
        segments[k].exposure = 'mountain';
      }
    }
    i = j - 1;
  }
}

// ---------- 驗證：閉環的切向量和應為零 ----------
let sumTx = 0, sumTy = 0, sumLen = 0;
for (const s of segments) {
  const br = s.bearing * D2R;
  sumTx += Math.sin(br) * s.len; // 東
  sumTy += Math.cos(br) * s.len; // 北
  sumLen += s.len;
}
const closureErrM = Math.hypot(sumTx, sumTy);
const closureRel = closureErrM / sumLen;

// ---------- 統計 ----------
const gain = segments.reduce((acc, s) => acc + Math.max(0, (s.gradePct / 100) * s.len), 0);
const byTerrain = {};
for (const s of segments) {
  const t = (byTerrain[s.terrain] ||= { km: 0, n: 0, speeds: [] });
  t.km += s.len / 1000; t.n++;
  if (s.obsSpeedKmh !== null) t.speeds.push(s.obsSpeedKmh);
}

const gradeBins = [
  ['下坡 < -3%', (g) => g < -3],
  ['-3 ~ -1%', (g) => g >= -3 && g < -1],
  ['平路 -1 ~ 1%', (g) => g >= -1 && g <= 1],
  ['1 ~ 3%', (g) => g > 1 && g <= 3],
  ['3 ~ 6%', (g) => g > 3 && g <= 6],
  ['上坡 > 6%', (g) => g > 6],
];

const bbox = {
  minLat: Math.min(...pts.map((p) => p.lat)), maxLat: Math.max(...pts.map((p) => p.lat)),
  minLon: Math.min(...pts.map((p) => p.lon)), maxLon: Math.max(...pts.map((p) => p.lon)),
};

const out = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: 'route.gpx',
    rideDate: new Date(pts[0].t).toISOString(),
    rawPoints: rawCount,
    dedupPoints: pts.length,
    totalKm: +(totalM / 1000).toFixed(3),
    segmentCount: nSeg,
    segmentLenM: +step.toFixed(2),
    elevGainM: Math.round(gain),
    eleMin: +Math.min(...segments.map((s) => s.ele)).toFixed(1),
    eleMax: +Math.max(...segments.map((s) => s.ele)).toFixed(1),
    gpxOrientation,
    enclosedAreaKm2: +areaKm2.toFixed(2),
    closeGapM: +closeGap.toFixed(1),
    closureErrM: +closureErrM.toFixed(2),
    bbox,
    config: CFG,
  },
  segments,
};

mkdirSync(dirname(CFG.out), { recursive: true });
writeFileSync(CFG.out, JSON.stringify(out));

// ---------- 報告 ----------
const pad = (s, n) => String(s).padStart(n);
console.log('');
console.log('=== 路線前處理 ===');
console.log('原始點 ' + rawCount + ' -> 去重 ' + pts.length + '（移除 ' + (rawCount - pts.length + 1) + ' 個靜止重複點）');
console.log('總距離       ' + (totalM / 1000).toFixed(3) + ' km  ->  ' + nSeg + ' 段 x ' + step.toFixed(2) + ' m');
console.log('爬升         ' + Math.round(gain) + ' m   高度 ' + out.meta.eleMin + ' ~ ' + out.meta.eleMax + ' m');
console.log('起終點缺口   ' + closeGap.toFixed(1) + ' m（已程式補上收尾段）');
console.log('GPX 記錄方向 ' + gpxOrientation + '（' + (gpxOrientation === 'CCW' ? '逆時針' : '順時針') +
            '），環繞面積 ' + areaKm2.toFixed(1) + ' km2');
console.log('軌跡最大間距 ' + maxGap.toFixed(1) + ' m（上限 ' + CFG.maxGapM + ' m）');
console.log('');
console.log('閉環切向量和 |Σ t·ds| = ' + closureErrM.toFixed(2) + ' m，相對 ' +
            (closureRel * 1e6).toFixed(1) + ' ppm of ' + (sumLen / 1000).toFixed(1) + ' km');
console.log('  -> 這是「均勻風場繞閉環無方向偏好」的數值驗證：此值為 0 代表');
console.log('     順逆時針的逆風分量完全抵銷。非零殘差僅為離散化誤差。');
console.log('');
console.log('坡度分布：');
for (const [label, test] of gradeBins) {
  const ss = segments.filter((s) => test(s.gradePct));
  const km = ss.reduce((a, s) => a + s.len / 1000, 0);
  const v = median(ss.map((s) => s.obsSpeedKmh).filter((x) => x !== null));
  console.log('  ' + label.padEnd(14) + pad(km.toFixed(1), 5) + ' km  ' +
              pad((100 * km / (totalM / 1000)).toFixed(1), 5) + '%   實測中位速 ' +
              (v === null ? '  n/a' : pad(v.toFixed(1), 5) + ' km/h'));
}
console.log('');
const pwSegs = segments.filter((s) => s.obsPowerW !== null);
if (pwSegs.length) {
  const allP = pwSegs.map((s) => s.obsPowerW);
  console.log('實測功率：' + pwSegs.length + '/' + segments.length + ' 段有資料   中位 ' +
              median(allP).toFixed(0) + ' W   範圍 ' + Math.min(...allP) + '-' + Math.max(...allP) + ' W');
  console.log('  依坡度：');
  for (const [label, test] of gradeBins) {
    const ss = pwSegs.filter((s) => test(s.gradePct));
    if (!ss.length) continue;
    console.log('    ' + label.padEnd(14) + pad(median(ss.map((s) => s.obsPowerW)).toFixed(0), 5) + ' W   中位速 ' +
                pad(median(ss.map((s) => s.obsSpeedKmh)).toFixed(1), 5) + ' km/h');
  }
  console.log('');
}
console.log('地形分類：');
for (const [k, t] of Object.entries(byTerrain)) {
  const v = median(t.speeds);
  console.log('  ' + k.padEnd(10) + pad(t.km.toFixed(1), 5) + ' km (' + pad(t.n, 3) + ' 段)   實測中位速 ' +
              (v === null ? 'n/a' : v.toFixed(1) + ' km/h'));
}

const pending = segments.filter((s) => s.exposure === null);
if (pending.length) {
  const km = pending.reduce((a, s) => a + s.len / 1000, 0);
  console.log('');
  console.log('[待辦] ' + pending.length + ' 段 / ' + km.toFixed(1) + ' km 標為 lowland 但尚未區分');
  console.log('       「河濱」與「市區」（exposure=null）。這會直接影響風場加權，');
  console.log('       必須在 step 2 用 OSM 水道資料補完，不能用預設值蒙過去。');
}
console.log('');
console.log('已寫出 ' + CFG.out);
console.log('');
