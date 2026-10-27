// lib/adaptors.js — 适配器：读 roles.json → 生成各目标工具的配置
// 用法：node lib/adaptors.js --target=claude-code --input=roles.json

const fs = require('fs');
const path = require('path');

const TARGETS = {
  'claude-code': generateClaudeCode,
  'cline': generateCline,
  'continue': generateContinue,
  'opencode': generateOpencode,
  'env': generateEnv,
  'vscode': generateVscodeSettings,
  'all': generateAll,
};

function loadRoles(inputFile) {
  const fullPath = require('path').isAbsolute(inputFile) ? inputFile : require('path').join(process.cwd(), inputFile);
  const data = fs.readFileSync(fullPath, 'utf-8');
  return JSON.parse(data);
}

function getModel(roles, role) {
  return roles.roles?.[role]?.model || '';
}

function generateEnv(roles) {
  const lines = [
    `ANTHROPIC_BASE_URL=http://127.0.0.1:8899`,
    `ANTHROPIC_AUTH_TOKEN=dummy`,
    `ANTHROPIC_MODEL=${getModel(roles, 'DEFAULT')}`,
    `ANTHROPIC_DEFAULT_OPUS_MODEL=${getModel(roles, 'OPUS')}`,
    `ANTHROPIC_DEFAULT_SONNET_MODEL=${getModel(roles, 'SONNET')}`,
    `ANTHROPIC_DEFAULT_HAIKU_MODEL=${getModel(roles, 'HAIKU')}`,
    `CLAUDE_CODE_SUBAGENT_MODEL=${getModel(roles, 'SUBAGENT')}`,
  ];
  return lines.join('\n');
}

function generateClaudeCode(roles) {
  // Claude Code 读环境变量，生成 .env 供 source 或 dotenv-cli 用
  return generateEnv(roles);
}

function generateCline(roles) {
  // Cline: .vscode/cline.json 或全局设置
  return JSON.stringify({
    "apiProvider": "openai",
    "openAiBaseUrl": "http://127.0.0.1:8899/v1",
    "openAiApiKey": "dummy",
    "model": getModel(roles, 'DEFAULT'),
    "maxTokens": 8192,
    "temperature": 0,
  }, null, 2);
}

function generateContinue(roles) {
  // Continue: .continue/config.json
  return JSON.stringify({
    "models": [
      {
        "title": "Kilo Free - Default",
        "provider": "openai",
        "model": getModel(roles, 'DEFAULT'),
        "apiBase": "http://127.0.0.1:8899/v1",
        "apiKey": "dummy",
      },
      {
        "title": "Kilo Free - Opus",
        "provider": "openai",
        "model": getModel(roles, 'OPUS'),
        "apiBase": "http://127.0.0.1:8899/v1",
        "apiKey": "dummy",
      },
      {
        "title": "Kilo Free - Sonnet",
        "provider": "openai",
        "model": getModel(roles, 'SONNET'),
        "apiBase": "http://127.0.0.1:8899/v1",
        "apiKey": "dummy",
      },
    ],
    "tabAutocompleteModel": {
      "title": "Kilo Free - Haiku",
      "provider": "openai",
      "model": getModel(roles, 'HAIKU'),
      "apiBase": "http://127.0.0.1:8899/v1",
      "apiKey": "dummy",
    },
  }, null, 2);
}

function generateOpencode(roles) {
  // OpenCode: ~/.config/opencode/config.json
  return JSON.stringify({
    "providers": {
      "kilo": {
        "name": "Kilo Free Gateway",
        "baseURL": "http://127.0.0.1:8899/v1",
        "apiKey": "dummy",
      }
    },
    "models": {
      "default": { "provider": "kilo", "model": getModel(roles, 'DEFAULT') },
      "opus": { "provider": "kilo", "model": getModel(roles, 'OPUS') },
      "sonnet": { "provider": "kilo", "model": getModel(roles, 'SONNET') },
      "haiku": { "provider": "kilo", "model": getModel(roles, 'HAIKU') },
    },
  }, null, 2);
}

function generateVscodeSettings(roles) {
  // VS Code settings.json 片段（用于 Cline/Continue/通用扩展）
  return JSON.stringify({
    "cline.apiProvider": "openai",
    "cline.openAiBaseUrl": "http://127.0.0.1:8899/v1",
    "cline.openAiApiKey": "dummy",
    "cline.model": getModel(roles, 'DEFAULT'),
    "continue.models": [
      { "title": "Kilo Default", "provider": "openai", "model": getModel(roles, 'DEFAULT'), "apiBase": "http://127.0.0.1:8899/v1", "apiKey": "dummy" },
      { "title": "Kilo Opus", "provider": "openai", "model": getModel(roles, 'OPUS'), "apiBase": "http://127.0.0.1:8899/v1", "apiKey": "dummy" },
      { "title": "Kilo Sonnet", "provider": "openai", "model": getModel(roles, 'SONNET'), "apiBase": "http://127.0.0.1:8899/v1", "apiKey": "dummy" },
    ],
  }, null, 2);
}

function generateAll(roles) {
  const outputs = {};
  for (const [name, fn] of Object.entries(TARGETS)) {
    if (name !== 'all') outputs[name] = fn(roles);
  }
  return outputs;
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find(a => a.startsWith('--target='))?.split('=')[1] || 'claude-code';
  const input = args.find(a => a.startsWith('--input='))?.split('=')[1] || 'roles.json';
  const output = args.find(a => a.startsWith('--output='))?.split('=')[1] || '';

  if (!TARGETS[target]) {
    console.error(`Unknown target: ${target}. Available: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
  }

  const roles = loadRoles(input);
  const result = TARGETS[target](roles);

  const out = typeof result === 'object' ? JSON.stringify(result, null, 2) : result;

  if (output) {
    fs.writeFileSync(output, out);
    console.error(`[adaptor] written to ${output}`);
  } else {
    console.log(out); // stdout 输出
  }
}

main();