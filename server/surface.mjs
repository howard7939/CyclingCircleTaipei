/**
 * 路面濕度與紫外線分析
 *
 * ── 路面濕度 ──────────────────────────────────────────────────────────
 * 不用「上次下雨後幾小時」這種經驗衰減，改用水膜的質量平衡：
 *
 *     film(t+1h) = min(maxFilm, film(t) + rain_h) − E_h
 *
 * 蒸發率 E 以 Penman 開水面蒸發公式計算（組合法，輻射項 + 空氣動力項）：
 *
 *     E = [ Δ·Rn + γ·(6.43/24)·(1 + 0.536·u₂)·VPD ] / [ λ·(Δ + γ) ]   mm/h
 *
 *     Δ   = 4098·es/(T+237.3)²        飽和水氣壓曲線斜率 kPa/°C
 *     γ   = 0.000665·P ≈ 0.0665       乾濕計常數 kPa/°C
 *     λ   = 2.45 MJ/kg                汽化潛熱
 *     VPD = es·(1 − RH/100)           水氣壓差 kPa
 *     Rn  = (1−α)·Rsw − Lnet          淨輻射；濕柏油 α≈0.08
 *
 * 文獻指出蒸發的驅動強弱依序為「日射 > 氣溫 > 水氣壓差 > 風速」，
 * 這個公式的項次權重與之一致（輻射項通常主導白天，空氣動力項主導夜間）。
 *
 * 資料來源分工（依騎乘者指定）：
 *   【現在下不下雨】   以雷達回波為準（1.3 km 網格），氣象測站為輔
 *                      雷達的空間解析度遠勝站距 5-10 km 的雨量站；雨量站會把
 *                      一個點的雨「抹」到周圍 10 km，判斷「我現在這裡有沒有雨」
 *                      並不可靠。雷達無涵蓋或取得失敗時才退回測站。
 *   【過去（地濕）】   以氣象測站為主
 *                      雷達的數值網格只有最新一張、無歷史（實測時戳版本 404），
 *                      而雨量站有 1/3/6/12/24 小時的累積桶，正是地濕要的量。
 *                      且雨量站測的是地面實際累積，雷達測的是空中回波。
 *   【乾燥條件】       Open-Meteo 逐時日射/風/濕度/氣溫（測站沒有這些）
 *
 * 夜間 Rn 為負（長波淨輻射散失），公式會給出負的 E，也就是結露。這是真的：
 * 清晨的路面可能在沒下雨的情況下仍然是濕的，模型保留這個行為。
 *
 * ── 紫外線 ────────────────────────────────────────────────────────────
 * UV 指數定義為「紅斑加權輻照度 / 0.025 W·m⁻²」，所以
 *     紅斑輻照度 = UVI × 0.025 W/m²
 *     劑量 = Σ UVI × 0.025 × 3600  J/m²
 * 1 MED（最小紅斑劑量）隨膚質而異，第 III 型約 350 J/m²。
 */

const LAMBDA = 2.45;        // MJ/kg 汽化潛熱
const GAMMA = 0.0665;       // kPa/°C 乾濕計常數（海平面）
const ALBEDO_WET = 0.08;    // 濕柏油反照率
const LNET_DAY = 60;        // W/m² 白天淨長波散失（概略）
const LNET_NIGHT = 55;      // W/m² 夜間淨長波散失

export const SURFACE_DEFAULTS = {
  maxFilmMm: 0.6,       // 水膜厚度上限（大雨時的平衡值）
  // 下雨時水膜不是把雨量全部累加，而是達到由降雨強度與排水決定的平衡厚度，
  // 其餘直接逕流。以 film_eq = c·√(雨強) 擬合：
  //   0.5 mm/h -> 0.15 mm（小雨，路面濕但不積水）
  //   10  mm/h -> 0.67 mm（大雨，明顯水膜）
  filmPerSqrtRain: 0.212,
  wetFilmMm: 0.15,      // 高於此值＝明顯濕、會噴水
  dampFilmMm: 0.05,     // 高於此值＝路面潮濕變深色（露水膜約此量級）
  maxDewMmPerH: 0.02,   // 結露速率上限
  // 露水膜很薄，不會像降雨那樣堆積；且風大時紊流混合會抑制結露。
  dewMaxFilmMm: 0.10,
  dewWindCalmMs: 1.5,   // 低於此風速結露不受抑制
  dewWindStopMs: 4.0,   // 高於此風速結露完全被抑制
  stationRadiusKm: 12,  // 路段取用雨量站的半徑
  idwPower: 2,
  medJm2: 350,          // 第 III 型膚質的 1 MED
};

