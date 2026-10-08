/**
 * 風場客觀分析（Barnes objective analysis）
 *
 * 問題：只有有限個測站，如何得到路線上每一小段的風？
 *
 * 做法與理由 —— 兩個來源各用各的強項：
 *
 *   風「向」取自測站，用 Barnes 分析
 *     實測調查顯示 0-10 km 內測站的「向量平均 / 純量平均」一致性達 0.95，
 *     風向高度一致且可信。68 個測站的密度足以解析空間結構。
 *
 *   風「速」取自 Open-Meteo 模式，不用測站
 *     結構函數顯示相距 0-2 km 的兩站 RMS 向量差已達 1.60 m/s，而全盆地平均
 *     風速僅 2.3 m/s（65%）—— 差異主要是各站的設站遮蔽，不是空間結構。
 *     直接內插測站風速只會把遮蔽雜訊當成風場傳播到路線上。
 *     模式輸出代表無遮蔽的開闊地 10 m 風，無設站偏差。
 *
 * Barnes 方案（Barnes 1964，承自 Cressman 1959 的逐次修正）：
 *   權重      w = exp(−r² / κ)
 *   第一遍    g₀ = Σ w·f / Σ w
 *   修正遍    g₁ = g₀ + Σ w'·(f − g₀) / Σ w'  ，w' = exp(−r² / γκ)，γ∈[0.2,1]
 *   起始尺度  κ₀ = 5.052·(2Δn/π)²  ，Δn 為測站典型間距
 *
 * 本實作把 Barnes 作用在「相對於模式背景場的增量」上，而不是原始觀測上。
 * 這是客觀分析的標準做法（analysis = background + weighted innovations）：
 * 遠離測站時自動退回模式背景，而不是退回某個全域平均。
 *
 * 向量處理：一律在 u/v 分量上操作，絕不內插角度（350° 與 10° 的平均不是 180°）。
 */

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const R_EARTH = 6371008.8;

export const BARNES_DEFAULTS = {
  gamma: 0.3,         // 修正遍的尺度收縮係數，文獻建議 0.2~1.0
  passes: 2,
  maxStationKm: 30,   // 超過此距離的測站不納入（隔著山脈不具代表性）
  minAltM: null,      // 不限下限
  maxAltM: 200,       // 高山站的風與盆地不可比
  // 風速太小時「風向」幾乎是亂數（讀到 0.2 m/s 的站，方向由身旁一棵樹決定），
  // 納入分析只會把雜訊傳播給鄰近格點。
  minSpeedMs: 1.5,
  minWeight: 1e-4,    // 權重低於此值視為無影響
};

function haversineKm(aLat, aLon, bLat, bLon) {
  const la1 = aLat * D2R, la2 = bLat * D2R;
  const h = Math.sin((la2 - la1) / 2) ** 2 +
            Math.cos(la1) * Math.cos(la2) * Math.sin((bLon - aLon) * D2R / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(Math.min(1, h))) / 1000;
}

export function toUV(speedMs, fromDeg) {
  const t = fromDeg * D2R;
  return { u: -speedMs * Math.sin(t), v: -speedMs * Math.cos(t) };
}
export function toSpeedDir(u, v) {
  return { speedMs: Math.hypot(u, v), fromDeg: (Math.atan2(-u, -v) * R2D + 360) % 360 };
}
/** 兩個方位角的最小夾角（度），0~180 */
export function angDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * 由 Open-Meteo 取樣點建立「背景場」取樣器（反距離權重）。
 * 模式格點約 8 km，取樣點之間本來就幾乎同值，IDW 僅作平滑銜接。
 */
export function makeBackground(omPoints, { power = 2, minKm = 0.3 } = {}) {
  const src = omPoints
    .filter((p) => Number.isFinite(p.current?.windMs) && Number.isFinite(p.current?.windFromDeg))
    .map((p) => ({
      lat: p.reqLat, lon: p.reqLon, gustMs: p.current.gustMs,
      ...toUV(p.current.windMs, p.current.windFromDeg),
    }));
  if (!src.length) throw new Error('沒有任何 Open-Meteo 取樣點含有效風資料');

  return function at(lat, lon) {
    let wu = 0, wv = 0, wg = 0, sw = 0;
    for (const p of src) {
      const d = Math.max(minKm, haversineKm(lat, lon, p.lat, p.lon));
      const w = 1 / Math.pow(d, power);
      wu += w * p.u; wv += w * p.v; wg += w * (Number.isFinite(p.gustMs) ? p.gustMs : 0); sw += w;
    }
    return { u: wu / sw, v: wv / sw, gustMs: wg / sw };
  };
}

