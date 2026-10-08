/**
 * 靜態模式：沒有後端時，在瀏覽器裡自己算方向分析。
 *
 * GitHub Pages 這類純靜態空間跑不了 Node。改由 GitHub Actions 定時產生
 * 快照（conditions.json 只含「觀測」），前端讀進來後用 physics.mjs 自己
 * 跑方向分析 —— 與伺服器端完全同一份程式碼，不會有兩套物理。
 *
 * 好處不只是能部署：參數滑桿變成純本地運算，不必往返伺服器。
 */
import {
  DEFAULT_PARAMS, USER_TUNABLE, analyzeDirections, selfTest,
  exposureDisplacement, toUV, toSpeedDir, airDensity,
} from './physics.mjs';

/** 把精簡過的 route.min.json 還原成前端其餘程式預期的形狀 */
export function expandRoute(min) {
  const labels = min.meta.sectionLabels || [];
  let acc = 0;
  const segments = min.segments.map((s, i) => {
    const s0 = s.s0, s1 = s0 + s.len;
    acc += s.len;
    return {
      i, s0, s1, len: s.len,
      a: s.a, b: s.b,
      // 中點：原本由前處理算好，這裡由端點還原（誤差遠小於 25 m 的段長）
      lat: (s.a[0] + s.b[0]) / 2, lon: (s.a[1] + s.b[1]) / 2,
      bearing: s.bearing, gradePct: s.gradePct, ele: s.ele,
      exposure: s.exposure, kFactor: s.kFactor ?? 1, phase: s.phase ?? null,
      sectionLabel: labels[s.sec] ?? '',
    };
  });
  return { meta: min.meta, segments };
}

/**
 * 以快照 + 使用者參數，在瀏覽器算出與伺服器 /api/conditions 同形狀的結果。
 * @param snap  conditions.json
 * @param route expandRoute() 的輸出
 * @param overrides 使用者調整的參數
 */
export function computeConditions(snap, route, overrides) {
  const segs = route.segments;

  // 參數：快照帶的校正值為底，再套使用者覆寫（與伺服器同一套驗證規則）
  const params = { ...DEFAULT_PARAMS, ...pickParams(snap.params) };
  for (const [k, spec] of Object.entries(USER_TUNABLE)) {
    const v = overrides?.[k];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(spec.label + ' 必須是數字');
    if (n < spec.min || n > spec.max) {
      throw new Error(spec.label + ' 必須在 ' + spec.min + ' ~ ' + spec.max + ' 之間');
    }
    params[k] = n;
  }
  if (overrides?.exposureK) {
    const ek = { ...params.exposureK };
    for (const cls of ['riverside', 'urban', 'mountain']) {
      const v = overrides.exposureK[cls];
      if (v === undefined || v === null || v === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 3) throw new Error('exposureK.' + cls + ' 必須是 0~3');
      ek[cls] = n;
    }
    params.exposureK = ek;
  }

  // 由快照的逐段觀測重建風場（u/v 由風速與來向還原）
  const field = snap.segments.map((c) => {
    const sd = toSpeedDir(c.u, c.v);
    return { u: c.u, v: c.v, ...sd, gustSigmaMs: c.g ?? 0 };
  });

  const orientation = route.meta.gpxOrientation;
  const analysis = analyzeDirections(segs, field, orientation, params);
  const st = selfTest(segs, orientation, {
    windMs: snap.wind.openTerrain.speedMs, fromDeg: snap.wind.openTerrain.fromDeg, params,
  });
  const D = exposureDisplacement(segs, params);

  // 零風基準：與天氣無關的那一部分
  const calmField = segs.map(() => ({ u: 0, v: 0, speedMs: 0, fromDeg: 0, gustSigmaMs: 0 }));
  const calm = analyzeDirections(segs, calmField, orientation, params);

  const contribSec = {};
  for (const ex of new Set(segs.map((s) => s.exposure))) {
    contribSec[ex] = +(((analysis.directions.CW.byExposure[ex]?.timeMin ?? 0) -
                        (analysis.directions.CCW.byExposure[ex]?.timeMin ?? 0)) * 60).toFixed(1);
  }

  return {
    ...snap,
    params,
    direction: {
      recommend: Math.abs(analysis.deltaSec) < 15 ? null : analysis.recommend,
      deltaSec: analysis.deltaSec,
      deltaKJ: analysis.deltaKJ,
      deltaPct: analysis.deltaPct,
      targetPowerW: analysis.targetPowerW,
      calmDeltaSec: calm.deltaSec,
      windDeltaSec: +(analysis.deltaSec - calm.deltaSec).toFixed(1),
      noiseFloorSec: st.noiseFloorSec,
      uniformWindSec: st.uniformWindSec,
      contributionSec: contribSec,
      exposureDisplacement: D,
      gustPenaltySec: {
        CW: analysis.directions.CW.gustPenaltyS,
        CCW: analysis.directions.CCW.gustPenaltyS,
      },
      byDirection: Object.fromEntries(Object.entries(analysis.directions).map(([k, v]) => [k, {
        timeMin: v.timeMin, timeS: v.timeS, avgSpeedKmh: v.avgSpeedKmh,
        energyKJ: v.energyKJ, aeroWorkKJ: v.aeroWorkKJ,
        brakingCapKm: v.brakingCapKm, byExposure: v.byExposure,
      }])),
    },
    // 逐段：把快照的觀測與剛算好的方向分析併回伺服器版的形狀
    segments: snap.segments.map((c, i) => ({
      i, km: +(segs[i].s0 / 1000).toFixed(2), exposure: segs[i].exposure,
      openWindMs: +field[i].speedMs.toFixed(2),
      openWindFromDeg: +field[i].fromDeg.toFixed(0),
      openGustSigmaMs: c.g ?? 0,
      cw: analysis.directions.CW.perSeg[i], ccw: analysis.directions.CCW.perSeg[i],
      cwCalmS: calm.directions.CW.perSeg[i].timeS,
      ccwCalmS: calm.directions.CCW.perSeg[i].timeS,
      surf: {
        filmMm: c.f, radarDbz: c.z, rainNowMmPerH: c.r,
        rainingNow: (c.r ?? 0) > 0,
        rainNowSource: snap.surface?.sources?.now === 'radar' ? 'radar' : 'station',
        level: c.f >= 0.15 ? 'wet' : c.f >= 0.05 ? 'damp' : 'dry',
        filmFromHistoryMm: c.f,
      },
      fc: c.fc ? { rain: c.fc } : null,
    })),
  };
}

function pickParams(p) {
  if (!p) return {};
  const out = {};
  for (const k of ['targetPowerW', 'massKg', 'cdaM2', 'crr', 'rho',
                   'minSpeedKmh', 'maxSpeedKmh', 'yawCorrection',
                   'gustPeakFactor', 'gustQuadPoints']) {
    if (p[k] !== undefined) out[k] = p[k];
  }
  if (p.exposureK) out.exposureK = { ...p.exposureK };
  if (p._riderProfile) out._riderProfile = p._riderProfile;
  return out;
}
