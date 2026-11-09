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
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const pathModule = require('node:path');
const zlib = require('node:zlib');

const UPSTREAM_HOST = 'api.kilo.ai';
const UPSTREAM_BASE = '/api/gateway';
const PORT = Number(process.env.PORT || 8899);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const CAPABILITIES_FILE = pathModule.join(ROOT, 'lib', 'model-capabilities.json');
const CLIENT_GUIDE_FILE = pathModule.join(ROOT, 'docs', 'client-guides', 'third-party-api-setup.html');
const PUBLIC_ASSETS = new Map([
  ['/assets/dashboard.css', { file: pathModule.join(ROOT, 'public', 'assets', 'dashboard.css'), type: 'text/css; charset=utf-8' }],
  ['/assets/dashboard.js', { file: pathModule.join(ROOT, 'public', 'assets', 'dashboard.js'), type: 'text/javascript; charset=utf-8' }],
]);
const WORKBUDDY_SKILL_DIR = pathModule.join(ROOT, '..', 'configure-workbuddy-easyai-model');
// 本机网关可选口令：设置后客户端需带 Authorization: Bearer <key>。
const LOCAL_KEY = process.env.LOCAL_KEY || '';

const USER_DATA_DIR = process.env.EASYAI_DATA_DIR || pathModule.join(
  process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || pathModule.join(os.homedir(), 'AppData', 'Local'))
    : process.platform === 'darwin'
      ? pathModule.join(os.homedir(), 'Library', 'Application Support')
      : (process.env.XDG_DATA_HOME || pathModule.join(os.homedir(), '.local', 'share')),
  'easyAI',
  'kilo-free-gateway',
);
const VAULT_FILE = process.env.EASYAI_VAULT_PATH || pathModule.join(USER_DATA_DIR, 'vault.json');
const VAULT_PROVIDERS = {
  sensenova: 'SenseNova（商汤日日新）',
  internlm: '书生·端砚（InternLM）',
};
const VAULT_PASSWORD_MIN_LENGTH = 12;

// SenseNova 配置（支持通过环境变量覆盖，用于测试）
const SENSENOVA_HOST = process.env.SENSENOVA_HOST || 'token.sensenova.cn';
const SENSENOVA_BASE = process.env.SENSENOVA_BASE || '/v1';

// InternLM (书生·端砚) 配置
const INTERNLM_HOST = process.env.INTERNLM_HOST || 'discovery-api.intern-ai.org.cn';
const INTERNLM_BASE = process.env.INTERNLM_BASE || '/v1';

let vaultKey = null;
let vaultSecrets = null;

const UPSTREAM_HEADERS = {
  'content-type': 'application/json',
  accept: '*/*',
  'user-agent': 'kilo-free-gateway/1.0',
};

const SENSENOVA_UPSTREAM_HEADERS = {
  'content-type': 'application/json',
  accept: '*/*',
  'user-agent': 'kilo-free-gateway/1.0',
};

const INTERNLM_UPSTREAM_HEADERS = {
  'content-type': 'application/json',
  accept: '*/*',
  'user-agent': 'kilo-free-gateway/1.0',
};

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

class VaultError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function deriveVaultKey(password, salt) {
  return crypto.scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function encryptVault(secrets, key, salt) {
  const iv = crypto.randomBytes(12);
  const metadata = {
    version: 1,
    salt: salt.toString('base64'),
    providers: Object.keys(secrets),
  };
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(metadata)));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(secrets), 'utf8'),
    cipher.final(),
  ]);
  return {
    ...metadata,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    providers: Object.keys(secrets),
    ciphertext: encrypted.toString('base64'),
  };
}

function decryptVault(envelope, key) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify({
      version: envelope.version,
      salt: envelope.salt,
      providers: envelope.providers,
    })));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    const secrets = JSON.parse(plaintext);
    if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
      throw new Error('invalid vault content');
    }
    return secrets;
  } catch {
    throw new VaultError(401, '密码不正确，或凭据库文件已损坏');
  }
}

