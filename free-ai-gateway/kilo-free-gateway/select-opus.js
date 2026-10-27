// select-opus.js — 启动时自动选当前最快的 Opus 级模型
const CANDIDATES = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'cohere/north-mini-code:free',
  'dots-studio/dots-3-note-preview:free',
];

const TIMEOUT_MS = 8000;
const BASE = 'http://127.0.0.1:8899/v1/chat/completions';

async function ping(model) {
  const start = Date.now();
  try {
    const r = await fetch(BASE, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({model, messages: [{role:'user',content:'ping'}], max_tokens: 1}),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (r.ok) return Date.now() - start;
  } catch {}
  return Infinity;
}

(async () => {
  const results = await Promise.all(CANDIDATES.map(m => ping(m).then(ms => ({model: m, ms}))));
  const ok = results.filter(r => r.ms < Infinity).sort((a,b) => a.ms - b.ms);
  const best = ok[0]?.model || CANDIDATES[0];
  console.log(best); // stdout 给环境变量用
})();