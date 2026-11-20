/**
 * 零依赖 HTTP 服务：REST API + 前端静态文件。
 *
 * 启动：node server.js [--port 3000] [--reset]
 * 数据：data/store.json（首次启动从 data/sample-data.json 播种）
 */

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { CaseStore } from './src/store.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 3000;
const RESET = args.includes('--reset');
const STORE_PATH = join(ROOT, 'data', 'store.json');
const SEED_PATH = join(ROOT, 'data', 'sample-data.json');
const PUBLIC = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

if (RESET && existsSync(STORE_PATH)) {
  const { rmSync } = await import('node:fs');
  rmSync(STORE_PATH);
}

const seed = JSON.parse(await readFile(SEED_PATH, 'utf8'));
const store = new CaseStore(STORE_PATH).load(seed);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'] });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p.startsWith('/api/')) return await handleApi(req, res, p, url);
    return await serveStatic(res, p);
  } catch (err) {
    const status = err.statusCode || 400;
    json(res, status, { error: err.message });
  }
});

async function handleApi(req, res, p, url) {
  const method = req.method;

  // GET /api/case —— 首屏完整视图
  if (p === '/api/case' && method === 'GET') {
    return json(res, 200, store.currentView());
  }

  // POST /api/events —— 追加证据并重算
  if (p === '/api/events' && method === 'POST') {
    const body = await readBody(req);
    const result = store.appendEvents(body.events || [body]);
    return json(res, 201, result);
  }

  // POST /api/judgments —— 人工确认/排除（黏滞）
  if (p === '/api/judgments' && method === 'POST') {
    const body = await readBody(req);
    const result = store.addJudgment(body);
    return json(res, 201, result);
  }

  // POST /api/remediation/:breachId/transition
  let m = p.match(/^\/api\/remediation\/([^/]+)\/transition$/);
  if (m && method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, store.transitionRemediation(decodeURIComponent(m[1]), body));
  }

  // POST /api/remediation/:breachId/assign
  m = p.match(/^\/api\/remediation\/([^/]+)\/assign$/);
  if (m && method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, store.assignRemediation(decodeURIComponent(m[1]), body.owner ?? null));
  }

  // GET /api/versions/:n —— 历史版本快照
  m = p.match(/^\/api\/versions\/(\d+)$/);
  if (m && method === 'GET') {
    return json(res, 200, store.getVersion(m[1]));
  }

  // GET /api/diff?from=1&to=2 —— 版本对比
  if (p === '/api/diff' && method === 'GET') {
    return json(res, 200, store.diff(url.searchParams.get('from'), url.searchParams.get('to')));
  }

  // POST /api/reset —— 用种子数据重建（演示用）
  if (p === '/api/reset' && method === 'POST') {
    return json(res, 200, store.reset(seed));
  }

  // POST /api/seed —— 用上传的案例数据重建
  if (p === '/api/seed' && method === 'POST') {
    const body = await readBody(req);
    await writeFile(SEED_PATH, JSON.stringify(body, null, 2));
    return json(res, 200, store.reset(body));
  }

  json(res, 404, { error: `未知接口: ${method} ${p}` });
}

async function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    // 未知路径回退到 SPA 入口
    const index = await readFile(join(PUBLIC, 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(index);
  }
}

server.listen(PORT, () => {
  console.log(`SLA 违约根因分析工具已启动: http://localhost:${PORT}`);
  console.log(`数据文件: ${STORE_PATH}（当前版本 v${store.currentVersion.version}）`);
});