/**
 * 由「尖峰陣風」推出風速起伏的標準差。
 *
 * 尖峰與標準差以尖峰因子相連：peak ≈ mean + g·σ。g 取決於「取樣期間多長」
 * —— 期間越長、取到極值的機會越多，g 就越大。Davenport 的尖峰因子：
 *     g = √(2·ln(νT)) + 0.577/√(2·ln(νT))      ν ≈ 0.2 Hz（近地紊流）
 *     T =  600 s（10 分鐘）-> νT=120 -> g ≈ 3.3
 *     T = 3600 s（1 小時） -> νT=720 -> g ≈ 3.8
 *
 * 兩個來源的基準不同，不能共用同一個 g：
 *   氣象署    10 分鐘平均 vs 同時段內 3 秒平均的最大瞬間風  -> g ≈ 3.3
 *   Open-Meteo  wind_gusts_10m 文件載明為 "maximum of the preceding hour"
 *               取樣期間是一小時而非十分鐘                  -> g ≈ 3.8
 *
 * 本模型用 Open-Meteo 的陣風（與模式平均風同源），故取 3.8。
 * 先前誤用 3.0，把 σ 高估約 27%。
 */
export const GUST_PEAK_FACTOR_HOURLY = 3.8;   // Open-Meteo：前一小時最大
export const GUST_PEAK_FACTOR_10MIN = 3.3;    // 氣象署：10 分鐘內 3 秒陣風

function gustSigma(gustMs, meanMs) {
  if (!Number.isFinite(gustMs) || !Number.isFinite(meanMs)) return 0;
  return Math.max(0, (gustMs - meanMs) / GUST_PEAK_FACTOR_HOURLY);
}

/**
 * 氣象署的陣風分級。
 *
 * 定義在「10 分鐘平均與同時段最大瞬間風的差值」上：
 *   差值 < 5 m/s   無陣風現象
 *   5 ~ 10         小陣風
 *   > 10           大陣風
 *
 * 但我們手上的陣風是「前一小時最大」，基準不同不能直接套門檻。
 * 作法是先還原成 σ（除以 3.8），再換算回 10 分鐘基準的差值（乘 3.3），
 * 這樣才是在跟氣象署同一個量上比較。
 */
export function cwaGustClass(sigmaMs) {
  const excess10min = (sigmaMs || 0) * GUST_PEAK_FACTOR_10MIN;
  return {
    excessMs: +excess10min.toFixed(2),
    level: excess10min >= 10 ? 'strong' : excess10min >= 5 ? 'mild' : 'none',
    label: excess10min >= 10 ? '大陣風' : excess10min >= 5 ? '小陣風' : '無陣風現象',
    basis: '已由前一小時最大(g=3.8)換算為氣象署的 10 分鐘基準(g=3.3)',
  };
}

/** 依測站散佈密度推出 Barnes 的起始尺度 κ₀ = 5.052·(2Δn/π)² */
export function barnesKappa(stations) {
  if (stations.length < 3) return { kappaKm2: 100, spacingKm: 10, areaKm2: null };
  const lats = stations.map((s) => s.lat), lons = stations.map((s) => s.lon);
  const latSpan = (Math.max(...lats) - Math.min(...lats)) * 111.32;
  const latMean = (Math.max(...lats) + Math.min(...lats)) / 2;
  const lonSpan = (Math.max(...lons) - Math.min(...lons)) * 111.32 * Math.cos(latMean * D2R);
  const areaKm2 = Math.max(1, latSpan * lonSpan);
  const spacingKm = Math.sqrt(areaKm2 / stations.length);
  return { kappaKm2: 5.052 * Math.pow(2 * spacingKm / Math.PI, 2), spacingKm, areaKm2 };
}

/** 篩出可用於分析的測站 */
export function usableStations(stations, centerLat, centerLon, cfg = BARNES_DEFAULTS) {
  return stations.filter((s) => {
    if (s.windMs == null || s.windFromDeg == null) return false;
    if (s.windMs <= 0) return false;              // 靜風無方向資訊
    if (cfg.minSpeedMs != null && s.windMs < cfg.minSpeedMs) return false;
    if (cfg.maxAltM != null && s.altM != null && s.altM > cfg.maxAltM) return false;
    if (cfg.minAltM != null && s.altM != null && s.altM < cfg.minAltM) return false;
    return haversineKm(centerLat, centerLon, s.lat, s.lon) <= cfg.maxStationKm;
  });
}

/**
 * 風向的 Barnes 分析。
 * 對「單位向量」操作：只取方向、丟棄測站風速（風速另由模式提供）。
 *
 * @returns dirAt(lat, lon) -> { ux, uy }  單位化後的方向向量
 */
