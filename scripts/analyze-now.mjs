#!/usr/bin/env node
/**
 * 取得目前氣象資料，執行風場與方向分析，把結果印出來。
 * 先用數字確認模型行為正確，再談畫面。
 *
 * 執行：node --env-file=.env scripts/analyze-now.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cwaStations, cwaRain, cwaUv, openMeteo } from '../server/sources.mjs';
import {
  DEFAULT_PARAMS, airDensity, buildSpeedCurve, openWindField,
  analyzeDirections, selfTest, toUV, toSpeedDir,
} from '../server/wind-model.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = resolve(ROOT, 'data/route.json');
const pad = (v, n) => String(v).padStart(n);
const NAME = { riverside: '河濱', urban: '市區', mountain: '山區' };

if (!existsSync(ROUTE)) { console.error('\n[FATAL] 找不到 ' + ROUTE + '，先執行 npm run build:data\n'); process.exit(1); }
const route = JSON.parse(readFileSync(ROUTE, 'utf8'));
const segs = route.segments;
const M = route.meta;
if (segs.some((s) => !s.exposure)) { console.error('\n[FATAL] 有路段缺 exposure，先執行 npm run sections\n'); process.exit(1); }

// ---------- 0. 自我檢驗 ----------
console.log('');
console.log('=== 0. 自我檢驗：均勻風場繞閉環應無方向偏好 ===');
console.log('  風向      CW(kJ)   CCW(kJ)      Δ      其中離散化    其中側風yaw');
for (const d of [0, 45, 70, 135, 200, 315]) {
  const t = selfTest(segs, M.gpxOrientation, { windMs: 5, fromDeg: d });
  console.log('  ' + pad(d, 3) + '°  ' + pad(t.cwKJ, 9) + pad(t.ccwKJ, 10) + pad(t.deltaKJ, 8) +
              pad(t.discretizationKJ.toFixed(3), 13) + pad(t.yawTermKJ.toFixed(3), 14));
}
console.log('  -> 純縱向模型下「均勻風場繞閉環零方向偏好」是嚴格恆等式，');
console.log('     所以「離散化」那一欄才是幾何誤差；「側風yaw」是真實物理效應');
console.log('     （側風增大視風速因而增加阻力），不是 bug。兩者合計即為');
console.log('     方向判斷的雜訊底線：小於此量級的差異沒有意義。');

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
console.log('  CWA 測站    ' + obs.stations.length + ' 站（全台 ' + (obs.totalStations ?? '?') + '）  ' +
            (obs._cache || '') + (obs.error ? '  錯誤:' + obs.error : '') + '  觀測時間 ' +
            (obs.stations[0]?.obsTime ?? '—'));
console.log('  CWA 雨量站  ' + rain.stations.length + ' 站（全台 ' + (rain.totalStations ?? '?') + '）  ' + (rain._cache || ''));
console.log('  CWA 紫外線  ' + uv.stations.length + ' 站  ' + (uv._cache || '') + '  （' + (uv.note || '') + '）');
console.log('  Open-Meteo  ' + om.points.length + ' 取樣點  ' + (om._cache || '') + '  現況時間 ' + om.points[0].current.time);
console.log('  耗時 ' + (Date.now() - t0) + ' ms');

// ---------- 2. 兩個來源的風交叉比對 ----------
const withWind = obs.stations.filter((s) => s.windMs != null && s.windFromDeg != null);
const low = withWind.filter((s) => s.altM == null || s.altM < 200);
let su = 0, sv = 0, ssum = 0;
for (const s of low) { const c = toUV(s.windMs, s.windFromDeg); su += c.u; sv += c.v; ssum += s.windMs; }
const stVec = toSpeedDir(su / low.length, sv / low.length);
const stScalar = ssum / low.length;

let ou = 0, ov = 0;
for (const p of om.points) { const c = toUV(p.current.windMs, p.current.windFromDeg); ou += c.u; ov += c.v; }
const omVec = toSpeedDir(ou / om.points.length, ov / om.points.length);

const angDiff = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
console.log('');
console.log('=== 2. 兩個來源交叉比對 ===');
console.log('  CWA 低地測站（' + low.length + ' 站）  向量平均 ' + stVec.speedMs.toFixed(2) + ' m/s @ ' +
            stVec.fromDeg.toFixed(0) + '°   純量平均風速 ' + stScalar.toFixed(2) + ' m/s' +
            '   方向一致性 ' + (stVec.speedMs / stScalar).toFixed(2));
console.log('  Open-Meteo 開闊地       向量平均 ' + omVec.speedMs.toFixed(2) + ' m/s @ ' + omVec.fromDeg.toFixed(0) + '°');
const dd = angDiff(stVec.fromDeg, omVec.fromDeg);
console.log('  風向差 ' + dd.toFixed(0) + '°  ' + (dd <= 45 ? '✓ 一致' : '✗ 不一致，模型結果需存疑'));
console.log('  風速比 模式/測站純量 = ' + (omVec.speedMs / stScalar).toFixed(2) +
            '（>1 符合預期：測站受設站遮蔽讀低，模式為開闊地值）');

const alt = withWind.filter((s) => s.altM != null && s.altM >= 400);
if (alt.length) {
  console.log('  參考：高海拔站（' + alt.length + ' 站，≥400 m）平均風速 ' +
              (alt.reduce((a, s) => a + s.windMs, 0) / alt.length).toFixed(2) + ' m/s');
}

// ---------- 3. 速度曲線 ----------
const curve = buildSpeedCurve(segs);
console.log('');
console.log('=== 3. 坡度→速度曲線（由你自己的 GPX 時間戳建立） ===');
console.log('  取樣 ' + curve.sampleCount + ' 段');
console.log('  坡度   -8%   -5%   -3%   -1%    0%    1%    3%    5%    8%');
console.log('  速度 ' + [-8, -5, -3, -1, 0, 1, 3, 5, 8].map((g) => pad(curve.speedAt(g).toFixed(1), 5)).join(' ') + '  km/h');

// ---------- 4. 風場與方向分析 ----------
const tempC = low.length ? low.reduce((a, s) => a + (s.tempC ?? 25), 0) / low.length : 25;
const params = { ...DEFAULT_PARAMS, rho: +airDensity(tempC, 1013).toFixed(3) };
const field = openWindField(segs, om.points);
const res = analyzeDirections(segs, field, M.gpxOrientation, params, curve);

const fs_ = field.map((f) => f.speedMs);
console.log('');
console.log('=== 4. 開闊地風場（內插到 ' + segs.length + ' 段） ===');
console.log('  風速範圍 ' + Math.min(...fs_).toFixed(2) + ' – ' + Math.max(...fs_).toFixed(2) + ' m/s' +
            '（空間變化 ' + (100 * (Math.max(...fs_) - Math.min(...fs_)) / (fs_.reduce((a, b) => a + b, 0) / fs_.length)).toFixed(0) + '%）');
console.log('  空氣密度 ' + params.rho + ' kg/m³（氣溫 ' + tempC.toFixed(1) + ' °C）');
console.log('  曝露度係數 ' + Object.entries(params.exposureK).map(([k, v]) => NAME[k] + ' ' + v).join('、'));

console.log('');
console.log('=== 5. 方向分析 ===');
for (const d of ['CW', 'CCW']) {
  const r = res.directions[d];
  console.log('  ' + (d === 'CW' ? '順時針' : '逆時針') + '  空氣阻力作功 ' + pad(r.aeroWorkKJ, 7) + ' kJ   ' +
              '預估時間 ' + pad(r.timeMin, 6) + ' min');
  for (const ex of ['riverside', 'urban', 'mountain']) {
    const e = r.byExposure[ex];
    if (!e) continue;
    console.log('       ' + NAME[ex] + ' ' + pad(e.km.toFixed(1), 5) + ' km  作功 ' + pad(e.aeroWorkKJ, 7) +
                ' kJ  平均逆風分量 ' + pad(e.meanHeadwindMs.toFixed(2), 6) + ' m/s');
  }
}
console.log('');
console.log('  差值 ΔW = W(順) − W(逆) = ' + res.deltaKJ + ' kJ  （' + res.deltaPct + '% of 平均）');
console.log('  各類別對差值的貢獻：' +
  Object.entries(res.contributionKJ).map(([k, v]) => NAME[k] + ' ' + v.toFixed(2) + ' kJ').join('、'));
console.log('');
const nt = selfTest(segs, M.gpxOrientation, { windMs: omVec.speedMs, fromDeg: omVec.fromDeg });
const noise = Math.abs(nt.deltaKJ);
console.log('  同強度均勻風的雜訊底線 ' + noise.toFixed(3) + ' kJ' +
            '（離散化 ' + nt.discretizationKJ.toFixed(3) + ' + yaw ' + nt.yawTermKJ.toFixed(3) + '）');
console.log('  訊噪比 ' + (Math.abs(res.deltaKJ) / Math.max(1e-6, noise)).toFixed(0) + '×');
console.log('  推估持續功率 ' + res.estPowerW + ' W（由爬坡段反推，對 CdA 不確定性最不敏感）');
if (Math.abs(res.deltaKJ) < noise * 3) {
  console.log('  -> 差值未達底線的 3 倍，視為無顯著方向偏好，順逆皆可。');
} else {
  console.log('  -> 建議方向：' + (res.recommend === 'CCW' ? '逆時針' : '順時針') +
              '  省 ' + Math.abs(res.deltaKJ).toFixed(1) + ' kJ ' +
              '≈ 定功率下省 ' + Math.floor(res.deltaSec / 60) + ' 分 ' + (res.deltaSec % 60) + ' 秒');
}

// ---------- 6. 雨 ----------
const rs = rain.stations.filter((s) => s.hr1 != null);
const wet = rs.filter((s) => (s.hr1 ?? 0) > 0);
const recent = rs.filter((s) => (s.hr6 ?? 0) > 0);
console.log('');
console.log('=== 6. 降雨 ===');
console.log('  雨量站 ' + rs.length + ' 站有效   過去 1 小時有雨 ' + wet.length + ' 站   過去 6 小時有雨 ' + recent.length + ' 站');
if (wet.length) {
  console.log('  目前降雨中的站（前 8）：');
  for (const s of wet.sort((a, b) => b.hr1 - a.hr1).slice(0, 8)) {
    console.log('    ' + (s.name || s.id).padEnd(10) + ' 1hr ' + pad(s.hr1, 5) + ' mm   3hr ' + pad(s.hr3 ?? '—', 5) +
                '   24hr ' + pad(s.hr24 ?? '—', 5) + '   ' + (s.county || '') + (s.town || ''));
  }
} else {
  console.log('  目前無降雨。');
}

// ---------- 7. 紫外線 ----------
const uvNow = om.points.map((p) => p.current.uvIndex).filter((x) => Number.isFinite(x));
const tp = uv.stations.find((s) => s.id === '466920');
console.log('');
console.log('=== 7. 紫外線 ===');
console.log('  Open-Meteo 即時 UV（路線各點）' +
            (uvNow.length ? Math.min(...uvNow).toFixed(1) + ' – ' + Math.max(...uvNow).toFixed(1) : '—') +
            '   白天 ' + (om.points[0].current.isDay ? '是' : '否'));
console.log('  CWA 臺北站今日最大值 ' + (tp ? tp.uvIndex : '—') + '（' + (uv.note || '') + '）');
console.log('');
