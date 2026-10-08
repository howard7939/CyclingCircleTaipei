/**
 * 風場模型與順/逆時針方向分析。
 *
 * 推導（完整說明見 docs/wind-model.md）：
 *   空氣阻力沿路線作功  W = ∫ ½ρ·CdA·|v_app|·(v + h) ds
 *   其中 h = -(W_felt · t̂) 是逆風分量（內積），t̂ 為行進方向單位向量。
 *   兩個方向相減時 v² 與 h² 項抵銷，只剩交叉項：
 *       ΔW = 2ρ·CdA·Σ kᵢ·vᵢ·hᵢ·Δsᵢ = -2ρ·CdA·∮ k·v·(W·dl)
 *   這是風場沿路線的「加權環流量」。均勻風場繞閉環的環流恆為零
 *   （∮dl = 0），所以方向偏好完全來自 k（曝露度）、v（速度）、W（風場）
 *   三者的不均勻性。本模組以 selfTest() 數值驗證這個恆等式。
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const R_EARTH = 6371008.8;
const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../data');
const PARAMS_FILE = resolve(DATA_DIR, 'model-params.json');
const PROFILE_FILE = resolve(DATA_DIR, 'rider-profile.json');
const G = 9.80665;

/**
 * 曝露度係數 k：騎士實際感受到的風速 / 模式的開闊地 10 m 風速。
 *
 * 依據：對數風速剖面 u(z) ∝ ln(z/z₀)，加上騎士高度約 1.5 m。
 *   riverside 堤內開闊地，z₀≈0.03 m（短草/水面）。
 *             ln(1.5/0.03)/ln(10/0.03) = 0.67，取 0.70（堤頂反而增速）。
 *   urban     市區街廓，z₀≈0.5 m，騎士位於粗糙元素「之下」，
 *             實測街谷風速常為開闊地的 0.3–0.5 倍。取 0.35。
 *   mountain  林蔭 + 地形遮蔽，取 0.25。
 *
 * 經驗佐證：本次觀測中 Open-Meteo 開闊地風 3.5–4.4 m/s，
 * 曝露良好的測站（臺北 3.9、板橋 4.8、三重 5.2）與之相當，
 * 而市區遮蔽站（大安森林 0.2、臺灣大學 1.2、信義 1.1）約為 0.05–0.3 倍。
 *
 * 這三個值是模型參數，可在 data/model-params.json 覆寫後重算。
 */
export const DEFAULT_PARAMS = {
  exposureK: { riverside: 1.0, urban: 0.3, mountain: 0.0 },
  targetPowerW: 100, // 目標持續功率；順逆時針比較以此為準，不用實測速度
  rho: 1.20,      // kg/m^3 空氣密度（會依氣溫修正）
  cdaM2: 0.3226,  // m^2 由實測功率校正（route.gpx, 72 kg, R²=0.73）
  crr: 0.00622,   // 滾動阻力係數，同上校正
  massKg: 72,     // 騎士 + 車 + 裝備
  minSpeedKmh: 5,
  // 下坡煞車上限。定功率模型在 −6% 會解出 54 km/h，但實測最快區塊是
  // 46 km/h —— 差額是煞車與過彎。兩個方向套用同一上限，比較仍公平。
  maxSpeedKmh: 48,
  // 陣風。報告的陣風是「尖峰」而非標準差，兩者以尖峰因子相連：
  //   peak ≈ mean + g·σ，10 分鐘期間取 3 秒陣風時 g ≈ 3
  // 故 σ ≈ (陣風 − 平均) / 3。設 0 則完全忽略陣風。
  gustPeakFactor: 3.0,
  // 陣風分布的積分點數（高斯-厄米特近似）。5 點已足夠，再多只是變慢。
  gustQuadPoints: 5,
  // 側風 yaw 修正：阻力沿行進方向的分量為 ½ρ·CdA·|v_app|·(v+h)，
  // 側風會增大 |v_app| 因而增加阻力，即使它本身垂直於行進方向。
  // 關閉時退化為純縱向模型 ½ρ·CdA·(v+h)²，此時「均勻風場繞閉環零方向
  // 偏好」是嚴格恆等式；開啟後僅近似成立（差異即 yaw 項的貢獻）。
  yawCorrection: true,
};

