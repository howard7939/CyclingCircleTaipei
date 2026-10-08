#!/usr/bin/env node
/**
 * 套用權威路段分類 + 計算幾何診斷量
 *   輸入 data/route.json、data/sections.json、data/osm-water.json
 *   回寫 data/route.json
 *
 * 分工：
 *   exposure（風程曝露度）來自 data/sections.json — 騎乘者實地分類，權威。
 *   distWaterM / channelAxisDeg 由幾何算出 — 風場模型需要，與分類無關。
 *
 * 這支腳本同時輸出「自動幾何推測 vs 實地分類」的混淆矩陣。自動推測已經
 * 不再決定 exposure，但這個數字能回答：換一條沒有實地分類的路線時，
 * 自動方法可以信到什麼程度。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = resolve(ROOT, 'data/route.json');
const WATER = resolve(ROOT, 'data/osm-water.json');
const SECTIONS = resolve(ROOT, 'data/sections.json');

const CFG = {
  riversideM: 250,       // 自動推測用的離水門檻（僅供比對，不再決定分類）
  majorRiverSpanM: 2000, // 只有這個尺度以上的水體才算有風程
  channelSearchM: 1500,  // 搜尋河道走向的半徑
};

const VALID = new Set(['riverside', 'urban', 'mountain']);
const NAME = { riverside: '河濱', urban: '市區', mountain: '山區' };
const R = 6371008.8, D2R = Math.PI / 180, R2D = 180 / Math.PI;

function die(msg) { console.error('\n[FATAL] ' + msg + '\n'); process.exit(1); }
function need(c, m) { if (!c) die(m); }

need(existsSync(ROUTE), '找不到 ' + ROUTE + '，先執行 npm run preprocess');
need(existsSync(WATER), '找不到 ' + WATER + '，先執行 node scripts/fetch-osm-water.mjs');
need(existsSync(SECTIONS), '找不到 ' + SECTIONS);

const route = JSON.parse(readFileSync(ROUTE, 'utf8'));
const water = JSON.parse(readFileSync(WATER, 'utf8'));
const spec = JSON.parse(readFileSync(SECTIONS, 'utf8'));
need(route.segments?.length > 100, 'route.json 的 segments 異常：' + (route.segments?.length ?? 0) + ' 段');
need(water.edges?.length > 0, 'osm-water.json 沒有水岸折線');

// ---------- 驗證分類表：必須完整覆蓋、不重疊、不留縫 ----------
const secs = spec.sections;
need(Array.isArray(secs) && secs.length > 0, 'sections.json 沒有 sections 陣列');
const routeKm = route.meta.totalKm;
for (const [i, s] of secs.entries()) {
  need(Number.isFinite(s.fromKm) && Number.isFinite(s.toKm),
    '第 ' + i + ' 個 section 的 fromKm/toKm 不是數字：' + JSON.stringify(s));
  need(s.toKm > s.fromKm, '第 ' + i + ' 個 section 的 toKm 不大於 fromKm：' + JSON.stringify(s));
  need(VALID.has(s.exposure),
    '第 ' + i + ' 個 section 的 exposure "' + s.exposure + '" 不在 ' + [...VALID].join('/') + ' 之中');
}
need(Math.abs(secs[0].fromKm) < 1e-9, '第一個 section 必須從 0.0 km 開始，實際為 ' + secs[0].fromKm);
for (let i = 1; i < secs.length; i++) {
  need(Math.abs(secs[i].fromKm - secs[i - 1].toKm) < 1e-9,
    '第 ' + (i - 1) + ' 與第 ' + i + ' 個 section 之間有縫或重疊：' +
    secs[i - 1].toKm + ' -> ' + secs[i].fromKm);
}
const specEnd = secs[secs.length - 1].toKm;
// 本流程會補一段閉環收尾（GPX 起終點相距 27.5 m），所以總長會略大於 GPX 原長。
// 這段位於最後一個 section 內，直接把它延伸到實際總長即可，不需縮放里程。
const tailM = (routeKm - specEnd) * 1000;
need(tailM > -1 && tailM < 200,
  '分類表總長 ' + specEnd + ' km 與路線總長 ' + routeKm + ' km 相差 ' + tailM.toFixed(1) +
  ' m，超出閉環收尾段的合理範圍。請確認 sections.json 的里程與目前的 route.gpx 相符。');

// ---------- 局部平面投影 ----------
const lat0 = (route.meta.bbox.minLat + route.meta.bbox.maxLat) / 2;
const lon0 = (route.meta.bbox.minLon + route.meta.bbox.maxLon) / 2;
const kx = R * D2R * Math.cos(lat0 * D2R), ky = R * D2R;
const prj = (la, lo) => [(lo - lon0) * kx, (la - lat0) * ky];

function segDist2(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const L2 = vx * vx + vy * vy;
  let t = L2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
  return { d2: dx * dx + dy * dy, vx, vy, L2 };
}

const majorEdges = water.edges.filter((e) => e.spanM >= CFG.majorRiverSpanM);
need(majorEdges.length > 0, '沒有任何水體的尺度 >= ' + CFG.majorRiverSpanM + ' m。');
const edgeXY = majorEdges.map((e) => ({ name: e.name, p: e.pts.map(([la, lo]) => prj(la, lo)) }));
const ctrXY = water.centers.map((c) => ({ name: c.name, p: c.pts.map(([la, lo]) => prj(la, lo)) }));

console.log('');
console.log('=== 套用實地路段分類 ===');
console.log('分類來源    ' + spec.source + '（' + spec.providedAt + '）');
console.log('路線        ' + routeKm.toFixed(3) + ' km / ' + route.segments.length + ' 段');
console.log('分類表      ' + secs.length + ' 個 section，覆蓋 0 ~ ' + specEnd + ' km');
console.log('收尾段      最後一段延伸 ' + tailM.toFixed(1) + ' m 以涵蓋閉環補點（不縮放里程）');

// ---------- 幾何診斷 ----------
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

  let cBest = Infinity, cAxis = null, cName = null;
  for (const c of ctrXY) {
    const p = c.p;
    for (let i = 0; i < p.length - 1; i++) {
      const r = segDist2(px, py, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]);
      if (r.d2 < cBest && r.L2 > 25) {
        cBest = r.d2;
        cAxis = (Math.atan2(r.vx, r.vy) * R2D + 360) % 180;
        cName = c.name;
      }
    }
  }
  const cDist = Math.sqrt(cBest);
  s.channelAxisDeg = cDist <= CFG.channelSearchM && cAxis !== null ? +cAxis.toFixed(1) : null;
  s.channelName = s.channelAxisDeg !== null ? cName : null;
  s.channelDistM = Math.round(cDist);
}

// ---------- 套用分類（以路段中點所在的 section 為準） ----------
function sectionAt(km) {
  for (const s of secs) if (km >= s.fromKm && km < s.toKm) return s;
  return secs[secs.length - 1]; // 收尾段
}
for (const s of route.segments) {
  const midKm = (s.s0 + s.s1) / 2000;
  const sec = sectionAt(midKm);
  s.exposure = sec.exposure;
  s.sectionLabel = sec.label;
  s.phase = sec.phase ?? null;
  delete s.exposureFilled;
  delete s.rampOverLevee;
}

// ---------- 自動幾何推測（僅供比對） ----------
for (const s of route.segments) {
  s.autoExposure = s.terrain === 'mountain'
    ? 'mountain'
    : (s.distWaterM <= CFG.riversideM ? 'riverside' : 'urban');
}

// ---------- 報告 ----------
const pad = (v, n) => String(v).padStart(n);
const byExp = {};
for (const s of route.segments) {
  const e = (byExp[s.exposure] ||= { km: 0, n: 0 });
  e.km += s.len / 1000; e.n++;
}
console.log('');
console.log('分類結果：');
for (const k of ['riverside', 'urban', 'mountain']) {
  const v = byExp[k] || { km: 0, n: 0 };
  console.log('  ' + NAME[k] + '  ' + pad(v.km.toFixed(2), 6) + ' km (' + pad(v.n, 3) + ' 段)  ' +
              pad((100 * v.km / routeKm).toFixed(1), 5) + '%');
}

console.log('');
console.log('各 section：');
for (const sec of secs) {
  const ss = route.segments.filter((s) => {
    const km = (s.s0 + s.s1) / 2000;
    return km >= sec.fromKm && km < sec.toKm;
  });
  const km = ss.reduce((a, s) => a + s.len / 1000, 0);
  const eles = ss.map((s) => s.ele);
  const vs = ss.map((s) => s.obsSpeedKmh).filter((x) => x != null).sort((a, b) => a - b);
  console.log('  km ' + pad(sec.fromKm.toFixed(1), 5) + ' – ' + pad(sec.toKm.toFixed(1), 5) +
              '  ' + NAME[sec.exposure] + '  ' + pad(km.toFixed(1), 5) + ' km  高度 ' +
              pad(Math.min(...eles).toFixed(0), 4) + '–' + pad(Math.max(...eles).toFixed(0), 4) + ' m  中位速 ' +
              pad(vs.length ? vs[vs.length >> 1].toFixed(1) : '—', 5) + ' km/h   ' + sec.label);
}

// ---------- 混淆矩陣：自動推測 vs 實地分類 ----------
const KEYS = ['riverside', 'urban', 'mountain'];
const cm = {};
for (const a of KEYS) { cm[a] = {}; for (const b of KEYS) cm[a][b] = 0; }
for (const s of route.segments) cm[s.exposure][s.autoExposure] += s.len / 1000;

const totalAll = route.segments.reduce((a, s) => a + s.len / 1000, 0);
const agree = KEYS.reduce((a, k) => a + cm[k][k], 0);

console.log('');
console.log('自動幾何推測 vs 實地分類（單位 km）：');
console.log('                     自動推測');
console.log('  實地        ' + KEYS.map((k) => pad(NAME[k], 7)).join('') + '     小計');
for (const a of KEYS) {
  const rowSum = KEYS.reduce((x, b) => x + cm[a][b], 0);
  console.log('  ' + NAME[a].padEnd(10) + KEYS.map((b) => pad(cm[a][b].toFixed(1), 7)).join('') +
              pad(rowSum.toFixed(1), 9));
}
console.log('');
console.log('  一致 ' + agree.toFixed(1) + ' / ' + totalAll.toFixed(1) + ' km = ' +
            (100 * agree / totalAll).toFixed(1) + '%');

const wrong = [];
for (const s of route.segments) if (s.exposure !== s.autoExposure) wrong.push(s);
if (wrong.length) {
  const runs = [];
  for (const s of wrong) {
    const last = runs[runs.length - 1];
    if (last && last.lastI === s.i - 1 && last.from === s.autoExposure && last.to === s.exposure) {
      last.endKm = s.s1 / 1000; last.lastI = s.i; last.w.push(s.distWaterM);
    } else {
      runs.push({ startKm: s.s0 / 1000, endKm: s.s1 / 1000, lastI: s.i, from: s.autoExposure, to: s.exposure, w: [s.distWaterM] });
    }
  }
  console.log('');
  console.log('  推測錯誤的區段（' + runs.length + ' 處）：');
  for (const r of runs) {
    const w = [...r.w].sort((a, b) => a - b);
    console.log('    km ' + pad(r.startKm.toFixed(1), 5) + ' – ' + pad(r.endKm.toFixed(1), 5) +
                ' (' + pad((r.endKm - r.startKm).toFixed(1), 4) + ' km)  推測 ' + NAME[r.from] +
                ' → 實為 ' + NAME[r.to] + '   中位離水 ' + pad(w[w.length >> 1], 5) + ' m');
  }
}

// ---------- 寫回 ----------
route.meta.sections = secs;
route.meta.waypoints = spec.waypoints || [];
route.meta.sectionSource = spec.source;
route.meta.sectionsAppliedAt = new Date().toISOString();
route.meta.autoAgreementPct = +(100 * agree / totalAll).toFixed(1);
route.meta.exposureConfig = CFG;
delete route.meta.exposureClassifiedAt;
writeFileSync(ROUTE, JSON.stringify(route));
console.log('');
console.log('已回寫 ' + ROUTE);
console.log('');
