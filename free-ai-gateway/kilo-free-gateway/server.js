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
  scnet: '超算互联网（SCNet）',
};
const CUSTOM_PROVIDER_ID_PATTERN = /^custom-[^\s/]{1,80}$/iu;
const VAULT_PASSWORD_MIN_LENGTH = 12;

// SenseNova 配置（支持通过环境变量覆盖，用于测试）
const SENSENOVA_HOST = process.env.SENSENOVA_HOST || 'token.sensenova.cn';
const SENSENOVA_BASE = process.env.SENSENOVA_BASE || '/v1';

// InternLM (书生·端砚) 配置
const INTERNLM_HOST = process.env.INTERNLM_HOST || 'discovery-api.intern-ai.org.cn';
const INTERNLM_BASE = process.env.INTERNLM_BASE || '/v1';
const SCNET_HOST = process.env.SCNET_HOST || 'api.scnet.cn';
const SCNET_OPENAI_BASE = '/api/llm/v1';
const SCNET_ANTHROPIC_BASE = '/api/llm/anthropic';

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

const SCNET_UPSTREAM_HEADERS = {
  'content-type': 'application/json',
  accept: '*/*',
  'user-agent': 'kilo-free-gateway/1.0',
};

const LOG_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function log(...args) {
  console.log(LOG_TIME_FORMATTER.format(new Date()), ...args);
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
  if (envelope && vaultKey && vaultSecrets) {
    const legacyIds = Object.keys(vaultSecrets).filter((id) => /^custom-[a-f0-9-]{36}$/i.test(id));
    if (legacyIds.length) {
      const updatedSecrets = { ...vaultSecrets };
      const updatedProviders = new Set(envelope.providers);
      for (const legacyId of legacyIds) {
        const config = updatedSecrets[legacyId];
        if (!config || typeof config.name !== 'string') continue;
        const newId = createCustomProviderId(config.name, updatedSecrets);
        if (newId === legacyId) continue;
        updatedSecrets[newId] = { ...updatedSecrets[legacyId], legacyId };
        delete updatedSecrets[legacyId];
        updatedProviders.delete(legacyId);
        updatedProviders.add(newId);
      }
      await saveVault(updatedSecrets, vaultKey, Buffer.from(envelope.salt, 'base64'));
      vaultSecrets = updatedSecrets;
      envelope.providers = [...updatedProviders];
    }
  }
  const providerIds = new Set(envelope?.providers || []);
  const customProviders = [...providerIds]
    .filter((id) => CUSTOM_PROVIDER_ID_PATTERN.test(id))
    .map((id) => {
      const saved = vaultSecrets?.[id];
      return {
        id,
        name: saved?.name || id,
        baseUrl: saved?.baseUrl || '',
        configured: providerIds.has(id),
        custom: true,
      };
    });
  return {
    initialized: Boolean(envelope),
    unlocked: Boolean(vaultKey && vaultSecrets),
    providers: [
      ...Object.entries(VAULT_PROVIDERS).map(([id, name]) => ({
        id,
        name,
        configured: providerIds.has(id),
      })),
      ...customProviders,
    ],
  };
}

function validateVaultPassword(password) {
  if (typeof password !== 'string' || password.length < VAULT_PASSWORD_MIN_LENGTH) {
    throw new VaultError(400, `主密码至少需要 ${VAULT_PASSWORD_MIN_LENGTH} 个字符`);
  }
}

function slugifyProviderName(name) {
  const readable = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return readable || 'provider';
}