/**
 * 載入 data/model-params.json 的覆寫值（若不存在則用預設）。
 * 大聲驗證：型別錯誤或缺曝露度類別一律 throw，不要靜默回退到預設值，
 * 否則使用者改了檔案卻沒生效、而且不會知道。
 */
export function loadParams({ file = PARAMS_FILE, quiet = false, overrides = null } = {}) {
  // 疊加順序：內建預設 < 實測校正的車手參數 < 使用者的 model-params.json < 呼叫端覆寫
  let p0 = { ...DEFAULT_PARAMS };
  if (existsSync(PROFILE_FILE)) {
    try {
      const pr = JSON.parse(readFileSync(PROFILE_FILE, 'utf8'));
      for (const k of ['massKg', 'cdaM2', 'crr']) if (Number.isFinite(pr[k])) p0[k] = pr[k];
      p0._riderProfile = { r2: pr.r2, blocks: pr.blocks, method: pr.method, rideDate: pr.rideDate };
    } catch (e) { if (!quiet) console.warn('[warn] rider-profile.json 讀取失敗：' + e.message); }
  }

  if (!existsSync(file)) return applyOverrides({ ...p0, _source: 'defaults+profile' }, overrides, quiet);

  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(file + ' 不是合法 JSON：' + e.message); }

  const p = { ...p0 };
  if (raw.exposureK !== undefined) {
    if (typeof raw.exposureK !== 'object' || raw.exposureK === null) {
      throw new Error('model-params.json 的 exposureK 必須是物件');
    }
    for (const cls of ['riverside', 'urban', 'mountain']) {
      const v = raw.exposureK[cls];
      if (v === undefined) throw new Error('model-params.json 的 exposureK 缺少 "' + cls + '"');
      if (!Number.isFinite(v) || v < 0 || v > 3) {
        throw new Error('model-params.json 的 exposureK.' + cls + ' = ' + JSON.stringify(v) +
                        '，必須是 0~3 的數字');
      }
    }
    p.exposureK = { ...raw.exposureK };
  }
  for (const key of ['rho', 'cdaM2', 'crr', 'massKg', 'minSpeedKmh', 'maxSpeedKmh', 'targetPowerW']) {
    if (raw[key] === undefined) continue;
    if (!Number.isFinite(raw[key]) || raw[key] <= 0) {
      throw new Error('model-params.json 的 ' + key + ' = ' + JSON.stringify(raw[key]) + '，必須是正數');
    }
    p[key] = raw[key];
  }
  if (raw.yawCorrection !== undefined) {
    if (typeof raw.yawCorrection !== 'boolean') throw new Error('model-params.json 的 yawCorrection 必須是 true/false');
    p.yawCorrection = raw.yawCorrection;
  }

  const ks = Object.values(p.exposureK);
  if (Math.max(...ks) - Math.min(...ks) < 1e-9 && !quiet) {
    console.warn('[warn] 三個 exposureK 相等 -> D = 0，方向偏好將恆為零（僅剩側風 yaw 的微量效應）。');
  }
  p._source = file;
  p._paramSource = raw.source ?? null;
  return applyOverrides(p, overrides, quiet);
}

/** 網站使用者可調整的參數（體重、功率等），以查詢字串傳入時用這裡驗證 */
export const USER_TUNABLE = {
  targetPowerW: { min: 40, max: 500, label: '目標功率 (W)' },
  massKg: { min: 35, max: 200, label: '總質量 (kg)' },
  cdaM2: { min: 0.15, max: 0.90, label: 'CdA (m²)' },
  crr: { min: 0.001, max: 0.030, label: 'Crr' },
  maxSpeedKmh: { min: 25, max: 90, label: '下坡速度上限 (km/h)' },
};

