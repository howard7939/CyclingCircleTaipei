/**
 * 降水雷達回波（CWA O-A0059-001 雷達合成回波網格）
 *
 * 用數值網格而不是回波圖影像：
 *   O-A0058-00x 是 PNG 影像（3600×3600，約 185 m/px），要建顏色→dBZ 對照表才能用，
 *   配色一改就壞、而且顏色是分級量化的。影像的高像素密度是算繪時的上取樣，
 *   雷達合成的原生解析度就是這份網格的 0.0125°，所以網格才是正確來源。
 *
 * 網格規格（由 API 回應自帶，不寫死）：
 *   左下角 115.0°E / 18.0°N，解析度 0.0125°（約 1.26 km 經向 × 1.39 km 緯向）
 *   921 × 881 = 811,401 格點，先西→東、再南→北
 *   −99  低於最小可偵測回波 ＝ 無降水
 *        （文件寫「無效值」，但 81 萬格點中有 60.7 萬是 −99，且只出現在雷達
 *          涵蓋區內；若真是無效資料這份產品就沒有用。實測台北周邊 −999 為 0，
 *          確認 −99 的語意是「無回波」。）
 *   −999 雷達觀測範圍外，或經品管流程移除
 *
 * 已知限制（實測驗證，見 docs）：
 *   1. 座標系統存疑。文件寫 TWD67（與 WGS84 差約 808 m 東 / 249 m 南），
 *      但用「正在下雨的測站」對位測試，不做修正反而對得較準。樣本太小
 *      （5 站且雨區不在台北）無法定論，故保留 800 m ≈ 0.6 格的不確定度。
 *   2. 雷達會漏掉低層地形雨。實測大屯山、擎天崗回報 0.5 mm/hr 但雷達無回波
 *      —— 波束在遠處已抬升，掃不到山區低層。雷達不能取代雨量站，只能互補。
 *   3. dBZ 不等於地面雨量。Marshall-Palmer 關係本身有 2 倍以上不確定度，
 *      另有雨幡（雨在落地前蒸發）與亮帶污染。
 */
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRAME_DIR = join(ROOT, 'data/cache/radar');
const API = 'https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/O-A0059-001';

export const RADAR = {
  ttlMs: 8 * 60e3,        // 產品每 10 分鐘更新
  subBufferDeg: 0.55,     // 子網格在路線 bbox 外擴的範圍（供臨近預報用）
  keepFrames: 8,          // 保留的歷史影格數（第二階段臨近預報要用）
  noEcho: -99,
  outOfRange: -999,
  echoThresholdDbz: 5,    // 低於此值視為無降水意義
};

/** Marshall-Palmer：Z = 200·R^1.6  ->  R = (Z/200)^(1/1.6)  mm/h */
export function dbzToRainMmPerH(dbz) {
  if (!Number.isFinite(dbz) || dbz <= RADAR.echoThresholdDbz) return 0;
  return Math.pow(Math.pow(10, dbz / 10) / 200, 1 / 1.6);
}

/** 依雨強分級（氣象上的慣用門檻） */
export function rainBand(mmPerH) {
  if (mmPerH <= 0) return 'none';
  if (mmPerH < 0.5) return 'drizzle';
  if (mmPerH < 2.5) return 'light';
  if (mmPerH < 10) return 'moderate';
  if (mmPerH < 50) return 'heavy';
  return 'violent';
}

let memFrame = null;

/**
 * 抓取並解析最新的雷達網格，只保留路線周邊的子網格。
 * 整張 811,401 格點只需要約 7,700 格，其餘丟棄以省記憶體與磁碟。
 */
