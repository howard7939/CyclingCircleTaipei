/**
 * 組裝「目前騎乘條件」的單一來源。
 *
 * 抽出來的理由：HTTP 伺服器與靜態快照產生器都需要這段邏輯。先前它埋在
 * index.mjs 裡，若為靜態版另外複製一份，兩邊遲早會走偏 —— 而那種偏差
 * 不會報錯，只會讓兩個部署悄悄給出不一樣的建議。
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cwaStations, cwaRain, cwaUv, openMeteo, cwaRainAt } from './sources.mjs';

// 雨量站歷史快照：每張 2.4 MB / 3-6 秒，用於取得近 6 小時的「真實逐時雨量」，
// 取代由累積桶均分推得的粗略值。影格不會變，磁碟快取永不過期，故只在
// 背景抓一次；抓到之前先用桶推值，不讓它擋住請求。
const RAIN_HISTORY_HOURS = 6;
let rainHistFetching = null;
async function getRainHistory(bbox) {
  const now = Date.now();
  const byHour = new Map();
  const missing = [];
  for (let h = 1; h <= RAIN_HISTORY_HOURS; h++) {
    const when = new Date(now - h * 3600e3);
    try {
      const snap = await cwaRainAt(when, bbox, { diskOnly: true });
      byHour.set(h, new Map(snap.stations.map((s) => [s.id, s])));
    } catch { missing.push(when); }
  }
  if (missing.length && !rainHistFetching) {
    rainHistFetching = (async () => {
      for (const when of missing) {
        try { await cwaRainAt(when, bbox); }
        catch (e) { console.warn('[rain-history] ' + when.toISOString() + ' 失敗：' + e.message); }
      }
    })().finally(() => { rainHistFetching = null; });
  }
  return { byHour, missingHours: missing.length };
}
import {
  airDensity, openWindField, analyzeDirections, selfTest,
  toUV, toSpeedDir, loadParams, exposureDisplacement, solveSpeedMs, USER_TUNABLE,
} from './wind-model.mjs';
import { buildWindField, cwaGustClass } from './wind-field.mjs';
import { stationWetness, surfaceAlongRoute, applyRadarNow, uvAnalysis, SURFACE_DEFAULTS } from './surface.mjs';
import { fetchRadar, fetchRadarAt, radarAlongRoute, echoCells, dbzToRainMmPerH, RADAR } from './radar.mjs';
import { estimateMotion, nowcastRoute, NOWCAST } from './nowcast.mjs';
import { pruneCache, RETENTION } from './cache.mjs';

// 雷達的 8.5 MB 下載時間 2-27 秒不等（取決於對方伺服器負載，實測變動很大，
// 且該 API 不支援空間子集、也不壓縮），不能每次請求都等它。
// 策略：手上有影格就先用（即使略舊），同時在背景更新；只有第一次沒得用才等。
let latestRadar = null, radarFetching = null;
function getRadar(bbox) {
  const fresh = latestRadar && Date.now() - latestRadar.fetchedAtMs < RADAR.ttlMs;
  if (!fresh && !radarFetching) {
    radarFetching = fetchRadar(bbox, { force: true })
      .then((f) => { latestRadar = f; return f; })
      .catch((e) => { console.warn('[radar] 背景更新失敗：' + e.message); return null; })
      .finally(() => { radarFetching = null; });
  }
  if (latestRadar) return Promise.resolve(latestRadar);
  return radarFetching ?? Promise.resolve(null);
}

// 歷史影格要 4-27 秒，不能擋在請求路徑上。磁碟快取命中就即時算，
// 沒有就在背景抓、下一次請求生效。背景抓取同時只允許一個。
let prevFrameFetching = null;
async function getPrevFrame(nowFrame, bbox) {
  const when = new Date(new Date(nowFrame.obsTime).getTime() - 10 * 60e3);
  try {
    return await fetchRadarAt(when, bbox, { diskOnly: true });
  } catch { /* 磁碟沒有 */ }
  if (!prevFrameFetching) {
    prevFrameFetching = fetchRadarAt(when, bbox)
      .catch((e) => { console.warn('[nowcast] 背景抓取歷史影格失敗：' + e.message); return null; })
      .finally(() => { prevFrameFetching = null; });
  }
  return null;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 5174;