export function makeDirectionAnalysis(stations, background, cfg = BARNES_DEFAULTS) {
  const { kappaKm2, spacingKm, areaKm2 } = barnesKappa(stations);

  // 測站方向的單位向量，以及該處背景場方向的單位向量
  const obs = stations.map((s) => {
    const o = toUV(1, s.windFromDeg);                       // 單位觀測向量
    const b = background(s.lat, s.lon);
    const bn = Math.hypot(b.u, b.v) || 1;
    return { lat: s.lat, lon: s.lon, id: s.id, name: s.name,
             ox: o.u, oy: o.v, bx: b.u / bn, by: b.v / bn };
  });

  function analyze(lat, lon, exclude = null) {
    const b = background(lat, lon);
    const bn = Math.hypot(b.u, b.v) || 1;
    let ax = b.u / bn, ay = b.v / bn;

    let kappa = kappaKm2;
    for (let pass = 0; pass < cfg.passes; pass++) {
      let sx = 0, sy = 0, sw = 0;
      for (const o of obs) {
        if (exclude !== null && o.id === exclude) continue;
        const r = haversineKm(lat, lon, o.lat, o.lon);
        const w = Math.exp(-(r * r) / kappa);
        if (w < cfg.minWeight) continue;
        // 增量 = 觀測方向 − 目前分析場在該測站處的方向
        const aAt = analyzedAt(o, pass, exclude, kappa);
        sx += w * (o.ox - aAt.x); sy += w * (o.oy - aAt.y);
        sw += w;
      }
      if (sw > 0) { ax += sx / sw; ay += sy / sw; }
      kappa *= cfg.gamma;   // 修正遍收縮尺度，恢復被首遍平滑掉的短波
    }
    const n = Math.hypot(ax, ay) || 1;
    return { ux: ax / n, uy: ay / n };
  }

  // 第 pass 遍時，分析場在測站 o 處的值（用於計算殘差）
  function analyzedAt(o, pass, exclude, kappa) {
    let ax = o.bx, ay = o.by;
    let k = kappaKm2;
    for (let p = 0; p < pass; p++) {
      let sx = 0, sy = 0, sw = 0;
      for (const q of obs) {
        if (exclude !== null && q.id === exclude) continue;
        const r = haversineKm(o.lat, o.lon, q.lat, q.lon);
        const w = Math.exp(-(r * r) / k);
        if (w < cfg.minWeight) continue;
        sx += w * (q.ox - q.bx); sy += w * (q.oy - q.by);
        sw += w;
      }
      if (sw > 0) { ax += sx / sw; ay += sy / sw; }
      k *= cfg.gamma;
    }
    const n = Math.hypot(ax, ay) || 1;
    return { x: ax / n, y: ay / n };
  }

  return { analyze, kappaKm2, spacingKm, areaKm2, stationCount: obs.length,
           eFoldKm: Math.sqrt(kappaKm2) };
}

/** 候選設定：每次請求都實測哪一組最好，而不是寫死一組 */
const CANDIDATES = [];
for (const minSpeedMs of [1.0, 1.5, 2.0, 2.5, 3.0]) {
  for (const [gamma, passes] of [[0.8, 1], [0.8, 2], [0.5, 2]]) {
    CANDIDATES.push({ minSpeedMs, gamma, passes });
  }
}
/** 分析必須贏過背景場這麼多才值得採用；否則就是在拿雜訊換複雜度 */
const MIN_GAIN_PCT = 3;
const MIN_STATIONS = 12;

/**
 * 組出每個路段的風：方向來自 Barnes 分析，風速來自模式背景場。
 *
 * 關鍵設計：不預先假定 Barnes 一定有用。每次請求都跑留一交叉驗證，
 * 只有在分析確實比純模式背景好（且測站數足夠）時才採用，否則誠實退回
 * 純模式場並標示原因。風場的品質隨天氣變動很大 —— 平靜的日子測站風向
 * 幾乎是亂數，那時任何內插都只是在放大雜訊。
 */
