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

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const R_EARTH = 6371008.8;

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
  exposureK: { riverside: 0.70, urban: 0.35, mountain: 0.25 },
  rho: 1.20,      // kg/m^3 空氣密度（會依氣溫修正）
  cdaM2: 0.32,    // m^2 公路車手握上把
  crr: 0.005,     // 滾動阻力係數
  massKg: 80,     // 騎士 + 車
  minSpeedKmh: 8, // 速度曲線下限
  maxSpeedKmh: 55,
  // 側風 yaw 修正：阻力沿行進方向的分量為 ½ρ·CdA·|v_app|·(v+h)，
  // 側風會增大 |v_app| 因而增加阻力，即使它本身垂直於行進方向。
  // 關閉時退化為純縱向模型 ½ρ·CdA·(v+h)²，此時「均勻風場繞閉環零方向
  // 偏好」是嚴格恆等式；開啟後僅近似成立（差異即 yaw 項的貢獻）。
  yawCorrection: true,
};

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
 * 方向分析。
 *
 * @param segments  route.json 的路段（含 bearing、gradePct、exposure、len）
 * @param field     與 segments 等長的開闊地風 {u,v}
 * @param orientation  segments 依索引順序行進時的繞行方向 'CW' | 'CCW'
 */
export function analyzeDirections(segments, field, orientation, params = DEFAULT_PARAMS, speedCurve = null) {
  const curve = speedCurve || buildSpeedCurve(segments, params);
  const half = 0.5 * params.rho * params.cdaM2;

  // 索引順序 = orientation 方向。另一方向則坡度反號、切向量反號。
  const dirs = [
    { key: orientation, sign: +1 },
    { key: orientation === 'CCW' ? 'CW' : 'CCW', sign: -1 },
  ];

  const result = {};
  for (const { key, sign } of dirs) {
    let workJ = 0, headTailJ = 0, distM = 0, timeS = 0;
    const byExposure = {};
    const perSeg = [];

    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const w = field[i];
      const k = params.exposureK[s.exposure];
      if (k === undefined) throw new Error('路段 ' + i + ' 的 exposure "' + s.exposure + '" 沒有對應的 k 值');

      // 行進方向單位向量（東, 北）
      const br = (s.bearing + (sign > 0 ? 0 : 180)) * D2R;
      const tx = Math.sin(br), ty = Math.cos(br);

      // 騎士感受到的風 = 開闊地風 × 曝露度係數
      const fu = k * w.u, fv = k * w.v;

      // 逆風分量（內積），正值為逆風
      const h = -(fu * tx + fv * ty);
      // 側風分量
      const cx = fu - (-h) * tx, cy = fv - (-h) * ty;
      const c = Math.hypot(cx, cy);

      const grade = sign > 0 ? s.gradePct : -s.gradePct;
      const vKmh = curve.speedAt(grade);
      const v = vKmh / 3.6;

      const along = v + h;                       // 沿行進方向的視風分量
      const vApp = params.yawCorrection ? Math.hypot(along, c) : Math.abs(along);
      const dW = half * vApp * along * s.len;    // 這段的空氣阻力作功

      workJ += dW;
      headTailJ += half * (2 * v * h) * s.len;   // 僅風造成的增減（交叉項）
      distM += s.len;
      timeS += s.len / v;

      const e = (byExposure[s.exposure] ||= { km: 0, workJ: 0, headTailJ: 0, hSum: 0, hLen: 0 });
      e.km += s.len / 1000; e.workJ += dW; e.headTailJ += half * (2 * v * h) * s.len;
      e.hSum += h * s.len; e.hLen += s.len;

      perSeg.push({
        i, headwindMs: +h.toFixed(3), crossMs: +c.toFixed(3),
        speedKmh: +vKmh.toFixed(1), appMs: +vApp.toFixed(2), workJ: +dW.toFixed(1),
      });
    }

    result[key] = {
      aeroWorkKJ: +(workJ / 1000).toFixed(1),
      windTermKJ: +(headTailJ / 1000).toFixed(1),
      distKm: +(distM / 1000).toFixed(2),
      timeMin: +(timeS / 60).toFixed(1),
      byExposure: Object.fromEntries(Object.entries(byExposure).map(([k2, v2]) => [k2, {
        km: +v2.km.toFixed(2),
        aeroWorkKJ: +(v2.workJ / 1000).toFixed(1),
        windTermKJ: +(v2.headTailJ / 1000).toFixed(1),
        meanHeadwindMs: +(v2.hSum / v2.hLen).toFixed(3),
      }])),
      perSeg,
    };
  }

  const a = result.CW, b = result.CCW;
  const deltaKJ = +(a.aeroWorkKJ - b.aeroWorkKJ).toFixed(1);
  const meanKJ = (a.aeroWorkKJ + b.aeroWorkKJ) / 2;

  // 各曝露度類別對方向差的貢獻
  const contrib = {};
  for (const ex of new Set(segments.map((s) => s.exposure))) {
    contrib[ex] = +((a.byExposure[ex]?.aeroWorkKJ ?? 0) - (b.byExposure[ex]?.aeroWorkKJ ?? 0)).toFixed(2);
  }

  // 把焦耳換算成騎士看得懂的單位：等效時間差。
  // 假設定功率騎乘，多出的空氣阻力作功換成多花的時間 ΔT ≈ ΔW / P。
  const powerW = estimatePowerW(segments, curve, params);
  const deltaSec = powerW ? Math.round(Math.abs(deltaKJ) * 1000 / powerW) : null;

  return {
    params: { ...params },
    speedCurve: { sampleCount: curve.sampleCount, binStep: curve.binStep },
    directions: result,
    deltaKJ,
    deltaPct: meanKJ > 0 ? +(100 * deltaKJ / meanKJ).toFixed(2) : 0,
    recommend: Math.abs(deltaKJ) < 1e-9 ? null : (deltaKJ > 0 ? 'CCW' : 'CW'),
    contributionKJ: contrib,
    estPowerW: powerW,
    deltaSec,
  };
}