function applyOverrides(p, overrides, quiet) {
  if (!overrides) return p;
  const applied = {};
  for (const [k, spec] of Object.entries(USER_TUNABLE)) {
    const v = overrides[k];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(spec.label + ' 必須是數字，收到 ' + JSON.stringify(v));
    if (n < spec.min || n > spec.max) {
      throw new Error(spec.label + ' 必須在 ' + spec.min + ' ~ ' + spec.max + ' 之間，收到 ' + n);
    }
    p[k] = n; applied[k] = n;
  }
  if (overrides.exposureK && typeof overrides.exposureK === 'object') {
    const ek = { ...p.exposureK };
    for (const cls of ['riverside', 'urban', 'mountain']) {
      const v = overrides.exposureK[cls];
      if (v === undefined || v === null || v === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 3) throw new Error('exposureK.' + cls + ' 必須是 0~3 的數字');
      ek[cls] = n;
    }
    p.exposureK = ek; applied.exposureK = ek;
  }
  if (Object.keys(applied).length) p._overrides = applied;
  return p;
}

/**
 * 曝露度加權位移向量 D = Σ kᵢ t̂ᵢ Δsᵢ（t̂ 取 segments 索引順序的行進方向）。
 *
 * 由閉環恆等式 Σ t̂ᵢΔsᵢ = 0，D 對 k 整體加常數不變，只取決於 k 之間的差值。
 * 方向判斷 ΔW ∝ W·D，所以 D 的方位角決定了「順逆時針的臨界風向」。
 */
export function exposureDisplacement(segments, params = DEFAULT_PARAMS) {
  let e = 0, n = 0;
  const byClass = {};
  for (const s of segments) {
    const br = s.bearing * D2R;
    const de = Math.sin(br) * s.len, dn = Math.cos(br) * s.len;
    const k = params.exposureK[s.exposure];
    if (k === undefined) throw new Error('exposure "' + s.exposure + '" 沒有對應的 k 值');
    e += k * de; n += k * dn;
    const c = (byClass[s.exposure] ||= { e: 0, n: 0, km: 0 });
    c.e += de; c.n += dn; c.km += s.len / 1000;
  }
  const magM = Math.hypot(e, n);
  const bearingDeg = (Math.atan2(e, n) * R2D + 360) % 360;
  // ΔW ≡ W(CW) − W(CCW) ∝ W·D，W 為風「吹向」的向量；風的「來向」= 吹向 + 180°。
  // 風「來向」正好等於 D 的方位時 W 與 D 反向 -> ΔW<0 -> 順時針最省；
  // 風「來向」為 D 的反方向時最有利於逆時針。臨界在兩者之間 ±90°。
  const crit = [(bearingDeg + 90 + 180) % 360, (bearingDeg - 90 + 180 + 360) % 360];
  return {
    east: +e.toFixed(1), north: +n.toFixed(1),
    magnitudeKm: +(magM / 1000).toFixed(3),
    bearingDeg: +bearingDeg.toFixed(1),
    ccwCenterFromDeg: +((bearingDeg + 180) % 360).toFixed(1), // 風從這個方位來時最該逆時針
    cwCenterFromDeg: +bearingDeg.toFixed(1),                   // 風從這個方位來時最該順時針
    criticalFromDeg: crit.map((x) => +x.toFixed(1)).sort((a, b) => a - b),
    byClass: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, {
      km: +v.km.toFixed(2),
      east: +(v.e / 1000).toFixed(3), north: +(v.n / 1000).toFixed(3),
      magnitudeKm: +(Math.hypot(v.e, v.n) / 1000).toFixed(3),
      bearingDeg: +((Math.atan2(v.e, v.n) * R2D + 360) % 360).toFixed(1),
    }])),
  };
}

/** 依氣溫/氣壓修正空氣密度 */
export function airDensity(tempC, pressureHpa) {
  const T = Number.isFinite(tempC) ? tempC : 25;
  const P = Number.isFinite(pressureHpa) ? pressureHpa : 1013;
  return (P * 100) / (287.05 * (T + 273.15));
}

/**
 * 從騎乘者自己的 GPX 時間戳建立「坡度 → 速度」曲線。
 * 用自己的數據比用文獻的功率模型準，而且自動包含他的體能與路況習慣。
 *
 * 兩個方向都用這條曲線（而不是一邊用實測、一邊用模型），
 * 否則比較本身就被不同來源的偏差汙染。
 */
