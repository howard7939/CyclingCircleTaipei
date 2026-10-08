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