function createCustomProviderId(name, secrets) {
  const base = `custom-${slugifyProviderName(name)}`;
  if (!Object.prototype.hasOwnProperty.call(secrets, base)) return base;
  let suffix = 2;
  while (Object.prototype.hasOwnProperty.call(secrets, `${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

function validateCustomProvider(body, current) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 80) {
    throw new VaultError(400, '服务商名称不能为空且不能超过 80 个字符');
  }
  const baseUrlValue = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : '';
  if (!baseUrlValue || baseUrlValue.length > 2048) {
    throw new VaultError(400, '请输入有效的 Base URL（最多 2048 个字符）');
  }
  let baseUrl;
  try {
    const parsed = new URL(baseUrlValue);
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      throw new Error('invalid URL');
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    baseUrl = parsed.toString().replace(/\/+$/, '');
  } catch {
    throw new VaultError(400, 'Base URL 必须是有效的 HTTP 或 HTTPS 地址，且不能包含账号、查询参数或片段');
  }
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  if (key.length > 4096 || (!key && !current?.key)) {
    throw new VaultError(400, '请输入有效的 API Key（最多 4096 个字符）');
  }
  return {
    name,
    baseUrl,
    key: key || current.key,
    ...(current?.legacyId ? { legacyId: current.legacyId } : {}),
  };
}

function getCustomProvider(id) {
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(id || '')) return null;
  const exact = vaultSecrets?.[id];
  if (exact && typeof exact === 'object' && typeof exact.key === 'string') {
    return { ...exact, id };
  }
  for (const [providerId, provider] of Object.entries(vaultSecrets || {})) {
    if (
      providerId !== id
      && provider?.legacyId === id
      && typeof provider.key === 'string'
    ) {
      return { ...provider, id: providerId };
    }
  }
  return null;
}

function isCustomProviderModel(modelId) {
  return typeof modelId === 'string' && /^custom-[^/\s]+\//i.test(modelId);
}

function customProviderModel(modelId, provider) {
  for (const prefix of [provider.id, provider.legacyId]) {
    if (typeof prefix === 'string' && modelId.startsWith(`${prefix}/`)) {
      return modelId.slice(`${prefix}/`.length);
    }
  }
  return modelId;
}

function requestCustomProvider(provider, pathname, method = 'GET', body = undefined, { stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const target = new URL(pathname.replace(/^\/+/, ''), `${provider.baseUrl}/`);
    const transport = target.protocol === 'https:' ? https : http;
    const headers = {
      ...UPSTREAM_HEADERS,
      authorization: `Bearer ${provider.key}`,
    };
    if (payload) headers['content-length'] = Buffer.byteLength(payload);
    if (stream) headers.accept = 'text/event-stream';
    const req = transport.request(target, { method, headers }, (up) => {
      const chunks = [];
      up.on('data', (chunk) => chunks.push(chunk));
      up.on('end', () => resolve({
        statusCode: up.statusCode || 502,
        headers: up.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(30000, () => req.destroy(new Error('custom provider request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function upstreamCustomProvider(provider, pathname, body, res, { stream, model }) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const target = new URL(pathname.replace(/^\/+/, ''), `${provider.baseUrl}/`);
  const transport = target.protocol === 'https:' ? https : http;
  const headers = {
    ...UPSTREAM_HEADERS,
    authorization: `Bearer ${provider.key}`,
  };
  if (payload) headers['content-length'] = Buffer.byteLength(payload);
  if (stream) headers.accept = 'text/event-stream';
  const startedAt = Date.now();
  const req = transport.request(target, { method: 'POST', headers }, (up) => {
    res.writeHead(up.statusCode || 502, forwardedHeaders(up, stream));
    up.pipe(res);
    up.on('end', () => {
      const retryAfter = up.headers['retry-after'];
      log(`<- ${provider.name} POST ${pathname} model=${model || '-'} ${Date.now() - startedAt}ms${retryAfter ? ` retry-after=${retryAfter}` : ''}`);
    });
  });
  req.setTimeout(30000, () => req.destroy(new Error('custom provider request timed out')));
  req.on('error', (error) => {
    log(`!! ${provider.name} upstream error POST ${pathname} model=${model || '-'}: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'upstream_error', message: error.message } }));
    } else res.end();
  });
  if (payload) req.write(payload);
  req.end();
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