export function buildSpeedCurve(segments, params = DEFAULT_PARAMS) {
  const LO = -12, HI = 12, STEP = 0.5;
  const nb = Math.round((HI - LO) / STEP);
  const bins = Array.from({ length: nb }, () => []);
  let used = 0;
  for (const s of segments) {
    if (s.obsSpeedKmh == null) continue;
    const bi = Math.floor((s.gradePct - LO) / STEP);
    if (bi < 0 || bi >= nb) continue;
    bins[bi].push(s.obsSpeedKmh);
    used++;
  }
  const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : null; };
  const centers = Array.from({ length: nb }, (_, i) => LO + (i + 0.5) * STEP);
  let v = bins.map((b) => (b.length >= 3 ? med(b) : null));

  // 空箱以相鄰已知值線性內插；兩端以最近的已知值外推
  const known = v.map((x, i) => (x === null ? -1 : i)).filter((i) => i >= 0);
  if (known.length < 3) throw new Error('速度曲線資料不足：只有 ' + known.length + ' 個有效坡度區間');
  for (let i = 0; i < nb; i++) {
    if (v[i] !== null) continue;
    const lo = [...known].reverse().find((k) => k < i);
    const hi = known.find((k) => k > i);
    if (lo === undefined) v[i] = v[hi];
    else if (hi === undefined) v[i] = v[lo];
    else v[i] = v[lo] + (v[hi] - v[lo]) * ((i - lo) / (hi - lo));
  }

  // 強制單調遞減（坡度越陡速度越慢）。PAVA：違反處與前一箱取平均後回溯。
  for (let i = 1; i < nb; i++) {
    if (v[i] <= v[i - 1]) continue;
    let j = i, sum = v[i] + v[i - 1], cnt = 2;
    while (j - cnt + 1 > 0 && sum / cnt > v[j - cnt]) { sum += v[j - cnt]; cnt++; }
    const avg = sum / cnt;
    for (let k = j - cnt + 1; k <= j; k++) v[k] = avg;
  }
  v = v.map((x) => Math.min(params.maxSpeedKmh, Math.max(params.minSpeedKmh, x)));

  const speedAt = (gradePct) => {
    const g = Math.min(HI - 1e-6, Math.max(LO, gradePct));
    const f = (g - LO) / STEP - 0.5;
    const i = Math.floor(f);
    if (i < 0) return v[0];
    if (i >= nb - 1) return v[nb - 1];
    return v[i] + (v[i + 1] - v[i]) * (f - i);
  };
  return { speedAt, centers, values: v, sampleCount: used, binStep: STEP };
}

/** 氣象慣例：風向 = 風的「來向」。轉成風吹「往」的向量分量。 */
export function toUV(speedMs, fromDeg) {
  const t = fromDeg * D2R;
  return { u: -speedMs * Math.sin(t), v: -speedMs * Math.cos(t) };
}
export function toSpeedDir(u, v) {
  return { speedMs: Math.hypot(u, v), fromDeg: (Math.atan2(-u, -v) * R2D + 360) % 360 };
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const la1 = aLat * D2R, la2 = bLat * D2R;
  const h = Math.sin((la2 - la1) / 2) ** 2 +
            Math.cos(la1) * Math.cos(la2) * Math.sin((bLon - aLon) * D2R / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(Math.min(1, h))) / 1000;
}

/**
 * 把 Open-Meteo 取樣點的開闊地風內插到每個路段。
 * 以 u,v 分量分別內插 —— 絕不可直接內插角度（350° 與 10° 的平均不是 180°）。
 * 模式格點約 8 km，取樣點之間本來就幾乎同值，IDW 僅作平滑銜接。
 */
