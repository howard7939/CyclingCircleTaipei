/**
 * 外部資料來源：中央氣象署開放資料 + Open-Meteo。
 *
 * 兩者分工（依實測調查決定，見 docs/wind-model.md）：
 *   CWA 測站    風「向」可靠（0-10 km 內向量/純量一致性 0.95），
 *               風「速」受設站遮蔽汙染（相距 1 km 的兩站 RMS 差already
 *               達平均風速的 65%），不可直接內插成風場。
 *   Open-Meteo  提供開闊地 10 m 風，無設站雜訊；格點約 8 km，
 *               解析不出河谷槽化。另提供逐時 UV（CWA 只有每日最大值）。
 *
 * 授權碼只存在於本行程的 process.env，絕不出現在回應中。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, 'data/cache');

const CWA_BASE = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/';
const OM_BASE = 'https://api.open-meteo.com/v1/forecast';

export const TTL = {
  cwaObs: 8 * 60e3,   // 整點觀測，8 分鐘
  cwaRain: 8 * 60e3,
  cwaUv: 30 * 60e3,
  openMeteo: 15 * 60e3,
};

const mem = new Map();

/** 缺測：CWA 以 "-99" / "-990" 等負值表示 */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > -90 ? n : null;
}

async function readCache(key) {
  const m = mem.get(key);
  if (m && Date.now() - m.at < m.ttl) return m;
  try {
    const raw = JSON.parse(await readFile(join(CACHE_DIR, key + '.json'), 'utf8'));
    if (Date.now() - raw.at < raw.ttl) { mem.set(key, raw); return raw; }
    return { ...raw, stale: true };
  } catch { return null; }
}

async function writeCache(key, entry) {
  mem.set(key, entry);
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(join(CACHE_DIR, key + '.json'), JSON.stringify(entry));
  } catch (e) { console.warn('[cache] 寫入失敗 ' + key + ': ' + e.message); }
}

/** 帶重試的 fetch。CWA 偶發 ECONNRESET，實測重試即可。 */
async function fetchRetry(url, { tries = 4, timeout = 90000, label = '' } = {}) {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      const txt = await r.text();
      if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + txt.slice(0, 200));
      return { json: JSON.parse(txt), ms: Date.now() - t0, bytes: txt.length, attempts: i };
    } catch (e) {
      last = e;
      if (i < tries) await new Promise((r) => setTimeout(r, 1200 * i));
    }
  }
  throw new Error((label || 'fetch') + ' 連續 ' + tries + ' 次失敗：' + (last?.cause?.code || last?.message));
}

/**
 * 取得快取或重新抓取。抓取失敗時若有過期快取，回傳過期資料並標示 stale —
 * 外部服務暫時掛掉不應該讓整個頁面空白，但必須讓使用者看到資料是舊的。
 */
async function cached(key, ttl, loader) {
  const hit = await readCache(key);
  if (hit && !hit.stale) return { ...hit.data, _cache: 'hit', _ageSec: Math.round((Date.now() - hit.at) / 1000) };
  try {
    const data = await loader();
    await writeCache(key, { at: Date.now(), ttl, data });
    return { ...data, _cache: 'miss', _ageSec: 0 };
  } catch (e) {
    if (hit) {
      return { ...hit.data, _cache: 'stale', _ageSec: Math.round((Date.now() - hit.at) / 1000), _error: e.message };
    }
    throw e;
  }
}

function wgs84(geo) {
  const c = geo?.Coordinates?.find((x) => x.CoordinateName === 'WGS84');
  if (!c) return null;
  const la = Number(c.StationLatitude), lo = Number(c.StationLongitude);
  return Number.isFinite(la) && Number.isFinite(lo) ? { lat: la, lon: lo } : null;
}

const inBox = (p, b) => p.lat >= b.minLat && p.lat <= b.maxLat && p.lon >= b.minLon && p.lon <= b.maxLon;

