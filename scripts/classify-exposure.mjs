#!/usr/bin/env node
/**
 * 路段曝露度分類：data/route.json + data/osm-water.json -> 回寫 route.json
 *
 * exposure 的物理意義是「風程 / 遮蔽程度」，不是行政區劃：
 *   riverside 河濱floodplain，上風向無建物，風程長 -> 風影響最大
 *   urban     市區街廓，建物遮蔽 + 粗糙長度大 -> 風影響中等
 *   mountain  山區，地形遮蔽且騎乘功率以重力為主 -> 風影響最小
 *
 * 同時算出每段的「最近河道走向」，供後續風場的河谷槽化模型使用。
 *
 * 紀律：先輸出距離分布，確認門檻有數據支撐，再做分類。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = resolve(ROOT, 'data/route.json');
const WATER = resolve(ROOT, 'data/osm-water.json');

const CFG = {
  riversideM: 250,      // 到水岸 <= 此距離且地勢低平 -> 河濱
  majorRiverSpanM: 2000, // 只有這個尺度以上的水體才算有風程
  channelSearchM: 1500,  // 搜尋河道走向的半徑
};

const R = 6371008.8, D2R = Math.PI / 180, R2D = 180 / Math.PI;

function die(msg) { console.error('\n[FATAL] ' + msg + '\n'); process.exit(1); }
function need(c, m) { if (!c) die(m); }

need(existsSync(ROUTE), '找不到 ' + ROUTE + '，先執行 npm run preprocess');
need(existsSync(WATER), '找不到 ' + WATER + '，先執行 node scripts/fetch-osm-water.mjs');

const route = JSON.parse(readFileSync(ROUTE, 'utf8'));
const water = JSON.parse(readFileSync(WATER, 'utf8'));
need(route.segments?.length > 100, 'route.json 的 segments 異常：' + (route.segments?.length ?? 0) + ' 段');
need(water.edges?.length > 0, 'osm-water.json 沒有水岸折線');

// --- 局部平面投影（以路線中心為原點，公尺） ---
const lat0 = (route.meta.bbox.minLat + route.meta.bbox.maxLat) / 2;
const lon0 = (route.meta.bbox.minLon + route.meta.bbox.maxLon) / 2;
const kx = R * D2R * Math.cos(lat0 * D2R);
const ky = R * D2R;
const prj = (la, lo) => [(lo - lon0) * kx, (la - lat0) * ky];

/** 點到線段的距離平方 + 線段方向 */
function segDist2(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const L2 = vx * vx + vy * vy;
  let t = L2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
  return { d2: dx * dx + dy * dy, vx, vy, L2 };
}

// --- 預先投影水域幾何 ---
const majorEdges = water.edges.filter((e) => e.spanM >= CFG.majorRiverSpanM);
need(majorEdges.length > 0,
  '沒有任何水體的尺度 >= ' + CFG.majorRiverSpanM + ' m。門檻設定有誤或抓到的資料不對。');
const edgeXY = majorEdges.map((e) => ({ name: e.name, spanM: e.spanM, p: e.pts.map(([la, lo]) => prj(la, lo)) }));
const ctrXY = water.centers.map((c) => ({ name: c.name, p: c.pts.map(([la, lo]) => prj(la, lo)) }));

console.log('');
console.log('=== 曝露度分類 ===');
console.log('路段           ' + route.segments.length + ' 段 x ' + route.meta.segmentLenM + ' m');
console.log('主要水體        ' + edgeXY.length + '/' + water.edges.length +
            ' 條（span >= ' + CFG.majorRiverSpanM + ' m），' +
            edgeXY.reduce((a, e) => a + e.p.length, 0) + ' 點');
console.log('河道中心線      ' + ctrXY.length + ' 條，' + ctrXY.reduce((a, c) => a + c.p.length, 0) + ' 點');

// --- 逐段計算到水岸距離 + 最近河道走向 ---
for (const s of route.segments) {
  const [px, py] = prj(s.lat, s.lon);

  let best = Infinity, bestName = null;
  for (const e of edgeXY) {
    const p = e.p;
    for (let i = 0; i < p.length - 1; i++) {
      const r = segDist2(px, py, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]);
      if (r.d2 < best) { best = r.d2; bestName = e.name; }
    }
  }
  s.distWaterM = Math.round(Math.sqrt(best));
  s.nearWater = bestName;

  // 最近河道的局部走向（0..180，軸向無方向性）
  let cBest = Infinity, cAxis = null, cName = null;
  for (const c of ctrXY) {
    const p = c.p;
    for (let i = 0; i < p.length - 1; i++) {
      const r = segDist2(px, py, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]);
      if (r.d2 < cBest && r.L2 > 25) {
        cBest = r.d2;
        cAxis = (Math.atan2(r.vx, r.vy) * R2D + 360) % 180; // 轉成方位角後取模 180
        cName = c.name;
      }
    }
  }
  const cDist = Math.sqrt(cBest);
  s.channelAxisDeg = cDist <= CFG.channelSearchM && cAxis !== null ? +cAxis.toFixed(1) : null;
  s.channelName = s.channelAxisDeg !== null ? cName : null;
  s.channelDistM = Math.round(cDist);
}

