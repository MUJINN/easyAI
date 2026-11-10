# Kilo 免费模型 → 本机网关与目录

把 Kilo AI 网关模型接入本机 OpenAI / Anthropic 兼容端点，并提供本地模型目录和手动测试界面。**零依赖，Node.js >= 18**。

模型免费状态、额度、隐私处理和可用性均由上游决定；目录标记为免费不代表模型此刻可调用，也不构成无限量或稳定性承诺。

## 历史验证记录（2026-10-16；不代表当前可用性）

| 上游 | 状态 | 说明 |
|---|---|---|
| **Kilo 公共网关** | 当时通过 | 当时测试了 chat / messages / 流式 / 工具调用；上游认证和免费策略可能已变化 |
| OpenCode Zen 免费车道 | ❌ 不可用 | 403 `FreeTierError`（客户端指纹门禁）+ `RegionError`（CN 出口被地区门拦截） |

## 快速开始

```powershell
# 启动网关和本地控制台（不会自动探测或调用模型）
.\start.cmd

# 或直接启动服务
node server.js

# 打开控制台
Start-Process http://127.0.0.1:8899/
```

可选：设置本机口令。Windows PowerShell:

```powershell
$env:LOCAL_KEY = "my-secret"
node server.js
```

设置口令后，在控制台填写该口令；接入 API 的客户端也需使用它作为 Bearer token 或 `x-api-key`。未设置口令时仅允许绑定本机回环地址，服务拒绝无认证的非本机监听。

## 本机服务商 Key 凭据库

在「接入自己的模型服务」页面首次设置凭据库主密码，然后解锁并保存服务商 Key。支持 SenseNova、InternLM (书生·端砚) 和超算互联网（SCNet）Key 的加密保存、替换和删除。模型目录、连通测试及请求转发按服务商分别进行；SCNet 支持 OpenAI 与 Anthropic 兼容 API。

- 主密码至少 12 个字符，不会保存到浏览器或凭据文件；网关重启后需要重新解锁。
- 服务商 Key 使用 Node.js `scrypt` 派生密钥和 AES-256-GCM 加密后保存在本机用户数据目录。Windows 默认位置为 `%LOCALAPPDATA%\easyAI\kilo-free-gateway\vault.json`；macOS/Linux 使用各自用户数据目录。
- 解锁期间，Key 会在网关进程内存中使用；锁定或退出进程后需要重新解锁。与任何本机程序一样，运行账户下的恶意软件或有权限访问进程的用户仍可能危及凭据。
- 忘记主密码无法恢复已保存的 Key。请使用密码管理器保管主密码；不要把凭据库文件提交到 Git 或分享给他人。
- 删除 Key 会将其从当前凭据库内容中移除；受文件系统和 SSD 特性影响，不承诺擦除磁盘历史数据。
- 页面仅显示 Key 是否已配置，不提供读取或回显 Key 的接口；输入后会清空表单。上游 Key 与可选的 `LOCAL_KEY` 本地网关访问口令用途不同。

**SenseNova 接入流程**：
1. 在 SenseNova 控制台申请 API Key（<https://www.sensenova.cn/token-plan>）
2. 控制台「接入自己的模型服务」→「本机加密凭据库」设置主密码并解锁
3. 保存 SenseNova Key（加密存入本机凭据库）
4. 点击「加载 SenseNova 模型目录」查看可用模型
5. 选中模型点击「连通测试」或使用「问答测试」验证连接
6. 点击「接入客户端」复制配置到 Claude Code、Cline 等工具

**InternLM (书生·端砚) 接入流程**：
1. 在 InternLM 控制台申请 API Key（<https://intern-ai.org.cn/>）
2. 控制台「接入自己的模型服务」→「本机加密凭据库」设置主密码并解锁
3. 保存 InternLM Key（加密存入本机凭据库）
4. 点击「加载 InternLM 模型目录」查看可用模型
5. 选中模型点击「连通测试」或使用「问答测试」验证连接
6. 点击「接入客户端」复制配置到 Claude Code、Cline 等工具

