// select-all-roles.js — 启动时：查上游模型 → 筛选免费 → 分角色冒烟测试 → 输出最佳
// 每模型只请求一次，用同一响应判 ping + smoke

const KNOWN_GOOD_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'cohere/north-mini-code:free',
  'poolside/laguna-s-2.1:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'kilo-auto/free',
  'openrouter/free',
  'dots-studio/dots-3-note-preview:free',
  'liquid/lfm-2.5-2.6b:free',
];

const ROLE_SPECS = {
  DEFAULT: {
    prompt: 'ping',
    check: (t) => t && t.length > 0 && !t.includes('error'),
    prefer: (m) => m.context >= 100000,
  },
  OPUS: {
    prompt: '2+2等于几？只回数字',
    check: (t) => /4|四/.test(t),
    prefer: (m) => m.context >= 200000 || m.id.includes('ultra') || m.id.includes('550b'),
  },
  SONNET: {
    prompt: '写一个 Python 函数加两个数 a 和 b，返回 a+b',
    check: (t) => /def|function|=>/.test(t) && /a.*b|b.*a|\+/.test(t),
    prefer: (m) => m.id.includes('code') || m.id.includes('laguna') || m.id.includes('north-mini'),
  },
  HAIKU: {
    prompt: '只回 OK',
    check: (t) => /^ok$/i.test(t.trim()),
    prefer: (m) => m.context <= 100000 || m.id.includes('nano') || m.id.includes('2.6b'),
  },
  SUBAGENT: {
    prompt: 'ping',
    check: (t) => t && t.length > 0 && !t.includes('error'),
    prefer: (m) => m.context <= 100000 || m.id.includes('nano') || m.id.includes('2.6b') || m.id.includes('auto'),
  },
};

const TIMEOUT_MS = 20000;
const MODEL_DELAY_MS = 2000;
const ROLE_DELAY_MS = 3000;
const UPSTREAM = 'https://api.kilo.ai/api/gateway';
const MODELS_URL = UPSTREAM + '/models';
const CHAT_URL = UPSTREAM + '/chat/completions';

function estimateContext(id) {
  if (id.includes('1m') || id.includes('1M') || id.includes('1000k')) return 1000000;
  if (id.includes('262k') || id.includes('256k')) return 262000;
  if (id.includes('512k')) return 512000;
  if (id.includes('128k')) return 128000;
  if (id.includes('65k')) return 65000;
  return 8000;
}

async function fetchFreeModels() {
  const r = await fetch(MODELS_URL, {signal: AbortSignal.timeout(8000)});
  const j = await r.json();
  const allFree = (j.data || [])
    .filter(m => m.isFree === true)
    .map(m => ({id: m.id, context: estimateContext(m.id)}));
  const onlineIds = new Set(allFree.map(m => m.id));
  return KNOWN_GOOD_MODELS
    .filter(id => onlineIds.has(id))
    .map(id => allFree.find(m => m.id === id))
    .filter(Boolean);
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

async function selectForRole(roleName, spec, freeModels) {
  console.error(`[${roleName}] testing ${freeModels.length} models...`);
  const results = [];
  for (const m of freeModels) {
    const r = await testModel(m.id, spec.prompt, spec.check);
    if (r.ok) console.error(`  [${m.id}] OK (${r.latency}ms)`);
    else console.error(`  [${m.id}] FAIL: ${r.reason}`);
    results.push(r);
    if (m !== freeModels[freeModels.length - 1]) await sleep(MODEL_DELAY_MS);
  }
  const ok = results.filter(r => r.ok);
  if (ok.length === 0) {
    console.error(`[${roleName}] ALL FAILED`);
    return null;
  }
  ok.sort((a, b) => {
    const ma = freeModels.find(m => m.id === a.model);
    const mb = freeModels.find(m => m.id === b.model);
    const pa = spec.prefer(ma) ? 0 : 1;
    const pb = spec.prefer(mb) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return a.latency - b.latency;
  });
  const best = ok[0].model;
  console.error(`[${roleName}] selected: ${best} (${ok[0].latency}ms) - passed ${ok.length}/${results.length}`);
  return best;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const freeModels = await fetchFreeModels();
  console.error(`[kilo] testing ${freeModels.length} known-good models: ${freeModels.map(m=>m.id).join(', ')}`);

  const selected = {};
  const roles = Object.entries(ROLE_SPECS);
  for (let i = 0; i < roles.length; i++) {
    const [roleName, spec] = roles[i];
    selected[roleName] = await selectForRole(roleName, spec, freeModels);
    if (i < roles.length - 1) await sleep(ROLE_DELAY_MS);
  }

  const anyOk = Object.values(selected).find(v => v);
  for (const [k, v] of Object.entries(selected)) {
    if (!v && anyOk) selected[k] = anyOk;
  }

  for (const [k, v] of Object.entries(selected)) {
    if (v) console.log(`${k}=${v}`);
  }
})();