/** O-A0001-001 氣象觀測站逐時：風向/風速/陣風/溫濕壓/現在雨量 */
export async function cwaStations(bbox) {
  const key = 'cwa-O-A0001-001';
  return cached(key, TTL.cwaObs, async () => {
    const k = process.env.CWA_API_KEY;
    if (!k) throw new Error('CWA_API_KEY 未設定');
    const { json, ms, bytes } = await fetchRetry(
      CWA_BASE + 'O-A0001-001?Authorization=' + encodeURIComponent(k) + '&format=JSON',
      { label: 'CWA O-A0001-001' });
    const all = json?.records?.Station;
    if (!Array.isArray(all) || all.length < 100) {
      throw new Error('CWA O-A0001-001 回應異常：Station 只有 ' + (all?.length ?? 0) + ' 筆');
    }
    const out = [];
    for (const s of all) {
      const p = wgs84(s.GeoInfo);
      if (!p || !inBox(p, bbox)) continue;
      const w = s.WeatherElement || {};
      out.push({
        id: s.StationId, name: s.StationName,
        lat: p.lat, lon: p.lon,
        altM: num(s.GeoInfo?.StationAltitude),
        county: s.GeoInfo?.CountyName ?? null, town: s.GeoInfo?.TownName ?? null,
        obsTime: s.ObsTime?.DateTime ?? null,
        windMs: num(w.WindSpeed),
        windFromDeg: num(w.WindDirection),
        gustMs: num(w.GustInfo?.PeakGustSpeed),
        tempC: num(w.AirTemperature),
        rh: num(w.RelativeHumidity),
        weather: w.Weather ?? null,
        precipNow: num(w.Now?.Precipitation),
      });
    }
    return { fetchedAt: new Date().toISOString(), totalStations: all.length,
             stations: out, _ms: ms, _kb: Math.round(bytes / 1024) };
  });
}

/** O-A0002-001 雨量站：Now / 10min / 1,3,6,12,24hr / 2,3days */
export async function cwaRain(bbox) {
  const key = 'cwa-O-A0002-001';
  return cached(key, TTL.cwaRain, async () => {
    const k = process.env.CWA_API_KEY;
    if (!k) throw new Error('CWA_API_KEY 未設定');
    const { json, ms, bytes } = await fetchRetry(
      CWA_BASE + 'O-A0002-001?Authorization=' + encodeURIComponent(k) + '&format=JSON',
      { label: 'CWA O-A0002-001' });
    const all = json?.records?.Station;
    if (!Array.isArray(all) || all.length < 100) {
      throw new Error('CWA O-A0002-001 回應異常：Station 只有 ' + (all?.length ?? 0) + ' 筆');
    }
    const out = [];
    for (const s of all) {
      const p = wgs84(s.GeoInfo);
      if (!p || !inBox(p, bbox)) continue;
      const r = s.RainfallElement || {};
      // 注意大小寫不一致：Past10Min / Past1hr / Past3hr / Past6Hr / Past12hr / Past24hr
      out.push({
        id: s.StationId, name: s.StationName,
        lat: p.lat, lon: p.lon, altM: num(s.GeoInfo?.StationAltitude),
        county: s.GeoInfo?.CountyName ?? null, town: s.GeoInfo?.TownName ?? null,
        obsTime: s.ObsTime?.DateTime ?? null,
        now: num(r.Now?.Precipitation),
        min10: num(r.Past10Min?.Precipitation),
        hr1: num(r.Past1hr?.Precipitation),
        hr3: num(r.Past3hr?.Precipitation),
        hr6: num(r.Past6Hr?.Precipitation),
        hr12: num(r.Past12hr?.Precipitation),
        hr24: num(r.Past24hr?.Precipitation),
      });
    }
    return { fetchedAt: new Date().toISOString(), totalStations: all.length,
             stations: out, _ms: ms, _kb: Math.round(bytes / 1024) };
  });
}

/**
 * O-A0005-001 紫外線指數。
 * 注意：這是「每日最大值」而非即時值，且回應只有 {StationID, UVIndex}，
 * 沒有站名與座標。因此僅作為日尺度參考，即時 UV 改用 Open-Meteo 逐時值。
 */
