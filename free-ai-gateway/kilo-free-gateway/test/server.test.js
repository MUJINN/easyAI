const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const KEY = 'test-local-key';

async function unusedPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('serves local dashboard, enforces auth, and validates manual tests', async () => {
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LOCAL_KEY: KEY },
    stdio: 'ignore',
  });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode !== null) throw new Error(`Gateway exited during startup (${child.exitCode})`);
      try {
        const response = await fetch(`${baseUrl}/healthz`);
        if (response.ok) { ready = true; break; }
      } catch (error) {
        if (attempt === 49) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'gateway should become ready');

    const [page, health] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/healthz`),
    ]);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /Kilo Free Gateway/);
    assert.match(pageHtml, /接入客户端/);
    assert.match(pageHtml, /Claude Code（Anthropic Messages）/);
    assert.match(pageHtml, /Cline（OpenAI 兼容表单）/);
    assert.match(pageHtml, /Continue（config\.json）/);
    assert.match(pageHtml, /Chatbox（自定义供应商）/);
    assert.match(pageHtml, /Cherry Studio（自定义供应商）/);
    assert.match(pageHtml, /WorkBuddy（自定义模型）/);
    assert.equal([...pageHtml.matchAll(/<option value="/g)].length, 19, '18 documented clients and one generic option should be available');
    assert.match(pageHtml, /class="setup-sidebar"/);
    assert.match(pageHtml, /id="setup-client-list"/);
    assert.match(pageHtml, /id="setup-client-search"/);
    assert.match(pageHtml, /id="setup-content-scroll"/);
    assert.match(pageHtml, /docs\/client-guides\/third-party-api-setup\.html/);
    for (const client of [
      'Trae（自定义模型）',
      'DeepSeek Harness',
      'CC-Switch（Claude Code）',
      'OpenCode',
      'WorkSwarm',
      'Loomy',
      'Hermes Agent',
      'OpenFIC',
      'GitHub Copilot（自带密钥）',
      'VS Code GitHub Copilot Chat',
      'QClaw',
      'CC-Switch（Codex）',
    ]) {
      assert.ok(pageHtml.includes(client), `dashboard should include ${client}`);
    }
    assert.match(pageHtml, /复制给 WorkBuddy/);
    assert.match(pageHtml, /下载 Skill ZIP/);
    const inlineScripts = [...pageHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.ok(inlineScripts.length > 0, 'dashboard should include its scripts');
    for (const [, script] of inlineScripts) {
      assert.doesNotThrow(() => new vm.Script(script), 'dashboard script should be valid JavaScript');
    }
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const unauthorized = await fetch(`${baseUrl}/api/catalog`);
    assert.equal(unauthorized.status, 401);

    const guide = await fetch(`${baseUrl}/docs/client-guides/third-party-api-setup.html`);
    assert.equal(guide.status, 200);
    assert.match(guide.headers.get('content-type'), /text\/html/);
    const guideHtml = await guide.text();
    assert.match(guideHtml, /<html/i);
    assert.match(guideHtml, /toc\.id = 'client-guide-toc'/);
    const guideSections = [...guideHtml.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)]
      .filter(([, heading]) => /^5\.\d+\b/.test(heading.replace(/<[^>]*>/g, '').trim()));
    assert.equal(guideSections.length, 18, 'the tutorial TOC should cover all 18 client sections');

    const unauthorizedSkill = await fetch(`${baseUrl}/api/workbuddy-skill`);
    assert.equal(unauthorizedSkill.status, 401);

    const [skillResponse, archiveResponse] = await Promise.all([
      fetch(`${baseUrl}/api/workbuddy-skill`, { headers: { Authorization: `Bearer ${KEY}` } }),
      fetch(`${baseUrl}/api/workbuddy-skill.zip`, { headers: { Authorization: `Bearer ${KEY}` } }),
    ]);
    assert.equal(skillResponse.status, 200);
    assert.match(await skillResponse.text(), /帮我把 easyAI 模型接入 WorkBuddy/);
    assert.equal(archiveResponse.status, 200);
    assert.match(archiveResponse.headers.get('content-type'), /application\/zip/);
    assert.match(archiveResponse.headers.get('content-disposition'), /configure-workbuddy-easyai-model\.zip/);
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    assert.equal(archive.subarray(0, 2).toString('ascii'), 'PK');
    const filenameLength = archive.readUInt16LE(26);
    const extraLength = archive.readUInt16LE(28);
    const compressedLength = archive.readUInt32LE(18);
    const contentOffset = 30 + filenameLength + extraLength;
    const skillText = zlib.inflateRawSync(archive.subarray(contentOffset, contentOffset + compressedLength)).toString('utf8');
    assert.match(skillText, /帮我把 easyAI 模型接入 WorkBuddy/);

    const invalid = await fetch(`${baseUrl}/api/test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error.message, /model is required/);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
});

test('refuses non-local binding without a local key', async () => {
  const port = await unusedPort();
  const rejected = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '0.0.0.0', PORT: String(port), LOCAL_KEY: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  rejected.stderr.setEncoding('utf8');
  rejected.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    rejected.once('error', reject);
    const timer = setTimeout(() => {
      if (rejected.exitCode === null) {
        rejected.kill();
        reject(new Error('Gateway did not reject non-local binding'));
      }
    }, 3000);
    rejected.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(exitCode, 1);
  assert.match(stderr, /without LOCAL_KEY/);
});
