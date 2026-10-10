# easyAI · 模型中转站 (model-relay)

统一的 AI 模型网关 / 中转站。屏蔽多家大模型厂商（OpenAI、Anthropic、DeepSeek、Gemini、通义、智谱、Ollama 本地等）在接口、鉴权、计费上的差异，对外暴露一套简洁、统一、**OpenAI 兼容**的 API。

> 一句话：**一套 Key、一个地址，调用所有模型。**

需求文档见 [requirements.md](requirements.md)。

## 状态：M3

- ✅ M1：仓库骨架、配置加载、OpenAI 兼容 hello-world 网关
- ✅ M2：首个真实后端（OpenAI / DeepSeek / Ollama，OpenAI 兼容协议）、chat/completions 转发 + SSE 流式、Bearer Key 鉴权、基础记账（SQLite）
- ✅ M3：模型目录多后端映射、fallback（429 / 5xx / 连接故障自动切换）、简单路由策略（priority / round-robin / weight / random）、后端动态下架
- ⏳ M4：管理控制台、限流、重试、额度扣减

## 快速开始

```bash
cd model-relay
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
cp config.example.yaml config.yaml
cp .env.example .env
uvicorn model_relay.main:app --reload --port 8080
```

### 配置真实后端

1. 在 `.env` 中填入上游厂商 Key（如 `DEEPSEEK_API_KEY=sk-xxx`），并设置管理 Key `MODEL_RELAY_ADMIN_KEY`。
2. `config.yaml` 中维护「统一模型名 → 后端」的映射（模板已含 DeepSeek / OpenAI / Ollama 示例）。

### 创建中转站 Key

```bash
curl -X POST http://localhost:8080/admin/keys \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"alias":"my-app"}'
# 响应中的 key 字段（sk-easyai-...）仅此一次返回，请妥善保存
```

### 调用

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-easyai-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
```

流式：请求体加 `"stream": true`，响应为 SSE。

任何官方 OpenAI SDK 只需把 `base_url` 改为 `http://localhost:8080/v1`、`api_key` 改为中转站 Key 即可直连。

## 模型目录与路由

一个统一模型名可以挂多个后端，按 `priority` 自动形成 fallback 链：

```yaml
routing:
  strategy: priority        # 全局默认策略
models:
  - id: deepseek-chat
    backends:
      - backend: deepseek-official
        priority: 10        # 主后端
      - backend: openrouter
        backend_model: deepseek/deepseek-chat
        priority: 20        # 备用后端
```

**fallback 规则**：上游返回 429 / 408 / 5xx 或连接失败时，自动切换下一个后端；400 / 401 / 403 等错误立即透传，不做重试。流式请求只在首帧到达前切换——部分内容已经发给客户端后无法重来。

**路由策略**（模型可用 `strategy` 字段单独覆盖）：

| 策略 | 行为 |
|------|------|
| `priority`（默认） | 按 priority 升序，同序保持配置先后 |
| `round_robin` | 在可用后端间轮转起点 |
| `weight` | 按权重随机选首个后端，其余按优先级兜底 |
| `random` | 等概率随机选首个后端 |

**动态下架**：把绑定或后端的 `enabled` 改为 `false` 即从候选中剔除，配置随每次请求热加载，无需重启（M2 的单后端写法 `backend: xxx` 仍然兼容）。

## 测试

```bash
pytest
```

测试不依赖真实上游：通过 `httpx.MockTransport` 模拟 OpenAI 兼容后端，SQLite 使用临时库。

## Docker 启动

```bash
docker compose up --build
```

## 管理 API

| 端点 | 说明 |
|------|------|
| `GET /admin/health` | 健康检查 |
| `GET /admin/info` | 元数据与配置概览 |
| `POST /admin/keys` | 创建 Access Key（明文仅返回一次） |
| `GET /admin/keys` | 列出 Access Key |
| `DELETE /admin/keys/{id}` | 吊销 Access Key |

管理 API 全部使用 `Authorization: Bearer $MODEL_RELAY_ADMIN_KEY` 鉴权。