export const UV_STATION_NAMES = {
  '466910': '鞍部', '466920': '臺北', '466930': '竹子湖', '466940': '基隆',
  '466880': '板橋', '466900': '淡水', '467410': '臺南', '467420': '永康',
  '467480': '嘉義', '467490': '臺中', '467530': '阿里山', '467540': '大武',
  '467550': '玉山', '467571': '新竹', '467590': '恆春', '467610': '成功',
  '467620': '蘭嶼', '467650': '日月潭', '467660': '臺東', '467770': '梧棲',
  '467780': '墾丁', '466990': '花蓮', '467050': '新屋', '467110': '金門',
  '467990': '馬祖', '466950': '宜蘭', '467350': '澎湖', '467080': '宜蘭',
};
export async function cwaUv() {
  return cached('cwa-O-A0005-001', TTL.cwaUv, async () => {
    const k = process.env.CWA_API_KEY;
    if (!k) throw new Error('CWA_API_KEY 未設定');
    const { json, ms } = await fetchRetry(
      CWA_BASE + 'O-A0005-001?Authorization=' + encodeURIComponent(k) + '&format=JSON',
      { label: 'CWA O-A0005-001' });
    const rows = json?.records?.weatherElement?.location || json?.records?.location || [];
    return {
      fetchedAt: new Date().toISOString(),
      note: '每日紫外線指數最大值（非即時）',
      stations: rows.map((r) => ({
        id: r.StationID ?? r.stationID ?? null,
        name: UV_STATION_NAMES[r.StationID] ?? null,
        uvIndex: num(r.UVIndex ?? r.uvIndex),
      })),
      _ms: ms,
    };
  });
}

/**
 * Open-Meteo 多點查詢。一次呼叫取回所有取樣點的現況與逐時預報。
 * 風速單位指定 m/s，與 CWA 一致，避免單位換算錯誤。
 */
export async function openMeteo(points, { hours = 24 } = {}) {
  const key = 'om-' + points.map((p) => p.lat.toFixed(3) + ',' + p.lon.toFixed(3)).join(';');
  const short = 'om-' + Buffer.from(key).toString('base64url').slice(0, 40);
  return cached(short, TTL.openMeteo, async () => {
    const qs = new URLSearchParams({
      latitude: points.map((p) => p.lat.toFixed(4)).join(','),
      longitude: points.map((p) => p.lon.toFixed(4)).join(','),
      current: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,temperature_2m,' +
               'relative_humidity_2m,uv_index,is_day,shortwave_radiation',
      // 過去 24 小時的逐時資料是路面乾燥模型的輸入：要把蒸發量積分回來，
      // 就需要當時的日射、風、濕度、氣溫，而不是只有現在的值。
      hourly: 'wind_speed_10m,wind_direction_10m,precipitation,precipitation_probability,' +
              'uv_index,uv_index_clear_sky,temperature_2m,relative_humidity_2m,shortwave_radiation,is_day',
      wind_speed_unit: 'ms',
      timezone: 'Asia/Taipei',
      past_days: '1',
      forecast_days: '2',
    });
    const { json, ms, bytes } = await fetchRetry(OM_BASE + '?' + qs, { label: 'Open-Meteo', timeout: 60000 });
    const arr = Array.isArray(json) ? json : [json];
    if (arr.length !== points.length) {
      throw new Error('Open-Meteo 回傳 ' + arr.length + ' 個地點，預期 ' + points.length);
    }
    return {
      fetchedAt: new Date().toISOString(),
      hours,
      points: arr.map((o, i) => ({
        name: points[i].name ?? null,
        reqLat: points[i].lat, reqLon: points[i].lon,
        gridLat: o.latitude, gridLon: o.longitude, gridElevM: o.elevation,
        current: {
          time: o.current?.time ?? null,
          windMs: o.current?.wind_speed_10m ?? null,
          windFromDeg: o.current?.wind_direction_10m ?? null,
          gustMs: o.current?.wind_gusts_10m ?? null,
          precipMm: o.current?.precipitation ?? null,
          tempC: o.current?.temperature_2m ?? null,
          rh: o.current?.relative_humidity_2m ?? null,
          uvIndex: o.current?.uv_index ?? null,
          swRadWm2: o.current?.shortwave_radiation ?? null,
          isDay: o.current?.is_day === 1,
        },
        hourly: (o.hourly?.time || []).map((t, k) => ({
          time: t,
          windMs: o.hourly.wind_speed_10m?.[k] ?? null,
          windFromDeg: o.hourly.wind_direction_10m?.[k] ?? null,
          precipMm: o.hourly.precipitation?.[k] ?? null,
          precipProb: o.hourly.precipitation_probability?.[k] ?? null,
          uvIndex: o.hourly.uv_index?.[k] ?? null,
          uvClear: o.hourly.uv_index_clear_sky?.[k] ?? null,
          tempC: o.hourly.temperature_2m?.[k] ?? null,
          rh: o.hourly.relative_humidity_2m?.[k] ?? null,
          swRadWm2: o.hourly.shortwave_radiation?.[k] ?? null,
          isDay: o.hourly.is_day?.[k] === 1,
        })),
      })),
      _ms: ms, _kb: Math.round(bytes / 1024),
    };
  });
}