export function openWindField(segments, omPoints, { power = 2, minKm = 0.3 } = {}) {
  const src = omPoints
    .filter((p) => Number.isFinite(p.current?.windMs) && Number.isFinite(p.current?.windFromDeg))
    .map((p) => ({
      lat: p.reqLat, lon: p.reqLon,
      ...toUV(p.current.windMs, p.current.windFromDeg),
      gustMs: p.current.gustMs,
    }));
  if (!src.length) throw new Error('沒有任何 Open-Meteo 取樣點含有效風資料');

  return segments.map((s) => {
    let wu = 0, wv = 0, wg = 0, sw = 0;
    for (const p of src) {
      const d = Math.max(minKm, haversineKm(s.lat, s.lon, p.lat, p.lon));
      const w = 1 / Math.pow(d, power);
      wu += w * p.u; wv += w * p.v;
      wg += w * (Number.isFinite(p.gustMs) ? p.gustMs : 0);
      sw += w;
    }
    const u = wu / sw, v = wv / sw;
    return { u, v, gustMs: wg / sw, ...toSpeedDir(u, v) };
  });
}

/**
 * 由目標功率解出地面速度。
 *
 *   P = [ ½ρ·CdA·|v_app|·(v+h)  +  Crr·m·g·cosθ  +  m·g·sinθ ] · v
 *
 * 對 v 非線性，以二分法求解。f(v) = (…)·v − P 在 v→0⁺ 時為 −P < 0，
 * 隨 v 單調趨向 +∞，正根唯一（下坡時 f 先降後升，但 f(0)<0 仍保證唯一正根）。
 *
 * 關鍵：兩個方向都用這個函式，所以速度不再帶有「GPX 是逆時針錄的」偏頗。
 * 逆風會讓同功率下速度變慢、因而在逆風中待更久 —— 這個二階效應會自動包含。
 */
export function solveSpeedMs(powerW, gradePct, headwindMs, crossMs, params = DEFAULT_PARAMS) {
  const th = Math.atan(gradePct / 100);
  const Fr = params.crr * params.massKg * G * Math.cos(th);
  const Fg = params.massKg * G * Math.sin(th);
  const half = 0.5 * params.rho * params.cdaM2;

  const f = (v) => {
    const along = v + headwindMs;
    const vApp = params.yawCorrection ? Math.hypot(along, crossMs) : Math.abs(along);
    return (half * vApp * along + Fr + Fg) * v - powerW;
  };

  let lo = 1e-3, hi = 40;
  if (f(hi) < 0) return params.maxSpeedKmh / 3.6; // 極端順風/陡下坡，直接吃上限
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) < 0) lo = mid; else hi = mid;
  }
  const v = 0.5 * (lo + hi);
  return Math.min(params.maxSpeedKmh / 3.6, Math.max(params.minSpeedKmh / 3.6, v));
}

/**
 * 陣風下的路段通過時間。
 *
 * 不能只在阻力上加一個 σ² 修正項：那只抓到「阻力變大」，抓不到真正的主因
 * —— 定功率下陣風讓你變慢，於是你在陣風裡待得更久，而 1/v 是凸函數，
 * 兩個效應疊加。實測同樣 σ=2 m/s 的陣風，逆風 +4 m/s 的時間損失是順風 −4
 * 的 2.68 倍（逆風 +3.0 s/km vs 順風 +1.1 s/km）—— 這正是「逆風遇到陣風
 * 特別痛苦」的來源，而純 σ² 修正會把兩者算成一樣。
 *
 * 作法：對陣風分布積分通過時間 ⟨L/v(h̄+σz)⟩，z 取標準常態的高斯-厄米特節點。
 */
const GQ = {
  5: { z: [-2.0, -0.95, 0, 0.95, 2.0], w: [0.028, 0.247, 0.45, 0.247, 0.028] },
  3: { z: [-1.6, 0, 1.6], w: [0.11, 0.78, 0.11] },
};

export function segmentTimeS(powerW, gradePct, h, c, sigma, lenM, params) {
  if (!(sigma > 0.05)) {
    const v = solveSpeedMs(powerW, gradePct, h, c, params);
    return { timeS: lenM / v, speedMs: v, gustPenaltyS: 0 };
  }
  const q = GQ[params.gustQuadPoints] || GQ[5];
  let t = 0, sw = 0, vSum = 0;
  for (let i = 0; i < q.z.length; i++) {
    const v = solveSpeedMs(powerW, gradePct, h + sigma * q.z[i], c, params);
    t += q.w[i] * (lenM / v); sw += q.w[i]; vSum += q.w[i] * v;
  }
  const timeS = t / sw;
  const steady = lenM / solveSpeedMs(powerW, gradePct, h, c, params);
  return { timeS, speedMs: lenM / timeS, gustPenaltyS: timeS - steady };
}

