#!/usr/bin/env node
/**
 * 本機開發伺服器。零外部依賴。
 *
 *   web/   -> 靜態前端
 *   data/  -> 前處理產出的 JSON
 *   /api/  -> 氣象資料代理（之後實作；授權碼只存在於此行程的 process.env）
 *
 * 執行：npm run dev:server
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cwaStations, cwaRain, cwaUv, openMeteo } from './sources.mjs';
import {
  airDensity, openWindField, analyzeDirections, selfTest,
  toUV, toSpeedDir, loadParams, exposureDisplacement, solveSpeedMs, USER_TUNABLE,
} from './wind-model.mjs';
import { buildWindField } from './wind-field.mjs';
import { stationWetness, surfaceAlongRoute, applyRadarNow, uvAnalysis, SURFACE_DEFAULTS } from './surface.mjs';
import { fetchRadar, radarAlongRoute, echoCells, dbzToRainMmPerH, RADAR } from './radar.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const DATA = join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 5174;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.gpx': 'application/gpx+xml',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** 把 URL 路徑解析到 base 底下，拒絕任何跳出 base 的路徑 */
function safeJoin(base, urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const abs = resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs;
}

async function serveFile(res, absPath) {
  try {
    const st = await stat(absPath);
    if (st.isDirectory()) return serveFile(res, join(absPath, 'index.html'));
    const body = await readFile(absPath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(absPath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw e;
  }
}

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
async function getConditions({ full = false, overrides = null } = {}) {
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
    fetchRadar(M.bbox).catch((e) => ({ error: e.message })),
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
  const wetStations = rainSt.map((st) => stationWetness(st, hourly, nowIso));
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

  const surfLevels = { wet: 0, damp: 0, dry: 0 };
  let maxFilm = 0, wetKm = 0, dampKm = 0;
  surf.forEach((x, i) => {
    surfLevels[x.level] += segs[i].len / 1000;
    if (x.filmMm > maxFilm) maxFilm = x.filmMm;
    if (x.level === 'wet') wetKm += segs[i].len / 1000;
    if (x.level === 'damp') dampKm += segs[i].len / 1000;
  });

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
                       dryInHours: w.dryInHours, dryNote: w.dryNote, evapMmPerH: w.evapMmPerH })),
      evapNowMmPerH: wetStations.length ? wetStations[0].evapMmPerH : null,
      thresholds: { wetFilmMm: SURFACE_DEFAULTS.wetFilmMm, dampFilmMm: SURFACE_DEFAULTS.dampFilmMm },
      // 來源分工（依騎乘者指定）
      sources: {
        now: radar?.available ? 'radar' : 'stations',
        past: 'stations',
        drying: 'open-meteo-hourly',
        nowCoveredSegments: radar?.applied?.coveredSegments ?? 0,
        nowRainingSegments: radar?.applied?.rainingSegments ?? 0,
        filmUpgradedByRadar: radar?.applied?.upgradedSegments ?? 0,
      },
      note: '【現在】以雷達回波為準（1.3 km 網格），雨量站為輔（雷達範圍外時退回測站）。' +
            '【過去/地濕】以雨量站為主 —— 雷達數值網格只有最新一張、無歷史，' +
            '而雨量站有 1/3/6/12/24 小時累積且測的是地面實況。' +
            '【乾燥】Open-Meteo 逐時日射/風/濕度，以 Penman 公式逐時積分。',
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
    }));
    out.stations = low.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon,
      altM: s.altM, windMs: s.windMs, windFromDeg: s.windFromDeg, tempC: s.tempC }));
  }
  return out;
}

const server = createServer(async (req, res) => {
  const t0 = Date.now();
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(res, 400, { error: 'bad url' });
  }
  const p = url.pathname;

  try {
    if (p === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        cwaKeyPresent: Boolean(process.env.CWA_API_KEY),
        uptimeSec: Math.round(process.uptime()),
      });
    }

    if (p === '/api/conditions') {
      const full = url.searchParams.get('full') === '1';
      // 網站使用者可調整的參數（體重、功率等）以查詢字串傳入，由模型層驗證範圍
      const overrides = {};
      for (const k of Object.keys(USER_TUNABLE)) {
        if (url.searchParams.has(k)) overrides[k] = url.searchParams.get(k);
      }
      for (const cls of ['riverside', 'urban', 'mountain']) {
        const v = url.searchParams.get('k_' + cls);
        if (v !== null) (overrides.exposureK ||= {})[cls] = v;
      }
      try {
        return sendJson(res, 200, await getConditions({ full, overrides }));
      } catch (e) {
        if (/必須/.test(e.message)) return sendJson(res, 400, { error: e.message });
        throw e;
      }
    }

    if (p === '/api/params') {
      return sendJson(res, 200, { tunable: USER_TUNABLE, current: loadParams({ quiet: true }) });
    }

    if (p.startsWith('/api/')) {
      return sendJson(res, 501, { error: 'not implemented yet', path: p });
    }

    if (p.startsWith('/data/')) {
      const abs = safeJoin(DATA, p.slice('/data'.length));
      if (!abs) return sendJson(res, 403, { error: 'forbidden' });
      if (await serveFile(res, abs)) return;
      return sendJson(res, 404, {
        error: 'not found',
        path: p,
        hint: '先執行 npm run preprocess 與 node scripts/fetch-osm-water.mjs',
      });
    }

    const abs = safeJoin(WEB, p === '/' ? '/index.html' : p);
    if (!abs) return sendJson(res, 403, { error: 'forbidden' });
    if (await serveFile(res, abs)) return;
    return sendJson(res, 404, { error: 'not found', path: p });
  } catch (e) {
    console.error('[500] ' + p + ' -> ' + e.stack);
    return sendJson(res, 500, { error: e.message });
  } finally {
    if (!p.startsWith('/api/') || p === '/api/health') {
      console.log('  ' + String(res.statusCode).padEnd(4) + p + '  ' + (Date.now() - t0) + 'ms');
    }
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('\n[FATAL] port ' + PORT + ' 已被佔用。改用其他 port：PORT=5175 npm run dev:server\n');
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log('');
  console.log('環騎臺北  開發伺服器');
  console.log('  http://localhost:' + PORT);
  console.log('');
  console.log('  web   ' + WEB);
  console.log('  data  ' + DATA);
  console.log('  CWA 授權碼  ' + (process.env.CWA_API_KEY ? '已載入（長度 ' + process.env.CWA_API_KEY.length + '）' : '未設定 — /api 將無法取得氣象資料'));
  console.log('');
});