function requestSCNet(pathname, method = 'GET', body = undefined, apiKey = undefined, base = SCNET_OPENAI_BASE) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { ...SCNET_UPSTREAM_HEADERS };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    if (payload) headers['content-length'] = Buffer.byteLength(payload);
    if (method !== 'GET') headers.accept = 'text/event-stream';

    const req = https.request(
      { hostname: SCNET_HOST, path: base + pathname, method, headers },
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
    req.setTimeout(30000, () => req.destroy(new Error('SCNet request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function requestProviderModels(provider, apiKey) {
  const requests = {
    sensenova: () => requestSenseNova('/models', 'GET', undefined, apiKey),
    internlm: () => requestInternLM('/models', 'GET', undefined, apiKey),
    scnet: () => requestSCNet('/models', 'GET', undefined, apiKey),
  };
  const providerId = typeof provider === 'string' ? provider : provider.id;
  const up = typeof provider === 'string'
    ? await requests[provider]()
    : await requestCustomProvider(provider, '/models');
  if (up.statusCode < 200 || up.statusCode >= 300) {
    throw new Error(`HTTP ${up.statusCode} while loading ${providerId} models`);
  }
  let catalog;
  try {
    catalog = JSON.parse(up.body);
  } catch {
    throw new Error(`${providerId} returned invalid JSON for its model catalog`);
  }
  if (!Array.isArray(catalog.data)) {
    throw new Error(`${providerId} returned an invalid model catalog`);
  }
  return catalog.data
    .filter((model) => typeof model?.id === 'string' && model.id.trim())
    .map((model) => ({
      ...model,
      id: prefixModelProvider(model.id, providerId),
      provider: providerId,
      upstream: providerId,
    }));
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

/** 转发到 SCNet 的 OpenAI 或 Anthropic 兼容 API。 */
function upstreamSCNet(pathname, method, body, res, {
  stream, model, apiKey, anthropic = false, anthropicVersion = '2023-06-01', anthropicBeta,
}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = { ...SCNET_UPSTREAM_HEADERS };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (anthropic) {
    headers['anthropic-version'] = anthropicVersion;
    if (anthropicBeta) headers['anthropic-beta'] = anthropicBeta;
  }
  if (payload) headers['content-length'] = Buffer.byteLength(payload);
  if (stream) headers.accept = 'text/event-stream';
  const base = anthropic ? SCNET_ANTHROPIC_BASE : SCNET_OPENAI_BASE;
  const startedAt = Date.now();

  const req = https.request(
    { hostname: SCNET_HOST, path: base + pathname, method, headers },
    (up) => {
      res.writeHead(up.statusCode || 502, forwardedHeaders(up, stream));
      up.pipe(res);
      up.on('end', () => {
        const retryAfter = up.headers['retry-after'];
        log(`<- SCNet ${up.statusCode} ${method} ${pathname} model=${model || '-'} ${Date.now() - startedAt}ms${retryAfter ? ` retry-after=${retryAfter}` : ''}`);
      });
    },
  );

  req.on('error', (e) => {
    log(`!! SCNet upstream error ${method} ${pathname} model=${model || '-'}: ${e.message}`);
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

function isSCNetModel(modelId) {
  return typeof modelId === 'string' && modelId.startsWith('scnet/');
}

function stripSCNetPrefix(modelId) {
  return stripModelProviderPrefix(modelId, 'scnet');
}

function stripModelProviderPrefix(modelId, provider) {
  const prefix = `${provider}/`;
  return typeof modelId === 'string' && modelId.toLowerCase().startsWith(prefix)
    ? modelId.slice(prefix.length)
    : modelId;
}

function prefixModelProvider(model, provider) {
  const prefix = `${provider}/`;
  return model.toLowerCase().startsWith(prefix) ? model : `${prefix}${model}`;
}

function stripSenseNovaPrefix(modelId) {
  return stripModelProviderPrefix(modelId, 'sensenova')
    .replace(/^sense-nova\//i, '');
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

function claudeCodeSettingsPath() {
  return process.env.EASYAI_CLAUDE_SETTINGS_PATH
    ? pathModule.resolve(process.env.EASYAI_CLAUDE_SETTINGS_PATH)
    : pathModule.join(os.homedir(), '.claude', 'settings.json');
}

function validateClaudeCodeConfig(body) {
  if (body?.confirmed !== true) {
    throw new VaultError(400, '请先在控制台确认配置变更');
  }
  for (const field of ['baseUrl', 'apiKey', 'model']) {
    if (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > 4096) {
      throw new VaultError(400, `Claude Code 配置字段无效：${field}`);
    }
  }
  let baseUrl;
  try {
    baseUrl = new URL(body.baseUrl);
  } catch {
    throw new VaultError(400, 'Claude Code 地址格式无效');
  }
  if (
    baseUrl.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname)
    || baseUrl.username
    || baseUrl.password
    || baseUrl.pathname !== '/'
    || baseUrl.search
    || baseUrl.hash
  ) {
    throw new VaultError(400, 'Claude Code 地址必须是本机网关地址');
  }
  return {
    ANTHROPIC_BASE_URL: baseUrl.origin,
    ANTHROPIC_AUTH_TOKEN: body.apiKey.trim(),
    ANTHROPIC_MODEL: body.model.trim(),
  };
}

async function inspectClaudeCodeSettings() {
  const file = claudeCodeSettingsPath();
  let contents;
  try {
    contents = await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { path: file, exists: false, valid: true };
    throw error;
  }
  try {
    const settings = JSON.parse(contents);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('settings must be an object');
    }
    return {
      path: file,
      exists: true,
      valid: true,
      current: {
        baseUrl: typeof settings.env?.ANTHROPIC_BASE_URL === 'string' ? settings.env.ANTHROPIC_BASE_URL : '',
        model: typeof settings.env?.ANTHROPIC_MODEL === 'string' ? settings.env.ANTHROPIC_MODEL : '',
        hasAuthToken: typeof settings.env?.ANTHROPIC_AUTH_TOKEN === 'string' && settings.env.ANTHROPIC_AUTH_TOKEN.length > 0,
      },
    };
  } catch {
    return { path: file, exists: true, valid: false };
  }
}

async function applyClaudeCodeSettings(body) {
  const updates = validateClaudeCodeConfig(body);
  const file = claudeCodeSettingsPath();
  let contents;
  let settings = {};
  try {
    contents = await fs.promises.readFile(file, 'utf8');
    settings = JSON.parse(contents);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      if (error instanceof SyntaxError) {
        throw new VaultError(409, 'Claude Code 配置文件不是有效 JSON，未做修改');
      }
      throw error;
    }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new VaultError(409, 'Claude Code 配置文件格式不受支持，未做修改');
  }
  if (settings.env !== undefined && (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env))) {
    throw new VaultError(409, 'Claude Code 配置中的 env 字段格式不受支持，未做修改');
  }
  const updated = {
    ...settings,
    env: { ...(settings.env || {}), ...updates },
  };
  await fs.promises.mkdir(pathModule.dirname(file), { recursive: true, mode: 0o700 });
  let backupPath = null;
  if (contents !== undefined) {
    const suffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
    backupPath = `${file}.easyai-backup-${suffix}`;
    await fs.promises.copyFile(file, backupPath, fs.constants.COPYFILE_EXCL);
  }
  const temporaryFile = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(temporaryFile, `${JSON.stringify(updated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.promises.rename(temporaryFile, file);
  } catch (error) {
    await fs.promises.unlink(temporaryFile).catch((cleanupError) => {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    });
    throw error;
  }
  return { path: file, backupPath, updatedKeys: Object.keys(updates) };
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
    if (path.startsWith('/api/client-config/')) {
      if (!validVaultOrigin(req)) {
        return json(res, 403, { error: { type: 'forbidden', message: '客户端配置只允许从本机控制台访问' } });
      }
      if (path === '/api/client-config/claude-code' && req.method === 'GET') {
        return json(res, 200, await inspectClaudeCodeSettings(), { 'cache-control': 'no-store' });
      }
      if (path === '/api/client-config/claude-code/apply' && req.method === 'POST') {
        return json(res, 200, await applyClaudeCodeSettings(await readBody(req)), { 'cache-control': 'no-store' });
      }
    }

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

      if (path === '/api/vault/custom-providers' && req.method === 'POST') {
        if (!vaultKey || !vaultSecrets) {
          throw new VaultError(423, '请先解锁本机凭据库');
        }
        const body = await readBody(req);
        const config = validateCustomProvider(body, null);
        const id = createCustomProviderId(config.name, vaultSecrets);
        const updatedSecrets = { ...vaultSecrets, [id]: config };
        const envelope = await readVaultEnvelope();
        if (!envelope) throw new VaultError(404, '凭据库尚未初始化');
        await saveVault(updatedSecrets, vaultKey, Buffer.from(envelope.salt, 'base64'));
        vaultSecrets = updatedSecrets;
        return json(res, 201, await getVaultStatus(), { 'cache-control': 'no-store' });
      }

      const customProviderMatch = path.match(/^\/api\/vault\/custom-providers\/(custom-[^/\s]+)$/iu);
      if (customProviderMatch && ['PUT', 'DELETE'].includes(req.method)) {
        if (!vaultKey || !vaultSecrets) {
          throw new VaultError(423, '请先解锁本机凭据库');
        }
        let providerId;
        try {
          providerId = decodeURIComponent(customProviderMatch[1]);
        } catch {
          return json(res, 400, { error: { type: 'invalid_request', message: '服务商 ID 格式无效' } });
        }
        const current = getCustomProvider(providerId);
        if (!current) throw new VaultError(404, '自定义服务商不存在');
        const envelope = await readVaultEnvelope();
        if (!envelope) throw new VaultError(404, '凭据库尚未初始化');
        const updatedSecrets = { ...vaultSecrets };
        if (req.method === 'PUT') {
          const config = validateCustomProvider(await readBody(req), current);
          updatedSecrets[providerId] = config;
        } else {
          delete updatedSecrets[providerId];
        }
        await saveVault(updatedSecrets, vaultKey, Buffer.from(envelope.salt, 'base64'));
        vaultSecrets = updatedSecrets;
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

    const customCatalogMatch = path.match(/^\/api\/custom-providers\/(custom-[^/\s]+)\/catalog$/iu);
    if (customCatalogMatch && req.method === 'GET') {
      if (!vaultKey || !vaultSecrets) {
        return json(res, 423, { error: { type: 'vault_locked', message: '请先解锁本机凭据库' } }, { 'cache-control': 'no-store' });
      }
      let providerId;
      try {
        providerId = decodeURIComponent(customCatalogMatch[1]);
      } catch {
        return json(res, 400, { error: { type: 'invalid_request', message: '服务商 ID 格式无效' } }, { 'cache-control': 'no-store' });
      }
      const provider = getCustomProvider(providerId);
      if (!provider) {
        return json(res, 404, { error: { type: 'not_configured', message: '自定义服务商不存在' } }, { 'cache-control': 'no-store' });
      }
      let models;
      try {
        models = await requestProviderModels(provider);
      } catch (error) {
        log(`!! ${provider.name} error GET /models: ${error.message}`);
        return json(res, 502, { error: { type: 'upstream_error', message: error.message } }, { 'cache-control': 'no-store' });
      }
      return json(res, 200, { data: models, checked_at: new Date().toISOString() }, { 'cache-control': 'no-store' });
    }

    const customTestMatch = path.match(/^\/api\/custom-providers\/(custom-[^/\s]+)\/test$/iu);
    if (customTestMatch && req.method === 'POST') {
      if (!vaultKey || !vaultSecrets) {
        return json(res, 423, { error: { type: 'vault_locked', message: '请先解锁本机凭据库' } }, { 'cache-control': 'no-store' });
      }
      let providerId;
      try {
        providerId = decodeURIComponent(customTestMatch[1]);
      } catch {
        return json(res, 400, { error: { type: 'invalid_request', message: '服务商 ID 格式无效' } }, { 'cache-control': 'no-store' });
      }
      const provider = getCustomProvider(providerId);
      if (!provider) {
        return json(res, 404, { error: { type: 'not_configured', message: '自定义服务商不存在' } }, { 'cache-control': 'no-store' });
      }
      const body = await readBody(req);
      if (typeof body?.model !== 'string' || !body.model.trim()) {
        return json(res, 400, { error: { type: 'invalid_request', message: 'model is required' } }, { 'cache-control': 'no-store' });
      }
      const model = body.model.startsWith(`${provider.id}/`)
        ? customProviderModel(body.model, provider)
        : body.model.trim();
      const prompt = typeof body.prompt === 'string' && body.prompt.trim()
        ? body.prompt.trim().slice(0, 2000)
        : 'Reply with OK.';
      let up;
      try {
        up = await requestCustomProvider(provider, '/chat/completions', 'POST', {
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 128,
        });
      } catch (error) {
        log(`!! ${provider.name} error POST /chat/completions: ${error.message}`);
        return json(res, 502, { error: { type: 'upstream_error', message: error.message } }, { 'cache-control': 'no-store' });
      }
      res.writeHead(up.statusCode, forwardedHeaders(up, false));
      return res.end(up.body);
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

    // SCNet 使用受 API Key 鉴权的 OpenAI 兼容模型列表接口。
    if (path === '/api/scnet/catalog' && req.method === 'GET') {
      if (!vaultKey || !vaultSecrets) {
        return json(res, 423, { error: { type: 'vault_locked', message: '请先解锁本机凭据库' } }, { 'cache-control': 'no-store' });
      }
      const scnetKey = vaultSecrets.scnet;
      if (!scnetKey) {
        return json(res, 404, { error: { type: 'not_configured', message: '尚未配置 SCNet API Key' } }, { 'cache-control': 'no-store' });
      }
      let up;
      try {
        up = await requestSCNet('/models', 'GET', undefined, scnetKey);
      } catch (e) {
        log(`!! SCNet error GET /models: ${e.message}`);
        return json(res, 502, { error: { type: 'upstream_error', message: e.message } }, { 'cache-control': 'no-store' });
      }
      const retryAfter = up.headers['retry-after'];
      log(`<- SCNet ${up.statusCode} GET /models${retryAfter ? ` retry-after=${retryAfter}` : ''}`);
      if (up.statusCode < 200 || up.statusCode >= 300) {
        return json(res, up.statusCode, {
          error: { type: 'upstream_error', message: 'Could not load SCNet model catalog', details: up.body },
          retry_after: up.headers['retry-after'] || null,
        }, retryAfter ? { 'retry-after': retryAfter } : { 'cache-control': 'no-store' });
      }
      let catalog;
      try {
        catalog = JSON.parse(up.body);
      } catch {
        return json(res, 502, { error: { type: 'upstream_error', message: 'SCNet model catalog has an invalid format' } }, { 'cache-control': 'no-store' });
      }
      if (!Array.isArray(catalog.data)) {
        return json(res, 502, { error: { type: 'upstream_error', message: 'SCNet model catalog data is not an array' } }, { 'cache-control': 'no-store' });
      }
      const models = catalog.data
        .filter((model) => typeof model?.id === 'string' && model.id.trim())
        .map((model) => ({
        ...model,
        id: `scnet/${model.id.replace(/^scnet\//i, '')}`,
        provider: 'scnet',
        upstream: 'scnet',
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
    if (path === '/api/scnet/test' && req.method === 'POST') {
      if (!vaultKey || !vaultSecrets) {
        return json(res, 423, { error: { type: 'vault_locked', message: '请先解锁本机凭据库' } }, { 'cache-control': 'no-store' });
      }
      const scnetKey = vaultSecrets.scnet;
      if (!scnetKey) {
        return json(res, 404, { error: { type: 'not_configured', message: '尚未配置 SCNet API Key' } }, { 'cache-control': 'no-store' });
      }
      const body = await readBody(req);
      if (typeof body?.model !== 'string' || !body.model.trim()) {
        return json(res, 400, { error: { type: 'invalid_request', message: 'model is required' } }, { 'cache-control': 'no-store' });
      }
      const model = stripSCNetPrefix(body.model.trim());
      const prompt = typeof body.prompt === 'string' && body.prompt.trim()
        ? body.prompt.trim().slice(0, 2000)
        : 'Reply with OK.';
      return upstreamSCNet('/chat/completions', 'POST', {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 128,
      }, res, { stream: false, model, apiKey: scnetKey });
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
      let up;
      try {
        up = await requestUpstream('/models');
      } catch (error) {
        log(`!! upstream error GET /models: ${error.message}`);
        return json(res, 502, { error: { type: 'upstream_error', message: error.message } });
      }
      if (up.statusCode < 200 || up.statusCode >= 300) {
        return json(res, up.statusCode, {
          error: { type: 'upstream_error', message: 'Could not load the upstream model catalog', details: up.body },
          retry_after: up.headers['retry-after'] || null,
        }, up.headers['retry-after'] ? { 'retry-after': up.headers['retry-after'] } : {});
      }
      let catalog;
      try {
        catalog = JSON.parse(up.body);
      } catch {
        return json(res, 502, { error: { type: 'upstream_error', message: 'Upstream model catalog has invalid JSON' } });
      }
      if (!Array.isArray(catalog.data)) {
        return json(res, 502, { error: { type: 'upstream_error', message: 'Upstream model catalog has an invalid format' } });
      }
      const capabilities = JSON.parse(await fs.promises.readFile(CAPABILITIES_FILE, 'utf8'));
      const models = catalog.data.map((model) => ({
        ...model,
        ...(capabilities[model.id] || {}),
        provider: 'kilo',
      }));
      const warnings = [];
      if (vaultKey && vaultSecrets) {
        const configuredProviders = [
          ...Object.keys(VAULT_PROVIDERS)
            .filter((provider) => vaultSecrets[provider])
            .map((id) => ({ id, provider: id, apiKey: vaultSecrets[id] })),
          ...Object.keys(vaultSecrets)
            .filter((id) => CUSTOM_PROVIDER_ID_PATTERN.test(id) && vaultSecrets[id]?.key)
            .map((id) => ({ id, provider: getCustomProvider(id), apiKey: vaultSecrets[id].key })),
        ];
        const results = await Promise.all(configuredProviders.map(async ({ id, provider, apiKey }) => {
          try {
            return { provider: id, models: await requestProviderModels(provider, apiKey) };
          } catch (error) {
            log(`!! ${id} error GET /models: ${error.message}`);
            return { provider: id, error: error.message };
          }
        }));
        for (const result of results) {
          if (result.models) models.push(...result.models);
          else warnings.push({ provider: result.provider, message: result.error });
        }
      }
      return json(res, 200, {
        ...catalog,
        data: models,
        ...(warnings.length ? { gateway_warnings: warnings } : {}),
      }, { 'cache-control': 'no-store' });
    }
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body?.model) return json(res, 400, { error: { type: 'invalid_request', message: 'model is required' } });
      if (isCustomProviderModel(body.model)) {
        if (!vaultKey || !vaultSecrets) {
          return json(res, 403, { error: { type: 'forbidden', message: '自定义服务商模型需要先解锁本机凭据库' } });
        }
        const providerId = body.model.slice(0, body.model.indexOf('/'));
        const provider = getCustomProvider(providerId);
        if (!provider) {
          return json(res, 404, { error: { type: 'not_found', message: '自定义服务商不存在或已删除' } });
        }
        const model = customProviderModel(body.model, provider);
        return upstreamCustomProvider(provider, '/chat/completions', { ...body, model }, res, {
          stream: body.stream === true,
          model,
        });
      }
      // 判断是否为 SenseNova 模型（通过 provider 字段或模型 ID 前缀）
      const isSenseNova = isSenseNovaModel(body.model);
      if (isSenseNova) {
        if (!vaultKey || !vaultSecrets || !vaultSecrets.sensenova) {
          return json(res, 403, { error: { type: 'forbidden', message: 'SenseNova 模型需要先在凭据库中配置并解锁 Key' } });
        }
        const model = stripSenseNovaPrefix(body.model);
        return upstreamSenseNova('/chat/completions', 'POST', { ...body, model }, res, { stream: body.stream === true, model, apiKey: vaultSecrets.sensenova });
      }
      // 判断是否为 InternLM 模型（模型 ID 以 internlm/ 开头）
      const isInternLM = isInternLMModel(body.model);
      if (isInternLM) {
        if (!vaultKey || !vaultSecrets || !vaultSecrets.internlm) {
          return json(res, 403, { error: { type: 'forbidden', message: 'InternLM 模型需要先在凭据库中配置并解锁 Key' } });
        }
        const model = stripModelProviderPrefix(body.model, 'internlm');
        return upstreamInternLM('/chat/completions', 'POST', { ...body, model }, res, { stream: body.stream === true, model, apiKey: vaultSecrets.internlm });
      }
      if (isSCNetModel(body.model)) {
        if (!vaultKey || !vaultSecrets || !vaultSecrets.scnet) {
          return json(res, 403, { error: { type: 'forbidden', message: 'SCNet 模型需要先在凭据库中配置并解锁 Key' } });
        }
        const model = stripSCNetPrefix(body.model);
        return upstreamSCNet('/chat/completions', 'POST', { ...body, model }, res, { stream: body.stream === true, model, apiKey: vaultSecrets.scnet });
      }
      return upstream('/chat/completions', 'POST', body, res, { stream: body.stream === true, model: body.model });
    }
    if (path === '/v1/messages' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body?.model) return json(res, 400, { error: { type: 'invalid_request', message: 'model is required' } });
      if (isCustomProviderModel(body.model)) {
        return json(res, 400, { error: { type: 'invalid_request', message: '自定义服务商目前仅支持 OpenAI Chat Completions 接口' } });
      }
      const isSenseNova = isSenseNovaModel(body.model);
      if (isSenseNova) {
        if (!vaultKey || !vaultSecrets || !vaultSecrets.sensenova) {
          return json(res, 403, { error: { type: 'forbidden', message: 'SenseNova 模型需要先在凭据库中配置并解锁 Key' } });
        }
        const model = stripSenseNovaPrefix(body.model);
        return upstreamSenseNova('/v1/messages', 'POST', { ...body, model }, res, { stream: body.stream === true, model, apiKey: vaultSecrets.sensenova });
      }
      const isInternLM = isInternLMModel(body.model);
      if (isInternLM) {
        if (!vaultKey || !vaultSecrets || !vaultSecrets.internlm) {
          return json(res, 403, { error: { type: 'forbidden', message: 'InternLM 模型需要先在凭据库中配置并解锁 Key' } });
        }
        const model = stripModelProviderPrefix(body.model, 'internlm');
        return upstreamInternLM('/v1/messages', 'POST', { ...body, model }, res, { stream: body.stream === true, model, apiKey: vaultSecrets.internlm });
      }
      if (isSCNetModel(body.model)) {
        if (!vaultKey || !vaultSecrets || !vaultSecrets.scnet) {
          return json(res, 403, { error: { type: 'forbidden', message: 'SCNet 模型需要先在凭据库中配置并解锁 Key' } });
        }
        const model = stripSCNetPrefix(body.model);
        return upstreamSCNet('/v1/messages', 'POST', { ...body, model }, res, {
          stream: body.stream === true,
          model,
          apiKey: vaultSecrets.scnet,
          anthropic: true,
          anthropicVersion: req.headers['anthropic-version'] || '2023-06-01',
          anthropicBeta: req.headers['anthropic-beta'],
        });
      }
      return upstream('/v1/messages', 'POST', body, res, { stream: body.stream === true, model: body.model });
    }
    if (path === '/v1/responses' && req.method === 'POST') {
      const body = await readBody(req);
      if (isCustomProviderModel(body?.model)) {
        return json(res, 400, { error: { type: 'invalid_request', message: '自定义服务商目前仅支持 OpenAI Chat Completions 接口' } });
      }
      const isSenseNova = isSenseNovaModel(body?.model);
      if (isSenseNova) {
        if (!vaultKey || !vaultSecrets || !vaultSecrets.sensenova) {
          return json(res, 403, { error: { type: 'forbidden', message: 'SenseNova 模型需要先在凭据库中配置并解锁 Key' } });
        }
        const model = stripSenseNovaPrefix(body.model);
        return upstreamSenseNova('/responses', 'POST', { ...body, model }, res, { stream: body?.stream === true, model, apiKey: vaultSecrets.sensenova });
      }
      const isInternLM = isInternLMModel(body?.model);
      if (isInternLM) {
        if (!vaultKey || !vaultSecrets || !vaultSecrets.internlm) {
          return json(res, 403, { error: { type: 'forbidden', message: 'InternLM 模型需要先在凭据库中配置并解锁 Key' } });
        }
        const model = stripModelProviderPrefix(body.model, 'internlm');
        return upstreamInternLM('/responses', 'POST', { ...body, model }, res, { stream: body?.stream === true, model, apiKey: vaultSecrets.internlm });
      }
      if (isSCNetModel(body?.model)) {
        if (!vaultKey || !vaultSecrets || !vaultSecrets.scnet) {
          return json(res, 403, { error: { type: 'forbidden', message: 'SCNet 模型需要先在凭据库中配置并解锁 Key' } });
        }
        const model = stripSCNetPrefix(body.model);
        return upstreamSCNet('/responses', 'POST', { ...body, model }, res, { stream: body?.stream === true, model, apiKey: vaultSecrets.scnet });
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
