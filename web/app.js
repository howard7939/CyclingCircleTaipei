/* 環騎臺北 — 騎乘條件前端
   資料全部來自 /api/conditions?full=1，授權碼只存在於伺服器端。 */
(function () {
  'use strict';

  const EXP = {
    riverside: { name: '河濱', color: '#2a78d6' },
    urban:     { name: '市區', color: '#eb6834' },
    mountain:  { name: '山區', color: '#1baf7a' },
  };

  // 順逆風是雙極量：藍（順風，省力）↔ 中性灰 ↔ 紅（逆風，費力），每臂 3 步。
  const WIND_BINS = [
    { max: -3.0,     color: '#184f95', label: '強順風 ≤ −3' },
    { max: -1.5,     color: '#2a78d6', label: '順風 −3 ~ −1.5' },
    { max: -0.5,     color: '#86b6ef', label: '微順風 −1.5 ~ −0.5' },
    { max:  0.5,     color: '#c3c2b7', label: '側風 ±0.5' },
    { max:  1.5,     color: '#f0a0a0', label: '微逆風 0.5 ~ 1.5' },
    { max:  3.0,     color: '#e34948', label: '逆風 1.5 ~ 3' },
    { max:  Infinity, color: '#a32a2a', label: '強逆風 > 3' },
  ];
  const GRADE_BINS = [
    { max: -6,       color: '#184f95', label: '≤ −6%' },
    { max: -3,       color: '#2a78d6', label: '−6 ~ −3%' },
    { max: -1,       color: '#86b6ef', label: '−3 ~ −1%' },
    { max:  1,       color: '#c3c2b7', label: '平路 ±1%' },
    { max:  3,       color: '#f0a0a0', label: '1 ~ 3%' },
    { max:  6,       color: '#e34948', label: '3 ~ 6%' },
    { max: Infinity, color: '#a32a2a', label: '> 6%' },
  ];

  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
  const mmss = (s) => {
    const x = Math.abs(Math.round(s));
    return Math.floor(x / 60) + ' 分 ' + String(x % 60).padStart(2, '0') + ' 秒';
  };
  const fail = (msg) => {
    document.querySelector('main').remove();
    const p = $('profile'); if (p) p.remove();
    const d = document.createElement('div');
    d.id = 'err'; d.textContent = msg;
    document.body.appendChild(d);
    throw new Error(msg);
  };

  const S = {
    route: null, cond: null, mode: 'windCCW',
    map: null, segLayer: null, casing: null, arrowLayer: null,
    stationLayer: null, rainLayer: null, lines: [], cursor: null,
    runs: [], defaults: null, pGeom: null, inflight: null,
  };

  // ---------- 資料 ----------
  async function getJson(url, what) {
    let r;
    try { r = await fetch(url); }
    catch (e) { fail('無法連線到 ' + url + '\n' + e.message + '\n\n伺服器有在跑嗎？ npm run dev'); }
    let body = null;
    try { body = await r.json(); } catch {}
    if (!r.ok) fail(what + ' 失敗：HTTP ' + r.status + '\n' + (body ? JSON.stringify(body, null, 2) : ''));
    return body;
  }

  function paramQuery() {
    const q = new URLSearchParams({ full: '1' });
    q.set('targetPowerW', $('pw').value);
    q.set('massKg', $('mk').value);
    q.set('cdaM2', $('cda').value);
    q.set('crr', $('crr').value);
    q.set('k_riverside', $('kr').value);
    q.set('k_urban', $('ku').value);
    q.set('k_mountain', $('km_').value);
    return q.toString();
  }

  let reqSeq = 0;
  async function refresh() {
    const my = ++reqSeq;
    $('busy').classList.add('on');
    try {
      const j = await getJson('/api/conditions?' + paramQuery(), '取得騎乘條件');
      if (my !== reqSeq) return;           // 已有更新的請求，丟棄這次結果
      S.cond = j;
      renderAll();
    } finally {
      if (my === reqSeq) $('busy').classList.remove('on');
    }
  }

  // ---------- 著色 ----------
  function binOf(bins, v) { return bins.find((b) => v <= b.max); }
  function segColor(i) {
    const s = S.route.segments[i], c = S.cond.segments[i];
    if (S.mode === 'exposure') return EXP[s.exposure].color;
    if (S.mode === 'grade') return binOf(GRADE_BINS, s.gradePct).color;
    const d = S.mode === 'windCW' ? c.cw : c.ccw;
    return binOf(WIND_BINS, d.headwindMs).color;
  }
  const dirKey = () => (S.mode === 'windCW' ? 'cw' : 'ccw');

  // ---------- 結論卡 ----------
  function renderVerdict() {
    const d = S.cond.direction, w = S.cond.wind;
    const cw = d.byDirection.CW, ccw = d.byDirection.CCW;
    const better = d.recommend;

    $('vdDir').textContent = better === 'CCW' ? '逆時針' : better === 'CW' ? '順時針' : '順逆皆可';
    $('vdGain').textContent = better ? '快 ' + mmss(d.deltaSec) : '差距 < 15 秒';
    $('vdSub').innerHTML =
      '開闊地風 <b>' + w.openTerrain.speedMs + '</b> m/s 從 <b>' + w.openTerrain.fromDeg + '°</b>' +
      ' · 目標 <b>' + d.targetPowerW + '</b> W' +
      '<br>純風 ' + (d.windDeltaSec >= 0 ? '+' : '') + Math.round(d.windDeltaSec) + ' s' +
      ' · 與天氣無關的常數項 ' + (d.calmDeltaSec >= 0 ? '+' : '') + Math.round(d.calmDeltaSec) + ' s';

    $('vCW').textContent = cw.timeMin.toFixed(1) + ' min';
    $('vCCW').textContent = ccw.timeMin.toFixed(1) + ' min';
    $('cellCW').classList.toggle('win', better === 'CW');
    $('cellCCW').classList.toggle('win', better === 'CCW');
    syncViewing();
  }

  // ---------- 圖例 ----------
  function renderLegend() {
    const host = $('legend');
    host.innerHTML = '';
    const add = (color, label, n) => {
      const r = document.createElement('div');
      r.className = 'lg-row';
      r.innerHTML = '<span class="sw" style="background:' + color + '"></span><span>' + label +
                    '</span><span class="n">' + n + '</span>';
      host.appendChild(r);
    };
    const segs = S.route.segments;
    if (S.mode === 'exposure') {
      for (const [k, e] of Object.entries(EXP)) {
        const km = segs.filter((s) => s.exposure === k).reduce((a, s) => a + s.len / 1000, 0);
        add(e.color, e.name, km.toFixed(1) + ' km');
      }
      return;
    }
    const bins = S.mode === 'grade' ? GRADE_BINS : WIND_BINS;
    const val = S.mode === 'grade'
      ? ((i) => segs[i].gradePct)
      : ((i) => S.cond.segments[i][dirKey()].headwindMs);
    let prev = -Infinity;
    for (const b of bins) {
      let km = 0;
      for (let i = 0; i < segs.length; i++) {
        const v = val(i);
        if (v > prev && v <= b.max) km += segs[i].len / 1000;
      }
      prev = b.max;
      if (km > 0.05) add(b.color, b.label + (S.mode === 'grade' ? '' : ' m/s'), km.toFixed(1) + ' km');
    }
  }

  // ---------- 羅盤 ----------
  function renderCompass() {
    const svg = $('compass');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const D = S.cond.direction.exposureDisplacement;
    const w = S.cond.wind.openTerrain;
    const cx = 110, cy = 110, R = 84;
    const pt = (deg, r) => [cx + r * Math.sin(deg * Math.PI / 180), cy - r * Math.cos(deg * Math.PI / 180)];

    // 兩個半圓：風「來向」落在哪一側決定建議方向
    const [a, b] = D.criticalFromDeg;
    const arc = (from, to, fill) => {
      const p0 = pt(from, R), p1 = pt(to, R);
      let span = (to - from + 360) % 360;
      const d = 'M' + cx + ',' + cy + ' L' + p0[0].toFixed(1) + ',' + p0[1].toFixed(1) +
                ' A' + R + ',' + R + ' 0 ' + (span > 180 ? 1 : 0) + ' 1 ' + p1[0].toFixed(1) + ',' + p1[1].toFixed(1) + ' Z';
      svg.appendChild(mk('path', { d, fill, 'fill-opacity': .16, stroke: fill, 'stroke-opacity': .35 }));
    };
    arc(b, a, '#2a78d6');  // 逆時針有利側（含 D 反方向）
    arc(a, b, '#eb6834');  // 順時針有利側（含 D 方向）

    svg.appendChild(mk('circle', { cx, cy, r: R, fill: 'none', stroke: '#c3c2b7', 'stroke-width': 1 }));
    for (const [deg, lab] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
      const p = pt(deg, R + 12);
      const t = mk('text', { x: p[0], y: p[1] + 4, 'text-anchor': 'middle', 'font-size': 11, fill: '#898781' });
      t.textContent = lab;
      svg.appendChild(t);
      const i0 = pt(deg, R - 6), i1 = pt(deg, R);
      svg.appendChild(mk('line', { x1: i0[0], y1: i0[1], x2: i1[0], y2: i1[1], stroke: '#c3c2b7' }));
    }

    // 臨界線
    for (const c of D.criticalFromDeg) {
      const p = pt(c, R);
      svg.appendChild(mk('line', { x1: cx, y1: cy, x2: p[0], y2: p[1], stroke: '#0b0b0b',
                                   'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: .5 }));
      const l = pt(c, R - 20);
      const t = mk('text', { x: l[0], y: l[1], 'text-anchor': 'middle', 'font-size': 9.5, fill: '#52514e' });
      t.textContent = c.toFixed(0) + '°';
      svg.appendChild(t);
    }

    // 目前風向（箭頭由外指向圓心＝風吹來的方向）
    const tip = pt(w.fromDeg, 31), tail = pt(w.fromDeg, R - 4);
    svg.appendChild(mk('line', { x1: tail[0], y1: tail[1], x2: tip[0], y2: tip[1],
                                 stroke: '#0b0b0b', 'stroke-width': 3, 'stroke-linecap': 'round' }));
    const ang = (w.fromDeg + 180) * Math.PI / 180;
    for (const s of [-1, 1]) {
      const h = [tip[0] + 11 * Math.sin(ang + s * 0.42), tip[1] - 11 * Math.cos(ang + s * 0.42)];
      svg.appendChild(mk('line', { x1: tip[0], y1: tip[1], x2: h[0], y2: h[1],
                                   stroke: '#0b0b0b', 'stroke-width': 3, 'stroke-linecap': 'round' }));
    }
    // 中央風速徽章畫在箭頭之上，並墊底色 —— 否則箭頭方向一轉就壓到文字
    svg.appendChild(mk('circle', { cx, cy, r: 25, fill: '#fcfcfb', stroke: '#c3c2b7', 'stroke-width': 1 }));
    const lbl = mk('text', { x: cx, y: cy - 1, 'text-anchor': 'middle', 'font-size': 14, 'font-weight': 680 });
    lbl.textContent = w.speedMs;
    svg.appendChild(lbl);
    const lbl2 = mk('text', { x: cx, y: cy + 11, 'text-anchor': 'middle', 'font-size': 9, fill: '#898781' });
    lbl2.textContent = 'm/s';
    svg.appendChild(lbl2);

    const kv = $('windKv');
    const st = S.cond.wind.stationsVector;
    kv.innerHTML =
      '<dt>開闊地風</dt><dd>' + w.speedMs + ' m/s @ ' + w.fromDeg + '°</dd>' +
      '<dt>測站向量平均</dt><dd>' + (st ? st.speedMs + ' m/s @ ' + st.fromDeg + '°' : '—') + '</dd>' +
      '<dt>兩者風向差</dt><dd>' + S.cond.wind.directionAgreeDeg + '°</dd>' +
      '<dt>遮蔽比</dt><dd>' + S.cond.wind.shelterRatio + '×</dd>' +
      '<dt>|D| 加權位移</dt><dd>' + D.magnitudeKm + ' km @ ' + D.bearingDeg + '°</dd>' +
      '<dt>臨界風向</dt><dd>' + D.criticalFromDeg.map((x) => x.toFixed(0) + '°').join(' / ') + '</dd>';
  }

  // ---------- 地圖 ----------
  function initMap() {
    const M = S.route.meta;
    S.map = L.map('map', { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(S.map);
    S.map.fitBounds([[M.bbox.minLat, M.bbox.minLon], [M.bbox.maxLat, M.bbox.maxLon]], { padding: [22, 22] });

    S.casing = L.layerGroup().addTo(S.map);
    const segs = S.route.segments;
    S.casing.addLayer(L.polyline(segs.map((s) => s.a).concat([segs[segs.length - 1].b]),
      { color: '#fff', weight: 7, opacity: .95, lineCap: 'round', interactive: false }));

    // 2630 段逐段畫成 polyline 會讓瀏覽器很吃力。依 displayStride 把相鄰數段
    // 併成一條繪製（計算仍用全解析度，只有「畫」被抽稀）。
    S.segLayer = L.layerGroup().addTo(S.map);
    const stride = S.stride;
    S.lines = []; S.lineIdx = [];
    for (let i = 0; i < segs.length; i += stride) {
      const grp = segs.slice(i, i + stride);
      const pts = grp.map((s) => s.a).concat([grp[grp.length - 1].b]);
      const mid = i + Math.floor(grp.length / 2);
      const pl = L.polyline(pts, { color: '#999', weight: 4, lineCap: 'butt', bubblingMouseEvents: false });
      pl.on('mouseover', () => { showSeg(mid); pl.setStyle({ weight: 8 }); });
      pl.on('mouseout', () => { pl.setStyle({ weight: 4 }); clearCursor(); });
      pl.on('click', () => L.popup({ maxWidth: 330 }).setLatLng([segs[mid].lat, segs[mid].lon])
        .setContent(tipHtml(mid)).openOn(S.map));
      S.segLayer.addLayer(pl);
      S.lines.push(pl); S.lineIdx.push(mid);
    }

    S.arrowLayer = L.layerGroup().addTo(S.map);
    S.stationLayer = L.layerGroup();
    S.rainLayer = L.layerGroup().addTo(S.map);
    S.cursor = L.circleMarker([0, 0], { radius: 7, color: '#0b0b0b', weight: 2.5, fillColor: '#fff', fillOpacity: 1 });
  }

  function renderMap() {
    S.lines.forEach((pl, k) => pl.setStyle({ color: segColor(S.lineIdx[k]), weight: 4 }));

    // 風向箭頭：直接畫在 Open-Meteo 的「取樣點」上，而不是沿路線等距亂擺 ——
    // 這樣箭頭的位置就等於風場資料的真實來源，hover 可以看到該點的原始值。
    S.arrowLayer.clearLayers();
    const samples = S.cond.wind.samples || [];
    const cellColor = new Map();
    const palette = ['#2a78d6', '#eb6834', '#1baf7a', '#4a3aa7', '#e87ba4', '#eda100'];
    samples.forEach((p) => {
      const key = p.gridLat + ',' + p.gridLon;
      if (!cellColor.has(key)) cellColor.set(key, palette[cellColor.size % palette.length]);
    });
    samples.forEach((p, idx) => {
      const toDeg = (p.fromDeg + 180) % 360;
      const len = 0.006 + 0.0022 * p.windMs;
      const rad = toDeg * Math.PI / 180;
      const kLat = 1 / Math.cos(p.lat * Math.PI / 180);
      const dLat = len * Math.cos(rad), dLon = len * Math.sin(rad) * kLat;
      const tail = [p.lat - dLat / 2, p.lon - dLon / 2], tip = [p.lat + dLat / 2, p.lon + dLon / 2];
      const col = cellColor.get(p.gridLat + ',' + p.gridLon);
      const pts = [tail, tip];
      for (const sgn of [-1, 1]) {
        const a = rad + Math.PI + sgn * 0.42, f = len * 0.33;
        pts.push(tip, [tip[0] + f * Math.cos(a), tip[1] + f * Math.sin(a) * kLat]);
      }
      const tipHtmlArrow =
        '<div class="tip"><div class="h">風場取樣點 ' + (idx + 1) + '/' + samples.length +
        '（' + (p.name || '') + '）</div><table>' +
        '<tr><td>風速</td><td>' + p.windMs.toFixed(2) + ' m/s</td></tr>' +
        '<tr><td>風向（來向）</td><td>' + p.fromDeg.toFixed(0) + '°</td></tr>' +
        '<tr><td>陣風</td><td>' + (p.gustMs == null ? '—' : p.gustMs.toFixed(1) + ' m/s') + '</td></tr>' +
        '<tr><td>查詢座標</td><td>' + p.lat.toFixed(4) + ', ' + p.lon.toFixed(4) + '</td></tr>' +
        '<tr><td>模式格點</td><td>' + p.gridLat.toFixed(3) + ', ' + p.gridLon.toFixed(3) + '</td></tr>' +
        '<tr><td>格點高程</td><td>' + p.gridElevM + ' m</td></tr>' +
        '</table><div style="margin-top:4px;color:#898781">同色箭頭＝同一個模式格點</div></div>';
      // 粗透明線當作好按的熱區，細線負責外觀
      const hit = L.polyline(pts, { color: col, weight: 14, opacity: 0 });
      const vis = L.polyline(pts, { color: col, weight: 2.4, opacity: .85, interactive: false });
      hit.bindTooltip(tipHtmlArrow, { direction: 'top', sticky: true, opacity: .97 });
      S.arrowLayer.addLayer(vis); S.arrowLayer.addLayer(hit);
      S.arrowLayer.addLayer(L.circleMarker([p.lat, p.lon],
        { radius: 2.6, color: col, weight: 1.5, fillColor: '#fff', fillOpacity: 1, interactive: false }));
    });

    S.stationLayer.clearLayers();
    for (const st of (S.cond.stations || [])) {
      S.stationLayer.addLayer(
        L.circleMarker([st.lat, st.lon], { radius: 4, color: '#fff', weight: 1.5,
                                           fillColor: '#52514e', fillOpacity: .9 })
          .bindTooltip(st.name + '　' + (st.windMs ?? '—') + ' m/s @ ' + (st.windFromDeg ?? '—') + '°' +
                       '　海拔 ' + (st.altM ?? '—') + ' m', { direction: 'top' }));
    }

    S.rainLayer.clearLayers();
    for (const r of (S.cond.rain.wettest || [])) {
      S.rainLayer.addLayer(
        L.circleMarker([r.lat, r.lon], { radius: 5 + Math.min(8, r.hr1 * 2), color: '#fff', weight: 1.5,
                                         fillColor: '#2a78d6', fillOpacity: .75 })
          .bindTooltip(r.name + '　1hr ' + r.hr1 + ' mm　6hr ' + (r.hr6 ?? '—') + ' mm<br>' + r.area,
                       { direction: 'top' }));
    }
  }

  function tipHtml(i) {
    const s = S.route.segments[i], c = S.cond.segments[i];
    const rows = [
      ['路段', s.sectionLabel || EXP[s.exposure].name],
      ['里程', (s.s0 / 1000).toFixed(2) + ' km'],
      ['行進方位', s.bearing.toFixed(0) + '° (逆時針向)'],
      ['坡度', s.gradePct.toFixed(2) + ' %'],
      ['開闊地風', c.openWindMs.toFixed(2) + ' m/s @ ' + c.openWindFromDeg + '°'],
      ['— 逆時針 —', ''],
      ['　逆風分量', c.ccw.headwindMs.toFixed(2) + ' m/s'],
      ['　速度', c.ccw.speedKmh.toFixed(1) + ' km/h' + (c.ccw.atCap ? '（煞車上限）' : '')],
      ['— 順時針 —', ''],
      ['　逆風分量', c.cw.headwindMs.toFixed(2) + ' m/s'],
      ['　速度', c.cw.speedKmh.toFixed(1) + ' km/h' + (c.cw.atCap ? '（煞車上限）' : '')],
      ['此段時間差', (c.cw.timeS - c.ccw.timeS).toFixed(1) + ' s'],
    ];
    return '<div class="tip"><div class="h">第 ' + i + ' 段 · ' + EXP[s.exposure].name + '</div><table>' +
      rows.map((r) => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('') + '</table></div>';
  }

  function showSeg(i) {
    const s = S.route.segments[i], c = S.cond.segments[i];
    const d = c[dirKey()];
    $('readout').innerHTML =
      'km <b>' + (s.s0 / 1000).toFixed(2) + '</b> · ' + EXP[s.exposure].name +
      ' · 坡度 <b>' + s.gradePct.toFixed(2) + '</b>%' +
      ' · ' + (S.mode === 'windCW' ? '順時針' : '逆時針') +
      ' 逆風 <b>' + d.headwindMs.toFixed(2) + '</b> m/s' +
      ' · 速度 <b>' + d.speedKmh.toFixed(1) + '</b> km/h';
    S.cursor.setLatLng([s.lat, s.lon]);
    if (!S.map.hasLayer(S.cursor)) S.cursor.addTo(S.map);
    setProfCursor(i);
  }
  function clearCursor() {
    if (S.map.hasLayer(S.cursor)) S.map.removeLayer(S.cursor);
    setProfCursor(null);
  }

  // ---------- 剖面 ----------
  const STRIP = 11, GAP = 5;
  function renderProfile() {
    const svg = $('svg');
    const W = svg.clientWidth || svg.parentElement.clientWidth || 900;
    const H = svg.clientHeight || 150;
    const P = { t: 8, r: 40, b: 17, l: 32 }; // 右側留白給累積時間差的軸標籤
    const iw = Math.max(10, W - P.l - P.r);
    const stripY = P.t + Math.max(10, H - P.t - P.b - STRIP - GAP) + GAP;
    const ih = Math.max(10, stripY - GAP - P.t);
    const segs = S.route.segments, kmMax = S.route.meta.totalKm;
    const rawMax = Math.max(...segs.map((s) => s.ele));
    const stepE = [10, 20, 25, 50, 100].find((v) => rawMax / v <= 5) || 100;
    const eMax = Math.ceil(rawMax / stepE) * stepE;
    const x = (km) => P.l + (km / kmMax) * iw;
    const y = (e) => P.t + ih - (e / eMax) * ih;
    S.pGeom = { x, P, W, kmMax, stripY };

    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    for (let e = 0; e <= eMax; e += stepE) {
      svg.appendChild(mk('line', { class: 'gl', x1: P.l, x2: P.l + iw, y1: y(e), y2: y(e) }));
      svg.appendChild(mk('text', { class: 'ax', x: P.l - 5, y: y(e) + 3.5, 'text-anchor': 'end' })).textContent = e;
    }
    for (let km = 0; km <= kmMax; km += 10) {
      svg.appendChild(mk('text', { class: 'ax', x: x(km), y: H - 4, 'text-anchor': 'middle' })).textContent = km;
    }
    svg.appendChild(mk('line', { class: 'bl', x1: P.l, x2: P.l + iw, y1: y(0), y2: y(0) }));

    for (const r of S.runs) {
      const pts = r.segs.map((s) => [x((s.s0 / 1000 + s.s1 / 1000) / 2), y(s.ele)]);
      if (!pts.length) continue;
      const d = 'M' + x(r.startKm) + ',' + y(0) + 'L' +
                pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L') +
                'L' + x(r.endKm) + ',' + y(0) + 'Z';
      svg.appendChild(mk('path', { d, fill: EXP[r.exposure].color, 'fill-opacity': .22,
                                   stroke: '#fcfcfb', 'stroke-width': 2 }));
    }

    // 色帶：依目前著色模式逐段上色
    for (let i = 0; i < segs.length; i++) {
      svg.appendChild(mk('rect', {
        x: x(segs[i].s0 / 1000), y: stripY,
        width: Math.max(1, x(segs[i].s1 / 1000) - x(segs[i].s0 / 1000)) + .4,
        height: STRIP, fill: segColor(i),
      }));
    }
    for (const w of (S.route.meta.waypoints || [])) {
      const wx = x(w.km);
      svg.appendChild(mk('line', { x1: wx, x2: wx, y1: stripY - 4, y2: stripY + STRIP + 3,
                                   stroke: '#0b0b0b', 'stroke-width': 1.2, opacity: .7 }));
    }
    for (const r of S.runs) {
      if (x(r.endKm) - x(r.startKm) < 34) continue;
      const t = mk('text', { class: 'runlab', x: (x(r.startKm) + x(r.endKm)) / 2,
                             y: stripY + STRIP - 2.5, 'text-anchor': 'middle', fill: '#fff' });
      t.textContent = EXP[r.exposure].name + (r.phase ? (r.phase === 'climb' ? '↑' : '↓') : '');
      svg.appendChild(t);
    }

    // 各路段對總時間差的「累積貢獻」：Σ(t順 − t逆) 依里程累加。
    //
    // 注意語意：這不是「領先多少時間」。順時針是以相反順序經過同樣的路段，
    // 所以中途的累積值並不對應「同一時刻的兩個你」。只有終點值才是總時間差。
    // 它的用途是回答「差距由哪些路段造成」——斜率陡的地方就是拉開差距的路段。
    //
    // 逐段色帶必然紅藍交錯（河濱車道蜿蜒，逆風分量一直變號），看不出這件事。
    // 分兩條：
    //   風的貢獻（粗黑實線）—— 扣掉零風基準，這才是隨天氣變動、我們關心的量
    //   坡度換邊的貢獻（細灰線）—— 山區上下坡互換，擺盪達 ±1600 s 但幾乎自相抵銷
    // 若混在一條裡，山區的擺盪會把 y 軸撐大 6 倍，風的訊號就看不見了。
    const cumWind = [], cumGrade = [];
    let aw = 0, ag = 0;
    const hasCalm = S.cond.segments[0].cwCalmS !== undefined;
    for (let i = 0; i < segs.length; i++) {
      const c = S.cond.segments[i];
      const tot = c.cw.timeS - c.ccw.timeS;
      const gr = hasCalm ? (c.cwCalmS - c.ccwCalmS) : 0;
      ag += gr; aw += tot - gr;
      cumGrade.push(ag); cumWind.push(aw);
    }
    // 只畫風的貢獻。坡度換邊的曲線在山區衝到 ±1100 s，遠超出以風為尺度的
    // 繪圖範圍，畫出來只會被夾成一條假的平線 —— 那比不畫更誤導。它的淨值
    // 很小（約 -18 s），寫在標題即可。
    const gradeSwing = Math.max(...cumGrade.map(Math.abs));
    const cMax = Math.max(10, Math.max(...cumWind.map(Math.abs)));
    const cy_ = (v) => P.t + ih / 2 - (Math.max(-1, Math.min(1, v / cMax))) * (ih / 2 - 7);
    svg.appendChild(mk('line', { x1: P.l, x2: P.l + iw, y1: cy_(0), y2: cy_(0),
                                 stroke: '#898781', 'stroke-width': 1, 'stroke-dasharray': '4 3', opacity: .7 }));

    const pathOf = (arr) => 'M' + arr.map((v, i) =>
      x((segs[i].s0 / 1000 + segs[i].s1 / 1000) / 2).toFixed(1) + ',' + cy_(v).toFixed(1)).join('L');

    svg.appendChild(mk('path', { d: pathOf(cumWind), fill: 'none', stroke: '#fcfcfb', 'stroke-width': 4.5, 'stroke-linejoin': 'round' }));
    svg.appendChild(mk('path', { d: pathOf(cumWind), fill: 'none', stroke: '#0b0b0b', 'stroke-width': 2, 'stroke-linejoin': 'round' }));

    for (const v of [cMax, 0, -cMax]) {
      const t = mk('text', { class: 'ax', x: P.l + iw + 4, y: cy_(v) + 3.5, 'text-anchor': 'start' });
      t.textContent = (v > 0 ? '+' : '') + Math.round(v) + ' s';
      svg.appendChild(t);
    }
    const endLab = mk('text', { x: P.l + iw - 3, y: cy_(aw) - 7, 'text-anchor': 'end',
                                'font-size': 11, 'font-weight': 650 });
    endLab.textContent = (aw >= 0 ? '+' : '') + Math.round(aw) + ' s';
    svg.appendChild(endLab);

    S.pGeom.cur = mk('line', { y1: P.t, y2: stripY + STRIP, stroke: '#0b0b0b', 'stroke-width': 1.5, opacity: 0 });
    svg.appendChild(S.pGeom.cur);

    $('profTitle').innerHTML =
      '<b>風對時間差的累積貢獻</b> <span style="color:var(--ink-muted)">' +
      '（非「領先時間」；只有終點值是總差距）</span>　' +
      '<span style="color:var(--ink-muted)">坡度換邊另貢獻 ' + (ag >= 0 ? '+' : '') + Math.round(ag) +
      ' s（途中振幅 ±' + Math.round(gradeSwing) + ' s，幾乎自相抵銷，未繪出）</span>　· 色帶（' +
      ({ windCCW: '逆時針順逆風', windCW: '順時針順逆風', exposure: '曝露度', grade: '坡度' }[S.mode]) + '）';
  }
  function setProfCursor(i) {
    if (!S.pGeom || !S.pGeom.cur) return;
    if (i === null) { S.pGeom.cur.setAttribute('opacity', 0); return; }
    const s = S.route.segments[i];
    const px = S.pGeom.x((s.s0 / 1000 + s.s1 / 1000) / 2);
    S.pGeom.cur.setAttribute('x1', px);
    S.pGeom.cur.setAttribute('x2', px);
    S.pGeom.cur.setAttribute('opacity', 1);
  }

  // ---------- 表格 / 中繼資料 ----------
  function renderTable() {
    const d = S.cond.direction;
    const head = '<thead><tr><th class="l">里程</th><th class="l">類別</th><th>順(min)</th>' +
                 '<th>逆(min)</th><th>Δ(s)</th></tr></thead>';
    const rows = S.runs.map((r, i) => {
      let tc = 0, tcc = 0;
      for (const s of r.segs) { tc += S.cond.segments[s.i].cw.timeS; tcc += S.cond.segments[s.i].ccw.timeS; }
      const dd = tc - tcc;
      return '<tr data-i="' + i + '"><td class="l">' + r.startKm.toFixed(1) + '–' + r.endKm.toFixed(1) + '</td>' +
        '<td class="l"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' +
        EXP[r.exposure].color + ';margin-right:4px"></span>' + EXP[r.exposure].name +
        (r.phase ? (r.phase === 'climb' ? '↑' : '↓') : '') + '</td>' +
        '<td>' + (tc / 60).toFixed(1) + '</td><td>' + (tcc / 60).toFixed(1) + '</td>' +
        '<td style="color:' + (dd > 0 ? '#0ca30c' : dd < 0 ? '#d03b3b' : 'inherit') + '">' +
        (dd >= 0 ? '+' : '') + dd.toFixed(0) + '</td></tr>';
    }).join('');
    const t = $('tbl');
    t.innerHTML = head + '<tbody>' + rows + '</tbody>' +
      '<tfoot><tr><th class="l">全線</th><th></th><th>' + d.byDirection.CW.timeMin.toFixed(1) +
      '</th><th>' + d.byDirection.CCW.timeMin.toFixed(1) + '</th><th>' +
      (d.deltaSec >= 0 ? '+' : '') + d.deltaSec.toFixed(0) + '</th></tr></tfoot>';
    t.querySelectorAll('tbody tr').forEach((tr) => {
      tr.onclick = () => {
        const r = S.runs[+tr.dataset.i];
        S.map.fitBounds(L.latLngBounds(r.segs.map((s) => s.a).concat(r.segs.map((s) => s.b))), { padding: [40, 40] });
        showSeg(r.segs[Math.floor(r.segs.length / 2)].i);
      };
    });
  }

  function renderMeta() {
    const c = S.cond, p = c.params, src = c.sources;
    const age = (s) => s.cache === 'stale' ? '過期 ' + Math.round(s.ageSec / 60) + ' 分' :
                       s.ageSec > 60 ? Math.round(s.ageSec / 60) + ' 分前' : '剛更新';
    $('metaKv').innerHTML =
      '<dt>CWA 觀測</dt><dd>' + (c.wind.obsTime || '—').slice(11, 16) + '　' + age(src.cwaObs) + '</dd>' +
      '<dt>模式時間</dt><dd>' + (c.wind.modelTime || '—').slice(11, 16) + '　' + age(src.openMeteo) + '</dd>' +
      '<dt>測站數</dt><dd>' + c.wind.stationCount + '</dd>' +
      '<dt>CdA / Crr</dt><dd>' + p.cdaM2 + ' / ' + p.crr + '</dd>' +
      '<dt>空氣密度</dt><dd>' + p.rho + ' kg/m³</dd>' +
      '<dt>下坡上限</dt><dd>' + p.maxSpeedKmh + ' km/h</dd>' +
      '<dt>校正 R²</dt><dd>' + (p._riderProfile ? p._riderProfile.r2 : '—') + '</dd>' +
      '<dt>數值底線</dt><dd>' + c.direction.noiseFloorSec + ' s</dd>' +
      '<dt>降雨中測站</dt><dd>' + c.rain.rainingNow + ' / ' + c.rain.stationCount + '</dd>' +
      '<dt>即時 UV</dt><dd>' + (c.uv.isDay ? c.uv.nowRange.join('–') : '夜間') + '</dd>';

    const stale = Object.entries(src).filter(([, v]) => v.cache === 'stale' || v.error);
    const el = $('stale');
    if (stale.length) {
      el.style.display = 'inline-block';
      el.textContent = '資料來源異常：' + stale.map(([k]) => k).join('、') + '（顯示為快取值）';
    } else el.style.display = 'none';

    $('hdrTime').textContent = '更新於 ' + new Date(c.generatedAt).toLocaleTimeString('zh-TW', { hour12: false });
  }

  // ---------- 方向檢視切換 ----------
  function syncViewing() {
    $('cellCW').classList.toggle('viewing', S.mode === 'windCW');
    $('cellCCW').classList.toggle('viewing', S.mode === 'windCCW');
  }
  function setMode(m) {
    S.mode = m;
    for (const b of $('modes').children) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
    syncViewing(); renderLegend(); renderMap(); renderProfile();
  }

  // ---------- 名詞說明 ----------
  function renderHelp() {
    const w = S.cond.wind, D = S.cond.direction.exposureDisplacement;
    $('windHelp').innerHTML =
      '<b>開闊地風</b>　沿路線等距取 ' + w.sampleCount + ' 點查 Open-Meteo 的 10 m 風，' +
      '以 u/v 分量向量平均（絕不平均角度）。模式輸出代表無遮蔽的開闊地。<br>' +
      '<b>測站向量平均</b>　氣象署路線周邊 ' + w.stationCount + ' 個海拔 &lt;200 m 的測站，' +
      '各自分解成 u/v 後平均。<br>' +
      '<b>遮蔽比 ' + w.shelterRatio + '×</b>　開闊地風 ÷ 測站「純量」平均風速。' +
      '大於 1 代表測站受樹木建物遮蔽而讀低；此值就是把開闊地風折減成市區風的經驗佐證。<br>' +
      '<b>|D| 加權位移 ' + D.magnitudeKm + ' km</b>　D = Σ kᵢ·t̂ᵢ·Δsᵢ，把每一小段的行進方向' +
      '用曝露度係數加權後相加。閉環使 Σt̂Δs=0，所以 D 只取決於 k 的<b>差值</b>。' +
      '時間差正比於 W·D。<br>' +
      '<b>臨界風向 ' + D.criticalFromDeg.map((x) => x.toFixed(0) + '°').join(' / ') + '</b>　' +
      'W 與 D 垂直之處，兩個方向等價。風從 ' + D.ccwCenterFromDeg.toFixed(0) + '° 來時最該逆時針，' +
      '從 ' + D.cwCenterFromDeg.toFixed(0) + '° 來時最該順時針。';

    $('arrowHelp').innerHTML =
      '箭頭畫在 Open-Meteo 的 <b>' + w.sampleCount + ' 個取樣點</b>上（沿路線等距），' +
      '指向風「吹往」的方向，長度隨風速。<br>' +
      '這些取樣點實際只落在 <b>' + w.gridCells + ' 個不同的模式格點</b>（格距約 8 km），' +
      '同色箭頭＝同一格點。所以真正的獨立風場分區只有 ' + w.gridCells + ' 區，' +
      '其餘是 IDW（power=2）內插的結果 —— 這也是為什麼模型解析不出河谷槽化。<br>' +
      '計算時再由這 ' + w.sampleCount + ' 點內插到全部 ' + S.route.segments.length + ' 個路段。' +
      '滑鼠移到箭頭可看該點原始值。';
  }

  function renderAll() {
    renderVerdict(); renderLegend(); renderCompass(); renderHelp();
    renderMap(); renderProfile(); renderTable(); renderMeta();
  }

  // ---------- 啟動 ----------
  (async function init() {
    S.route = await getJson('/data/route.json', '載入路線');
    if (!S.route.segments?.length) fail('route.json 沒有 segments，請先執行 npm run build:data');
    if (S.route.segments.some((s) => !s.exposure)) fail('有路段缺 exposure，請先執行 npm run sections');

    for (const s of S.route.segments) {
      const last = S.runs[S.runs.length - 1];
      if (last && last.label === s.sectionLabel) { last.endKm = s.s1 / 1000; last.segs.push(s); }
      else S.runs.push({ exposure: s.exposure, label: s.sectionLabel, phase: s.phase,
                         startKm: s.s0 / 1000, endKm: s.s1 / 1000, segs: [s] });
    }
    const M = S.route.meta;
    $('hdrRoute').textContent = M.totalKm.toFixed(2) + ' km · 爬升 ' + M.elevGainM + ' m · ' +
                                M.segments?.length + '';
    $('hdrRoute').textContent = M.totalKm.toFixed(2) + ' km · ' + S.route.segments.length + ' 段 · 爬升 ' + M.elevGainM + ' m';

    const pr = await getJson('/api/params', '讀取參數');
    const cur = pr.current;
    S.defaults = { pw: cur.targetPowerW, mk: cur.massKg, cda: cur.cdaM2, crr: cur.crr,
                   kr: cur.exposureK.riverside, ku: cur.exposureK.urban, km_: cur.exposureK.mountain };
    applyDefaults();

    S.stride = 1;
    const probe = await getJson('/api/conditions?full=1&' + paramQuery().replace('full=1&',''), '取得騎乘條件');
    S.cond = probe; S.stride = probe.displayStride || 1;
    initMap();
    renderAll();

    // 互動
    $('modes').addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-mode]');
      if (b) setMode(b.dataset.mode);
    });
    // 結論卡的兩欄也是方向切換鈕 —— 使用者直覺會先點那裡
    for (const id of ['cellCW', 'cellCCW']) $(id).onclick = () => setMode($(id).dataset.dir);

    let timer = null;
    const onParam = () => { syncOutputs(); clearTimeout(timer); timer = setTimeout(refresh, 260); };
    for (const id of ['pw', 'mk', 'cda', 'crr', 'kr', 'ku', 'km_']) $(id).addEventListener('input', onParam);
    $('reset').onclick = () => { applyDefaults(); refresh(); };

    $('tArrows').onchange = (e) => e.target.checked ? S.arrowLayer.addTo(S.map) : S.map.removeLayer(S.arrowLayer);
    $('tStations').onchange = (e) => e.target.checked ? S.stationLayer.addTo(S.map) : S.map.removeLayer(S.stationLayer);
    $('tRain').onchange = (e) => e.target.checked ? S.rainLayer.addTo(S.map) : S.map.removeLayer(S.rainLayer);

    const svg = $('svg');
    svg.addEventListener('mousemove', (ev) => {
      if (!S.pGeom) return;
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) / r.width * S.pGeom.W;
      const km = (px - S.pGeom.P.l) / (S.pGeom.W - S.pGeom.P.l - S.pGeom.P.r) * S.pGeom.kmMax;
      const i = Math.max(0, Math.min(S.route.segments.length - 1, Math.round(km * 1000 / S.route.meta.segmentLenM)));
      showSeg(i);
    });
    svg.addEventListener('mouseleave', clearCursor);

    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderProfile, 150); });
    setInterval(refresh, 10 * 60 * 1000);   // 每 10 分鐘自動更新
  })();

  function applyDefaults() {
    const d = S.defaults;
    for (const [id, v] of Object.entries(d)) $(id).value = v;
    syncOutputs();
  }
  function syncOutputs() {
    $('pwOut').textContent = $('pw').value + ' W';
    $('mkOut').textContent = $('mk').value + ' kg';
    $('cdaOut').textContent = (+$('cda').value).toFixed(3) + ' m²';
    $('crrOut').textContent = (+$('crr').value).toFixed(4);
    $('krOut').textContent = (+$('kr').value).toFixed(2);
    $('kuOut').textContent = (+$('ku').value).toFixed(2);
    $('kmOut').textContent = (+$('km_').value).toFixed(2);
    const c = +$('cda').value;
    $('cdaHint').textContent = c < 0.28 ? '計時車等級' : c < 0.35 ? '公路車下把/煎車花鼓'
                              : c < 0.45 ? '公路車上把' : '直身姿勢 / 登山車';
  }
})();
