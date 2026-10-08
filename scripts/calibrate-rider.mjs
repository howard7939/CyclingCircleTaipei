#!/usr/bin/env node
/**
 * 由 route.gpx 的實測功率校正車手/車輛參數 -> data/rider-profile.json
 *
 * 方法：區塊能量平衡（不是逐點力平衡）。
 *
 * 逐點力平衡 y = P/v − m·g·sinθ − m·a 看似直接，實際上不可用：
 * m·g·sinθ 這一項對坡度極度敏感（m=80 時坡度差 1% 就是 7.9 N），而逐點坡度
 * 必須在很短的基線上差分，殘留的高度雜訊會淹沒整個訊號。實測殘差 RMSE 7.87 N
 * 恰好等於這個量級，證實了這一點。
 *
 * 改用區塊積分後，高度差與動能差都只取端點（長基線、精確），雜訊被積掉：
 *
 *   ∫P dt  −  m·g·Δh  −  ΔKE   =   ½ρ·CdA·Σv_air²Δs   +   Crr·m·g·Σcosθ·Δs
 *   └────────── y ───────────┘      └ A ┘ └── x₁ ──┘      └─ B ─┘└── x₂ ──┘
 *
 * 對 (A, B) 做無截距的二元線性回歸。
 *
 * 質量 m 無法由本資料可靠辨識（與 Crr、CdA 強烈共線），必須外部給定：
 *   MASS_KG=72 node scripts/calibrate-rider.mjs
 *
 * 查核：若 GPX 的功率是 Strava「推估功率」而非功率計實測，它本身就是用同一套
 * 物理模型從速度與坡度反算的，此回歸即為循環論證。輸出 R² 供判斷。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GPX = resolve(ROOT, 'route.gpx');
const OUT = resolve(ROOT, 'data/rider-profile.json');

const CFG = {
  eleSmoothM: 200,        // 高度平滑視窗
  blockSec: 45,           // 區塊長度（時間）
  blockMinM: 250,         // 區塊最短距離
  // 低於此速視為停等。不可訂太高：這個門檻同時決定 sumDs 的累加，
  // 訂在 2.5 m/s (9 km/h) 會讓 7% 陡坡上大量秒數不被計入，使區塊距離
  // 不足而整塊被丟棄 —— 系統性砍掉最慢的爬坡資料，造成選擇偏差。
  minSpeedMs: 1.4,        // 5 km/h，與前處理的停等判準一致
  maxBrakeDropM: 8,       // 區塊內下降超過此值且功率偏低 -> 可能煞車，排除
  outlierSigma: 2.5,
};

const R_EARTH = 6371008.8, D2R = Math.PI / 180, G = 9.80665;
const pad = (v, n) => String(v).padStart(n);
const die = (m) => { console.error('\n[FATAL] ' + m + '\n'); process.exit(1); };
const median = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };

function haversine(a, b) {
  const la1 = a.lat * D2R, la2 = b.lat * D2R;
  const h = Math.sin((la2 - la1) / 2) ** 2 +
            Math.cos(la1) * Math.cos(la2) * Math.sin((b.lon - a.lon) * D2R / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(Math.min(1, h)));
}

// ---------- 解析 ----------
const xml = readFileSync(GPX, 'utf8');
const blocks0 = xml.match(/<trkpt\b[^>]*>[\s\S]*?<\/trkpt>/g);
if (!blocks0 || blocks0.length < 500) die('route.gpx 解析失敗：只找到 ' + (blocks0?.length ?? 0) + ' 個 trkpt');

const pts = [];
for (const b of blocks0) {
  const g = (re) => { const m = re.exec(b); return m ? +m[1] : null; };
  pts.push({
    lat: +/lat="([-\d.]+)"/.exec(b)[1],
    lon: +/lon="([-\d.]+)"/.exec(b)[1],
    ele: g(/<ele>([-\d.eE+]+)<\/ele>/),
    t: Date.parse(/<time>([^<]+)<\/time>/.exec(b)[1]),
    p: g(/<gpxpx:PowerInWatts>([-\d.]+)<\/gpxpx:PowerInWatts>/),
    cad: g(/<gpxtpx:cad>([-\d.]+)<\/gpxtpx:cad>/),
    temp: g(/<gpxtpx:atemp>([-\d.]+)<\/gpxtpx:atemp>/),
  });
}
const nP = pts.filter((x) => x.p !== null).length;
if (nP < 500) die('GPX 只有 ' + nP + ' 個點含功率，無法校正');

// ---------- 累積距離、平滑高度、逐點速度 ----------
const cum = [0];
for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));

const eleS = new Array(pts.length);
{
  const half = CFG.eleSmoothM / 2;
  let lo = 0, hi = 0, sum = 0, n = 0;
  for (let i = 0; i < pts.length; i++) {
    while (hi < pts.length && cum[hi] <= cum[i] + half) { sum += pts[hi].ele; n++; hi++; }
    while (cum[lo] < cum[i] - half) { sum -= pts[lo].ele; n--; lo++; }
    eleS[i] = n > 0 ? sum / n : pts[i].ele;
  }
}

const vS = new Array(pts.length).fill(0);
for (let i = 1; i < pts.length; i++) {
  const dt = (pts[i].t - pts[i - 1].t) / 1000;
  vS[i] = dt > 0 && dt < 30 ? (cum[i] - cum[i - 1]) / dt : 0;
}
vS[0] = vS[1];

const temps = pts.map((p) => p.temp).filter((x) => x !== null);
const tempC = temps.length ? median(temps) : 20;
const rho = (1013 * 100) / (287.05 * (tempC + 273.15));
const M = Number(process.env.MASS_KG) || 80;

// ---------- 切成區塊 ----------
const B = [];
let i0 = 0;
while (i0 < pts.length - 2) {
  let i1 = i0 + 1;
  while (i1 < pts.length - 1 &&
         ((pts[i1].t - pts[i0].t) / 1000 < CFG.blockSec || cum[i1] - cum[i0] < CFG.blockMinM)) i1++;
  if (i1 >= pts.length - 1) break;

  let energyJ = 0, sumV2ds = 0, sumDs = 0, movingSec = 0, nPow = 0, stopped = 0;
  let sumTx = 0, sumTy = 0;
  for (let i = i0 + 1; i <= i1; i++) {
    const dt = (pts[i].t - pts[i - 1].t) / 1000;
    const ds = cum[i] - cum[i - 1];
    if (!(dt > 0) || dt > 30) continue;
    const v = vS[i];
    if (v < CFG.minSpeedMs) { stopped += dt; continue; }
    if (pts[i].p !== null) { energyJ += pts[i].p * dt; nPow++; }
    sumV2ds += v * v * ds;
    sumDs += ds;
    movingSec += dt;
    // 平均行進方向（供風向擬合）
    const d = haversine(pts[i - 1], pts[i]);
    if (d > 0.5) {
      const la1 = pts[i - 1].lat * D2R, la2 = pts[i].lat * D2R;
      const dlo = (pts[i].lon - pts[i - 1].lon) * D2R;
      const by = Math.sin(dlo) * Math.cos(la2);
      const bx = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dlo);
      const br = Math.atan2(by, bx);
      sumTx += Math.sin(br) * ds; sumTy += Math.cos(br) * ds;
    }
  }

  const dH = eleS[i1] - eleS[i0];
  const dKE = 0.5 * M * (vS[i1] ** 2 - vS[i0] ** 2);
  const meanV = movingSec > 0 ? sumDs / movingSec : 0;
  const meanP = movingSec > 0 ? energyJ / movingSec : 0;

  // 注意門檻：爬坡區塊的均速約 10.8~11.2 km/h（3.0~3.1 m/s）。把下限訂在
  // 3 m/s 會剛好砍掉它們，而那正是分開 CdA 與 Crr 所需的低速槓桿
  // （爬坡 11 km/h 對平路 25 km/h，v² 差 5.2 倍）。訂在 2.2 m/s 才留得住。
  if (sumDs >= CFG.blockMinM && movingSec > 10 && nPow > movingSec * 0.5 && meanV >= 2.2) {
    B.push({
      i0, i1, km0: cum[i0] / 1000, dH, dKE, energyJ, sumV2ds, sumDs, movingSec, meanV, meanP, stopped,
      gradePct: (dH / sumDs) * 100,
      tx: sumDs > 0 ? sumTx / sumDs : 0, ty: sumDs > 0 ? sumTy / sumDs : 0,
    });
  }
  i0 = i1;
}

console.log('');
console.log('=== 車手參數校正（區塊能量平衡） ===');
console.log('軌跡點        ' + pts.length + '（含功率 ' + nP + '）');
console.log('區塊          ' + B.length + ' 個，每個約 ' + CFG.blockSec + ' s / ≥' + CFG.blockMinM + ' m');
{
  // 坡度槓桿檢查：分開 CdA 與 Crr 靠的是速度對比，而速度對比來自坡度。
  // 若陡坡區塊被濾光，回歸就只剩 22-29 km/h 的窄帶，兩參數分不開。
  const hb = [[-99, -4], [-4, -2], [-2, -1], [-1, 1], [1, 2], [2, 4], [4, 99]];
  console.log('  坡度分布（保留的區塊）：');
  for (const [lo, hi] of hb) {
    const g = B.filter((b) => b.gradePct >= lo && b.gradePct < hi);
    if (!g.length) continue;
    const vmin = Math.min(...g.map((b) => b.meanV)) * 3.6, vmax = Math.max(...g.map((b) => b.meanV)) * 3.6;
    console.log('    ' + pad(lo === -99 ? '<-4' : hi === 99 ? '>4' : lo + '~' + hi, 6) + '%  ' +
                pad(g.length, 4) + ' 個   速度 ' + pad(vmin.toFixed(1), 5) + '-' + pad(vmax.toFixed(1), 5) + ' km/h');
  }
  const dropped = [];
  for (const d of ['sumDs', 'movingSec', 'nPow', 'meanV']) dropped.push(d);
}
console.log('氣溫          ' + tempC.toFixed(1) + ' °C  ->  空氣密度 ' + rho.toFixed(4) + ' kg/m³');
console.log('總質量 m      ' + M.toFixed(1) + ' kg  （外部給定；以 MASS_KG=xx 覆寫）');
if (B.length < 40) die('只有 ' + B.length + ' 個可用區塊，不足以回歸');

// 排除可能煞車的區塊（大幅下降且功率偏低）
const medP = median(B.map((b) => b.meanP));
const kept0 = B.filter((b) => !(b.dH < -CFG.maxBrakeDropM && b.meanP < medP * 0.7));
console.log('排除疑似煞車  ' + (B.length - kept0.length) + ' 個區塊（下降 >' + CFG.maxBrakeDropM + ' m 且功率低於中位 70%）');

// ---------- 無截距二元回歸：y = A·x1 + B·x2 ----------
function xAero(b, We, Wn) {
  if (We === 0 && Wn === 0) return b.sumV2ds;
  const h = -(We * b.tx + Wn * b.ty);
  const cx = We + h * b.tx, cy = Wn + h * b.ty;
  const along = b.meanV + h;
  return Math.hypot(along, Math.hypot(cx, cy)) * along * b.sumDs;
}

function fit(sample, We = 0, Wn = 0) {
  let s11 = 0, s12 = 0, s22 = 0, s1y = 0, s2y = 0, syy = 0;
  const rows = sample.map((b) => {
    const x1 = xAero(b, We, Wn);
    const x2 = b.sumDs;                       // Σcosθ·Δs ≈ Σ Δs（坡度 <12% 時誤差 <1%）
    const y = b.energyJ - M * G * b.dH - b.dKE;
    return { x1, x2, y, b };
  });
  for (const r of rows) {
    s11 += r.x1 * r.x1; s12 += r.x1 * r.x2; s22 += r.x2 * r.x2;
    s1y += r.x1 * r.y; s2y += r.x2 * r.y; syy += r.y * r.y;
  }
  const det = s11 * s22 - s12 * s12;
  if (Math.abs(det) < 1e-6) return null;
  const A = (s1y * s22 - s2y * s12) / det;    // ½ρ·CdA
  const Bc = (s2y * s11 - s1y * s12) / det;   // Crr·m·g
  let ss = 0, sst = 0;
  const ybar = rows.reduce((a, r) => a + r.y, 0) / rows.length;
  const resid = rows.map((r) => {
    const e = r.y - (A * r.x1 + Bc * r.x2);
    ss += e * e; sst += (r.y - ybar) ** 2;
    return e;
  });
  return {
    A, Bc, We, Wn, n: rows.length, rows, resid,
    cdaM2: 2 * A / rho,
    crr: Bc / (M * G),
    r2: 1 - ss / sst,
    rmseKJ: Math.sqrt(ss / rows.length) / 1000,
  };
}

function searchWind(sample, { span = 6, coarse = 0.5, fine = 0.05 } = {}) {
  let best = fit(sample, 0, 0);
  for (let we = -span; we <= span + 1e-9; we += coarse) {
    for (let wn = -span; wn <= span + 1e-9; wn += coarse) {
      const f = fit(sample, we, wn);
      if (f && f.rmseKJ < best.rmseKJ) best = f;
    }
  }
  const ce = best.We, cn = best.Wn;
  for (let we = ce - coarse; we <= ce + coarse + 1e-9; we += fine) {
    for (let wn = cn - coarse; wn <= cn + coarse + 1e-9; wn += fine) {
      const f = fit(sample, we, wn);
      if (f && f.rmseKJ < best.rmseKJ) best = f;
    }
  }
  return best;
}

const noWind = fit(kept0);
const withWind = searchWind(kept0);
console.log('');
console.log('=== 是否需要把「當天的風」納入模型 ===');
console.log('  無風假設    R² ' + noWind.r2.toFixed(4) + '   RMSE ' + noWind.rmseKJ.toFixed(2) +
            ' kJ   CdA ' + noWind.cdaM2.toFixed(3) + '   Crr ' + noWind.crr.toFixed(4));
console.log('  擬合風場    R² ' + withWind.r2.toFixed(4) + '   RMSE ' + withWind.rmseKJ.toFixed(2) +
            ' kJ   CdA ' + withWind.cdaM2.toFixed(3) + '   Crr ' + withWind.crr.toFixed(4));
const ws = Math.hypot(withWind.We, withWind.Wn);
console.log('  解出的風    ' + ws.toFixed(2) + ' m/s @ ' +
            ((Math.atan2(-withWind.We, -withWind.Wn) * 180 / Math.PI + 360) % 360).toFixed(0) +
            '°（來向）   RMSE 改善 ' + (100 * (1 - withWind.rmseKJ / noWind.rmseKJ)).toFixed(1) + '%');
const useWind = withWind.rmseKJ < noWind.rmseKJ * 0.97;
console.log('  -> ' + (useWind ? '採用含風模型' : '風無法顯著改善，維持無風假設'));

// 離群剔除後重擬
const pick = useWind ? withWind : noWind;
const sd = Math.sqrt(pick.resid.reduce((a, r) => a + r * r, 0) / pick.resid.length);
const keep = kept0.filter((_, i) => Math.abs(pick.resid[i]) <= CFG.outlierSigma * sd);
const F = useWind ? searchWind(keep) : fit(keep);
console.log('');
console.log('離群剔除      ' + (kept0.length - keep.length) + ' 個區塊（殘差 > ' +
            (CFG.outlierSigma * sd / 1000).toFixed(1) + ' kJ）');

console.log('');
console.log('=== 回歸結果 ===');
console.log('  CdA         ' + F.cdaM2.toFixed(4) + ' m²' +
            (F.cdaM2 >= 0.25 && F.cdaM2 <= 0.50 ? '   （公路車合理範圍）' : '   [!] 超出公路車常見範圍 0.25-0.50'));
console.log('  Crr         ' + F.crr.toFixed(5) +
            (F.crr >= 0.002 && F.crr <= 0.012 ? '   （合理範圍）' : '   [!] 超出常見範圍 0.002-0.012'));
console.log('  區塊數      ' + F.n);
console.log('  R²          ' + F.r2.toFixed(4));
console.log('  殘差 RMSE   ' + F.rmseKJ.toFixed(2) + ' kJ  （區塊平均能量 ' +
            (F.rows.reduce((a, r) => a + r.y, 0) / F.n / 1000).toFixed(1) + ' kJ）');

// ---------- 質量敏感度 ----------
console.log('');
console.log('=== 質量敏感度（m 由外部給定，無法由本資料辨識） ===');
console.log('  m (kg)     CdA      Crr      R²');
const Msave = M;
for (const mm of [60, 65, 70, 75, 80, 85, 90]) {
  let s11 = 0, s12 = 0, s22 = 0, s1y = 0, s2y = 0, ss = 0, sst = 0;
  const rows = keep.map((b) => ({ x1: xAero(b, F.We, F.Wn), x2: b.sumDs, y: b.energyJ - mm * G * b.dH - (b.dKE / Msave) * mm }));
  for (const r of rows) { s11 += r.x1 ** 2; s12 += r.x1 * r.x2; s22 += r.x2 ** 2; s1y += r.x1 * r.y; s2y += r.x2 * r.y; }
  const det = s11 * s22 - s12 * s12;
  const A = (s1y * s22 - s2y * s12) / det, Bc = (s2y * s11 - s1y * s12) / det;
  const yb = rows.reduce((a, r) => a + r.y, 0) / rows.length;
  for (const r of rows) { ss += (r.y - (A * r.x1 + Bc * r.x2)) ** 2; sst += (r.y - yb) ** 2; }
  const cda = 2 * A / rho, crr = Bc / (mm * G);
  console.log('  ' + pad(mm, 5) + '    ' + pad(cda.toFixed(3), 7) + '  ' + pad(crr.toFixed(5), 8) +
              '  ' + pad((1 - ss / sst).toFixed(4), 7) + (mm === Msave ? '   <- 目前假設' : ''));
}

// ---------- 功率來源判讀 ----------
console.log('');
console.log('=== 功率資料來源判讀 ===');
if (F.r2 > 0.995) {
  console.log('  [警告] R² = ' + F.r2.toFixed(4) + '，擬合過於完美。功率很可能是 Strava 推估值，');
  console.log('         本回歸恐為循環論證，CdA/Crr 只是還原 Strava 的內建常數。');
} else if (F.r2 > 0.85) {
  console.log('  R² = ' + F.r2.toFixed(4) + '，擬合良好且保有合理散佈，符合真實功率計資料。');
} else {
  console.log('  R² = ' + F.r2.toFixed(4) + '，擬合偏弱；結果可用但不確定度較大。');
}

// ---------- 預測檢驗 ----------
function solveV(P, gradePct, cdaM2, crr, m) {
  const th = Math.atan(gradePct / 100);
  const f = (v) => (0.5 * rho * cdaM2 * v * v + crr * m * G * Math.cos(th) + m * G * Math.sin(th)) * v - P;
  let lo = 0.05, hi = 40;
  for (let k = 0; k < 90; k++) { const mid = (lo + hi) / 2; if (f(mid) < 0) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
console.log('');
console.log('=== 代入目標功率的預測速度（km/h） ===');
console.log('  坡度       ' + [100, 120, 150, 200].map((p) => pad(p + 'W', 8)).join(''));
for (const g of [-6, -3, -1, 0, 1, 3, 6, 9]) {
  console.log('  ' + pad(g.toFixed(0) + '%', 6) + '     ' +
    [100, 120, 150, 200].map((p) => pad((solveV(p, g, F.cdaM2, F.crr, M) * 3.6).toFixed(1), 8)).join(''));
}

// 與實測比對
console.log('');
console.log('=== 模型 vs 實測（用各區塊自己的平均功率預測速度） ===');
const bins = [[-99, -3], [-3, -1], [-1, 1], [1, 3], [3, 99]];
console.log('  坡度帶        區塊  實測均速   模型預測   差異');
for (const [lo, hi] of bins) {
  const g = keep.filter((b) => b.gradePct >= lo && b.gradePct < hi);
  if (!g.length) continue;
  const obs = g.reduce((a, b) => a + b.meanV, 0) / g.length * 3.6;
  const pre = g.reduce((a, b) => a + solveV(b.meanP, b.gradePct, F.cdaM2, F.crr, M), 0) / g.length * 3.6;
  console.log('  ' + pad(lo === -99 ? '< -3%' : hi === 99 ? '> 3%' : lo + '~' + hi + '%', 8) +
    pad(g.length, 8) + pad(obs.toFixed(1), 10) + pad(pre.toFixed(1), 11) + pad((pre - obs).toFixed(1), 8) + ' km/h');
}

// ---------- 寫出 ----------
const allP = pts.map((p) => p.p).filter((x) => x !== null && x > 0).sort((a, b) => a - b);
const profile = {
  generatedAt: new Date().toISOString(),
  method: '區塊能量平衡回歸',
  source: 'route.gpx 實測功率',
  rideDate: new Date(pts[0].t).toISOString(),
  blocks: F.n,
  massKg: M,
  massNote: '外部給定，本資料無法辨識（與 CdA/Crr 共線）',
  cdaM2: +F.cdaM2.toFixed(4),
  crr: +F.crr.toFixed(5),
  r2: +F.r2.toFixed(4),
  rmseKJ: +F.rmseKJ.toFixed(2),
  calibRho: +rho.toFixed(4),
  calibTempC: +tempC.toFixed(1),
  fittedWind: useWind ? {
    speedMs: +ws.toFixed(2),
    fromDeg: +((Math.atan2(-F.We, -F.Wn) * 180 / Math.PI + 360) % 360).toFixed(0),
  } : null,
  observedPowerW: { p25: allP[Math.floor(allP.length * 0.25)], median: allP[allP.length >> 1], p75: allP[Math.floor(allP.length * 0.75)] },
  plausible: { cda: F.cdaM2 >= 0.25 && F.cdaM2 <= 0.50, crr: F.crr >= 0.002 && F.crr <= 0.012 },
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(profile, null, 2) + '\n');
console.log('');
console.log('已寫出 ' + OUT);
console.log('');
