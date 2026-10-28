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
| POST | `/v1/chat/completions` | OpenAI Chat Completions，支持 `stream: true` |
| POST | `/v1/messages` | Anthropic Messages，支持 `stream: true`、`thinking`、`tool_use` |
| POST | `/v1/responses` | OpenAI Responses（部分模型） |
| GET | `/healthz` | 本机服务健康检查（不检查上游） |
| GET | `/` | 本地模型控制台 |
| GET | `/api/catalog` | 上游模型目录与项目能力标签 |
| POST | `/api/test` | 用户手动触发的单次模型测试 |

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
