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
  DEFAULT_PARAMS, airDensity, buildSpeedCurve, openWindField, analyzeDirections,
  selfTest, toUV, toSpeedDir, loadParams, exposureDisplacement,
} from './wind-model.mjs';

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
  r._curve = buildSpeedCurve(r.segments);
  ROUTE = r;
  return r;
}

const SAMPLE_N = 12;
const BBOX_BUFFER = 0.18; // 約 18 km。再大會抓進宜蘭/桃園，隔著山脈不具代表性。

/** 目前的騎乘條件：風場、方向建議、降雨、紫外線 */
async function getConditions({ full = false } = {}) {
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

  const [obs, rain, uv, om] = await Promise.all([
    cwaStations(bbox).catch((e) => ({ error: e.message, stations: [] })),
    cwaRain(bbox).catch((e) => ({ error: e.message, stations: [] })),
    cwaUv().catch((e) => ({ error: e.message, stations: [] })),
    openMeteo(samplePts),
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

  const params = { ...loadParams({ quiet: true }), rho: +airDensity(tempC, 1013).toFixed(3) };
  const field = openWindField(segs, om.points);
  const analysis = analyzeDirections(segs, field, M.gpxOrientation, params, route._curve);
  const noise = selfTest(segs, M.gpxOrientation, { windMs: omVec.speedMs, fromDeg: omVec.fromDeg });
  const D = exposureDisplacement(segs, params);
  // 零風基準：與天氣完全無關的方向偏好（上下坡換邊的速度不對稱）
  const calm = analyzeDirections(segs, segs.map(() => ({ u: 0, v: 0, speedMs: 0, fromDeg: 0, gustMs: 0 })),
                                 M.gpxOrientation, params, route._curve);

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
    },
    direction: {
      recommend: Math.abs(analysis.deltaKJ) < Math.abs(noise.deltaKJ) * 3 ? null : analysis.recommend,
      deltaKJ: analysis.deltaKJ,
      deltaPct: analysis.deltaPct,
      deltaSec: analysis.deltaSec,
      estPowerW: analysis.estPowerW,
      noiseFloorKJ: +Math.abs(noise.deltaKJ).toFixed(3),
      snr: +(Math.abs(analysis.deltaKJ) / Math.max(1e-6, Math.abs(noise.deltaKJ))).toFixed(0),
      contributionKJ: analysis.contributionKJ,
      calmDeltaKJ: calm.deltaKJ,
      windDeltaKJ: +(analysis.deltaKJ - calm.deltaKJ).toFixed(1),
      exposureDisplacement: D,
      byDirection: Object.fromEntries(Object.entries(analysis.directions).map(([k, v]) => [k, {
        aeroWorkKJ: v.aeroWorkKJ, timeMin: v.timeMin, byExposure: v.byExposure,
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
      nowRange: [Math.min(...om.points.map((p) => p.current.uvIndex ?? 0)),
                 Math.max(...om.points.map((p) => p.current.uvIndex ?? 0))],
      isDay: om.points[0]?.current?.isDay ?? null,
      cwaTaipeiDailyMax: uv.stations?.find((s) => s.id === '466920')?.uvIndex ?? null,
      cwaNote: uv.note ?? null,
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
    out.segments = segs.map((s, i) => ({
      i, km: +(s.s0 / 1000).toFixed(2), exposure: s.exposure,
      openWindMs: +field[i].speedMs.toFixed(2), openWindFromDeg: +field[i].fromDeg.toFixed(0),
      cw: analysis.directions.CW.perSeg[i], ccw: analysis.directions.CCW.perSeg[i],
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
      return sendJson(res, 200, await getConditions({ full }));
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