/**
 * 由爬坡段反推騎乘者的持續輸出功率。
 * 選爬坡段是因為那裡重力項主導，估計值對 CdA 的不確定性最不敏感
 * （平路反推會把 CdA 的誤差全部吃進功率）。
 */
export function estimatePowerW(segments, curve, params = DEFAULT_PARAMS) {
  const g = 9.80665;
  const vals = [];
  for (const s of segments) {
    if (s.gradePct < 2) continue;
    const v = curve.speedAt(s.gradePct) / 3.6;
    const sinT = s.gradePct / 100 / Math.sqrt(1 + (s.gradePct / 100) ** 2);
    const P = params.massKg * g * v * sinT
            + params.crr * params.massKg * g * v
            + 0.5 * params.rho * params.cdaM2 * v ** 3;
    vals.push(P);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return +vals[vals.length >> 1].toFixed(0);
}

/**
 * 自我檢驗：均勻風場 + 均勻曝露度 + 均勻速度時，兩方向的空氣阻力作功
 * 必須相等（環流定理）。非零殘差應僅為路線離散化誤差。
 * 這同時驗證幾何（bearing）、風向慣例、以及方向反轉的實作。
 */
export function selfTest(segments, orientation, { windMs = 5, fromDeg = 70 } = {}) {
  const uniform = toUV(windMs, fromDeg);
  const field = segments.map(() => ({ ...uniform, ...toSpeedDir(uniform.u, uniform.v), gustMs: 0 }));
  const flat = segments.map((s) => ({ ...s, exposure: 'riverside', gradePct: 0, obsSpeedKmh: 25 }));
  const curve = { speedAt: () => 25, sampleCount: 0, binStep: 0 };
  const base = { ...DEFAULT_PARAMS, exposureK: { riverside: 1, urban: 1, mountain: 1 } };

  // 純縱向模型：此時恆等式嚴格成立，殘差只可能來自路線離散化
  const lon = analyzeDirections(flat, field, orientation, { ...base, yawCorrection: false }, curve);
  // 含 yaw 修正：殘差 = 離散化 + 側風 yaw 項
  const yaw = analyzeDirections(flat, field, orientation, { ...base, yawCorrection: true }, curve);

  const mean = (yaw.directions.CW.aeroWorkKJ + yaw.directions.CCW.aeroWorkKJ) / 2;
  return {
    windMs, fromDeg,
    cwKJ: yaw.directions.CW.aeroWorkKJ,
    ccwKJ: yaw.directions.CCW.aeroWorkKJ,
    deltaKJ: yaw.deltaKJ,
    discretizationKJ: lon.deltaKJ,            // 幾何離散化誤差
    yawTermKJ: +(yaw.deltaKJ - lon.deltaKJ).toFixed(3), // 側風 yaw 項
    relativePpm: mean > 0 ? +(1e6 * Math.abs(yaw.deltaKJ) / mean).toFixed(1) : 0,
  };
}
