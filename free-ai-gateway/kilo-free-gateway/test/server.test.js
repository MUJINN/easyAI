const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

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
    assert.match(await page.text(), /Kilo Free Gateway/);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const unauthorized = await fetch(`${baseUrl}/api/catalog`);
    assert.equal(unauthorized.status, 401);

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