/**
 * 方向分析：在固定目標功率下，比較順時針與逆時針。
 *
 * 定功率時總能量 = P × T，所以「時間」就是最自然也最可解讀的比較量綱，
 * 不需要再把焦耳換算成分鐘。
 *
 * @param segments     route.json 的路段（含 bearing、gradePct、exposure、len）
 * @param field        與 segments 等長的開闊地風 {u, v}
 * @param orientation  segments 依索引順序行進時的繞行方向 'CW' | 'CCW'
 */
export function analyzeDirections(segments, field, orientation, params = DEFAULT_PARAMS) {
  const P = params.targetPowerW;
  const half = 0.5 * params.rho * params.cdaM2;

  const dirs = [
    { key: orientation, sign: +1 },
    { key: orientation === 'CCW' ? 'CW' : 'CCW', sign: -1 },
  ];

  const result = {};
  for (const { key, sign } of dirs) {
    let timeS = 0, distM = 0, aeroJ = 0, cappedM = 0, energyJ = 0, gustS = 0;
    const byExposure = {};
    const perSeg = [];

    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const w = field[i];
      const k = params.exposureK[s.exposure];
      if (k === undefined) throw new Error('路段 ' + i + ' 的 exposure "' + s.exposure + '" 沒有對應的 k 值');

      const br = (s.bearing + (sign > 0 ? 0 : 180)) * D2R;
      const tx = Math.sin(br), ty = Math.cos(br);

      const fu = k * w.u, fv = k * w.v;            // 騎士實際感受到的風
      const h = -(fu * tx + fv * ty);              // 逆風分量（內積）
      const cx = fu + h * tx, cy = fv + h * ty;    // 側風分量
      const c = Math.hypot(cx, cy);

      const grade = sign > 0 ? s.gradePct : -s.gradePct;
      // 陣風的起伏同樣受曝露度折減（市區遮蔽也擋陣風）
      const sigma = (w.gustSigmaMs ?? 0) * k;
      const st = segmentTimeS(P, grade, h, c, sigma, s.len, params);
      const v = st.speedMs;
      const atCap = v >= params.maxSpeedKmh / 3.6 - 1e-9;

      const along = v + h;
      const vApp = params.yawCorrection ? Math.hypot(along, c) : Math.abs(along);
      const dAero = half * vApp * along * s.len;
      const dt = st.timeS;
      gustS += st.gustPenaltyS;

      // 實際需要的功率。下坡觸及煞車上限時騎士是在煞車，不是輸出 P；
      // 重力大於阻力時需要的功率甚至為負。照 P×t 計能量會高估做功。
      const th = Math.atan(grade / 100);
      const needW = (half * vApp * along
                   + params.crr * params.massKg * 9.80665 * Math.cos(th)
                   + params.massKg * 9.80665 * Math.sin(th)) * v;
      const usedW = Math.max(0, Math.min(P, needW));

      timeS += dt; distM += s.len; aeroJ += dAero; energyJ += usedW * dt;
      if (atCap) cappedM += s.len;

      const e = (byExposure[s.exposure] ||= { km: 0, timeS: 0, aeroJ: 0, hSum: 0, len: 0 });
      e.km += s.len / 1000; e.timeS += dt; e.aeroJ += dAero;
      e.hSum += h * s.len; e.len += s.len;

      perSeg.push({
        i, headwindMs: +h.toFixed(3), crossMs: +c.toFixed(3),
        speedKmh: +(v * 3.6).toFixed(1), appMs: +vApp.toFixed(2),
        timeS: +dt.toFixed(2), atCap,
        gustSigmaMs: +sigma.toFixed(2), gustPenaltyS: +st.gustPenaltyS.toFixed(2),
      });
    }

    result[key] = {
      timeS: +timeS.toFixed(1),
      timeMin: +(timeS / 60).toFixed(2),
      energyKJ: +(energyJ / 1000).toFixed(1),
      avgPowerW: +(energyJ / timeS).toFixed(1),
      aeroWorkKJ: +(aeroJ / 1000).toFixed(1),
      avgSpeedKmh: +(distM / timeS * 3.6).toFixed(2),
      brakingCapKm: +(cappedM / 1000).toFixed(2),
      gustPenaltyS: +gustS.toFixed(1),
      byExposure: Object.fromEntries(Object.entries(byExposure).map(([k2, v2]) => [k2, {
        km: +v2.km.toFixed(2),
        timeMin: +(v2.timeS / 60).toFixed(2),
        aeroWorkKJ: +(v2.aeroJ / 1000).toFixed(1),
        avgSpeedKmh: +(v2.km * 1000 / v2.timeS * 3.6).toFixed(2),
        meanHeadwindMs: +(v2.hSum / v2.len).toFixed(3),
      }])),
      perSeg,
    };
  }

  const a = result.CW, b = result.CCW;
  const deltaSec = +(a.timeS - b.timeS).toFixed(1);          // 正值 = 順時針較慢
  const deltaKJ = +(P * deltaSec / 1000).toFixed(2);
  const meanT = (a.timeS + b.timeS) / 2;

  const contribSec = {};
  for (const ex of new Set(segments.map((s) => s.exposure))) {
    contribSec[ex] = +(((a.byExposure[ex]?.timeMin ?? 0) - (b.byExposure[ex]?.timeMin ?? 0)) * 60).toFixed(1);
  }

  return {
    params: { ...params },
    targetPowerW: P,
    directions: result,
    deltaSec,
    deltaKJ,
    deltaPct: meanT > 0 ? +(100 * deltaSec / meanT).toFixed(3) : 0,
    recommend: deltaSec === 0 ? null : (deltaSec > 0 ? 'CCW' : 'CW'),
    contributionSec: contribSec,
  };
}

