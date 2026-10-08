/**
 * 伺服器端的模型入口：純計算部分來自 physics.mjs（可在瀏覽器跑），
 * 這裡只多加「從檔案載入參數」的能力 —— 那是唯一需要 Node 的部分。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PARAMS, USER_TUNABLE } from '../web/physics.mjs';

export * from '../web/physics.mjs';

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../data');
const PARAMS_FILE = resolve(DATA_DIR, 'model-params.json');
const PROFILE_FILE = resolve(DATA_DIR, 'rider-profile.json');

/**
 * 載入 data/model-params.json 的覆寫值（若不存在則用預設）。
 * 大聲驗證：型別錯誤或缺曝露度類別一律 throw，不要靜默回退到預設值，
 * 否則使用者改了檔案卻沒生效、而且不會知道。
 */
export function loadParams({ file = PARAMS_FILE, quiet = false, overrides = null } = {}) {
  // 疊加順序：內建預設 < 實測校正的車手參數 < 使用者的 model-params.json < 呼叫端覆寫
  let p0 = { ...DEFAULT_PARAMS };
  if (existsSync(PROFILE_FILE)) {
    try {
      const pr = JSON.parse(readFileSync(PROFILE_FILE, 'utf8'));
      for (const k of ['massKg', 'cdaM2', 'crr']) if (Number.isFinite(pr[k])) p0[k] = pr[k];
      p0._riderProfile = { r2: pr.r2, blocks: pr.blocks, method: pr.method, rideDate: pr.rideDate };
    } catch (e) { if (!quiet) console.warn('[warn] rider-profile.json 讀取失敗：' + e.message); }
  }

  if (!existsSync(file)) return applyOverridesLocal({ ...p0, _source: 'defaults+profile' }, overrides, quiet);

  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(file + ' 不是合法 JSON：' + e.message); }

  const p = { ...p0 };
  if (raw.exposureK !== undefined) {
    if (typeof raw.exposureK !== 'object' || raw.exposureK === null) {
      throw new Error('model-params.json 的 exposureK 必須是物件');
    }
    for (const cls of ['riverside', 'urban', 'mountain']) {
      const v = raw.exposureK[cls];
      if (v === undefined) throw new Error('model-params.json 的 exposureK 缺少 "' + cls + '"');
      if (!Number.isFinite(v) || v < 0 || v > 3) {
        throw new Error('model-params.json 的 exposureK.' + cls + ' = ' + JSON.stringify(v) +
                        '，必須是 0~3 的數字');
      }
    }
    p.exposureK = { ...raw.exposureK };
  }
  for (const key of ['rho', 'cdaM2', 'crr', 'massKg', 'minSpeedKmh', 'maxSpeedKmh', 'targetPowerW']) {
    if (raw[key] === undefined) continue;
    if (!Number.isFinite(raw[key]) || raw[key] <= 0) {
      throw new Error('model-params.json 的 ' + key + ' = ' + JSON.stringify(raw[key]) + '，必須是正數');
    }
    p[key] = raw[key];
  }
  if (raw.yawCorrection !== undefined) {
    if (typeof raw.yawCorrection !== 'boolean') throw new Error('model-params.json 的 yawCorrection 必須是 true/false');
    p.yawCorrection = raw.yawCorrection;
  }

  const ks = Object.values(p.exposureK);
  if (Math.max(...ks) - Math.min(...ks) < 1e-9 && !quiet) {
    console.warn('[warn] 三個 exposureK 相等 -> D = 0，方向偏好將恆為零（僅剩側風 yaw 的微量效應）。');
  }
  p._source = file;
  p._paramSource = raw.source ?? null;
  return applyOverridesLocal(p, overrides, quiet);
}


/** physics.mjs 的 applyOverrides 沒有匯出，這裡重做一份（同樣的驗證規則） */
function applyOverridesLocal(p, overrides, quiet) {
  if (!overrides) return p;
  const applied = {};
  for (const [k, spec] of Object.entries(USER_TUNABLE)) {
    const v = overrides[k];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(spec.label + ' 必須是數字，收到 ' + JSON.stringify(v));
    if (n < spec.min || n > spec.max) {
      throw new Error(spec.label + ' 必須在 ' + spec.min + ' ~ ' + spec.max + ' 之間，收到 ' + n);
    }
    p[k] = n; applied[k] = n;
  }
  if (overrides.exposureK && typeof overrides.exposureK === 'object') {
    const ek = { ...p.exposureK };
    for (const cls of ['riverside', 'urban', 'mountain']) {
      const v = overrides.exposureK[cls];
      if (v === undefined || v === null || v === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 3) throw new Error('exposureK.' + cls + ' 必須是 0~3 的數字');
      ek[cls] = n;
    }
    p.exposureK = ek; applied.exposureK = ek;
  }
  if (Object.keys(applied).length) p._overrides = applied;
  return p;
}