const D2R = Math.PI / 180, R_EARTH = 6371008.8;
function haversineKm(aLat, aLon, bLat, bLon) {
  const la1 = aLat * D2R, la2 = bLat * D2R;
  const h = Math.sin((la2 - la1) / 2) ** 2 +
            Math.cos(la1) * Math.cos(la2) * Math.sin((bLon - aLon) * D2R / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(Math.min(1, h))) / 1000;
}

/** 飽和水氣壓 kPa（Tetens） */
function esKpa(tC) { return 0.6108 * Math.exp(17.27 * tC / (tC + 237.3)); }

/**
 * Penman 開水面蒸發（mm/h）。回傳值可為負＝結露。
 * @param swRadWm2 入射短波輻射
 * @param tempC 氣溫
 * @param rh 相對濕度 %
 * @param windMs 10 m 風速
 */
export function evaporationMmPerH(swRadWm2, tempC, rh, windMs, isDay) {
  const T = Number.isFinite(tempC) ? tempC : 22;
  const RH = Number.isFinite(rh) ? Math.min(100, Math.max(1, rh)) : 75;
  const u10 = Number.isFinite(windMs) ? Math.max(0, windMs) : 2;
  const u2 = u10 * 0.75;                       // 粗略的 10 m -> 2 m 換算
  const Rsw = Number.isFinite(swRadWm2) ? Math.max(0, swRadWm2) : 0;

  const es = esKpa(T);
  const vpd = es * (1 - RH / 100);
  const delta = 4098 * es / Math.pow(T + 237.3, 2);

  const lnet = (isDay ?? Rsw > 5) ? LNET_DAY : LNET_NIGHT;
  const RnWm2 = (1 - ALBEDO_WET) * Rsw - lnet;
  const RnMJperH = RnWm2 * 3600 / 1e6;

  const radTerm = delta * RnMJperH;
  const aeroTerm = GAMMA * (6.43 / 24) * (1 + 0.536 * u2) * vpd;
  return (radTerm + aeroTerm) / (LAMBDA * (delta + GAMMA));
}

/**
 * 把 CWA 雨量站的累積桶（1/3/6/12/24 小時）還原成逐時雨量。
 * 解析度只有 1~12 小時，均分到各小時 —— 這是資料本身的限制，不是近似選擇。
 */
export function hourlyRainFromBuckets(st) {
  const g = (v) => (Number.isFinite(v) ? Math.max(0, v) : 0);
  const h1 = g(st.hr1), h3 = g(st.hr3), h6 = g(st.hr6), h12 = g(st.hr12), h24 = g(st.hr24);
  const segs = [
    { hoursAgoFrom: 0, hoursAgoTo: 1, total: h1 },
    { hoursAgoFrom: 1, hoursAgoTo: 3, total: Math.max(0, h3 - h1) },
    { hoursAgoFrom: 3, hoursAgoTo: 6, total: Math.max(0, h6 - h3) },
    { hoursAgoFrom: 6, hoursAgoTo: 12, total: Math.max(0, h12 - h6) },
    { hoursAgoFrom: 12, hoursAgoTo: 24, total: Math.max(0, h24 - h12) },
  ];
  const perHour = new Array(24).fill(0);        // index 0 = 最近 1 小時
  for (const s of segs) {
    const n = s.hoursAgoTo - s.hoursAgoFrom;
    for (let k = s.hoursAgoFrom; k < s.hoursAgoTo; k++) perHour[k] = s.total / n;
  }
  return perHour;
}

/**
 * 用歷史快照組出「真實的逐時雨量」。
 *
 * 每個整點快照的 hr1 就是「那一小時的實際雨量」，不需要任何均分假設。
 * 這取代了 hourlyRainFromBuckets() 在近 6 小時的粗略均分 —— 那是整個水膜
 * 模型最粗糙的一環（12-24 小時那段是把總量平均攤到 12 小時）。
 *
 * 更久以前仍用累積桶反推：那麼久之前的雨對現在的路面幾乎沒有影響，
 * 不值得為此多抓 18 次 2.4 MB。
 *
 * 註：最近的未完成小時用即時的 hr1，會與最後一個整點快照有時間重疊。
 * 這不會造成重複累加 —— 水膜更新用的是 max(film, 平衡膜厚) 而非累加，
 * 重複套用同一場雨是冪等的。
 */