async function readVaultEnvelope() {
  let contents;
  try {
    contents = await fs.promises.readFile(VAULT_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const envelope = JSON.parse(contents);
  if (
    envelope.version !== 1
    || !Array.isArray(envelope.providers)
    || typeof envelope.salt !== 'string'
    || typeof envelope.iv !== 'string'
    || typeof envelope.tag !== 'string'
    || typeof envelope.ciphertext !== 'string'
  ) {
    throw new Error('凭据库格式无效');
  }
  return envelope;
}

async function writeVaultEnvelope(envelope) {
  await fs.promises.mkdir(pathModule.dirname(VAULT_FILE), { recursive: true, mode: 0o700 });
  const temporaryFile = `${VAULT_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let file;
  try {
    file = await fs.promises.open(temporaryFile, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    await file.sync();
    await file.close();
    file = null;
    await fs.promises.rename(temporaryFile, VAULT_FILE);
    if (process.platform !== 'win32') {
      await fs.promises.chmod(VAULT_FILE, 0o600);
    }
  } catch (error) {
    if (file) await file.close();
    try {
      await fs.promises.unlink(temporaryFile);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    }
    throw error;
  }
}

async function saveVault(secrets, key, salt) {
  await writeVaultEnvelope(encryptVault(secrets, key, salt));
}

async function getVaultStatus() {
  const envelope = await readVaultEnvelope();
  return {
    initialized: Boolean(envelope),
    unlocked: Boolean(vaultKey && vaultSecrets),
    providers: Object.entries(VAULT_PROVIDERS).map(([id, name]) => ({
      id,
      name,
      configured: Boolean(envelope?.providers.includes(id)),
    })),
  };
}

function validateVaultPassword(password) {
  if (typeof password !== 'string' || password.length < VAULT_PASSWORD_MIN_LENGTH) {
    throw new VaultError(400, `主密码至少需要 ${VAULT_PASSWORD_MIN_LENGTH} 个字符`);
  }
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

function requestSenseNova(pathname, method = 'GET', body = undefined, apiKey = undefined) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { ...SENSENOVA_UPSTREAM_HEADERS };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    if (payload) headers['content-length'] = Buffer.byteLength(payload);
    if (method !== 'GET') headers.accept = 'text/event-stream';

    const req = https.request(
      { hostname: SENSENOVA_HOST, path: SENSENOVA_BASE + pathname, method, headers },
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
    req.setTimeout(30000, () => req.destroy(new Error('sensenova request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestInternLM(pathname, method = 'GET', body = undefined, apiKey = undefined) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { ...INTERNLM_UPSTREAM_HEADERS };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    if (payload) headers['content-length'] = Buffer.byteLength(payload);
    if (method !== 'GET') headers.accept = 'text/event-stream';

    const req = https.request(
      { hostname: INTERNLM_HOST, path: INTERNLM_BASE + pathname, method, headers },
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
    req.setTimeout(30000, () => req.destroy(new Error('internlm request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
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

/** 转发到 Kilo 上游。stream=true 时把响应体直接管道回客户端。 */
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

/** 转发到 SenseNova 上游。stream=true 时把响应体直接管道回客户端。 */
function upstreamSenseNova(pathname, method, body, res, { stream, model, apiKey }) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = { ...SENSENOVA_UPSTREAM_HEADERS };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (payload) headers['content-length'] = Buffer.byteLength(payload);
  if (stream) headers.accept = 'text/event-stream';
  const startedAt = Date.now();

  const req = https.request(
    { hostname: SENSENOVA_HOST, path: SENSENOVA_BASE + pathname, method, headers },
    (up) => {
      res.writeHead(up.statusCode || 502, forwardedHeaders(up, stream));
      up.pipe(res);
      up.on('end', () => {
        const retryAfter = up.headers['retry-after'];
        log(`<- SenseNova ${up.statusCode} ${method} ${pathname} model=${model || '-'} ${Date.now() - startedAt}ms${retryAfter ? ` retry-after=${retryAfter}` : ''}`);
      });
    },
  );

  req.on('error', (e) => {
    log(`!! SenseNova upstream error ${method} ${pathname} model=${model || '-'}: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'upstream_error', message: e.message } }));
    } else res.end();
  });

  if (payload) req.write(payload);
  req.end();
}

