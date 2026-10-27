"""端到端验收本机网关：OpenAI 路径 + Anthropic 路径 + 流式。"""
import json, urllib.request, urllib.error, time

GW = "http://127.0.0.1:8899"


def req(path, body=None, method="GET", headers=None):
    if body is not None and method == "GET":
        method = "POST"
    r = urllib.request.Request(GW + path, method=method)
    for k, v in (headers or {"content-type": "application/json"}).items():
        r.add_header(k, v)
    data = json.dumps(body).encode() if body is not None else None
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, data=data, timeout=90) as resp:
            return resp.status, resp.read().decode("utf-8", "replace"), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), time.time() - t0
    except Exception as e:
        return None, f"{type(e).__name__}: {e}", time.time() - t0


print("=== 0. healthz ===")
st, raw, dt = req("/healthz")
print(f"  {st} ({dt:.2f}s) {raw[:150]}")

print("\n=== 1. GET /v1/models（免费池）===")
st, raw, dt = req("/v1/models")
if st == 200:
    models = json.loads(raw).get("data", [])
    free = [m for m in models if m.get("isFree")]
    print(f"  {st} ({dt:.2f}s) 总 {len(models)} / 免费 {len(free)}")
    for m in free[:6]:
        print("   -", m["id"])
else:
    print(f"  {st} {raw[:200]}")

print("\n=== 2. OpenAI /v1/chat/completions 非流式 ===")
st, raw, dt = req("/v1/chat/completions", {
    "model": "nvidia/nemotron-3-super-120b-a12b:free",
    "messages": [{"role": "user", "content": "用一句话说明什么是 prompt cache。"}],
    "max_tokens": 500, "stream": False})
print(f"  {st} ({dt:.2f}s)")
if st == 200:
    d = json.loads(raw)
    c = (d.get("choices") or [{}])[0]
    print("  content:", repr((c.get("message") or {}).get("content"))[:250])
    print("  usage:", d.get("usage", {}).get("total_tokens"))
else:
    print("  ", raw[:250])

print("\n=== 3. OpenAI 流式 ===")
st, raw, dt = req("/v1/chat/completions", {
    "model": "cohere/north-mini-code:free",
    "messages": [{"role": "user", "content": "说三个字"}],
    "max_tokens": 200, "stream": True})
print(f"  {st} ({dt:.2f}s) SSE行数={len([l for l in raw.splitlines() if l.strip()])}")

print("\n=== 4. Anthropic /v1/messages（Claude Code 用）===")
st, raw, dt = req("/v1/messages", {
    "model": "nvidia/nemotron-3-super-120b-a12b:free",
    "max_tokens": 300, "system": "You are a coding agent.",
    "messages": [{"role": "user", "content": "Run ls. Use the tool."}],
    "tools": [{"name": "bash", "description": "shell",
               "input_schema": {"type": "object", "properties": {"cmd": {"type": "string"}}, "required": ["cmd"]}}]})
print(f"  {st} ({dt:.2f}s)")
if st == 200:
    d = json.loads(raw)
    for b in d.get("content", []):
        print("  block:", b.get("type"), "->", str(b)[:150])
    print("  stop_reason:", d.get("stop_reason"))
else:
    print("  ", raw[:250])

print("\n=== 5. 工具调用（OpenAI 格式）===")
st, raw, dt = req("/v1/chat/completions", {
    "model": "nvidia/nemotron-3-super-120b-a12b:free",
    "messages": [{"role": "user", "content": "北京天气？用工具。"}],
    "max_tokens": 400, "stream": False,
    "tools": [{"type": "function", "function": {"name": "get_weather",
               "description": "weather", "parameters": {"type": "object",
               "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]})
print(f"  {st} ({dt:.2f}s)")
if st == 200:
    d = json.loads(raw)
    c = (d.get("choices") or [{}])[0]
    print("  finish:", c.get("finish_reason"))
    tc = (c.get("message") or {}).get("tool_calls")
    print("  tool_calls:", json.dumps(tc, ensure_ascii=False)[:250] if tc else None)
else:
    print("  ", raw[:250])