export function buildWindField(segments, omPoints, stations, cfgOverride = null) {
  const background = makeBackground(omPoints);
  const cLat = segments.reduce((a, s) => a + s.lat, 0) / segments.length;
  const cLon = segments.reduce((a, s) => a + s.lon, 0) / segments.length;

  const modelOnly = (reason, extra = {}) => {
    const field = segments.map((s) => {
      const b = background(s.lat, s.lon);
      const sd = toSpeedDir(b.u, b.v);
      return { ...b, ...sd, dirShiftDeg: 0, gustSigmaMs: gustSigma(b.gustMs, sd.speedMs) };
    });
    return { field, method: 'model-only', reason, ...extra };
  };

  // 選設定：實測各候選的交叉驗證成績
  let cfg = cfgOverride, bestCv = null, tried = [];
  if (!cfg) {
    for (const c of CANDIDATES) {
      const full = { ...BARNES_DEFAULTS, ...c };
      const used = usableStations(stations, cLat, cLon, full);
      if (used.length < MIN_STATIONS) continue;
      const cv = crossValidateDirection(stations, omPoints, full);
      if (cv.skipped) continue;
      tried.push({ ...c, n: cv.n, gainPct: cv.rmsImprovementPct,
                   bgRms: cv.backgroundRmsDeg, anRms: cv.barnesRmsDeg });
      if (!bestCv || cv.rmsImprovementPct > bestCv.cv.rmsImprovementPct) bestCv = { cfg: full, cv };
    }
    if (!bestCv) return modelOnly('沒有任何候選設定有足夠測站（需 ≥' + MIN_STATIONS + ' 站）', { tried });
    if (bestCv.cv.rmsImprovementPct < MIN_GAIN_PCT) {
      return modelOnly('測站之間沒有可解析的空間結構（最佳候選僅改善 ' +
        bestCv.cv.rmsImprovementPct + '%，未達 ' + MIN_GAIN_PCT + '% 門檻）',
        { tried, crossValidation: bestCv.cv });
    }
    cfg = bestCv.cfg;
  }

  const used = usableStations(stations, cLat, cLon, cfg);
  if (used.length < MIN_STATIONS) return modelOnly('可用測站僅 ' + used.length + ' 個', { tried });

  const ana = makeDirectionAnalysis(used, background, cfg);
  let maxShift = 0, sumShift = 0;
  const field = segments.map((s) => {
    const b = background(s.lat, s.lon);
    const spd = Math.hypot(b.u, b.v);
    const d = ana.analyze(s.lat, s.lon);
    const u = spd * d.ux, v = spd * d.uy;
    const bg = toSpeedDir(b.u, b.v), an = toSpeedDir(u, v);
    const shift = angDiff(bg.fromDeg, an.fromDeg);
    maxShift = Math.max(maxShift, shift); sumShift += shift;
    return { u, v, gustMs: b.gustMs, speedMs: an.speedMs, fromDeg: an.fromDeg,
             dirShiftDeg: +shift.toFixed(1),
             gustSigmaMs: gustSigma(b.gustMs, an.speedMs) };
  });

  return {
    field, method: 'barnes-direction + model-speed',
    stationCount: used.length,
    kappaKm2: +ana.kappaKm2.toFixed(1),
    eFoldKm: +ana.eFoldKm.toFixed(2),
    spacingKm: +ana.spacingKm.toFixed(2),
    gamma: cfg.gamma, passes: cfg.passes, minSpeedMs: cfg.minSpeedMs,
    meanDirShiftDeg: +(sumShift / segments.length).toFixed(2),
    maxDirShiftDeg: +maxShift.toFixed(1),
    crossValidation: bestCv ? bestCv.cv : null,
    tried,
  };
}

/**
 * 留一交叉驗證：Barnes 分析真的比單純用模式背景好嗎？
 *
 * 對每個測站，用「其餘測站」預測它的風向，與實測比較角度誤差。
 * 若 Barnes 的誤差沒有低於背景場，代表測站之間沒有可解析的空間結構，
 * 這時就不該宣稱做出了風場 —— 必須讓資料自己說話。
 */
export function crossValidateDirection(stations, omPoints, cfg = BARNES_DEFAULTS) {
  const background = makeBackground(omPoints);
  const cLat = stations.reduce((a, s) => a + s.lat, 0) / stations.length;
  const cLon = stations.reduce((a, s) => a + s.lon, 0) / stations.length;
  const used = usableStations(stations, cLat, cLon, cfg);
  if (used.length < 8) return { n: used.length, skipped: '測站不足' };

  const ana = makeDirectionAnalysis(used, background, cfg);
  const errBg = [], errAn = [];
  for (const s of used) {
    const b = background(s.lat, s.lon);
    const bgDir = toSpeedDir(b.u, b.v).fromDeg;
    const d = ana.analyze(s.lat, s.lon, s.id);          // 排除自己
    const anDir = toSpeedDir(d.ux, d.uy).fromDeg;
    errBg.push(angDiff(bgDir, s.windFromDeg));
    errAn.push(angDiff(anDir, s.windFromDeg));
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const rms = (a) => Math.sqrt(a.reduce((x, y) => x + y * y, 0) / a.length);
  const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
  const improved = errAn.filter((e, i) => e < errBg[i]).length;
  return {
    n: used.length,
    backgroundMeanDeg: +mean(errBg).toFixed(2), backgroundRmsDeg: +rms(errBg).toFixed(2),
    backgroundMedianDeg: +med(errBg).toFixed(2),
    barnesMeanDeg: +mean(errAn).toFixed(2), barnesRmsDeg: +rms(errAn).toFixed(2),
    barnesMedianDeg: +med(errAn).toFixed(2),
    improvedStations: improved,
    rmsImprovementPct: +((1 - rms(errAn) / rms(errBg)) * 100).toFixed(1),
    helps: rms(errAn) < rms(errBg),
  };
}
