/**
 * 雷達臨近預報（radar nowcasting）
 *
 * 做法：交叉相關求回波的移動向量，再做半拉格朗日平流外推。
 *
 *   1. 取兩張間隔 10 分鐘的影格，在位移空間上做正規化交叉相關，
 *      找出使兩張最相似的位移 (dx, dy)，即回波場的整體移動。
 *   2. 外推：T 分鐘後位於 p 的回波，現在位於 p − v·T。
 *      所以 forecast(p, T) = current(p − v·T)。
 *
 * 這是臨近預報最基本也最穩健的做法（Lagrangian persistence）。它假設
 * 回波只平移、不生成也不消散 —— 對 0~60 分鐘的尺度通常夠用，再長就會
 * 高估持續性。本模組只提供到 60 分鐘，並隨前置時間標示信心下降。
 *
 * 與騎乘結合：真正要回答的不是「哪裡會下雨」，而是「我騎到那裡的時候
 * 會不會下」。所以每一路段的預報時刻，取的是依目標功率算出的抵達時間。
 */
import { dbzToRainMmPerH, rainBand, RADAR } from './radar.mjs';

export const NOWCAST = {
  maxShiftCells: 16,     // 回波移速上限約 120 km/h（10 分鐘 16 格 x 1.26 km）
  coarseStep: 2,
  minEchoCells: 40,      // 回波太少時相關係數沒有意義
  minCorr: 0.3,          // 低於此相關度視為無法可靠估計移動
  maxLeadMin: 60,
  rainThresholdMmPerH: 0.2,
};

/** 把 dBZ 轉成相關計算用的強度（無回波 -> 0） */
function intensity(v) {
  if (!Number.isFinite(v) || v <= RADAR.echoThresholdDbz) return 0;
  return Math.min(60, v);
}

/**
 * 交叉相關估計移動向量。
 * @returns { dxCells, dyCells, corr, speedKmh, towardDeg, ok, reason }
 */
export function estimateMotion(frameOld, frameNew) {
  if (!frameOld || !frameNew) return { ok: false, reason: '影格不足' };
  if (frameOld.nx !== frameNew.nx || frameOld.ny !== frameNew.ny ||
      Math.abs(frameOld.lon0 - frameNew.lon0) > 1e-9 || Math.abs(frameOld.lat0 - frameNew.lat0) > 1e-9) {
    return { ok: false, reason: '兩張影格的網格範圍不一致' };
  }
  const dtMin = (new Date(frameNew.obsTime) - new Date(frameOld.obsTime)) / 60000;
  if (!(dtMin > 0 && dtMin <= 40)) return { ok: false, reason: '影格時間間隔異常（' + dtMin + ' 分）' };

  const { nx, ny, res } = frameNew;
  const A = new Float32Array(nx * ny), B = new Float32Array(nx * ny);
  let nA = 0, nB = 0;
  for (let i = 0; i < nx * ny; i++) {
    A[i] = intensity(frameOld.data[i]); if (A[i] > 0) nA++;
    B[i] = intensity(frameNew.data[i]); if (B[i] > 0) nB++;
  }
  if (nA < NOWCAST.minEchoCells || nB < NOWCAST.minEchoCells) {
    return { ok: false, reason: '回波太少（' + nA + ' -> ' + nB + ' 格），無法估計移動', echoOld: nA, echoNew: nB };
  }

  // 位移 (dx,dy)：舊影格平移後與新影格比對
  const score = (dx, dy) => {
    let sab = 0, saa = 0, sbb = 0;
    const x0 = Math.max(0, -dx), x1 = Math.min(nx, nx - dx);
    const y0 = Math.max(0, -dy), y1 = Math.min(ny, ny - dy);
    for (let y = y0; y < y1; y++) {
      const rowB = y * nx, rowA = (y + dy) * nx + dx;
      for (let x = x0; x < x1; x++) {
        const a = A[rowA + x], b = B[rowB + x];
        if (a === 0 && b === 0) continue;
        sab += a * b; saa += a * a; sbb += b * b;
      }
    }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : -1;
  };

  // 粗搜 -> 細修
  let best = { dx: 0, dy: 0, c: -1 };
  const M = NOWCAST.maxShiftCells, st = NOWCAST.coarseStep;
  for (let dy = -M; dy <= M; dy += st) {
    for (let dx = -M; dx <= M; dx += st) {
      const c = score(dx, dy);
      if (c > best.c) best = { dx, dy, c };
    }
  }
  for (let dy = best.dy - st; dy <= best.dy + st; dy++) {
    for (let dx = best.dx - st; dx <= best.dx + st; dx++) {
      if (Math.abs(dx) > M || Math.abs(dy) > M) continue;
      const c = score(dx, dy);
      if (c > best.c) best = { dx, dy, c };
    }
  }
  if (best.c < NOWCAST.minCorr) {
    return { ok: false, reason: '相關度僅 ' + best.c.toFixed(2) + '，低於 ' + NOWCAST.minCorr +
             '，回波型態變化太大無法可靠外推', corr: +best.c.toFixed(3), echoOld: nA, echoNew: nB };
  }

  // 位移（格）-> 速度。經向每格的公里數隨緯度縮短。
  const latMid = frameNew.lat0 + (ny / 2) * res;
  const kmPerCellLat = res * 111.32;
  const kmPerCellLon = res * 111.32 * Math.cos(latMid * Math.PI / 180);
  const vxKmMin = (best.dx * kmPerCellLon) / dtMin;
  const vyKmMin = (best.dy * kmPerCellLat) / dtMin;
  const speedKmh = Math.hypot(vxKmMin, vyKmMin) * 60;
  const towardDeg = (Math.atan2(vxKmMin, vyKmMin) * 180 / Math.PI + 360) % 360;

  return {
    ok: true,
    dxCells: best.dx, dyCells: best.dy, dtMin,
    corr: +best.c.toFixed(3),
    vLonDegPerMin: (best.dx * res) / dtMin,
    vLatDegPerMin: (best.dy * res) / dtMin,
    speedKmh: +speedKmh.toFixed(1),
    towardDeg: +towardDeg.toFixed(0),
    fromDeg: +((towardDeg + 180) % 360).toFixed(0),
    echoOld: nA, echoNew: nB,
  };
}