export async function fetchRadar(bbox, { force = false } = {}) {
  if (!force && memFrame && Date.now() - memFrame.fetchedAtMs < RADAR.ttlMs) {
    return { ...memFrame, cache: 'hit' };
  }
  const key = process.env.CWA_API_KEY;
  if (!key) throw new Error('CWA_API_KEY 未設定');

  const t0 = Date.now();
  const r = await fetch(API + '?Authorization=' + encodeURIComponent(key) + '&downloadType=WEB&format=JSON',
    { signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error('雷達 API HTTP ' + r.status);
  const txt = await r.text();
  const tFetch = Date.now() - t0;

  let j;
  try { j = JSON.parse(txt); }
  catch (e) { throw new Error('雷達回應不是合法 JSON（' + (txt.length / 1024).toFixed(0) + ' KB）：' + e.message); }

  const ps = j?.cwaopendata?.dataset?.datasetInfo?.parameterSet;
  const content = j?.cwaopendata?.dataset?.contents?.content;
  if (!ps || !content) throw new Error('雷達回應缺少 parameterSet 或 content');

  const lon0 = +ps.StartPointLongitude, lat0 = +ps.StartPointLatitude;
  const res = +ps.GridResolution, nx = +ps.GridDimensionX, ny = +ps.GridDimensionY;
  const obsTime = ps.DateTime;
  if (![lon0, lat0, res, nx, ny].every(Number.isFinite)) {
    throw new Error('雷達網格參數異常：' + JSON.stringify({ lon0, lat0, res, nx, ny }));
  }

  const t1 = Date.now();
  const vals = content.split(',');
  if (vals.length !== nx * ny) {
    throw new Error('雷達格點數不符：收到 ' + vals.length + '，預期 ' + (nx * ny));
  }

  // 只截取路線周邊
  const b = RADAR.subBufferDeg;
  const ix0 = Math.max(0, Math.floor((bbox.minLon - b - lon0) / res));
  const ix1 = Math.min(nx - 1, Math.ceil((bbox.maxLon + b - lon0) / res));
  const iy0 = Math.max(0, Math.floor((bbox.minLat - b - lat0) / res));
  const iy1 = Math.min(ny - 1, Math.ceil((bbox.maxLat + b - lat0) / res));
  const sw = ix1 - ix0 + 1, sh = iy1 - iy0 + 1;
  const sub = new Float32Array(sw * sh);
  let nEcho = 0, nNo = 0, nOut = 0, maxDbz = -999;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const v = parseFloat(vals[(iy0 + y) * nx + (ix0 + x)]);
      sub[y * sw + x] = v;
      if (v <= -998) nOut++;
      else if (v <= -98) nNo++;
      else { nEcho++; if (v > maxDbz) maxDbz = v; }
    }
  }
  const tParse = Date.now() - t1;

  const frame = {
    obsTime, fetchedAt: new Date().toISOString(), fetchedAtMs: Date.now(),
    lon0: lon0 + ix0 * res, lat0: lat0 + iy0 * res, res, nx: sw, ny: sh,
    data: Array.from(sub),
    stats: { echoCells: nEcho, noEchoCells: nNo, outOfRangeCells: nOut,
             maxDbz: nEcho ? +maxDbz.toFixed(1) : null },
    timing: { fetchMs: tFetch, parseMs: tParse, payloadKB: Math.round(txt.length / 1024) },
    fullGrid: { lon0, lat0, res, nx, ny },
  };
  memFrame = frame;
  saveFrame(frame).catch((e) => console.warn('[radar] 影格儲存失敗：' + e.message));
  return { ...frame, cache: 'miss' };
}

/** 保留最近數張影格，供第二階段的移動向量估計使用 */
async function saveFrame(frame) {
  await mkdir(FRAME_DIR, { recursive: true });
  const stamp = frame.obsTime.replace(/[:+]/g, '-');
  await writeFile(join(FRAME_DIR, 'frame-' + stamp + '.json'), JSON.stringify(frame));
  const files = (await readdir(FRAME_DIR)).filter((f) => f.startsWith('frame-')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - RADAR.keepFrames))) {
    await unlink(join(FRAME_DIR, f)).catch(() => {});
  }
}

/** 取某座標的 dBZ。回傳 null 代表不在子網格內。 */
export function dbzAt(frame, lat, lon) {
  const ix = Math.round((lon - frame.lon0) / frame.res);
  const iy = Math.round((lat - frame.lat0) / frame.res);
  if (ix < 0 || ix >= frame.nx || iy < 0 || iy >= frame.ny) return null;
  return frame.data[iy * frame.nx + ix];
}

/** 逐路段的雷達回波與換算雨強 */
export function radarAlongRoute(segments, frame) {
  let maxDbz = -999, echoKm = 0, outKm = 0, sumRain = 0, nEcho = 0;
  const per = segments.map((s) => {
    const v = dbzAt(frame, s.lat, s.lon);
    if (v === null || v <= RADAR.outOfRange + 1) {
      outKm += s.len / 1000;
      return { dbz: null, rainMmPerH: 0, band: 'unknown' };
    }
    if (v <= -98) return { dbz: null, rainMmPerH: 0, band: 'none' };   // 無回波
    const R = dbzToRainMmPerH(v);
    if (v > maxDbz) maxDbz = v;
    if (R > 0) { echoKm += s.len / 1000; nEcho++; sumRain += R; }
    return { dbz: +v.toFixed(1), rainMmPerH: +R.toFixed(2), band: rainBand(R) };
  });

  return {
    perSegment: per,
    obsTime: frame.obsTime,
    maxDbz: maxDbz > -999 ? +maxDbz.toFixed(1) : null,
    maxRainMmPerH: +dbzToRainMmPerH(maxDbz).toFixed(2),
    echoKm: +echoKm.toFixed(2),
    outOfRangeKm: +outKm.toFixed(2),
    meanRainOnEcho: nEcho ? +(sumRain / nEcho).toFixed(2) : 0,
    anyRain: echoKm > 0.1,
  };
}

/** 路線周邊有回波的格點（供地圖疊圖） */
export function echoCells(frame, bbox, { pad = 0.25, minDbz = RADAR.echoThresholdDbz } = {}) {
  const out = [];
  for (let y = 0; y < frame.ny; y++) {
    for (let x = 0; x < frame.nx; x++) {
      const v = frame.data[y * frame.nx + x];
      if (!(v > minDbz)) continue;
      const lat = frame.lat0 + y * frame.res, lon = frame.lon0 + x * frame.res;
      if (lat < bbox.minLat - pad || lat > bbox.maxLat + pad) continue;
      if (lon < bbox.minLon - pad || lon > bbox.maxLon + pad) continue;
      out.push({ lat: +lat.toFixed(4), lon: +lon.toFixed(4), dbz: +v.toFixed(1),
                 mmPerH: +dbzToRainMmPerH(v).toFixed(2) });
    }
  }
  return out;
}
