/**
 * 磁碟快取的保留策略。
 *
 * 為什麼需要這支：雷達影格與雨量快照都是「一旦發布就不會變」的資料，
 * 所以快取永不過期 —— 但那是指「內容不會過期」，不是「檔案該永久保留」。
 * 兩者都是每 10 分鐘 / 每小時新增一筆，沒有清理就會無限成長。
 *
 * 實測成長率（持續開著）：
 *   雷達影格  約 120 KB x 6/小時  = 17 MB/日
 *   雨量快照  約  29 KB x 24/日   = 0.7 MB/日
 *
 * 保留量的依據是「還會不會被用到」，不是「還有沒有空間」：
 *   雷達  臨近預報只需要最新 + 10 分鐘前共 2 張。保留 6 張（1 小時）
 *         讓影格偶爾缺漏時仍能找到可用的前一張。
 *   雨量  水膜模型用近 6 小時的整點快照。保留 12 小時，留一倍餘裕。
 *
 * 同時以「時間」為第二道防線：即使數量沒超過，超過保留時數的檔案也一律刪除。
 * 只靠數量的話，隔了三天再開會留著三天前的舊檔，而那些檔案已經毫無用處。
 */
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const RETENTION = {
  radar: { keep: 6, maxAgeH: 3 },
  rain: { keep: 12, maxAgeH: 26 },
};

/** 由檔名取出觀測時刻。無法解析者回傳 null（交由 mtime 判斷）。 */
function stampOf(name) {
  // frame-YYYYMMDD-HHmm.json
  let m = /^frame-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.json$/.exec(name);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  // rain-YYYYMMDD-HH.json
  m = /^rain-(\d{4})(\d{2})(\d{2})-(\d{2})\.json$/.exec(name);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4]).getTime();
  return null;
}

async function pruneGroup(dir, files, { keep, maxAgeH }, now) {
  const cutoff = now - maxAgeH * 3600e3;
  const items = [];
  for (const f of files) {
    let t = stampOf(f);
    if (t === null) {
      // 舊版命名或來路不明的殘檔：以 mtime 判斷，過期即刪
      try { t = (await stat(join(dir, f))).mtimeMs; } catch { continue; }
    }
    items.push({ f, t });
  }
  items.sort((a, b) => b.t - a.t);                 // 新的在前

  const doomed = [];
  items.forEach((it, i) => {
    if (i >= keep || it.t < cutoff) doomed.push(it.f);
  });
  let bytes = 0;
  for (const f of doomed) {
    try {
      const s = await stat(join(dir, f));
      await unlink(join(dir, f));
      bytes += s.size;
    } catch { /* 已被刪除或鎖住，忽略 */ }
  }
  return { removed: doomed.length, bytes, kept: items.length - doomed.length };
}

/**
 * 清理雷達影格與雨量快照。
 * @param cacheDir data/cache 的絕對路徑
 */
export async function pruneCache(cacheDir, { quiet = true } = {}) {
  const now = Date.now();
  const out = { radar: null, rain: null };
  try {
    const radarDir = join(cacheDir, 'radar');
    const files = (await readdir(radarDir)).filter((f) => f.startsWith('frame-'));
    out.radar = await pruneGroup(radarDir, files, RETENTION.radar, now);
  } catch { out.radar = { removed: 0, bytes: 0, kept: 0 }; }
  try {
    const files = (await readdir(cacheDir)).filter((f) => /^rain-.*\.json$/.test(f));
    out.rain = await pruneGroup(cacheDir, files, RETENTION.rain, now);
  } catch { out.rain = { removed: 0, bytes: 0, kept: 0 }; }

  const total = (out.radar?.removed ?? 0) + (out.rain?.removed ?? 0);
  if (total && !quiet) {
    const kb = Math.round(((out.radar?.bytes ?? 0) + (out.rain?.bytes ?? 0)) / 1024);
    console.log('[cache] 清理 ' + total + ' 個檔案（' + kb + ' KB）：雷達留 ' +
                out.radar.kept + '、雨量留 ' + out.rain.kept);
  }
  return out;
}
