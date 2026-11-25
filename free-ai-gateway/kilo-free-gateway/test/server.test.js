const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const vm = require('node:vm');
const https = require('node:https');

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
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kilo-gateway-vault-test-'));
  const vaultPath = path.join(vaultDir, 'vault.json');
  const claudeSettingsPath = path.join(vaultDir, 'claude', 'settings.json');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      LOCAL_KEY: KEY,
      EASYAI_VAULT_PATH: vaultPath,
      EASYAI_CLAUDE_SETTINGS_PATH: claudeSettingsPath,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${path.join(ROOT, 'test-support', 'mock-upstreams.cjs')}`].filter(Boolean).join(' '),
    },
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
    assert.match(pageHtml, /id="home-view"/);
    assert.match(pageHtml, /id="open-kilo"/);
    assert.match(pageHtml, /id="open-providers"/);
    assert.match(pageHtml, /id="vault-view"/);
    assert.match(pageHtml, /id="custom-provider-name"/);
    assert.match(pageHtml, /id="custom-provider-view"/);
    assert.match(pageHtml, /id="test-prompt"[^>]*>Reply with OK\.<\/textarea>/);
    assert.match(pageHtml, /id="custom-provider-test-prompt"[^>]*>Reply with OK\.<\/textarea>/);
    assert.match(pageHtml, /id="sensenova-view"/);
    assert.match(pageHtml, /id="internlm-view"/);
    assert.match(pageHtml, /id="scnet-view"/);
    assert.match(pageHtml, /id="vault-open-sensenova"/);
    assert.match(pageHtml, /id="vault-open-internlm"/);
    assert.match(pageHtml, /id="vault-open-scnet"/);
    assert.doesNotMatch(pageHtml, /id="provider-tabs"|id="panel-sensenova"|id="panel-internlm"/);
    assert.match(pageHtml, /SenseNova（商汤日日新）/);
    assert.match(pageHtml, /id="sensenova-flow"/);
    assert.match(pageHtml, /https:\/\/www\.sensenova\.cn\/token-plan/);
    assert.match(pageHtml, /API 地址：<code>https:\/\/token\.sensenova\.cn\/v1<\/code>/);
    assert.match(pageHtml, /id="vault-password"/);
    assert.match(pageHtml, /id="sensenova-api-key"/);
    assert.match(pageHtml, /id="scnet-api-key"/);
    assert.match(pageHtml, /https:\/\/api\.scnet\.cn\/api\/llm\/v1/);
    assert.match(pageHtml, /https:\/\/api\.scnet\.cn\/api\/llm\/anthropic/);
    assert.match(pageHtml, /id="scnet-catalog-section"/);
    assert.match(pageHtml, /主密码不会保存在浏览器或凭据文件中/);
    for (const client of [
      'Claude Code（Anthropic Messages）',
      'Cline（OpenAI 兼容表单）',
      'Continue（config.json）',
      'Chatbox（自定义供应商）',
      'Cherry Studio（自定义供应商）',
      'WorkBuddy（自定义模型）',
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
      '复制给 WorkBuddy',
      '下载 Skill ZIP',
    ]) {
      assert.ok(pageHtml.includes(client), `dashboard should include ${client}`);
    }
    assert.equal([...pageHtml.matchAll(/<option value="/g)].length, 19, '18 documented clients and one generic option should be available');
    assert.match(pageHtml, /class="setup-sidebar"/);
    assert.match(pageHtml, /id="setup-client-list"/);
    assert.match(pageHtml, /id="setup-recommended-client-list"/);
    assert.match(pageHtml, /id="setup-client-search"/);
    assert.match(pageHtml, /id="quick-start"/);
    assert.match(pageHtml, /id="setup-profile-list"/);
    assert.match(pageHtml, /id="setup-apply"/);
    assert.match(pageHtml, /id="apply-confirm-dialog"/);
    assert.match(pageHtml, /id="setup-content-scroll"/);
    assert.match(pageHtml, /docs\/client-guides\/third-party-api-setup\.html/);
    assert.match(pageHtml, /href="\/assets\/dashboard\.css"/);
    assert.match(pageHtml, /src="\/assets\/dashboard\.js"/);
    const [stylesheet, dashboardScript] = await Promise.all([
      fetch(`${baseUrl}/assets/dashboard.css`),
      fetch(`${baseUrl}/assets/dashboard.js`),
    ]);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type'), /text\/css/);
    assert.match(await stylesheet.text(), /\.catalog\s*\{/);
    assert.equal(dashboardScript.status, 200);
    assert.match(dashboardScript.headers.get('content-type'), /javascript/);
    const dashboardScriptText = await dashboardScript.text();
    assert.match(dashboardScriptText, /class ModelCatalog/);
    assert.match(dashboardScriptText, /catalogEndpoint: '\/api\/scnet\/catalog'/);
    assert.match(dashboardScriptText, /testEndpoint: '\/api\/scnet\/test'/);
    assert.match(dashboardScriptText, /接入客户端/);
    assert.doesNotThrow(() => new vm.Script(dashboardScriptText), 'dashboard JavaScript should be valid');
    const inlineScripts = [...pageHtml.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.ok(inlineScripts.length > 0, 'dashboard should keep its early theme initialization script');
    for (const [, script] of inlineScripts) {
      assert.doesNotThrow(() => new vm.Script(script), 'dashboard script should be valid JavaScript');
    }
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const unauthorized = await fetch(`${baseUrl}/api/catalog`);
    assert.equal(unauthorized.status, 401);

    const vaultHeaders = { Authorization: `Bearer ${KEY}` };
    const clientConfigStatus = await fetch(`${baseUrl}/api/client-config/claude-code`, { headers: vaultHeaders });
    assert.equal(clientConfigStatus.status, 200);
    assert.deepEqual(await clientConfigStatus.json(), {
      path: claudeSettingsPath,
      exists: false,
      valid: true,
    });
    const clientConfig = {
      baseUrl,
      apiKey: KEY,
      model: 'nvidia/test-model',
    };
    const crossOriginConfigApply = await fetch(`${baseUrl}/api/client-config/claude-code/apply`, {
      method: 'POST',
      headers: { ...vaultHeaders, Origin: 'http://example.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...clientConfig, confirmed: true }),
    });
    assert.equal(crossOriginConfigApply.status, 403);
    const unconfirmedConfigApply = await fetch(`${baseUrl}/api/client-config/claude-code/apply`, {
      method: 'POST',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(clientConfig),
    });
    assert.equal(unconfirmedConfigApply.status, 400);
    const invalidConfigApply = await fetch(`${baseUrl}/api/client-config/claude-code/apply`, {
      method: 'POST',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...clientConfig, baseUrl: 'https://example.com', confirmed: true }),
    });
    assert.equal(invalidConfigApply.status, 400);

    await fs.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
    await fs.writeFile(claudeSettingsPath, JSON.stringify({
      theme: 'dark',
      env: { KEEP_ME: 'preserved', ANTHROPIC_AUTH_TOKEN: 'old-token' },
    }));
    const applyConfigResponse = await fetch(`${baseUrl}/api/client-config/claude-code/apply`, {
      method: 'POST',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...clientConfig, confirmed: true }),
    });
    assert.equal(applyConfigResponse.status, 200);
    const applyConfigResult = await applyConfigResponse.json();
    assert.ok(applyConfigResult.backupPath);
    assert.equal(JSON.stringify(applyConfigResult).includes(KEY), false);
    assert.equal(JSON.stringify(applyConfigResult).includes('old-token'), false);
    const appliedConfig = JSON.parse(await fs.readFile(claudeSettingsPath, 'utf8'));
    assert.equal(appliedConfig.theme, 'dark');
    assert.deepEqual(appliedConfig.env, {
      KEEP_ME: 'preserved',
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_MODEL: 'nvidia/test-model',
    });
    const backupConfig = JSON.parse(await fs.readFile(applyConfigResult.backupPath, 'utf8'));
    assert.equal(backupConfig.env.ANTHROPIC_AUTH_TOKEN, 'old-token');

    const initialVaultStatus = await fetch(`${baseUrl}/api/vault/status`, { headers: vaultHeaders });
    assert.equal(initialVaultStatus.status, 200);
    assert.equal((await initialVaultStatus.json()).initialized, false);

    const blockedOrigin = await fetch(`${baseUrl}/api/vault/status`, {
      headers: { ...vaultHeaders, Origin: 'http://example.com' },
    });
    assert.equal(blockedOrigin.status, 403);

    const weakPassword = await fetch(`${baseUrl}/api/vault/setup`, {
      method: 'POST',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'short' }),
    });
    assert.equal(weakPassword.status, 400);

    const masterPassword = 'long-test-master-password';
    const createdVault = await fetch(`${baseUrl}/api/vault/setup`, {
      method: 'POST',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: masterPassword }),
    });
    assert.equal(createdVault.status, 201);
    assert.equal((await createdVault.json()).unlocked, true);

    const apiKey = 'sensenova-secret-test-key';
    const savedKey = await fetch(`${baseUrl}/api/vault/providers/sensenova`, {
      method: 'PUT',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: apiKey }),
    });
    assert.equal(savedKey.status, 200);
    const savedStatus = await savedKey.json();
    assert.equal(savedStatus.providers.find((provider) => provider.id === 'sensenova').configured, true);
    assert.equal(JSON.stringify(savedStatus).includes(apiKey), false);
    const scnetKey = 'scnet-secret-test-key';
    const saveScnetKey = await fetch(`${baseUrl}/api/vault/providers/scnet`, {
      method: 'PUT',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: scnetKey }),
    });
    assert.equal(saveScnetKey.status, 200);
    const savedWithScnet = await saveScnetKey.json();
    assert.equal(savedWithScnet.providers.find((provider) => provider.id === 'scnet').configured, true);
    assert.equal(JSON.stringify(savedWithScnet).includes(scnetKey), false);
    const internlmKey = 'internlm-test-key';
    const saveInternlmKey = await fetch(`${baseUrl}/api/vault/providers/internlm`, {
      method: 'PUT',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: internlmKey }),
    });
    assert.equal(saveInternlmKey.status, 200);
    const invalidCustomProvider = await fetch(`${baseUrl}/api/vault/custom-providers`, {
      method: 'POST',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Invalid', baseUrl: 'ftp://custom.example/v1', key: 'invalid-key' }),
    });
    assert.equal(invalidCustomProvider.status, 400);
    const customProviderKey = 'custom-provider-secret';
    const createCustomProvider = await fetch(`${baseUrl}/api/vault/custom-providers`, {
      method: 'POST',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Custom Test Provider',
        baseUrl: 'https://custom.example/v1/',
        key: customProviderKey,
      }),
    });
    assert.equal(createCustomProvider.status, 201);
    const createdCustomStatus = await createCustomProvider.json();
    const customProvider = createdCustomStatus.providers.find((provider) => provider.custom);
    assert.ok(customProvider);
    assert.match(customProvider.id, /^custom-[a-z0-9-]+$/);
    assert.equal(customProvider.id, 'custom-custom-test-provider');
    assert.equal(customProvider.baseUrl, 'https://custom.example/v1');
    assert.equal(JSON.stringify(createdCustomStatus).includes(customProviderKey), false);

    const customCatalogResponse = await fetch(`${baseUrl}/api/custom-providers/${customProvider.id}/catalog`, { headers: vaultHeaders });
    assert.equal(customCatalogResponse.status, 200);
    const customCatalog = await customCatalogResponse.json();
    assert.deepEqual(customCatalog.data.map((model) => model.id), [`${customProvider.id}/custom-test-model`]);
    assert.equal(customCatalog.data[0].provider, customProvider.id);

    const customTestResponse = await fetch(`${baseUrl}/api/custom-providers/${customProvider.id}/test`, {
      method: 'POST',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: customCatalog.data[0].id, prompt: 'Say hello' }),
    });
    assert.equal(customTestResponse.status, 200);
    assert.equal((await customTestResponse.json()).choices[0].message.content, 'custom provider works');

    const createChineseCustomProvider = await fetch(`${baseUrl}/api/vault/custom-providers`, {
      method: 'POST',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '百度千帆',
        baseUrl: 'https://custom.example/v1',
        key: customProviderKey,
      }),
    });
    assert.equal(createChineseCustomProvider.status, 201);
    const chineseCustomProvider = (await createChineseCustomProvider.json()).providers.find((provider) => provider.name === '百度千帆');
    assert.equal(chineseCustomProvider.id, 'custom-百度千帆');
    const encodedChineseProviderId = encodeURIComponent(chineseCustomProvider.id);
    const chineseCatalogResponse = await fetch(`${baseUrl}/api/custom-providers/${encodedChineseProviderId}/catalog`, { headers: vaultHeaders });
    assert.equal(chineseCatalogResponse.status, 200);
    const chineseCatalog = await chineseCatalogResponse.json();
    assert.deepEqual(chineseCatalog.data.map((model) => model.id), [`${chineseCustomProvider.id}/custom-test-model`]);
    const chineseProviderDeleteResponse = await fetch(`${baseUrl}/api/vault/custom-providers/${encodedChineseProviderId}`, {
      method: 'DELETE',
      headers: vaultHeaders,
    });
    assert.equal(chineseProviderDeleteResponse.status, 200);

    const updateCustomProvider = await fetch(`${baseUrl}/api/vault/custom-providers/${customProvider.id}`, {
      method: 'PUT',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Custom Provider', baseUrl: customProvider.baseUrl, key: '' }),
    });
    assert.equal(updateCustomProvider.status, 200);
    assert.equal((await updateCustomProvider.json()).providers.find((provider) => provider.id === customProvider.id).name, 'Updated Custom Provider');

    const customChatResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: customCatalog.data[0].id, messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(customChatResponse.status, 200);
    assert.equal((await customChatResponse.json()).choices[0].message.content, 'custom provider works');
    const customAnthropicResponse = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: customCatalog.data[0].id, messages: [] }),
    });
    assert.equal(customAnthropicResponse.status, 400);

    const encryptedVault = await fs.readFile(vaultPath, 'utf8');
    assert.equal(encryptedVault.includes(apiKey), false);
    assert.equal(encryptedVault.includes(scnetKey), false);
    assert.equal(encryptedVault.includes(internlmKey), false);
    assert.equal(encryptedVault.includes(customProviderKey), false);
    assert.equal(encryptedVault.includes(masterPassword), false);

    const combinedModelsResponse = await fetch(`${baseUrl}/v1/models`, { headers: vaultHeaders });
    assert.equal(combinedModelsResponse.status, 200);
    const combinedModels = await combinedModelsResponse.json();
    assert.deepEqual(combinedModels.data.map((model) => model.id).sort(), [
      `${customProvider.id}/custom-test-model`,
      'internlm/internlm-test-model',
      'kilo-test-model',
      'scnet/scnet-test-model',
      'sensenova/nova-test-model',
    ]);
    assert.equal(combinedModels.data.find((model) => model.id.startsWith('scnet/')).provider, 'scnet');
    assert.equal(combinedModels.gateway_warnings, undefined);

    const lockResponse = await fetch(`${baseUrl}/api/vault/lock`, {
      method: 'POST',
      headers: vaultHeaders,
    });
    assert.equal((await lockResponse.json()).unlocked, false);
    const lockedModels = await fetch(`${baseUrl}/v1/models`, { headers: vaultHeaders });
    assert.equal(lockedModels.status, 200);
    assert.deepEqual((await lockedModels.json()).data.map((model) => model.id), ['kilo-test-model']);
    const lockedCustomModel = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: customCatalog.data[0].id, messages: [] }),
    });
    assert.equal(lockedCustomModel.status, 403);

    const wrongUnlock = await fetch(`${baseUrl}/api/vault/unlock`, {
      method: 'POST',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'incorrect-master-password' }),
    });
    assert.equal(wrongUnlock.status, 401);

    const unlockResponse = await fetch(`${baseUrl}/api/vault/unlock`, {
      method: 'POST',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: masterPassword }),
    });
    assert.equal(unlockResponse.status, 200);
    assert.equal((await unlockResponse.json()).unlocked, true);

    const deleteCustomProvider = await fetch(`${baseUrl}/api/vault/custom-providers/${customProvider.id}`, {
      method: 'DELETE',
      headers: vaultHeaders,
    });
    assert.equal(deleteCustomProvider.status, 200);
    assert.equal((await deleteCustomProvider.json()).providers.some((provider) => provider.id === customProvider.id), false);
    const deletedCustomModel = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: customCatalog.data[0].id, messages: [] }),
    });
    assert.equal(deletedCustomModel.status, 404);

    const deleteKey = await fetch(`${baseUrl}/api/vault/providers/sensenova`, {
      method: 'DELETE',
      headers: vaultHeaders,
    });
    assert.equal(deleteKey.status, 200);
    assert.equal((await deleteKey.json()).providers.find((provider) => provider.id === 'sensenova').configured, false);
    const deleteScnetKey = await fetch(`${baseUrl}/api/vault/providers/scnet`, {
      method: 'DELETE',
      headers: vaultHeaders,
    });
    assert.equal(deleteScnetKey.status, 200);
    assert.equal((await deleteScnetKey.json()).providers.find((provider) => provider.id === 'scnet').configured, false);
    const deleteInternlmKey = await fetch(`${baseUrl}/api/vault/providers/internlm`, {
      method: 'DELETE',
      headers: vaultHeaders,
    });
    assert.equal(deleteInternlmKey.status, 200);
    assert.equal((await deleteInternlmKey.json()).providers.find((provider) => provider.id === 'internlm').configured, false);
    const missingScnetKey = await fetch(`${baseUrl}/api/scnet/catalog`, { headers: vaultHeaders });
    assert.equal(missingScnetKey.status, 404);
    const blockedScnetRoute = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'scnet/example-model', messages: [] }),
    });
    assert.equal(blockedScnetRoute.status, 403);
    for (const [providerModel, provider] of [
      ['sensenova/example-model', 'SenseNova'],
      ['internlm/example-model', 'InternLM'],
    ]) {
      const blockedProviderRoute = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...vaultHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: providerModel, messages: [] }),
      });
      assert.equal(blockedProviderRoute.status, 403, `${provider} prefixed model IDs should route to that provider`);
    }

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
    await fs.rm(vaultDir, { recursive: true, force: true });
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