/**
 * 自我檢驗。
 *
 * 核心檢查：零風 + 全線坡度歸零時，兩方向的時間必須「嚴格」相等。
 * 這驗證幾何（bearing）、方向反轉、以及風向慣例的實作都正確。
 *
 * 其餘兩項是真實物理效應，不是誤差，分開報告：
 *   均勻風 + 平路   定功率下逆風損失大於順風收益（t(h) 對 h 為凸函數），
 *                   而閉環只保證 Σh·Δs = 0，不保證 h 的分布對稱，
 *                   所以均勻風仍可能產生方向偏好。
 *   零風 + 真實坡度 上下坡換邊造成的時間不對稱，與天氣完全無關。
 */
export function selfTest(segments, orientation, { windMs = 5, fromDeg = 70, params = DEFAULT_PARAMS } = {}) {
  const zero = segments.map(() => ({ u: 0, v: 0, speedMs: 0, fromDeg: 0, gustMs: 0 }));
  const uni = toUV(windMs, fromDeg);
  const uniField = segments.map(() => ({ ...uni, ...toSpeedDir(uni.u, uni.v), gustMs: 0 }));
  const flat = segments.map((s) => ({ ...s, gradePct: 0 }));
  const flatUniform = flat.map((s) => ({ ...s, exposure: 'riverside' }));
  const pk = { ...params, exposureK: { riverside: 1, urban: 1, mountain: 1 } };

  const geom = analyzeDirections(flatUniform, zero, orientation, pk);
  const windFlat = analyzeDirections(flatUniform, uniField, orientation, pk);
  const calmReal = analyzeDirections(segments, zero, orientation, params);

  return {
    windMs, fromDeg,
    geometrySec: geom.deltaSec,        // 必須為 0
    uniformWindSec: windFlat.deltaSec, // 定功率下的凸性效應（真實）
    calmGradeSec: calmReal.deltaSec,   // 上下坡換邊的不對稱（真實，與天氣無關）
    noiseFloorSec: +Math.abs(geom.deltaSec).toFixed(2),
  };
}