export function hourlyRainFromHistory(st, snapshotsByHour, cfg = SURFACE_DEFAULTS) {
  const perHour = hourlyRainFromBuckets(st);      // 先取桶推值作為基底
  let replaced = 0;
  for (const [hoursAgo, byId] of snapshotsByHour) {
    if (hoursAgo < 1 || hoursAgo >= perHour.length) continue;
    const h = byId.get(st.id);
    if (!h || h.hr1 === null) continue;
    perHour[hoursAgo] = Math.max(0, h.hr1);       // 該小時的實測值，取代均分值
    replaced++;
  }
  return { perHour, replacedHours: replaced };
}

/**
 * 逐站積分水膜厚度。
 * @param hourly Open-Meteo 的逐時序列（需含過去 24 小時）
 * @param nowIso 目前時間
 * @param snapshotsByHour Map<hoursAgo, Map<stationId, {hr1}>>，雨量站歷史快照
 */
export function stationWetness(st, hourly, nowIso, cfg = SURFACE_DEFAULTS, snapshotsByHour = null) {
  const hist = snapshotsByHour && snapshotsByHour.size
    ? hourlyRainFromHistory(st, snapshotsByHour, cfg) : null;
  const rain = hist ? hist.perHour : hourlyRainFromBuckets(st);
  const now = new Date(nowIso);

  // 取出過去 24 小時的氣象條件，索引 0 = 最近 1 小時
  const past = [];
  for (let k = 0; k < 24; k++) {
    const t = new Date(now.getTime() - (k + 0.5) * 3600e3);
    let best = null, bestDt = Infinity;
    for (const h of hourly) {
      const dt = Math.abs(new Date(h.time + ':00+08:00') - t);
      if (dt < bestDt) { bestDt = dt; best = h; }
    }
    past.push(best);
  }

  let film = 0;
  const trace = [];
  for (let k = 23; k >= 0; k--) {               // 由 24 小時前推到現在
    const h = past[k];
    const e = h ? evaporationMmPerH(h.swRadWm2, h.tempC, h.rh, h.windMs, h.isDay) : 0.05;
    const evap = Math.max(-cfg.maxDewMmPerH, e);
    // 降雨：趨近該雨強下的平衡膜厚，而非全額累加（多餘的逕流掉）
    if (rain[k] > 0) {
      const eq = Math.min(cfg.maxFilmMm, cfg.filmPerSqrtRain * Math.sqrt(rain[k]));
      film = Math.max(film, eq);
    }
    if (evap >= 0) {
      film = Math.max(0, film - evap);
    } else {
      // 結露：風速越大抑制越強；且只能把乾路面潤濕到 dewMaxFilmMm，
      // 不會讓本來就更濕的路面變得更濕（露水不是降雨）。
      const u = h?.windMs ?? 2;
      const supp = Math.max(0, Math.min(1,
        (cfg.dewWindStopMs - u) / (cfg.dewWindStopMs - cfg.dewWindCalmMs)));
      if (film < cfg.dewMaxFilmMm) film = Math.min(cfg.dewMaxFilmMm, film + (-evap) * supp);
    }
    if (k < 12) trace.push({ hoursAgo: k, rainMm: +rain[k].toFixed(2),
                             evapMmPerH: +evap.toFixed(3), filmMm: +film.toFixed(3) });
  }

  const level = film >= cfg.wetFilmMm ? 'wet' : film >= cfg.dampFilmMm ? 'damp' : 'dry';
  const rainingNow = (st.min10 ?? 0) > 0 || (st.hr1 ?? 0) > 0;
  // 還要多久才乾：用目前的蒸發率外推
  const nowH = past[0];
  const eRaw = nowH ? evaporationMmPerH(nowH.swRadWm2, nowH.tempC, nowH.rh, nowH.windMs, nowH.isDay) : 0.05;
  // 結露或蒸發極微弱時，「還要幾小時乾」沒有意義 —— 回 null 並說明，
  // 不要除以接近零的數字生出 590 小時這種數字。
  let dryInH = null, dryNote = null;
  if (film <= cfg.dampFilmMm) { dryInH = 0; dryNote = '已乾'; }
  else if (eRaw <= 0.002) { dryNote = eRaw < 0 ? '結露中，目前條件下不會變乾' : '蒸發極微弱，短期內不會乾'; }
  else dryInH = (film - cfg.dampFilmMm) / eRaw;

  return {
    id: st.id, name: st.name, lat: st.lat, lon: st.lon,
    area: (st.county || '') + (st.town || ''),
    hr1: st.hr1, hr3: st.hr3, hr6: st.hr6, hr24: st.hr24,
    filmMm: +film.toFixed(3), level, rainingNow,
    rainSource: hist ? ('history+buckets(' + hist.replacedHours + 'h 實測)') : 'buckets',
    exactHours: hist ? hist.replacedHours : 0,
    evapMmPerH: +eRaw.toFixed(4),
    dryInHours: dryInH === null ? null : +dryInH.toFixed(1),
    dryNote,
    trace: trace.reverse(),
  };
}