/** 转发到 InternLM (书生·端砚) 上游。stream=true 时把响应体直接管道回客户端。 */
function upstreamInternLM(pathname, method, body, res, { stream, model, apiKey }) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = { ...INTERNLM_UPSTREAM_HEADERS };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (payload) headers['content-length'] = Buffer.byteLength(payload);
  if (stream) headers.accept = 'text/event-stream';
  const startedAt = Date.now();

  const req = https.request(
    { hostname: INTERNLM_HOST, path: INTERNLM_BASE + pathname, method, headers },
    (up) => {
      res.writeHead(up.statusCode || 502, forwardedHeaders(up, stream));
      up.pipe(res);
      up.on('end', () => {
        const retryAfter = up.headers['retry-after'];
        log(`<- InternLM ${up.statusCode} ${method} ${pathname} model=${model || '-'} ${Date.now() - startedAt}ms${retryAfter ? ` retry-after=${retryAfter}` : ''}`);
      });
    },
  );

  req.on('error', (e) => {
    log(`!! InternLM upstream error ${method} ${pathname} model=${model || '-'}: ${e.message}`);
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

function zipSingleFile(name, content) {
  const filename = Buffer.from(name, 'utf8');
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const compressed = zlib.deflateRawSync(data);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x0800, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(filename.length, 26);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0x0800, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(data.length, 24);
  centralHeader.writeUInt16LE(filename.length, 28);
  centralHeader.writeUInt32LE(0, 42);

  const localRecord = Buffer.concat([localHeader, filename, compressed]);
  const centralRecord = Buffer.concat([centralHeader, filename]);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  endRecord.writeUInt32LE(centralRecord.length, 12);
  endRecord.writeUInt32LE(localRecord.length, 16);
  return Buffer.concat([localRecord, centralRecord, endRecord]);
}

function isSenseNovaModel(modelId) {
  if (!modelId || typeof modelId !== 'string') return false;
  // SenseNova 模型通常以 sensenova/ 开头
  // 也可以扩展为从目录缓存中查询
  return modelId.startsWith('sensenova/') || modelId.startsWith('sense-nova/');
}

function isInternLMModel(modelId) {
  if (!modelId || typeof modelId !== 'string') return false;
  // InternLM 模型通常以 internlm/ 开头
  return modelId.startsWith('internlm/');
}

/** 本地口令校验（仅在设置了 LOCAL_KEY 时生效）。 */
function authorized(req) {
  if (!LOCAL_KEY) return true;
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  return got === LOCAL_KEY || req.headers['x-api-key'] === LOCAL_KEY;
}

function validVaultOrigin(req) {
  if (!req.headers.origin) return true;
  try {
    const origin = new URL(req.headers.origin);
    const requestHost = (req.headers.host || '').toLowerCase();
    return origin.protocol === 'http:' && origin.host.toLowerCase() === requestHost;
  } catch {
    return false;
  }
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
  if (req.method === 'GET' && PUBLIC_ASSETS.has(path)) {
    const asset = PUBLIC_ASSETS.get(path);
    try {
      const contents = await fs.promises.readFile(asset.file);
      res.writeHead(200, {
        'content-type': asset.type,
        'content-length': contents.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      return res.end(contents);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return json(res, 404, { error: { type: 'not_found', message: 'Dashboard asset is not installed' } });
      }
      throw error;
    }
  }
  if (req.method === 'GET' && path === '/docs/client-guides/third-party-api-setup.html') {
    try {
      const guide = await fs.promises.readFile(CLIENT_GUIDE_FILE);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': guide.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      return res.end(guide);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return json(res, 404, { error: { type: 'not_found', message: 'Client setup guide is not installed' } });
      }
      throw error;
    }
  }

  if (!authorized(req)) {
    return json(res, 401, { error: { type: 'authentication_error', message: 'local gateway: bad or missing key' } });
  }

  try {
    if (path.startsWith('/api/vault/')) {
      if (!validVaultOrigin(req)) {
        return json(res, 403, { error: { type: 'forbidden', message: '凭据库只允许从本机控制台访问' } });
      }

      if (path === '/api/vault/status' && req.method === 'GET') {
        return json(res, 200, await getVaultStatus(), { 'cache-control': 'no-store' });
      }

      if (path === '/api/vault/setup' && req.method === 'POST') {
        const body = await readBody(req);
        validateVaultPassword(body?.password);
        if (await readVaultEnvelope()) {
          throw new VaultError(409, '凭据库已经初始化，请使用解锁操作');
        }
        const salt = crypto.randomBytes(16);
        const key = deriveVaultKey(body.password, salt);
        try {
          await saveVault({}, key, salt);
          vaultKey = key;
          vaultSecrets = {};
        } catch (error) {
          key.fill(0);
          throw error;
        }
        return json(res, 201, await getVaultStatus(), { 'cache-control': 'no-store' });
      }

      if (path === '/api/vault/unlock' && req.method === 'POST') {
        const body = await readBody(req);
        if (typeof body?.password !== 'string' || !body.password) {
          throw new VaultError(400, '请输入凭据库主密码');
        }
        const envelope = await readVaultEnvelope();
        if (!envelope) throw new VaultError(404, '凭据库尚未初始化');
        vaultKey?.fill(0);
        vaultKey = null;
        vaultSecrets = null;
        const key = deriveVaultKey(body.password, Buffer.from(envelope.salt, 'base64'));
        try {
          vaultSecrets = decryptVault(envelope, key);
        } catch (error) {
          key.fill(0);
          throw error;
        }
        vaultKey?.fill(0);
        vaultKey = key;
        return json(res, 200, await getVaultStatus(), { 'cache-control': 'no-store' });
      }

      if (path === '/api/vault/lock' && req.method === 'POST') {
        vaultKey?.fill(0);
        vaultKey = null;
        vaultSecrets = null;
        return json(res, 200, await getVaultStatus(), { 'cache-control': 'no-store' });
      }

      const providerMatch = path.match(/^\/api\/vault\/providers\/([a-z0-9-]+)$/);
      if (providerMatch && ['PUT', 'DELETE'].includes(req.method)) {
        const providerId = providerMatch[1];
        if (!VAULT_PROVIDERS[providerId]) {
          return json(res, 404, { error: { type: 'not_found', message: '不支持的服务商' } });
        }
        if (!vaultKey || !vaultSecrets) {
          throw new VaultError(423, '请先解锁本机凭据库');
        }
        const envelope = await readVaultEnvelope();
        if (!envelope) throw new VaultError(404, '凭据库尚未初始化');
        const updatedSecrets = { ...vaultSecrets };
        if (req.method === 'PUT') {
          const body = await readBody(req);
          if (typeof body?.key !== 'string' || !body.key.trim() || body.key.trim().length > 4096) {
            throw new VaultError(400, '请输入有效的服务商 API Key（最多 4096 个字符）');
          }
          updatedSecrets[providerId] = body.key.trim();
        } else {
          delete updatedSecrets[providerId];
        }
        const salt = Buffer.from(envelope.salt, 'base64');
        await saveVault(updatedSecrets, vaultKey, salt);
        vaultSecrets = updatedSecrets;
        return json(res, 200, await getVaultStatus(), { 'cache-control': 'no-store' });
      }

      return json(res, 404, { error: { type: 'not_found', message: `no route for ${req.method} ${path}` } });
    }

    if (path === '/api/workbuddy-skill' && req.method === 'GET') {
      const skill = await fs.promises.readFile(pathModule.join(WORKBUDDY_SKILL_DIR, 'SKILL.md'));
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-length': skill.length,
        'cache-control': 'no-store',
      });
      return res.end(skill);
    }
    if (path === '/api/workbuddy-skill.zip' && req.method === 'GET') {
      const skill = await fs.promises.readFile(pathModule.join(WORKBUDDY_SKILL_DIR, 'SKILL.md'));
      const archive = zipSingleFile('configure-workbuddy-easyai-model/SKILL.md', skill);
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-length': archive.length,
        'content-disposition': 'attachment; filename="configure-workbuddy-easyai-model.zip"',
        'cache-control': 'no-store',
      });
      return res.end(archive);
    }
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
        provider: 'kilo',
      }));
      return json(res, 200, { data: models, checked_at: new Date().toISOString() });
    }

    // SenseNova 目录端点：仅在凭据库解锁且配置了 Key 时可用
    if (path === '/api/sensenova/catalog' && req.method === 'GET') {
      if (!vaultKey || !vaultSecrets) {
        return json(res, 423, { error: { type: 'vault_locked', message: '请先解锁本机凭据库' } }, { 'cache-control': 'no-store' });
      }
      const sensenovaKey = vaultSecrets.sensenova;
      if (!sensenovaKey) {
        return json(res, 404, { error: { type: 'not_configured', message: '尚未配置 SenseNova Key' } }, { 'cache-control': 'no-store' });
      }
      let up;
      try {
        up = await requestSenseNova('/models', 'GET', undefined, sensenovaKey);
      } catch (e) {
        log(`!! SenseNova error GET /models: ${e.message}`);
        return json(res, 502, { error: { type: 'upstream_error', message: e.message } }, { 'cache-control': 'no-store' });
      }
      const retryAfter = up.headers['retry-after'];
      log(`<- SenseNova ${up.statusCode} GET /models${retryAfter ? ` retry-after=${retryAfter}` : ''}`);
      if (up.statusCode < 200 || up.statusCode >= 300) {
        return json(res, up.statusCode, {
          error: { type: 'upstream_error', message: 'Could not load SenseNova model catalog', details: up.body },
          retry_after: up.headers['retry-after'] || null,
        }, retryAfter ? { 'retry-after': retryAfter } : { 'cache-control': 'no-store' });
      }
      let catalog;
      try {
        catalog = JSON.parse(up.body);
      } catch {
        return json(res, 502, { error: { type: 'upstream_error', message: 'SenseNova model catalog has an invalid format' } }, { 'cache-control': 'no-store' });
      }
      if (!Array.isArray(catalog.data)) {
        return json(res, 502, { error: { type: 'upstream_error', message: 'SenseNova model catalog data is not an array' } }, { 'cache-control': 'no-store' });
      }
      const models = catalog.data.map((model) => ({
        ...model,
        provider: 'sensenova',
        upstream: 'sensenova',
      }));
      return json(res, 200, { data: models, checked_at: new Date().toISOString() }, { 'cache-control': 'no-store' });
    }

    // InternLM (书生·端砚) 目录端点：仅在凭据库解锁且配置了 Key 时可用
    if (path === '/api/internlm/catalog' && req.method === 'GET') {
      if (!vaultKey || !vaultSecrets) {
        return json(res, 423, { error: { type: 'vault_locked', message: '请先解锁本机凭据库' } }, { 'cache-control': 'no-store' });
      }
      const internlmKey = vaultSecrets.internlm;
      if (!internlmKey) {
        return json(res, 404, { error: { type: 'not_configured', message: '尚未配置 InternLM Key' } }, { 'cache-control': 'no-store' });
      }
      let up;
      try {
        up = await requestInternLM('/models', 'GET', undefined, internlmKey);
      } catch (e) {
        log(`!! InternLM error GET /models: ${e.message}`);
        return json(res, 502, { error: { type: 'upstream_error', message: e.message } }, { 'cache-control': 'no-store' });
      }
      const retryAfter = up.headers['retry-after'];
      log(`<- InternLM ${up.statusCode} GET /models${retryAfter ? ` retry-after=${retryAfter}` : ''}`);
      if (up.statusCode < 200 || up.statusCode >= 300) {
        return json(res, up.statusCode, {
          error: { type: 'upstream_error', message: 'Could not load InternLM model catalog', details: up.body },
          retry_after: up.headers['retry-after'] || null,
        }, retryAfter ? { 'retry-after': retryAfter } : { 'cache-control': 'no-store' });
      }
      let catalog;
      try {
        catalog = JSON.parse(up.body);
      } catch {
        return json(res, 502, { error: { type: 'upstream_error', message: 'InternLM model catalog has an invalid format' } }, { 'cache-control': 'no-store' });
      }
      if (!Array.isArray(catalog.data)) {
        return json(res, 502, { error: { type: 'upstream_error', message: 'InternLM model catalog data is not an array' } }, { 'cache-control': 'no-store' });
      }
      const models = catalog.data.map((model) => ({
        ...model,
        provider: 'internlm',
        upstream: 'internlm',
      }));
      return json(res, 200, { data: models, checked_at: new Date().toISOString() }, { 'cache-control': 'no-store' });
    }

    // SenseNova 测试端点
    if (path === '/api/sensenova/test' && req.method === 'POST') {
      if (!vaultKey || !vaultSecrets) {
        return json(res, 423, { error: { type: 'vault_locked', message: '请先解锁本机凭据库' } }, { 'cache-control': 'no-store' });
      }
      const sensenovaKey = vaultSecrets.sensenova;
      if (!sensenovaKey) {
        return json(res, 404, { error: { type: 'not_configured', message: '尚未配置 SenseNova Key' } }, { 'cache-control': 'no-store' });
      }
      const body = await readBody(req);
      if (typeof body?.model !== 'string' || !body.model.trim()) {
        return json(res, 400, { error: { type: 'invalid_request', message: 'model is required' } }, { 'cache-control': 'no-store' });
      }
      const prompt = typeof body.prompt === 'string' && body.prompt.trim()
        ? body.prompt.trim().slice(0, 2000)
        : 'Reply with OK.';
      return upstreamSenseNova('/chat/completions', 'POST', {
        model: body.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 128,
      }, res, { stream: false, model: body.model, apiKey: sensenovaKey });
    }

    // InternLM (书生·端砚) 测试端点
    if (path === '/api/internlm/test' && req.method === 'POST') {
      if (!vaultKey || !vaultSecrets) {
        return json(res, 423, { error: { type: 'vault_locked', message: '请先解锁本机凭据库' } }, { 'cache-control': 'no-store' });
      }
      const internlmKey = vaultSecrets.internlm;
      if (!internlmKey) {
        return json(res, 404, { error: { type: 'not_configured', message: '尚未配置 InternLM Key' } }, { 'cache-control': 'no-store' });
      }
      const body = await readBody(req);
      if (typeof body?.model !== 'string' || !body.model.trim()) {
        return json(res, 400, { error: { type: 'invalid_request', message: 'model is required' } }, { 'cache-control': 'no-store' });
      }
      const prompt = typeof body.prompt === 'string' && body.prompt.trim()
        ? body.prompt.trim().slice(0, 2000)
        : 'Reply with OK.';
      return upstreamInternLM('/chat/completions', 'POST', {
        model: body.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 128,
      }, res, { stream: false, model: body.model, apiKey: internlmKey });
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
      // 判断是否为 SenseNova 模型（通过 provider 字段或模型 ID 前缀）
      const isSenseNova = isSenseNovaModel(body.model);
      if (isSenseNova) {
        if (!vaultKey || !vaultSecrets || !vaultSecrets.sensenova) {
          return json(res, 403, { error: { type: 'forbidden', message: 'SenseNova 模型需要先在凭据库中配置并解锁 Key' } });
        }
        return upstreamSenseNova('/chat/completions', 'POST', body, res, { stream: body.stream === true, model: body.model, apiKey: vaultSecrets.sensenova });
      }
      // 判断是否为 InternLM 模型（模型 ID 以 internlm/ 开头）
      const isInternLM = isInternLMModel(body.model);
      if (isInternLM) {
        if (!vaultKey || !vaultSecrets || !vaultSecrets.internlm) {
          return json(res, 403, { error: { type: 'forbidden', message: 'InternLM 模型需要先在凭据库中配置并解锁 Key' } });
        }
        return upstreamInternLM('/chat/completions', 'POST', body, res, { stream: body.stream === true, model: body.model, apiKey: vaultSecrets.internlm });
      }
      return upstream('/chat/completions', 'POST', body, res, { stream: body.stream === true, model: body.model });
    }
    if (path === '/v1/messages' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body?.model) return json(res, 400, { error: { type: 'invalid_request', message: 'model is required' } });
      const isSenseNova = isSenseNovaModel(body.model);
      if (isSenseNova) {
        if (!vaultKey || !vaultSecrets || !vaultSecrets.sensenova) {
          return json(res, 403, { error: { type: 'forbidden', message: 'SenseNova 模型需要先在凭据库中配置并解锁 Key' } });
        }
        return upstreamSenseNova('/v1/messages', 'POST', body, res, { stream: body.stream === true, model: body.model, apiKey: vaultSecrets.sensenova });
      }
      const isInternLM = isInternLMModel(body.model);
      if (isInternLM) {
        if (!vaultKey || !vaultSecrets || !vaultSecrets.internlm) {
          return json(res, 403, { error: { type: 'forbidden', message: 'InternLM 模型需要先在凭据库中配置并解锁 Key' } });
        }
        return upstreamInternLM('/v1/messages', 'POST', body, res, { stream: body.stream === true, model: body.model, apiKey: vaultSecrets.internlm });
      }
      return upstream('/v1/messages', 'POST', body, res, { stream: body.stream === true, model: body.model });
    }
    if (path === '/v1/responses' && req.method === 'POST') {
      const body = await readBody(req);
      const isSenseNova = isSenseNovaModel(body?.model);
      if (isSenseNova) {
        if (!vaultKey || !vaultSecrets || !vaultSecrets.sensenova) {
          return json(res, 403, { error: { type: 'forbidden', message: 'SenseNova 模型需要先在凭据库中配置并解锁 Key' } });
        }
        return upstreamSenseNova('/responses', 'POST', body, res, { stream: body?.stream === true, model: body?.model, apiKey: vaultSecrets.sensenova });
      }
      const isInternLM = isInternLMModel(body?.model);
      if (isInternLM) {
        if (!vaultKey || !vaultSecrets || !vaultSecrets.internlm) {
          return json(res, 403, { error: { type: 'forbidden', message: 'InternLM 模型需要先在凭据库中配置并解锁 Key' } });
        }
        return upstreamInternLM('/responses', 'POST', body, res, { stream: body?.stream === true, model: body?.model, apiKey: vaultSecrets.internlm });
      }
      return upstream('/responses', 'POST', body, res, { stream: body?.stream === true, model: body?.model });
    }
    return json(res, 404, { error: { type: 'not_found', message: `no route for ${req.method} ${path}` } });
  } catch (e) {
    if (e instanceof VaultError) {
      return json(res, e.status, { error: { type: 'vault_error', message: e.message } }, { 'cache-control': 'no-store' });
    }
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