// ---------- 路線資料（啟動時載入一次） ----------
let ROUTE = null;
async function getRoute() {
  if (ROUTE) return ROUTE;
  const r = JSON.parse(await readFile(join(DATA, 'route.json'), 'utf8'));
  if (!r.segments?.length) throw new Error('route.json 沒有 segments，先執行 npm run build:data');
  if (r.segments.some((s) => !s.exposure)) throw new Error('有路段缺 exposure，先執行 npm run sections');
  ROUTE = r;
  return r;
}

const SAMPLE_N = 12;
const BBOX_BUFFER = 0.18; // 約 18 km。再大會抓進宜蘭/桃園，隔著山脈不具代表性。

/** 目前的騎乘條件：風場、方向建議、降雨、紫外線 */
export async function getConditions({ full = false, overrides = null } = {}) {
  const route = await getRoute();
  const M = route.meta, segs = route.segments;

  const bbox = {
    minLat: M.bbox.minLat - BBOX_BUFFER, maxLat: M.bbox.maxLat + BBOX_BUFFER,
    minLon: M.bbox.minLon - BBOX_BUFFER, maxLon: M.bbox.maxLon + BBOX_BUFFER,
  };
  const samplePts = Array.from({ length: SAMPLE_N }, (_, i) => {
    const s = segs[Math.floor(i * segs.length / SAMPLE_N)];
    return { name: 'km' + (s.s0 / 1000).toFixed(0), lat: s.lat, lon: s.lon };
  });

  const [obs, rain, uv, om, radarFrame] = await Promise.all([
    cwaStations(bbox).catch((e) => ({ error: e.message, stations: [] })),
    cwaRain(bbox).catch((e) => ({ error: e.message, stations: [] })),
    cwaUv().catch((e) => ({ error: e.message, stations: [] })),
    openMeteo(samplePts),
    // 雷達失敗不應該讓整頁掛掉 —— 其餘分析不依賴它
    getRadar(M.bbox).catch((e) => ({ error: e.message })),
  ]);

  // 測站風的向量平均（只取低地站；高山站風速與盆地不可比）
  const withWind = obs.stations.filter((s) => s.windMs != null && s.windFromDeg != null);
  const low = withWind.filter((s) => s.altM == null || s.altM < 200);
  let su = 0, sv = 0, ssum = 0, tsum = 0, tn = 0;
  for (const s of low) {
    const c = toUV(s.windMs, s.windFromDeg);
    su += c.u; sv += c.v; ssum += s.windMs;
    if (s.tempC != null) { tsum += s.tempC; tn++; }
  }
  const stVec = low.length ? toSpeedDir(su / low.length, sv / low.length) : null;
  const stScalar = low.length ? ssum / low.length : null;
  const tempC = tn ? tsum / tn : 25;

  let ou = 0, ov = 0;
  for (const p of om.points) { const c = toUV(p.current.windMs, p.current.windFromDeg); ou += c.u; ov += c.v; }
  const omVec = toSpeedDir(ou / om.points.length, ov / om.points.length);

  const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

  const params = { ...loadParams({ quiet: true, overrides }), rho: +airDensity(tempC, 1013).toFixed(3) };
  // 風場：方向以測站做 Barnes 客觀分析，風速取模式開闊地值。
  // buildWindField 會自己跑留一交叉驗證，確認分析真的勝過純模式場才採用。
  const wf = buildWindField(segs, om.points, obs.stations);
  const field = wf.field;
  const analysis = analyzeDirections(segs, field, M.gpxOrientation, params);
  const st = selfTest(segs, M.gpxOrientation, { windMs: omVec.speedMs, fromDeg: omVec.fromDeg, params });
  const D = exposureDisplacement(segs, params);
  // 零風條件下的同一條路線：用來把「風造成的時間差」與「上下坡換邊造成的
  // 時間差」分開。山區換邊的擺盪可達 ±1600 s 卻幾乎自相抵銷，不分開的話
  // 會把真正關心的風訊號壓到看不見。
  const calmField = segs.map(() => ({ u: 0, v: 0, speedMs: 0, fromDeg: 0, gustMs: 0 }));
  const calm = analyzeDirections(segs, calmField, M.gpxOrientation, params);

  // ---------- 路面濕度：水膜質量平衡（Penman 蒸發） ----------
  const nowIso = new Date().toISOString();
  const hourly = om.points[0]?.hourly || [];
  const rainSt = rain.stations.filter((s) => s.hr24 != null || s.hr1 != null);
  const rainHist = await getRainHistory(bbox);
  const wetStations = rainSt.map((st) => stationWetness(st, hourly, nowIso, undefined, rainHist.byHour));
  const surf = surfaceAlongRoute(segs, wetStations);

  // 雷達：補足雨量站的空間解析度（1.3 km vs 站距 5-10 km）。
  // 只修正「現在」—— 過去 24 小時的歷史仍由雨量站提供，雷達沒有歷史。
  let radar = null;
  if (radarFrame && !radarFrame.error) {
    const ra = radarAlongRoute(segs, radarFrame);
    radar = {
      available: true,
      obsTime: ra.obsTime,
      ageMin: Math.round((Date.now() - new Date(ra.obsTime).getTime()) / 60000),
      maxDbz: ra.maxDbz, maxRainMmPerH: ra.maxRainMmPerH,
      echoKm: ra.echoKm, outOfRangeKm: ra.outOfRangeKm,
      meanRainOnEcho: ra.meanRainOnEcho, anyRain: ra.anyRain,
      gridResDeg: radarFrame.res,
      gridResKm: +(radarFrame.res * 111.32).toFixed(2),
      cellsNearRoute: echoCells(radarFrame, M.bbox),
      subgridCells: radarFrame.nx * radarFrame.ny,
      stats: radarFrame.stats,
      timing: radarFrame.timing,
      cache: radarFrame.cache,
      note: '雷達合成回波 O-A0059-001，數值 dBZ 網格（非回波圖影像）。' +
            'Marshall-Palmer Z=200R^1.6 換算雨強。雷達會漏掉低層地形雨，' +
            '且 dBZ 與地面雨量有 2 倍以上不確定度，故與雨量站互補而非取代。',
    };
    // 「現在」以雷達為準覆寫；「過去」的水膜歷史維持由雨量站積分而來
    radar.applied = applyRadarNow(surf, ra.perSegment);
  } else {
    radar = { available: false, error: radarFrame?.error ?? '未取得雷達資料' };
  }

  // ---------- 臨近預報：回波移動向量 + 平流外推 ----------
  let nowcast = { available: false, reason: '雷達不可用' };
  if (radar?.available) {
    const prev = await getPrevFrame(radarFrame, M.bbox);
    if (!prev) {
      nowcast = { available: false, pending: true,
                  reason: '正在背景取得前一張影格（歷史 API 需 4-27 秒），稍後重新整理即可' };
    } else {
      const motion = estimateMotion(prev, radarFrame);
      if (!motion.ok) {
        nowcast = { available: false, reason: motion.reason, motion };
      } else {
        // 全路線 × 未來 60 分鐘。不綁定出發點或配速 —— 服務的是全台北的騎士，
        // 每個人的起點與出發時間都不同。
        const nr = nowcastRoute(segs, radarFrame, motion, { stepMin: 5 });
        nowcast = {
          available: true,
          motion: { speedKmh: motion.speedKmh, towardDeg: motion.towardDeg,
                    fromDeg: motion.fromDeg, corr: motion.corr, dtMin: motion.dtMin,
                    echoOld: motion.echoOld, echoNew: motion.echoNew },
          frames: { prev: prev.obsTime, now: radarFrame.obsTime, prevCache: prev.cache },
          horizonMin: NOWCAST.maxLeadMin,
          leads: nr.leads,
          timeline: nr.timeline,
          summary: nr.summary,
          note: 'Lagrangian persistence：以交叉相關求回波移動向量，再平流外推。' +
                '假設回波只平移、不生成也不消散 —— 0~60 分鐘通常夠用，再長會高估持續性。' +
                '預報涵蓋整條路線的未來 60 分鐘，不綁定出發點或配速。',
          _perSeg: nr.perSegment,
        };
      }
    }
  }

  const surfLevels = { wet: 0, damp: 0, dry: 0 };
  let maxFilm = 0, wetKm = 0, dampKm = 0;
  surf.forEach((x, i) => {
    surfLevels[x.level] += segs[i].len / 1000;
    if (x.filmMm > maxFilm) maxFilm = x.filmMm;
    if (x.level === 'wet') wetKm += segs[i].len / 1000;
    if (x.level === 'damp') dampKm += segs[i].len / 1000;
  });

  // ---------- 未來展望：臨近預報（60 分鐘）之外的尺度 ----------
  // 這份逐時資料本來就為了乾燥模型而抓，順手接出來即可，零額外 API 成本。
  // 臨近預報回答「現在出門會不會淋到」，展望回答「今天下午/明天適不適合騎」。
  const outlookHours = (() => {
    const t0 = Date.now();
    const rows = hourly
      .filter((h) => {
        const t = new Date(h.time + ':00+08:00').getTime();
        return t >= t0 - 3600e3 && t <= t0 + 24 * 3600e3;
      })
      .map((h) => ({
        time: h.time,
        precipMm: h.precipMm ?? 0,
        precipProb: h.precipProb ?? null,
        uvIndex: h.uvIndex ?? 0,
        tempC: h.tempC ?? null,
        windMs: h.windMs ?? null,
        windFromDeg: h.windFromDeg ?? null,
      }));
    const rainy = rows.filter((r) => r.precipMm > 0.05 || (r.precipProb ?? 0) >= 30);
    const totalMm = rows.reduce((a, r) => a + r.precipMm, 0);
    const maxProb = Math.max(0, ...rows.map((r) => r.precipProb ?? 0));
    const peakUv = rows.reduce((a, r) => (r.uvIndex > (a?.uvIndex ?? -1) ? r : a), null);
    // 最接近的「乾爽時段」：連續 2 小時以上無雨、降雨機率 < 30%
    let bestRun = null, run = null;
    for (const r of rows) {
      const dry = r.precipMm <= 0.05 && (r.precipProb ?? 0) < 30;
      if (dry) { run = run || { from: r.time, n: 0 }; run.n++; run.to = r.time; }
      else { if (run && (!bestRun || run.n > bestRun.n)) bestRun = run; run = null; }
    }
    if (run && (!bestRun || run.n > bestRun.n)) bestRun = run;
    return {
      hours: rows,
      summary: {
        hoursAhead: rows.length,
        totalRainMm: +totalMm.toFixed(1),
        maxPrecipProb: maxProb,
        rainyHours: rainy.length,
        firstRainy: rainy.length ? rainy[0].time : null,
        peakUv: peakUv ? { time: peakUv.time, uvIndex: +peakUv.uvIndex.toFixed(1) } : null,
        longestDryRun: bestRun ? { from: bestRun.from, to: bestRun.to, hours: bestRun.n } : null,
      },
      source: 'Open-Meteo 逐時預報（與乾燥模型同一份資料，未另外呼叫 API）',
    };
  })();

  // ---------- 紫外線：騎乘期間的劑量 ----------
  const rideH = analysis.directions[analysis.recommend || 'CCW'].timeS / 3600;
  const uvNow = uvAnalysis(hourly, nowIso, rideH);

  const rs = rain.stations.filter((s) => s.hr1 != null);
  const out = {
    generatedAt: new Date().toISOString(),
    route: { totalKm: M.totalKm, segmentCount: segs.length, orientation: M.gpxOrientation },
    wind: {
      openTerrain: { speedMs: +omVec.speedMs.toFixed(2), fromDeg: +omVec.fromDeg.toFixed(0) },
      stationsVector: stVec ? { speedMs: +stVec.speedMs.toFixed(2), fromDeg: +stVec.fromDeg.toFixed(0) } : null,
      stationsScalarMs: stScalar ? +stScalar.toFixed(2) : null,
      stationCount: low.length,
      directionAgreeDeg: stVec ? +angDiff(stVec.fromDeg, omVec.fromDeg).toFixed(0) : null,
      shelterRatio: stScalar ? +(omVec.speedMs / stScalar).toFixed(2) : null,
      fieldSpeedRangeMs: [+Math.min(...field.map((f) => f.speedMs)).toFixed(2),
                          +Math.max(...field.map((f) => f.speedMs)).toFixed(2)],
      // 陣風：報告值是尖峰，σ ≈ (尖峰 − 平均)/3（風工程的尖峰因子）
      gustMs: +(om.points.reduce((a, p) => a + (p.current.gustMs ?? 0), 0) / om.points.length).toFixed(2),
      gustSigmaMs: +(field.reduce((a, f) => a + (f.gustSigmaMs ?? 0), 0) / field.length).toFixed(2),
      gustFactor: +((om.points.reduce((a, p) => a + (p.current.gustMs ?? 0), 0) / om.points.length) /
                    Math.max(0.1, omVec.speedMs)).toFixed(2),
      // 氣象署分級（已換算到其 10 分鐘基準，見 wind-field.mjs）
      gustClass: cwaGustClass(field.reduce((a, f) => a + (f.gustSigmaMs ?? 0), 0) / field.length),
      obsTime: obs.stations[0]?.obsTime ?? null,
      modelTime: om.points[0]?.current?.time ?? null,
      // 風場的實際來源：沿路線等距取 SAMPLE_N 個點查 Open-Meteo，
      // 再以 IDW(power=2) 內插到每個路段。模式格點約 8 km，所以多個取樣點
      // 常落在同一格 —— gridCells 就是實際的獨立風場分區數。
      sampleCount: om.points.length,
      gridCells: new Set(om.points.map((p) => p.gridLat + ',' + p.gridLon)).size,
      samples: om.points.map((p) => ({
        name: p.name, lat: p.reqLat, lon: p.reqLon,
        gridLat: p.gridLat, gridLon: p.gridLon, gridElevM: p.gridElevM,
        windMs: p.current.windMs, fromDeg: p.current.windFromDeg, gustMs: p.current.gustMs,
      })),
      // 風場分析的實際做法與成績（每次請求重新決定）
      analysis: {
        method: wf.method,
        reason: wf.reason ?? null,
        stationsUsed: wf.stationCount ?? 0,
        eFoldKm: wf.eFoldKm ?? null,
        kappaKm2: wf.kappaKm2 ?? null,
        gamma: wf.gamma ?? null,
        passes: wf.passes ?? null,
        minSpeedMs: wf.minSpeedMs ?? null,
        meanDirShiftDeg: wf.meanDirShiftDeg ?? 0,
        maxDirShiftDeg: wf.maxDirShiftDeg ?? 0,
        crossValidation: wf.crossValidation ?? null,
        segmentCount: segs.length,
        segmentLenM: M.segmentLenM,
        note: '方向：測站 Barnes 客觀分析（背景場＝模式）；風速：模式開闊地值。' +
              'u/v 分量各自處理，絕不內插角度。',
      },
    },
    direction: {
      // 定功率下總能量 = P x T，所以「時間」就是最自然的比較量綱
      recommend: Math.abs(analysis.deltaSec) < 15 ? null : analysis.recommend,
      deltaSec: analysis.deltaSec,
      deltaKJ: analysis.deltaKJ,
      deltaPct: analysis.deltaPct,
      targetPowerW: analysis.targetPowerW,
      calmDeltaSec: st.calmGradeSec,                                   // 與天氣無關的常數項
      windDeltaSec: +(analysis.deltaSec - st.calmGradeSec).toFixed(1), // 純風造成的部分
      noiseFloorSec: st.noiseFloorSec,                                 // 零風平路，應為 0
      uniformWindSec: st.uniformWindSec,
      contributionSec: analysis.contributionSec,
      // 陣風讓兩個方向都變慢，但逆風段慢得更多：定功率下逆風速度低、
      // 在陣風裡待得久，而 1/v 又是凸函數。實測同樣 σ=2 m/s，
      // 逆風 +4 的時間損失是順風 −4 的 2.68 倍（+3.0 s/km vs +1.1 s/km）。
      gustPenaltySec: {
        CW: analysis.directions.CW.gustPenaltyS,
        CCW: analysis.directions.CCW.gustPenaltyS,
      },
      exposureDisplacement: D,
      byDirection: Object.fromEntries(Object.entries(analysis.directions).map(([k, v]) => [k, {
        timeMin: v.timeMin, timeS: v.timeS, avgSpeedKmh: v.avgSpeedKmh,
        energyKJ: v.energyKJ, aeroWorkKJ: v.aeroWorkKJ,
        brakingCapKm: v.brakingCapKm, byExposure: v.byExposure,
      }])),
    },
    rain: {
      stationCount: rs.length,
      rainingNow: rs.filter((s) => (s.hr1 ?? 0) > 0).length,
      rainedPast6hr: rs.filter((s) => (s.hr6 ?? 0) > 0).length,
      wettest: rs.filter((s) => (s.hr1 ?? 0) > 0).sort((a, b) => b.hr1 - a.hr1).slice(0, 12)
        .map((s) => ({ name: s.name, lat: s.lat, lon: s.lon, hr1: s.hr1, hr3: s.hr3, hr6: s.hr6, hr24: s.hr24,
                       area: (s.county || '') + (s.town || '') })),
    },
    uv: {
      ...uvNow,
      isDay: om.points[0]?.current?.isDay ?? null,
      cwaTaipeiDailyMax: uv.stations?.find((s) => s.id === '466920')?.uvIndex ?? null,
      cwaNote: uv.note ?? null,
      rideHours: +rideH.toFixed(2),
    },
    radar,
    nowcast: nowcast.available ? { ...nowcast, _perSeg: undefined } : nowcast,
    outlook: outlookHours,
    surface: {
      wetKm: +wetKm.toFixed(1), dampKm: +dampKm.toFixed(1),
      dryKm: +(surfLevels.dry).toFixed(1),
      maxFilmMm: +maxFilm.toFixed(3),
      stationCount: wetStations.length,
      rainingStations: wetStations.filter((w) => w.rainingNow).length,
      wettest: wetStations.filter((w) => w.filmMm > 0.005)
        .sort((a, b) => b.filmMm - a.filmMm).slice(0, 12)
        .map((w) => ({ name: w.name, lat: w.lat, lon: w.lon, area: w.area,
                       filmMm: w.filmMm, level: w.level, rainingNow: w.rainingNow,
                       hr1: w.hr1, hr6: w.hr6, hr24: w.hr24,
                       dryInHours: w.dryInHours, dryNote: w.dryNote, evapMmPerH: w.evapMmPerH,
                       rainSource: w.rainSource, exactHours: w.exactHours })),
      evapNowMmPerH: wetStations.length ? wetStations[0].evapMmPerH : null,
      thresholds: { wetFilmMm: SURFACE_DEFAULTS.wetFilmMm, dampFilmMm: SURFACE_DEFAULTS.dampFilmMm },
      // 來源分工（依騎乘者指定）
      sources: {
        now: radar?.available ? 'radar' : 'stations',
        past: 'stations',
        pastHourlyExact: rainHist.byHour.size,
        pastHourlyPending: rainHist.missingHours,
        pastHourlyWindow: RAIN_HISTORY_HOURS,
        drying: 'open-meteo-hourly',
        nowCoveredSegments: radar?.applied?.coveredSegments ?? 0,
        nowRainingSegments: radar?.applied?.rainingSegments ?? 0,
        filmUpgradedByRadar: radar?.applied?.upgradedSegments ?? 0,
      },
      note: '【現在】以雷達回波為準（1.3 km 網格），雨量站為輔（雷達範圍外時退回測站）。' +
            '【過去/地濕】以雨量站為主 —— 雷達數值網格只有最新一張、無歷史，' +
            '而雨量站有 1/3/6/12/24 小時累積且測的是地面實況。' +
            '【乾燥】Open-Meteo 逐時日射/風/濕度，以 Penman 公式逐時積分。' +
            '近 ' + RAIN_HISTORY_HOURS + ' 小時改用雨量站歷史快照的實測逐時值' +
            '（每個整點快照的 hr1 即該小時實際雨量），取代由累積桶均分推得的粗略值；' +
            '更久以前仍用桶推，因為那麼久之前的雨對現在的路面幾乎沒有影響。',
    },
    params,
    sources: {
      cwaObs: { cache: obs._cache, ageSec: obs._ageSec, error: obs.error ?? obs._error ?? null },
      cwaRain: { cache: rain._cache, ageSec: rain._ageSec, error: rain.error ?? rain._error ?? null },
      cwaUv: { cache: uv._cache, ageSec: uv._ageSec, error: uv.error ?? uv._error ?? null },
      openMeteo: { cache: om._cache, ageSec: om._ageSec, error: om._error ?? null },
    },
  };

  if (full) {
    // 2630 段對瀏覽器繪圖太多，給前端一個建議的抽樣步長（計算仍用全解析度）
    out.displayStride = Math.max(1, Math.round(segs.length / 700));
    out.segments = segs.map((s, i) => ({
      i, km: +(s.s0 / 1000).toFixed(2), exposure: s.exposure,
      openWindMs: +field[i].speedMs.toFixed(2), openWindFromDeg: +field[i].fromDeg.toFixed(0),
      cw: analysis.directions.CW.perSeg[i], ccw: analysis.directions.CCW.perSeg[i],
      cwCalmS: calm.directions.CW.perSeg[i].timeS,
      ccwCalmS: calm.directions.CCW.perSeg[i].timeS,
      surf: surf[i],
      fc: nowcast.available ? nowcast._perSeg[i] : null,
    }));
    out.stations = low.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon,
      altM: s.altM, windMs: s.windMs, windFromDeg: s.windFromDeg, tempC: s.tempC }));
  }
  return out;
}