// --- 先看分布，再定門檻 ---
const lowland = route.segments.filter((s) => s.terrain === 'lowland');
const bins = [0, 50, 100, 150, 200, 250, 300, 400, 600, 1000, 2000, Infinity];
console.log('');
console.log('lowland 路段（' + lowland.length + ' 段）到主要水岸的距離分布：');
let cumPct = 0;
for (let i = 0; i < bins.length - 1; i++) {
  const n = lowland.filter((s) => s.distWaterM >= bins[i] && s.distWaterM < bins[i + 1]).length;
  if (n === 0) continue;
  const pct = 100 * n / lowland.length;
  cumPct += pct;
  const label = bins[i + 1] === Infinity ? '>= ' + bins[i] + ' m' : bins[i] + '-' + bins[i + 1] + ' m';
  console.log('  ' + label.padEnd(14) + String(n).padStart(4) + ' 段  ' +
              pct.toFixed(1).padStart(5) + '%  累積 ' + cumPct.toFixed(1).padStart(5) + '%  ' +
              '#'.repeat(Math.round(pct)));
}

// --- 套用分類 ---
// 注意順序：terrain 的 mountain 是在前處理階段只憑坡度/高度判的，當時還沒有
// 水域資料。河濱車道的跨堤坡道與橋梁引道在 100 m 內坡度就超過 1.5%，會被誤
// 判成山區。而那裡的物理恰恰相反——高於堤頂、四周無遮蔽，是全線最曝露處。
// 所以離水近的「山區」必須降級為河濱，否則權重的符號是錯的。
let nRamp = 0;
for (const s of route.segments) {
  if (s.terrain === 'mountain' && s.distWaterM <= CFG.riversideM) {
    s.exposure = 'riverside';
    s.rampOverLevee = true; // 跨堤/橋梁引道：坡度屬山區特徵，曝露屬河濱
    nRamp++;
    continue;
  }
  if (s.terrain === 'mountain') { s.exposure = 'mountain'; continue; }
  s.exposure = s.distWaterM <= CFG.riversideM ? 'riverside' : 'urban';
}
if (nRamp) {
  console.log('');
  console.log('[修正] ' + nRamp + ' 段原判為山區但離水 <= ' + CFG.riversideM +
              ' m，判定為跨堤/橋梁引道，曝露度改為河濱：');
  for (const s of route.segments.filter((x) => x.rampOverLevee)) {
    console.log('       km ' + (s.s0 / 1000).toFixed(1).padStart(5) + '  坡度 ' +
                String(s.gradePct).padStart(6) + '%  離水 ' + String(s.distWaterM).padStart(4) +
                ' m  高度 ' + String(s.ele).padStart(5) + ' m');
  }
}

// 形態學閉合：短的孤立 urban 夾在河濱中間，通常是橋下或水岸幾何缺口
{
  const segs = route.segments;
  const CLOSE = 4; // <= 400 m
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].exposure !== 'urban') continue;
    let j = i;
    while (j < segs.length && segs[j].exposure === 'urban') j++;
    const L = (i - 1 + segs.length) % segs.length, Rr = j % segs.length;
    if ((j - i) <= CLOSE && segs[L].exposure === 'riverside' && segs[Rr].exposure === 'riverside') {
      for (let k = i; k < j; k++) { segs[k].exposure = 'riverside'; segs[k].exposureFilled = true; }
    }
    i = j - 1;
  }
}

// --- 連續區段報告（這是人眼能驗證的部分） ---
const runs = [];
for (const s of route.segments) {
  const last = runs[runs.length - 1];
  if (last && last.exposure === s.exposure) { last.endKm = s.s1 / 1000; last.n++; last.water.push(s.distWaterM); }
  else runs.push({ exposure: s.exposure, startKm: s.s0 / 1000, endKm: s.s1 / 1000, n: 1, water: [s.distWaterM], name: s.nearWater });
}

console.log('');
console.log('沿路線的連續區段（' + runs.length + ' 段）：');
const NAME = { riverside: '河濱', urban: '市區', mountain: '山區' };
for (const r of runs) {
  const km = r.endKm - r.startKm;
  const medW = [...r.water].sort((a, b) => a - b)[r.water.length >> 1];
  const flag = km < 0.5 ? '  <- 很短，可疑' : '';
  console.log('  km ' + r.startKm.toFixed(1).padStart(5) + ' - ' + r.endKm.toFixed(1).padStart(5) +
              '  (' + km.toFixed(1).padStart(4) + ' km)  ' + NAME[r.exposure].padEnd(3) +
              '  中位離水 ' + String(medW).padStart(5) + ' m' + flag);
}

const byExp = {};
for (const s of route.segments) {
  const e = (byExp[s.exposure] ||= { km: 0, n: 0 });
  e.km += s.len / 1000; e.n++;
}
console.log('');
console.log('總計：');
for (const [k, v] of Object.entries(byExp)) {
  console.log('  ' + NAME[k].padEnd(3) + ' ' + v.km.toFixed(1).padStart(5) + ' km (' +
              String(v.n).padStart(3) + ' 段)  ' + (100 * v.km / route.meta.totalKm).toFixed(1).padStart(5) + '%');
}
const filled = route.segments.filter((s) => s.exposureFilled).length;
if (filled) console.log('  （其中 ' + filled + ' 段由形態學閉合補為河濱，多為橋下/水岸幾何缺口）');

const noChannel = route.segments.filter((s) => s.channelAxisDeg === null).length;
console.log('');
console.log('河道走向：' + (route.segments.length - noChannel) + '/' + route.segments.length +
            ' 段在 ' + CFG.channelSearchM + ' m 內找到河道（供槽化風場模型使用）');

route.meta.exposureClassifiedAt = new Date().toISOString();
route.meta.exposureConfig = CFG;
writeFileSync(ROUTE, JSON.stringify(route));
console.log('');
console.log('已回寫 ' + ROUTE);
console.log('');