/**
 * 把逐站的雨與濕度內插到路段（IDW，只取半徑內的站）。
 * 這一層只負責「過去」—— 由雨量站累積桶積分出來的水膜歷史。
 * 「現在」由 applyRadarNow() 以雷達覆寫，見該函式說明。
 */
export function surfaceAlongRoute(segments, wetStations, cfg = SURFACE_DEFAULTS) {
  return segments.map((s) => {
    let wf = 0, wr = 0, sw = 0, nearest = null, nd = Infinity, maxRain1 = 0;
    for (const st of wetStations) {
      const d = haversineKm(s.lat, s.lon, st.lat, st.lon);
      if (d < nd) { nd = d; nearest = st; }
      if (d > cfg.stationRadiusKm) continue;
      const w = 1 / Math.pow(Math.max(0.3, d), cfg.idwPower);
      wf += w * st.filmMm; wr += w * (st.hr1 ?? 0); sw += w;
      if ((st.hr1 ?? 0) > maxRain1) maxRain1 = st.hr1;
    }
    const film = sw > 0 ? wf / sw : (nearest ? nearest.filmMm : 0);
    const rain1 = sw > 0 ? wr / sw : 0;
    return {
      filmMm: +film.toFixed(3),
      level: film >= cfg.wetFilmMm ? 'wet' : film >= cfg.dampFilmMm ? 'damp' : 'dry',
      rain1hrMm: +rain1.toFixed(2),
      maxNearbyRain1hrMm: +maxRain1.toFixed(1),
      nearestStation: nearest ? nearest.name : null,
      nearestKm: +nd.toFixed(1),
      // 「過去」的水膜，先記下來；雷達覆寫後仍保留供比對
      filmFromHistoryMm: +film.toFixed(3),
      rainNowSource: 'station',
      rainNowMmPerH: +rain1.toFixed(2),
      rainingNow: rain1 > 0.05,
    };
  });
}

/**
 * 以雷達覆寫「現在」的降雨判定。
 *
 * 為什麼現在要以雷達為準：雨量站站距 5-10 km，IDW 會把某一站的雨抹到周圍
 * 十公里，拿來回答「我現在騎到這裡有沒有在下雨」並不可靠。雷達是 1.3 km 的
 * 連續場，正好補上這個解析度缺口。
 *
 * 為什麼過去仍以測站為準：雷達的數值網格只有最新一張（實測時戳版本 404），
 * 而雨量站提供 1/3/6/12/24 小時累積，正是地濕模型需要的量；且測站測地面
 * 實際累積，雷達測空中回波，兩者在「已經下了多少」這件事上測站更直接。
 *
 * @param surf  surfaceAlongRoute 的輸出（會被就地修改）
 * @param radarPerSeg  radarAlongRoute 的 perSegment（dbz / rainMmPerH / band）
 */
export function applyRadarNow(surf, radarPerSeg, cfg = SURFACE_DEFAULTS) {
  let covered = 0, raining = 0, upgraded = 0;
  for (let i = 0; i < surf.length; i++) {
    const r = radarPerSeg[i];
    if (!r || r.band === 'unknown') continue;   // 雷達範圍外 -> 維持測站判定
    covered++;
    surf[i].rainNowSource = 'radar';
    surf[i].radarDbz = r.dbz;
    surf[i].rainNowMmPerH = r.rainMmPerH;
    surf[i].rainingNow = r.rainMmPerH > 0;
    if (r.rainMmPerH > 0) {
      raining++;
      const eq = Math.min(cfg.maxFilmMm, cfg.filmPerSqrtRain * Math.sqrt(r.rainMmPerH));
      if (eq > surf[i].filmMm) {
        surf[i].filmMm = +eq.toFixed(3);
        surf[i].fromRadar = true;
        upgraded++;
      }
    }
    surf[i].level = surf[i].filmMm >= cfg.wetFilmMm ? 'wet'
                  : surf[i].filmMm >= cfg.dampFilmMm ? 'damp' : 'dry';
  }
  return { coveredSegments: covered, rainingSegments: raining, upgradedSegments: upgraded };
}

