#!/usr/bin/env node
/**
 * kilo-free-gateway — 把 Kilo AI 的公共免密池暴露成本机 OpenAI / Anthropic 兼容端点。
 *
 * 上游：https://api.kilo.ai/api/gateway（模型访问和额度由上游策略决定）
 * 监听：127.0.0.1:8899（默认）
 *
 * 提供：
 *   GET  /v1/models                列出免费池模型
 *   POST /v1/chat/completions      OpenAI Chat Completions（流式/非流式）
 *   POST /v1/messages              Anthropic Messages（流式/非流式，供 Claude Code）
 *   GET  /healthz                  健康检查
 *
 * 零依赖，Node >= 18。
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const pathModule = require('node:path');

const UPSTREAM_HOST = 'api.kilo.ai';
const UPSTREAM_BASE = '/api/gateway';
const PORT = Number(process.env.PORT || 8899);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const CAPABILITIES_FILE = pathModule.join(ROOT, 'lib', 'model-capabilities.json');
// 本机网关可选口令：设置后客户端需带 Authorization: Bearer <key>。
const LOCAL_KEY = process.env.LOCAL_KEY || '';

const UPSTREAM_HEADERS = {
  'content-type': 'application/json',
  accept: '*/*',
  'user-agent': 'kilo-free-gateway/1.0',
};

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

function requestUpstream(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: UPSTREAM_HOST, path: UPSTREAM_BASE + pathname, method: 'GET', headers: UPSTREAM_HEADERS },
      (up) => {
        const chunks = [];
        up.on('data', (chunk) => chunks.push(chunk));
        up.on('end', () => resolve({
          statusCode: up.statusCode || 502,
          headers: up.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.setTimeout(15000, () => req.destroy(new Error('upstream request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function forwardedHeaders(up, stream) {
  const headers = {};
  for (const name of ['content-type', 'retry-after', 'x-request-id']) {
    if (up.headers[name]) headers[name] = up.headers[name];
  }
  if (!stream && up.headers['content-length']) headers['content-length'] = up.headers['content-length'];
  if (stream) {
    headers['cache-control'] = 'no-cache';
    headers.connection = 'keep-alive';
    headers['x-accel-buffering'] = 'no';
  }
  return headers;
}

/** 转发到上游。stream=true 时把响应体直接管道回客户端。 */
function upstream(pathname, method, body, res, { stream, model }) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = { ...UPSTREAM_HEADERS };
  if (payload) headers['content-length'] = Buffer.byteLength(payload);
  if (stream) headers.accept = 'text/event-stream';
  const startedAt = Date.now();

  const req = https.request(
    { hostname: UPSTREAM_HOST, path: UPSTREAM_BASE + pathname, method, headers },
    (up) => {
      res.writeHead(up.statusCode || 502, forwardedHeaders(up, stream));
      up.pipe(res);
      up.on('end', () => {
        const retryAfter = up.headers['retry-after'];
        log(`<- ${up.statusCode} ${method} ${pathname} model=${model || '-'} ${Date.now() - startedAt}ms${retryAfter ? ` retry-after=${retryAfter}` : ''}`);
      });
    },
  );

  req.on('error', (e) => {
    log(`!! upstream error ${method} ${pathname} model=${model || '-'}: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'upstream_error', message: e.message } }));
    } else res.end();
  });

  if (payload) req.write(payload);
  req.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj, headers = {}) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

/** 本地口令校验（仅在设置了 LOCAL_KEY 时生效）。 */
function authorized(req) {
  if (!LOCAL_KEY) return true;
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  return got === LOCAL_KEY || req.headers['x-api-key'] === LOCAL_KEY;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  log(`-> ${req.method} ${path}`);

  if (path === '/healthz') return json(res, 200, { ok: true, upstream: UPSTREAM_HOST + UPSTREAM_BASE });
  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return fs.createReadStream(pathModule.join(ROOT, 'public', 'index.html')).pipe(res);
  }

  if (!authorized(req)) {
    return json(res, 401, { error: { type: 'authentication_error', message: 'local gateway: bad or missing key' } });
  }

  try {
    if (path === '/api/catalog' && req.method === 'GET') {
      let up;
      try {
        up = await requestUpstream('/models');
      } catch (e) {
        log(`!! upstream error GET /models: ${e.message}`);
        return json(res, 502, { error: { type: 'upstream_error', message: e.message } });
      }
      const retryAfter = up.headers['retry-after'];
      log(`<- ${up.statusCode} GET /models${retryAfter ? ` retry-after=${retryAfter}` : ''}`);
      if (up.statusCode < 200 || up.statusCode >= 300) {
        return json(res, up.statusCode, {
          error: { type: 'upstream_error', message: 'Could not load the upstream model catalog', details: up.body },
          retry_after: up.headers['retry-after'] || null,
        }, retryAfter ? { 'retry-after': retryAfter } : {});
      }
      const [catalog, capabilities] = await Promise.all([
        Promise.resolve(JSON.parse(up.body)),
        fs.promises.readFile(CAPABILITIES_FILE, 'utf8').then(JSON.parse),
      ]);
      if (!Array.isArray(catalog.data)) {
        return json(res, 502, { error: { type: 'upstream_error', message: 'Upstream model catalog has an invalid format' } });
      }
      const models = catalog.data.map((model) => ({
        ...model,
        ...(capabilities[model.id] || {}),
      }));
      return json(res, 200, { data: models, checked_at: new Date().toISOString() });
    }
    if (path === '/api/test' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body?.model !== 'string' || !body.model.trim()) {
        return json(res, 400, { error: { type: 'invalid_request', message: 'model is required' } });
      }
      const prompt = typeof body.prompt === 'string' && body.prompt.trim()
        ? body.prompt.trim().slice(0, 2000)
        : 'Reply with OK.';
      return upstream('/chat/completions', 'POST', {
        model: body.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 128,
      }, res, { stream: false, model: body.model });
    }
    if (path === '/v1/models' && req.method === 'GET') {
      return upstream('/models', 'GET', undefined, res, { stream: false });
    }
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body?.model) return json(res, 400, { error: { type: 'invalid_request', message: 'model is required' } });
      return upstream('/chat/completions', 'POST', body, res, { stream: body.stream === true, model: body.model });
    }
    if (path === '/v1/messages' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body?.model) return json(res, 400, { error: { type: 'invalid_request', message: 'model is required' } });
      return upstream('/v1/messages', 'POST', body, res, { stream: body.stream === true, model: body.model });
    }
    if (path === '/v1/responses' && req.method === 'POST') {
      const body = await readBody(req);
      return upstream('/responses', 'POST', body, res, { stream: body?.stream === true, model: body?.model });
    }
    return json(res, 404, { error: { type: 'not_found', message: `no route for ${req.method} ${path}` } });
  } catch (e) {
    const isInvalidRequest = e.message === 'invalid JSON body' || e.message === 'request body too large';
    return json(res, isInvalidRequest ? 400 : 500, {
      error: { type: isInvalidRequest ? 'invalid_request' : 'internal_error', message: e.message },
    });
  }
});

if (!['127.0.0.1', '::1', 'localhost'].includes(HOST) && !LOCAL_KEY) {
  console.error('[kilo] refusing to listen on a non-local host without LOCAL_KEY');
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  log(`kilo-free-gateway listening on http://${HOST}:${PORT}`);
  log(`  Dashboard         : http://${HOST}:${PORT}/`);
  log(`  OpenAI  base URL : http://${HOST}:${PORT}/v1`);
  log(`  Anthropic base   : http://${HOST}:${PORT}`);
  if (LOCAL_KEY) log('  local key required on every request');
});
