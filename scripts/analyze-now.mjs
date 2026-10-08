#!/usr/bin/env node
/**
 * 取得目前氣象資料，在固定目標功率下比較順時針與逆時針。
 * 先用數字確認模型行為正確，再談畫面。
 *
 * 執行：node --env-file=.env scripts/analyze-now.mjs
 * 覆寫：POWER_W=120 MASS_KG=75 node --env-file=.env scripts/analyze-now.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cwaStations, cwaRain, cwaUv, openMeteo } from '../server/sources.mjs';
import {
  airDensity, openWindField, analyzeDirections, selfTest,
  toUV, toSpeedDir, loadParams, exposureDisplacement, solveSpeedMs,
} from '../server/wind-model.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = resolve(ROOT, 'data/route.json');
const pad = (v, n) => String(v).padStart(n);
const NAME = { riverside: '河濱', urban: '市區', mountain: '山區' };
const mmss = (sec) => {
  const s = Math.abs(Math.round(sec));
  return Math.floor(s / 60) + ' 分 ' + String(s % 60).padStart(2, '0') + ' 秒';
};

if (!existsSync(ROUTE)) { console.error('\n[FATAL] 找不到 ' + ROUTE + '，先執行 npm run build:data\n'); process.exit(1); }
const route = JSON.parse(readFileSync(ROUTE, 'utf8'));
const segs = route.segments;
const M = route.meta;
if (segs.some((s) => !s.exposure)) { console.error('\n[FATAL] 有路段缺 exposure，先執行 npm run sections\n'); process.exit(1); }

const params0 = loadParams({
  overrides: { targetPowerW: process.env.POWER_W, massKg: process.env.MASS_KG },
});

// ---------- 1. 取資料 ----------
const BUF = 0.18; // 約 18 km；更大會抓進宜蘭/桃園，隔著山脈不具代表性
const bbox = {
  minLat: M.bbox.minLat - BUF, maxLat: M.bbox.maxLat + BUF,
  minLon: M.bbox.minLon - BUF, maxLon: M.bbox.maxLon + BUF,
};
const NS = 12;
const samplePts = Array.from({ length: NS }, (_, i) => {
  const s = segs[Math.floor(i * segs.length / NS)];
  return { name: 'km' + (s.s0 / 1000).toFixed(0), lat: s.lat, lon: s.lon };
});

console.log('');
console.log('=== 1. 取得資料 ===');
const t0 = Date.now();
const [obs, rain, uv, om] = await Promise.all([
  cwaStations(bbox).catch((e) => ({ error: e.message, stations: [] })),
  cwaRain(bbox).catch((e) => ({ error: e.message, stations: [] })),
  cwaUv().catch((e) => ({ error: e.message, stations: [] })),
  openMeteo(samplePts),
]);
console.log('  CWA 測站    ' + obs.stations.length + ' 站  ' + (obs._cache || '') +
            '  觀測時間 ' + (obs.stations[0]?.obsTime ?? '—'));
console.log('  CWA 雨量站  ' + rain.stations.length + ' 站  ' + (rain._cache || ''));
console.log('  Open-Meteo  ' + om.points.length + ' 取樣點  ' + (om._cache || '') +
            '  現況時間 ' + om.points[0].current.time);
console.log('  耗時 ' + (Date.now() - t0) + ' ms');

// ---------- 2. 兩個來源交叉比對 ----------
const withWind = obs.stations.filter((s) => s.windMs != null && s.windFromDeg != null);
const low = withWind.filter((s) => s.altM == null || s.altM < 200);
let su = 0, sv = 0, ssum = 0, tsum = 0, tn = 0;
for (const s of low) {
  const c = toUV(s.windMs, s.windFromDeg);
  su += c.u; sv += c.v; ssum += s.windMs;
  if (s.tempC != null) { tsum += s.tempC; tn++; }
}
const stVec = toSpeedDir(su / low.length, sv / low.length);
const stScalar = ssum / low.length;
const tempC = tn ? tsum / tn : 25;

let ou = 0, ov = 0;
for (const p of om.points) { const c = toUV(p.current.windMs, p.current.windFromDeg); ou += c.u; ov += c.v; }
const omVec = toSpeedDir(ou / om.points.length, ov / om.points.length);
const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const dd = angDiff(stVec.fromDeg, omVec.fromDeg);

console.log('');
console.log('=== 2. 兩個來源交叉比對 ===');
console.log('  CWA 低地測站（' + low.length + ' 站）  向量平均 ' + stVec.speedMs.toFixed(2) + ' m/s @ ' +
            stVec.fromDeg.toFixed(0) + '°   純量平均 ' + stScalar.toFixed(2) +
            '   方向一致性 ' + (stVec.speedMs / stScalar).toFixed(2));
console.log('  Open-Meteo 開闊地       ' + omVec.speedMs.toFixed(2) + ' m/s @ ' + omVec.fromDeg.toFixed(0) + '°');
console.log('  風向差 ' + dd.toFixed(0) + '°  ' + (dd <= 45 ? '✓ 一致' : '✗ 不一致，模型結果需存疑') +
            '   遮蔽比 ' + (omVec.speedMs / stScalar).toFixed(2));

// ---------- 3. 車手模型 ----------
const params = { ...params0, rho: +airDensity(tempC, 1013).toFixed(3) };
console.log('');
console.log('=== 3. 車手模型（功率 -> 速度） ===');
console.log('  目標功率    ' + params.targetPowerW + ' W' + (process.env.POWER_W ? '（環境變數覆寫）' : ''));
console.log('  總質量      ' + params.massKg + ' kg');
console.log('  CdA         ' + params.cdaM2 + ' m²   Crr ' + params.crr +
            (params._riderProfile ? '   （由實測功率校正，R²=' + params._riderProfile.r2 + '）' : ''));
console.log('  空氣密度    ' + params.rho + ' kg/m³（氣溫 ' + tempC.toFixed(1) + ' °C）');
console.log('  下坡上限    ' + params.maxSpeedKmh + ' km/h');
console.log('  無風下的速度（km/h）：');
console.log('    坡度  ' + [-6, -3, -1, 0, 1, 3, 6, 9].map((g) => pad(g + '%', 7)).join(''));
console.log('    速度  ' + [-6, -3, -1, 0, 1, 3, 6, 9]
  .map((g) => pad((solveSpeedMs(params.targetPowerW, g, 0, 0, params) * 3.6).toFixed(1), 7)).join(''));

// ---------- 4. 自我檢驗 ----------
console.log('');
console.log('=== 4. 自我檢驗 ===');
const st = selfTest(segs, M.gpxOrientation, { windMs: omVec.speedMs, fromDeg: omVec.fromDeg, params });
console.log('  零風 + 坡度歸零      Δt = ' + st.geometrySec.toFixed(3) + ' s   <- 必須為 0（驗證幾何與方向反轉）');
console.log('  均勻風 + 坡度歸零    Δt = ' + st.uniformWindSec.toFixed(2) + ' s   <- 定功率下 t(h) 的凸性效應（真實）');
console.log('  零風 + 真實坡度      Δt = ' + st.calmGradeSec.toFixed(2) + ' s   <- 上下坡換邊的不對稱（真實，與天氣無關）');
if (Math.abs(st.geometrySec) > 0.5) {
  console.error('\n[FATAL] 零風平路的方向差不為零（' + st.geometrySec + ' s），幾何或方向反轉有誤。\n');
  process.exit(1);
}

// ---------- 5. 風場 ----------
const field = openWindField(segs, om.points);
const res = analyzeDirections(segs, field, M.gpxOrientation, params);
const D = exposureDisplacement(segs, params);
const fs_ = field.map((f) => f.speedMs);

console.log('');
console.log('=== 5. 開闊地風場 ===');
console.log('  風速範圍 ' + Math.min(...fs_).toFixed(2) + ' – ' + Math.max(...fs_).toFixed(2) + ' m/s');
console.log('  曝露度係數 ' + Object.entries(params.exposureK).map(([k, v]) => NAME[k] + ' ' + v).join('、'));
console.log('  曝露度加權位移 |D| ' + D.magnitudeKm.toFixed(3) + ' km @ ' + D.bearingDeg.toFixed(1) + '°');
console.log('  -> 風從 ' + D.ccwCenterFromDeg.toFixed(0) + '° 來時最該逆時針；臨界風向 ' +
            D.criticalFromDeg.map((x) => x.toFixed(0) + '°').join(' / '));

// ---------- 6. 方向比較 ----------
console.log('');
console.log('=== 6. 方向比較（固定 ' + params.targetPowerW + ' W） ===');
for (const d of ['CW', 'CCW']) {
  const r = res.directions[d];
  console.log('  ' + (d === 'CW' ? '順時針' : '逆時針') + '   總時間 ' + pad(r.timeMin.toFixed(2), 7) + ' min  (' +
              mmss(r.timeS) + ')   均速 ' + pad(r.avgSpeedKmh.toFixed(2), 6) + ' km/h   能量 ' +
              pad(r.energyKJ, 7) + ' kJ   煞車上限路段 ' + r.brakingCapKm.toFixed(1) + ' km');
  for (const ex of ['riverside', 'urban', 'mountain']) {
    const e = r.byExposure[ex];
    if (!e) continue;
    console.log('       ' + NAME[ex] + ' ' + pad(e.km.toFixed(1), 5) + ' km   ' + pad(e.timeMin.toFixed(2), 6) +
                ' min   均速 ' + pad(e.avgSpeedKmh.toFixed(2), 6) + ' km/h   平均逆風 ' +
                pad(e.meanHeadwindMs.toFixed(2), 6) + ' m/s');
  }
}

console.log('');
console.log('  Δt = t(順) − t(逆) = ' + res.deltaSec.toFixed(1) + ' s  （' + mmss(res.deltaSec) + '，' +
            res.deltaPct + '% of 平均）');
console.log('  各類別貢獻：' + Object.entries(res.contributionSec)
  .map(([k, v]) => NAME[k] + ' ' + (v >= 0 ? '+' : '') + v.toFixed(0) + ' s').join('、'));
console.log('  與天氣無關的常數項（零風）：' + st.calmGradeSec.toFixed(1) + ' s');
console.log('  純風造成的部分：          ' + (res.deltaSec - st.calmGradeSec).toFixed(1) + ' s');
console.log('  數值底線（零風平路）：    ' + Math.abs(st.geometrySec).toFixed(3) + ' s');
console.log('');
if (Math.abs(res.deltaSec) < 15) {
  console.log('  -> 差距不到 15 秒，兩個方向實質相當，順逆皆可。');
} else {
  console.log('  -> 建議方向：' + (res.recommend === 'CCW' ? '逆時針' : '順時針') + '   快 ' + mmss(res.deltaSec));
}

// ---------- 7. 目標功率敏感度 ----------
console.log('');
console.log('=== 7. 目標功率對建議的影響 ===');
console.log('  功率(W)    順時針       逆時針        Δt      建議');
for (const P of [80, 100, 120, 150, 200]) {
  const r = analyzeDirections(segs, field, M.gpxOrientation, { ...params, targetPowerW: P });
  console.log('  ' + pad(P, 6) + '   ' + pad(r.directions.CW.timeMin.toFixed(1), 8) + ' min ' +
              pad(r.directions.CCW.timeMin.toFixed(1), 8) + ' min ' + pad(r.deltaSec.toFixed(0), 7) + ' s   ' +
              (Math.abs(r.deltaSec) < 15 ? '相當' : (r.recommend === 'CCW' ? '逆時針' : '順時針')));
}

// ---------- 8. 降雨 / 紫外線 ----------
const rs = rain.stations.filter((s) => s.hr1 != null);
const wet = rs.filter((s) => (s.hr1 ?? 0) > 0);
console.log('');
console.log('=== 8. 降雨 / 紫外線 ===');
console.log('  雨量站 ' + rs.length + ' 站   過去 1 小時有雨 ' + wet.length + ' 站   過去 6 小時 ' +
            rs.filter((s) => (s.hr6 ?? 0) > 0).length + ' 站');
for (const s of wet.sort((a, b) => b.hr1 - a.hr1).slice(0, 5)) {
  console.log('    ' + (s.name || s.id).padEnd(10) + ' 1hr ' + pad(s.hr1, 5) + ' mm   6hr ' + pad(s.hr6 ?? '—', 5) +
              '   ' + (s.county || '') + (s.town || ''));
}
const uvNow = om.points.map((p) => p.current.uvIndex).filter((x) => Number.isFinite(x));
console.log('  即時 UV ' + (uvNow.length ? Math.min(...uvNow).toFixed(1) + '–' + Math.max(...uvNow).toFixed(1) : '—') +
            '   白天 ' + (om.points[0].current.isDay ? '是' : '否') +
            '   CWA 臺北今日最大 ' + (uv.stations?.find((s) => s.id === '466920')?.uvIndex ?? '—'));
console.log('');