/**
 * 紫外線：目前值、騎乘期間的變化、累積紅斑劑量、曬傷時間。
 * @param hourly 單點的逐時序列
 * @param startIso 出發時間
 * @param durationH 騎乘時數
 */
export function uvAnalysis(hourly, startIso, durationH, cfg = SURFACE_DEFAULTS) {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + durationH * 3600e3);
  const inRide = hourly.filter((h) => {
    const t = new Date(h.time + ':00+08:00');
    return t >= new Date(start.getTime() - 3600e3) && t <= end;
  });
  if (!inRide.length) return { available: false };

  let doseJm2 = 0;
  const series = inRide.map((h) => {
    const uvi = Number.isFinite(h.uvIndex) ? h.uvIndex : 0;
    // 每筆代表 1 小時，但首尾可能只涵蓋部分時段；以 1 小時計已足夠
    doseJm2 += uvi * 0.025 * 3600;
    return { time: h.time, uvIndex: uvi, clearSky: h.uvClear ?? null, isDay: h.isDay };
  });

  const uvs = series.map((s) => s.uvIndex);
  const maxUv = Math.max(...uvs), meanUv = uvs.reduce((a, b) => a + b, 0) / uvs.length;
  const nowUv = series[0].uvIndex;
  const burnMinNow = nowUv > 0.1 ? cfg.medJm2 / (nowUv * 0.025) / 60 : null;
  const burnMinPeak = maxUv > 0.1 ? cfg.medJm2 / (maxUv * 0.025) / 60 : null;

  // WHO 的 UV 指數分級
  const band = (u) => u < 3 ? '低' : u < 6 ? '中等' : u < 8 ? '高' : u < 11 ? '很高' : '極危險';

  // 夜間騎乘時報告「下一個白天的高峰」，否則畫面只會是一排 0，沒有資訊
  let nextPeak = null;
  if (maxUv < 0.5) {
    const future = hourly.filter((h) => new Date(h.time + ':00+08:00') > start);
    let bestH = null;
    for (const h of future) if (Number.isFinite(h.uvIndex) && (!bestH || h.uvIndex > bestH.uvIndex)) bestH = h;
    if (bestH && bestH.uvIndex > 0.5) {
      nextPeak = { time: bestH.time, uvIndex: +bestH.uvIndex.toFixed(1), band: band(bestH.uvIndex),
                   burnMinutes: Math.round(cfg.medJm2 / (bestH.uvIndex * 0.025) / 60) };
    }
  }

  // 夜間時騎乘期間的 UV 全是 0，圖表毫無資訊。附上未來 24 小時的展望，
  // 讓使用者看得到明天的強度與高峰時刻。
  const outlook = hourly
    .filter((h) => {
      const t = new Date(h.time + ':00+08:00');
      return t >= start && t <= new Date(start.getTime() + 24 * 3600e3);
    })
    .map((h) => ({ time: h.time, uvIndex: Number.isFinite(h.uvIndex) ? h.uvIndex : 0 }));

  return {
    available: true,
    nextPeak,
    outlookHours: outlook,
    isNight: maxUv < 0.5,
    nowUv: +nowUv.toFixed(1),
    maxUv: +maxUv.toFixed(1),
    meanUv: +meanUv.toFixed(1),
    band: band(maxUv),
    doseJm2: Math.round(doseJm2),
    doseMed: +(doseJm2 / cfg.medJm2).toFixed(2),
    medJm2: cfg.medJm2,
    burnMinutesNow: burnMinNow === null ? null : Math.round(burnMinNow),
    burnMinutesAtPeak: burnMinPeak === null ? null : Math.round(burnMinPeak),
    hours: series,
    note: 'UV 指數 ×0.025 W/m² 為紅斑加權輻照度；1 MED（第 III 型膚質）取 ' +
          cfg.medJm2 + ' J/m²。山區有樹蔭遮蔽，實際曝曬低於此估計。',
  };
}