/** 平流外推：T 分鐘後 (lat,lon) 的回波 = 現在 (lat − vLat·T, lon − vLon·T) 的回波 */
export function forecastDbzAt(frame, motion, lat, lon, leadMin) {
  const la = lat - motion.vLatDegPerMin * leadMin;
  const lo = lon - motion.vLonDegPerMin * leadMin;
  const ix = Math.round((lo - frame.lon0) / frame.res);
  const iy = Math.round((la - frame.lat0) / frame.res);
  if (ix < 0 || ix >= frame.nx || iy < 0 || iy >= frame.ny) return null;  // 外推到子網格之外
  const v = frame.data[iy * frame.nx + ix];
  return v <= -98 ? null : v;
}

/**
 * 沿騎乘路線的臨近預報。
 * @param arrivalMin 與 segments 等長，每段的抵達時間（分鐘，自現在起算）
 */
export function nowcastRide(segments, frame, motion, arrivalMin) {
  const per = segments.map((s, i) => {
    const lead = arrivalMin[i];
    if (lead > NOWCAST.maxLeadMin) return { leadMin: +lead.toFixed(1), beyondHorizon: true };
    const d = forecastDbzAt(frame, motion, s.lat, s.lon, lead);
    const R = d === null ? 0 : dbzToRainMmPerH(d);
    return {
      leadMin: +lead.toFixed(1),
      dbz: d === null ? null : +d.toFixed(1),
      rainMmPerH: +R.toFixed(2),
      band: rainBand(R),
      outOfDomain: d === null && lead <= NOWCAST.maxLeadMin ? undefined : undefined,
    };
  });

  let firstHit = null, wetKm = 0, maxR = 0, beyond = 0;
  for (let i = 0; i < per.length; i++) {
    if (per[i].beyondHorizon) { beyond += segments[i].len / 1000; continue; }
    const R = per[i].rainMmPerH;
    if (R > NOWCAST.rainThresholdMmPerH) {
      wetKm += segments[i].len / 1000;
      if (R > maxR) maxR = R;
      if (!firstHit) {
        firstHit = { segIndex: i, km: +(segments[i].s0 / 1000).toFixed(2),
                     leadMin: per[i].leadMin, rainMmPerH: R, band: per[i].band };
      }
    }
  }
  return {
    perSegment: per,
    firstHit,
    wetKm: +wetKm.toFixed(2),
    maxRainMmPerH: +maxR.toFixed(2),
    beyondHorizonKm: +beyond.toFixed(2),
    horizonMin: NOWCAST.maxLeadMin,
    anyRain: wetKm > 0.1,
  };
}

/** 整個路線在未來各時刻的降雨覆蓋（不考慮配速，單純看雨帶掃過） */
export function nowcastTimeline(segments, frame, motion, { stepMin = 10, maxMin = 60 } = {}) {
  const out = [];
  for (let t = 0; t <= maxMin; t += stepMin) {
    let km = 0, maxR = 0;
    for (const s of segments) {
      const d = forecastDbzAt(frame, motion, s.lat, s.lon, t);
      const R = d === null ? 0 : dbzToRainMmPerH(d);
      if (R > NOWCAST.rainThresholdMmPerH) { km += s.len / 1000; if (R > maxR) maxR = R; }
    }
    out.push({ leadMin: t, wetKm: +km.toFixed(2), maxRainMmPerH: +maxR.toFixed(2) });
  }
  return out;
}
