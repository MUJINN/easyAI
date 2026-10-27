// lib/selector.js — 核心选型器：查上游 → 筛选 → 测试 → 输出 roles.json
// 使用方式：node lib/selector.js > roles.json

const ROLE_SPECS = {
  DEFAULT: {
    prompt: 'ping',
    check: (t) => t && t.length > 0 && !t.includes('error'),
    preferTags: ['longctx', 'reasoning', 'general'],
  },
  OPUS: {
    prompt: '2+2等于几？只回数字',
    check: (t) => /4|四/.test(t),
    preferTags: ['reasoning', 'longctx'],
  },
  SONNET: {
    prompt: '写一个 Python 函数加两个数 a 和 b，返回 a+b',
    check: (t) => /def|function|=>/.test(t) && /a.*b|b.*a|\+/.test(t),
    preferTags: ['coding', 'benchmark', 'agentic'],
  },
  HAIKU: {
    prompt: '只回 OK',
    check: (t) => /^ok$/i.test(t.trim()),
    preferTags: ['speed', 'small'],
  },
  SUBAGENT: {
    prompt: 'ping',
    check: (t) => t && t.length > 0 && !t.includes('error'),
    preferTags: ['speed', 'small', 'router'],
  },
};

const TIMEOUT_MS = 20000;
const MODEL_DELAY_MS = 2000;
const ROLE_DELAY_MS = 3000;
const UPSTREAM = 'https://api.kilo.ai/api/gateway';
const MODELS_URL = UPSTREAM + '/models';
const CHAT_URL = UPSTREAM + '/chat/completions';

const CAPS_FILE = require('path').join(__dirname, 'model-capabilities.json');
const fs = require('fs');

function loadCapabilities() {
  return JSON.parse(fs.readFileSync(CAPS_FILE, 'utf-8'));
}

function filterCandidates(caps, allFreeModels) {
  const onlineIds = new Set(allFreeModels.map(m => m.id));
  // 只要在线且在 capabilities 里定义过的
  return Object.entries(caps)
    .filter(([id]) => onlineIds.has(id))
    .map(([id, meta]) => ({id, ...meta}));
}

async function fetchFreeModels() {
  const r = await fetch(MODELS_URL, {signal: AbortSignal.timeout(8000)});
  const j = await r.json();
  return (j.data || [])
    .filter(m => m.isFree === true)
    .map(m => ({id: m.id}));
}

function estimateContext(id) {
  if (id.includes('1m') || id.includes('1M') || id.includes('1000k')) return 1000000;
  if (id.includes('262k') || id.includes('256k')) return 262000;
  if (id.includes('512k')) return 512000;
  if (id.includes('128k')) return 128000;
  if (id.includes('65k')) return 65000;
  return 8000;
}

async function callModel(model, prompt, maxTokens = 50) {
  const start = Date.now();
  try {
    const r = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Accept': '*/*', 'User-Agent': 'kilo-select/1.0'},
      body: JSON.stringify({model, messages: [{role:'user',content:prompt}], max_tokens: maxTokens}),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const j = await r.json();
    if (!r.ok) return {ok: false, latency: Date.now()-start, error: j.error?.message || `HTTP ${r.status}`};
    const text = j.choices?.[0]?.message?.content || '';
    return {ok: true, latency: Date.now()-start, text};
  } catch (e) {
    return {ok: false, latency: Date.now()-start, error: e.message};
  }
}

async function testModel(modelId, prompt, check) {
  const r = await callModel(modelId, prompt, 50);
  if (!r.ok) return {model: modelId, ok: false, reason: r.error, latency: r.latency};
  if (!check(r.text)) return {model: modelId, ok: false, reason: 'check failed', latency: r.latency};
  return {model: modelId, ok: true, latency: r.latency};
}

function scoreModel(model, spec) {
  let score = 0;
  for (const tag of spec.preferTags) {
    if (model.tags.includes(tag)) score += 10;
  }
  // 长上下文加分
  if (model.ctx >= 500000) score += 5;
  else if (model.ctx >= 200000) score += 2;
  return score;
}

async function selectForRole(roleName, spec, candidates) {
  console.error(`[${roleName}] testing ${candidates.length} models...`);
  const results = [];
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    const r = await testModel(m.id, spec.prompt, spec.check);
    if (r.ok) console.error(`  [${m.id}] OK (${r.latency}ms)`);
    else console.error(`  [${m.id}] FAIL: ${r.reason}`);
    results.push({...r, modelMeta: m});
    if (i < candidates.length - 1) await sleep(MODEL_DELAY_MS);
  }
  const ok = results.filter(r => r.ok);
  if (ok.length === 0) {
    console.error(`[${roleName}] ALL FAILED`);
    return null;
  }
  // 先按偏好分，再按延迟
  ok.sort((a, b) => {
    const sa = scoreModel(a.modelMeta, spec);
    const sb = scoreModel(b.modelMeta, spec);
    if (sa !== sb) return sb - sa;
    return a.latency - b.latency;
  });
  const best = ok[0];
  console.error(`[${roleName}] selected: ${best.model} (${best.latency}ms) - passed ${ok.length}/${results.length}`);
  return {model: best.model, latency: best.latency, meta: best.modelMeta};
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const caps = loadCapabilities();
  const freeModels = await fetchFreeModels();
  const candidates = filterCandidates(caps, freeModels);
  console.error(`[kilo] testing ${candidates.length} known-good models: ${candidates.map(m=>m.id).join(', ')}`);

  const roles = {};
  const allTested = [];
  for (const [roleName, spec] of Object.entries(ROLE_SPECS)) {
    const selected = await selectForRole(roleName, spec, candidates);
    if (selected) roles[roleName] = selected;
    allTested.push({role: roleName, selected});
    await sleep(ROLE_DELAY_MS);
  }

  // 兜底：用第一个成功的填补空缺
  const anyOk = Object.values(roles).find(v => v);
  for (const [k, v] of Object.entries(roles)) {
    if (!v && anyOk) roles[k] = anyOk;
  }

  if (!Object.values(roles).some((role) => role?.model)) {
    throw new Error('no available model passed the smoke tests');
  }

  const output = {
    timestamp: new Date().toISOString(),
    upstream: 'kilo',
    roles,
    all_tested: allTested.flatMap(r => r.selected ? [{role: r.role, model: r.selected.model, latency: r.selected.latency, ok: true}] : [{role: r.role, ok: false}])
  };

  // stdout 只输出 JSON
  console.log(JSON.stringify(output, null, 2));
}

main().catch(e => {
  console.error('[selector] fatal:', e.message);
  process.exit(1);
});