**SCNet 接入流程**：
1. 在 [SCNet 模型 API Key 管理](https://www.scnet.cn/ui/console/index.html#/llm/apikeys)创建模型 API Key，并配置可访问的模型范围
2. 控制台选择「接入 SCNet」→「管理本机凭据」，解锁凭据库并加密保存 Key
3. 返回 SCNet 页面加载模型目录；列表按该 Key 的权限返回，展示的模型 ID 带有 `scnet/` 本地路由前缀
4. 选中模型进行连通测试，或通过「接入客户端」配置本地网关

SCNet 上游地址为 `https://api.scnet.cn/api/llm/v1`（OpenAI 兼容）和 `https://api.scnet.cn/api/llm/anthropic`（Anthropic 兼容）。Token Plan Key 有独立的使用范围限制，请遵守 SCNet 官方规则。

控制台刷新模型目录不会调用模型。只有点击测试按钮才会发出测试消息。

控制台默认使用暗色主题，可点击页面顶部按钮切换亮色/暗色；选择会保存在当前浏览器中。

测试或刷新目录失败时，控制台会按 HTTP 状态码显示常见原因和建议，并尽量展示上游错误信息、`Retry-After` 和请求 ID。状态码只能帮助定位方向，具体原因以上游返回内容为准；例如 403 可能与账号、地区或模型权限有关，网关不会绕过上游限制。

每张模型卡片的“连通测试”按钮可立即单独测试该模型。卡片右上角仅在选中时显示勾选标记；普通点击会逐个选中或取消该模型，不影响其他已选模型。也可以在页面中按住鼠标左键拖出方框，和方框相交的模型卡片会加入选择。Shift+点击可选择范围；在非文本输入区域按 Ctrl/Cmd+A 可选择当前筛选可见的模型。

选中模型后，页面顶部“全部测试”按钮和底部悬浮栏均可开始批量测试已选模型；模型会按目录顺序逐个请求，单个失败不会中断后续测试，各模型的状态、回复或错误显示在对应卡片中。停止测试会阻止后续模型开始请求，但不会中止已经发出的当前请求。测试使用“问答测试”区域的提示词；Ctrl/Cmd+Enter 也可开始批量测试。

## 模型选择与配置生成

显式运行选型器会逐个探测候选模型并消耗上游请求；只启动网关无需运行选型器：

```cmd
start.cmd select
start.cmd cline
```

生成 Cline、Continue、OpenCode 等配置也会先运行选型器。失败时不会继续生成空模型配置。建议优先使用控制台按需选择模型和复制配置。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 列出上游全部模型（含 `isFree` 标记） |
| POST | `/v1/chat/completions` | OpenAI Chat Completions，支持 `stream: true`（自动路由 Kilo/SenseNova/InternLM/SCNet） |
| POST | `/v1/messages` | Anthropic Messages，支持 `stream: true`、`thinking`、`tool_use`（自动路由 Kilo/SenseNova/InternLM/SCNet） |
| POST | `/v1/responses` | OpenAI Responses（部分模型，自动路由 Kilo/SenseNova/InternLM/SCNet） |
| GET | `/healthz` | 本机服务健康检查（不检查上游） |
| GET | `/` | 本地模型控制台 |
| GET | `/docs/client-guides/third-party-api-setup.html` | 打开第三方模型 API 接入图文教程 |
| GET | `/api/catalog` | Kilo 上游模型目录与项目能力标签 |
| POST | `/api/test` | 用户手动触发的单次 Kilo 模型测试 |
| GET | `/api/sensenova/catalog` | SenseNova 模型目录（需凭据库解锁且配置 Key） |
| POST | `/api/sensenova/test` | SenseNova 模型连通测试（需凭据库解锁且配置 Key） |
| GET | `/api/internlm/catalog` | InternLM 模型目录（需凭据库解锁且配置 Key） |
| POST | `/api/internlm/test` | InternLM 模型连通测试（需凭据库解锁且配置 Key） |
| GET | `/api/scnet/catalog` | SCNet 当前 Key 可访问的模型目录（需凭据库解锁且配置 Key） |
| POST | `/api/scnet/test` | SCNet 模型连通测试（需凭据库解锁且配置 Key） |
| GET | `/api/vault/status` | 本机凭据库锁定状态和服务商 Key 配置状态 |
| POST | `/api/vault/setup`、`/api/vault/unlock`、`/api/vault/lock` | 创建、解锁或锁定本机凭据库 |
| PUT、DELETE | `/api/vault/providers/sensenova` | 保存/替换或删除 SenseNova Key（Key 不会从接口回传） |
| PUT、DELETE | `/api/vault/providers/internlm` | 保存/替换或删除 InternLM Key（Key 不会从接口回传） |
| PUT、DELETE | `/api/vault/providers/scnet` | 保存/替换或删除 SCNet Key（Key 不会从接口回传） |
| GET | `/api/workbuddy-skill` | 获取 WorkBuddy 配置 Skill 文本 |
| GET | `/api/workbuddy-skill.zip` | 下载 WorkBuddy 配置 Skill 压缩包 |

## 模型目录与能力信息

控制台从上游实时读取目录，并叠加 `lib/model-capabilities.json` 中的项目维护标签和上下文估计。卡片展示上游名称、提供方、上下文与回复上限、输入/输出模态、接口能力、简短模型说明及上游提示词使用提示；长说明可展开查看。目录字段由上游提供，可能缺失或变化；能力表可能过期，免费标记也不代表可用性保证。

### 为什么名字陌生

| 成因 | 例子 |
|---|---|
| **匿名/stealth 模型**：厂商隐去品牌免费测试，收集真实使用数据 | `stealth/glyph-cluster`（自称"身份尚未公布"）、`dots-studio/dots-3-note-preview` |
| **刚发布的开源模型**：真实存在，只是没进大众视野 | `nvidia/nemotron-3.5-*`、`thinkingmachines/inkling-small`、`cohere/north-mini-code`、`poolside/laguna-*` |
| **聚合路由**：不是单个模型 | `kilo-auto/free`（3 个模型间轮换）、`openrouter/free`（8 家厂商按权重路由）|

### 已知模型示例

以下信息是 2026-10-16 的历史观测，不保证模型仍存在、免费或可调用；请以控制台当前目录及单次手动测试结果为准。

| 模型 id | 上下文 | 实测 | 身份 / 说明 |
|---|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b:free` | 262K | ✅ 1.5s | NVIDIA MoE 120B/12B。**推荐日常用**，稳定 |
| `nvidia/nemotron-3.5-super-vl:free` | 1M | ✅ 2.1s | NVIDIA，支持图像/视频输入 |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256K | ✅ 0.8s | NVIDIA 30B，多模态+推理，响应快 |
| `nvidia/nemotron-3.5-lightning:free` | 1M | ⚠️ 2~57s | NVIDIA 30B/3B，主打高吞吐 agent，**延迟波动大** |
| `nvidia/nemotron-3.5-content-safety:free` | 128K | ✅ 3.0s | 4B 内容审核模型，非通用对话 |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1M | ❌ 超时 | 550B 旗舰，实测 70s 无响应 |
| `cohere/north-mini-code:free` | 256K | ✅ 2.3s | Cohere 首个 agentic 编码模型，30B/3B |
| `poolside/laguna-s-2.1:free` | 262K | ✅ 1.4s | Poolside 编码模型，118B/8B，Terminal-Bench 2.1 得 70.2% |
| `dots-studio/dots-3-note-preview:free` | 512K | ✅ 1.8s | 280B/16B MoE。**2026-12-31 到期** |
| `thinkingmachines/inkling-small:free` | 1M | ⚠️ 429 | Thinking Machines 276B/12B，原生图像+音频。**日配额常被打满** |
| `poolside/laguna-xs-2.1:free` | 262K | ⚠️ 429 | Poolside 33B/3B。**2026-10-31 到期**，常限流 |
| `liquid/lfm-2.5-2.6b:free` | 65K | ✅ 1.0s | Liquid AI 2.6B 小模型，MIT CSAIL 系 |
| `stealth/glyph-cluster` | 256K | ✅ 3.9s | **匿名模型，身份未公布**。推理型，跑量大 |
| `kilo-auto/free` | 256K | ✅ 1.8s | 自动路由（3 个模型间轮换）|
| `openrouter/free` | 200K | ✅ 2.0s | 路由到 8 家厂商的免费模型 |

> 模型目录里的 `isFree` 是上游当时返回的标记，不保证额度、账户要求、提供方路由或即时可用性。遇到错误时应以具体 API 响应为准。

## 接入各客户端

模型卡片上的「接入客户端」按手册覆盖全部 18 个工具：Chatbox、Cline、Cherry Studio、Continue、WorkBuddy、Trae、DeepSeek Harness、CC-Switch（Claude Code / Codex）、OpenCode、WorkSwarm、Loomy、Hermes Agent、OpenFIC、GitHub Copilot BYOK、VS Code GitHub Copilot Chat、Claude Code 直连和 QClaw。页面按各自流程提供配置字段与操作提示；配置切换器和客户端特有高级字段仍需在目标应用中按界面操作。向导只生成和复制配置，不会改写客户端文件。WorkBuddy 使用本机网关地址时，需确认请求从运行网关的同一台电脑发出；远程 / 云端请求无法直接访问 `127.0.0.1`。未设置 `LOCAL_KEY` 时可使用占位 API Key；设置后应填入本地口令。配置预览会遮蔽口令，但复制配置会包含真实口令，请妥善保管。

在模型卡片选择 WorkBuddy 后，可直接点「复制给 WorkBuddy」并粘贴到 WorkBuddy 对话框，或点「下载 Skill ZIP」后上传到 WorkBuddy 的 Skill 入口。源文件位于 `../configure-workbuddy-easyai-model/SKILL.md`。复制的指令不包含 API Key；Skill 会要求 WorkBuddy 在保存配置和发送测试请求前征求用户确认。

完整的 18 款客户端图文教程位于 `docs/client-guides/third-party-api-setup.html`，也可从配置向导点击「查看 18 款客户端完整图文教程」打开。

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8899
export ANTHROPIC_AUTH_TOKEN=dummy     # 未设 LOCAL_KEY 时随便填
export ANTHROPIC_MODEL=nvidia/nemotron-3-super-120b-a12b:free
claude
```

### OpenAI SDK / 任意 OpenAI 兼容工具

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8899/v1", api_key="dummy")
r = client.chat.completions.create(
    model="nvidia/nemotron-3-super-120b-a12b:free",
    messages=[{"role": "user", "content": "hello"}],
)
```

```bash
curl http://127.0.0.1:8899/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"cohere/north-mini-code:free","messages":[{"role":"user","content":"hi"}]}'
```

### Cline / Continue / Roo（VS Code 扩展）

配置里选 **OpenAI Compatible**，Base URL 填 `http://127.0.0.1:8899/v1`，API Key 随便填，模型名填上表里的 id。这些扩展是本地进程，直连即可，无需隧道。

### Cursor —— 注意

Cursor 的模型请求由 **Cursor 服务端**发出，`127.0.0.1` 在服务端解析，**打不到本机**。要用必须另配公网隧道，同时你的 prompt 仍会过 Cursor 服务端。不建议。

## 注意事项

- **提示词会发送给上游**：本地网关不代表本地推理；请先查看所选模型提供方的数据处理政策，避免发送敏感代码或数据。
- **偶发超时**：`nvidia/nemotron-3.5-lightning:free` 和 `openrouter/free` 实测出现过 45s 超时，属于上游路由波动，换模型即可。
- **上游错误**：网关会透传上游状态码、错误正文和 `Retry-After`（若存在）；日志记录模型名、状态码和响应耗时，不记录提示词或响应正文。
- **失败诊断**：控制台会对常见 400/401/403/404/408/429/5xx 提供排查建议；这类提示是定位线索，不保证能仅凭状态码确认上游根因。
- **上游限额**：429 可能与账户门槛、短时限流或上游容量有关；遵循上游提示，不要用并发重试放大请求。
- **仅本机监听**：默认绑定 `127.0.0.1`。非本机监听必须设置 `LOCAL_KEY`，并自行评估网络暴露风险。

## 本地测试

```bash
npm test
```
