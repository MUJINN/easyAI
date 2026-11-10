import { useCallback, useEffect, useState } from "react";

import { ApiError, getAdminKey, request, setAdminKey } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCost, formatDateTime, formatNumber } from "@/lib/format";
import type {
  BillingPage,
  CreatedKey,
  KeyInfo,
  LogPage,
  ModelInfo,
  ProviderInfo,
  ProviderTestResult,
  UsageGroupBy,
  UsageRow,
} from "@/types";

type Page = "usage" | "billing" | "logs" | "keys" | "providers" | "models";

const GROUP_LABELS: Record<UsageGroupBy, string> = {
  model: "按模型",
  key: "按 Key",
  backend: "按后端",
  day: "按日期",
};

export default function App() {
  const [adminKey, updateAdminKey] = useState(getAdminKey());
  const [keyDraft, setKeyDraft] = useState(getAdminKey());
  const [page, setPage] = useState<Page>("usage");
  const [groupBy, setGroupBy] = useState<UsageGroupBy>("model");
  const [offset, setOffset] = useState(0);
  const [usageRows, setUsageRows] = useState<UsageRow[]>([]);
  const [billing, setBilling] = useState<BillingPage | null>(null);
  const [logs, setLogs] = useState<LogPage | null>(null);
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [keyUsageRows, setKeyUsageRows] = useState<UsageRow[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [createdKey, setCreatedKey] = useState("");
  const [providerTest, setProviderTest] = useState<ProviderTestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!adminKey) return;
    setLoading(true);
    setError("");
    try {
      const [
        usageData,
        keyUsageData,
        billingData,
        logData,
        keyData,
        providerData,
        modelData,
      ] = await Promise.all([
        request<UsageRow[]>("/admin/usage", { query: { group_by: groupBy } }),
        request<UsageRow[]>("/admin/usage", { query: { group_by: "key" } }),
        request<BillingPage>("/admin/billing", {
          query: { limit: 50, offset },
        }),
        request<LogPage>("/admin/logs", { query: { limit: 50, offset } }),
        request<KeyInfo[]>("/admin/keys"),
        request<ProviderInfo[]>("/admin/providers"),
        request<ModelInfo[]>("/admin/models"),
      ]);
      setUsageRows(usageData);
      setKeyUsageRows(keyUsageData);
      setBilling(billingData);
      setLogs(logData);
      setKeys(keyData);
      setProviders(providerData);
      setModels(modelData);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : "加载管理数据失败"
      );
    } finally {
      setLoading(false);
    }
  }, [adminKey, groupBy, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  function saveKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAdminKey(keyDraft);
    updateAdminKey(keyDraft.trim());
  }

  async function mutate(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
      await load();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : "操作失败"
      );
    }
  }

  async function createAccessKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const payload = {
      alias: stringValue(data, "alias") || null,
      quota_requests: numberValue(data, "quota_requests"),
      quota_amount: usdLimitValue(data, "quota_amount"),
      rate_rpm: numberValue(data, "rate_rpm"),
      max_concurrency: numberValue(data, "max_concurrency"),
    };
    await mutate(async () => {
      const result = await request<CreatedKey>("/admin/keys", {
        method: "POST",
        body: payload,
      });
      setCreatedKey(result.key);
      form.reset();
    });
  }

  async function updateProvider(
    event: React.FormEvent<HTMLFormElement>,
    provider: ProviderInfo
  ) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await mutate(() =>
      request(`/admin/providers/${encodeURIComponent(provider.id)}`, {
        method: "PATCH",
        body: {
          type: stringValue(data, "type"),
          base_url: stringValue(data, "base_url") || null,
          api_key_env: stringValue(data, "api_key_env") || null,
          ...(stringValue(data, "api_key")
            ? { api_key: stringValue(data, "api_key") }
            : {}),
          timeout: Number(data.get("timeout")) || 60,
          rpm: numberValue(data, "rpm"),
        },
      })
    );
  }

  async function createProvider(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const payload = {
      id: stringValue(data, "id"),
      type: stringValue(data, "type"),
      base_url: stringValue(data, "base_url") || null,
      api_key: stringValue(data, "api_key") || null,
      api_key_env: stringValue(data, "api_key_env") || null,
      timeout: Number(data.get("timeout")) || 60,
      rpm: numberValue(data, "rpm"),
    };
    await mutate(async () => {
      await request("/admin/providers", { method: "POST", body: payload });
      form.reset();
    });
  }

  async function createModel(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const backend = stringValue(data, "backend");
    const payload = {
      id: stringValue(data, "id"),
      name: stringValue(data, "name") || null,
      strategy: stringValue(data, "strategy") || null,
      backends: backend
        ? [
            {
              backend,
              backend_model: stringValue(data, "backend_model") || null,
              priority: numberValue(data, "priority") ?? 100,
              weight: numberValue(data, "weight") ?? 1,
              input_price_per_1k: optionalNumberValue(data, "input_price"),
              output_price_per_1k: optionalNumberValue(data, "output_price"),
              currency: stringValue(data, "currency") || "USD",
            },
          ]
        : [],
    };
    await mutate(async () => {
      await request("/admin/models", { method: "POST", body: payload });
      form.reset();
    });
  }

  async function updateKey(
    event: React.FormEvent<HTMLFormElement>,
    key: KeyInfo
  ) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await mutate(() =>
      request(`/admin/keys/${key.id}`, {
        method: "PATCH",
        body: {
          quota_requests: numberValue(data, "quota_requests"),
          quota_amount: usdLimitValue(data, "quota_amount"),
          rate_rpm: numberValue(data, "rate_rpm"),
          max_concurrency: numberValue(data, "max_concurrency"),
        },
      })
    );
  }

  async function addBinding(
    event: React.FormEvent<HTMLFormElement>,
    model: ModelInfo
  ) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const backend = stringValue(data, "backend");
    if (!backend) return;
    await mutate(() =>
      request(`/admin/models/${encodeURIComponent(model.id)}/bindings`, {
        method: "POST",
        body: {
          backend,
          backend_model: stringValue(data, "backend_model") || null,
          input_price_per_1k: optionalNumberValue(data, "input_price"),
          output_price_per_1k: optionalNumberValue(data, "output_price"),
          currency: stringValue(data, "currency") || "USD",
        },
      })
    );
  }

  async function testProvider(provider: ProviderInfo) {
    await mutate(async () => {
      setProviderTest(
        await request<ProviderTestResult>(
          `/admin/providers/${encodeURIComponent(provider.id)}/test`,
          { method: "POST" }
        )
      );
    });
  }

  const pages: { id: Page; label: string }[] = [
    { id: "usage", label: "用量概览" },
    { id: "billing", label: "账单明细" },
    { id: "logs", label: "请求日志" },
    { id: "keys", label: "访问 Key" },
    { id: "providers", label: "上游后端" },
    { id: "models", label: "模型路由" },
  ];

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-5">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-blue-700">
              easyAI
            </p>
            <h1 className="mt-1 text-2xl font-semibold">模型中转站</h1>
          </div>
          <form onSubmit={saveKey} className="flex gap-2">
            <input
              aria-label="Admin Key"
              className="h-10 w-64 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-blue-600"
              type="password"
              autoComplete="current-password"
              placeholder="输入 Admin Key"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
            />
            <Button type="submit" variant="outline">
              保存
            </Button>
          </form>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-5 py-7">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <nav aria-label="控制台页面" className="flex gap-2">
            {pages.map((item) => (
              <Button
                key={item.id}
                type="button"
                variant={page === item.id ? "default" : "ghost"}
                onClick={() => setPage(item.id)}
              >
                {item.label}
              </Button>
            ))}
          </nav>
          <Button type="button" variant="outline" onClick={() => void load()} disabled={loading}>
            {loading ? "加载中…" : "刷新"}
          </Button>
        </div>

        {!adminKey && (
          <div className="mb-5 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            请先输入 Admin Key。密钥仅保存在当前浏览器的本地存储中。
          </div>
        )}
        {error && (
          <div role="alert" className="mb-5 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800">
            {error}
          </div>
        )}

        {page === "usage" && (
          <section>
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">用量概览</h2>
                <p className="mt-1 text-sm text-slate-500">用量与费用按当前账单记录聚合。</p>
              </div>
              <select
                className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm"
                value={groupBy}
                onChange={(event) => setGroupBy(event.target.value as UsageGroupBy)}
                aria-label="用量分组"
              >
                {Object.entries(GROUP_LABELS).map(([value, label]) => (
                  <option value={value} key={value}>{label}</option>
                ))}
              </select>
            </div>
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{GROUP_LABELS[groupBy]}</TableHead>
                      <TableHead>请求数</TableHead>
                      <TableHead>输入 Tokens</TableHead>
                      <TableHead>输出 Tokens</TableHead>
                      <TableHead>估算费用</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {usageRows.map((row) => (
                      <TableRow key={row.dim}>
                        <TableCell className="font-medium">{row.dim || "—"}</TableCell>
                        <TableCell>{formatNumber(row.requests)}</TableCell>
                        <TableCell>{formatNumber(row.prompt_tokens)}</TableCell>
                        <TableCell>{formatNumber(row.completion_tokens)}</TableCell>
                        <TableCell>{formatCost(row.cost_usd)}</TableCell>
                      </TableRow>
                    ))}
                    {!usageRows.length && (
                      <TableRow><TableCell colSpan={5} className="py-10 text-center text-slate-500">暂无用量记录</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </section>
        )}

        {page === "billing" && billing && (
          <section>
            <div className="mb-5">
              <h2 className="text-xl font-semibold">账单明细</h2>
              <p className="mt-1 text-sm text-slate-500">仅统计成功请求；费用为估算，仅供参考，单位 USD。</p>
            </div>
            <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <SummaryCard title="成功请求" value={formatNumber(billing.total.requests)} />
              <SummaryCard title="输入 Tokens" value={formatNumber(billing.total.prompt_tokens)} />
              <SummaryCard title="输出 Tokens" value={formatNumber(billing.total.completion_tokens)} />
              <SummaryCard title="估算总费用" value={formatCost(billing.total.cost_usd)} />
            </div>
            <Card>
              <CardHeader><CardTitle className="text-base">收费记录</CardTitle></CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>模型 / 后端</TableHead>
                      <TableHead>Key ID</TableHead>
                      <TableHead>Tokens（输入 / 输出）</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className="text-right">估算费用</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {billing.items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="whitespace-nowrap">{formatDateTime(item.created_at)}</TableCell>
                        <TableCell><div className="font-medium">{item.model}</div><div className="text-xs text-slate-500">{item.backend_id ?? "—"}</div></TableCell>
                        <TableCell className="font-mono text-xs">{item.access_key_id ?? "—"}</TableCell>
                        <TableCell>{formatNumber(item.prompt_tokens)} / {formatNumber(item.completion_tokens)}{item.tokens_estimated && <span className="ml-1 text-xs text-amber-700">估算</span>}</TableCell>
                        <TableCell><Badge variant="success">已结算</Badge></TableCell>
                        <TableCell className="text-right font-medium">{formatCost(item.cost_usd)}</TableCell>
                      </TableRow>
                    ))}
                    {!billing.items.length && (
                      <TableRow><TableCell colSpan={6} className="py-10 text-center text-slate-500">暂无账单记录</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Pager offset={offset} count={billing.items.length} onChange={setOffset} />
          </section>
        )}

        {page === "logs" && logs && (
          <section>
            <div className="mb-5">
              <h2 className="text-xl font-semibold">请求日志</h2>
              <p className="mt-1 text-sm text-slate-500">包含成功与失败请求，用于排查上游错误。</p>
            </div>
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>模型 / 后端</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>Tokens</TableHead>
                      <TableHead>耗时</TableHead>
                      <TableHead>Trace ID</TableHead>
                      <TableHead>错误</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logs.items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="whitespace-nowrap">{formatDateTime(item.created_at)}</TableCell>
                        <TableCell><div className="font-medium">{item.model}</div><div className="text-xs text-slate-500">{item.backend_id ?? "—"}</div></TableCell>
                        <TableCell><Badge variant={item.status === "success" ? "success" : "destructive"}>{item.status}</Badge></TableCell>
                        <TableCell>{formatNumber(item.prompt_tokens + item.completion_tokens)}</TableCell>
                        <TableCell>{formatNumber(item.duration_ms)} ms</TableCell>
                        <TableCell className="max-w-40 truncate font-mono text-xs" title={item.id}>{item.id}</TableCell>
                        <TableCell className="text-red-700">{item.error_type ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                    {!logs.items.length && (
                      <TableRow><TableCell colSpan={7} className="py-10 text-center text-slate-500">暂无请求日志</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Pager offset={offset} count={logs.items.length} onChange={setOffset} />
          </section>
        )}

        {page === "keys" && (
          <section>
            <div className="mb-5">
              <h2 className="text-xl font-semibold">访问 Key</h2>
              <p className="mt-1 text-sm text-slate-500">创建密钥、设置配额与限流；密钥明文只在创建时显示一次。</p>
            </div>
            {createdKey && (
              <div className="mb-5 rounded-md border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-950">
                <div className="font-semibold">新 Key 已创建，请立即复制保存</div>
                <code className="mt-2 block break-all">{createdKey}</code>
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() => void navigator.clipboard.writeText(createdKey)}
                >
                  复制 Key
                </Button>
              </div>
            )}
            <Card className="mb-5">
              <CardHeader><CardTitle className="text-base">创建访问 Key</CardTitle></CardHeader>
              <CardContent>
                <form onSubmit={(event) => void createAccessKey(event)} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <FormField name="alias" label="备注 / 应用名" placeholder="例如：我的应用" />
                  <FormField name="quota_requests" label="请求次数上限" type="number" min="1" />
                  <FormField name="quota_amount" label="金额上限（USD）" type="number" min="0" step="0.0001" />
                  <FormField name="rate_rpm" label="速率上限（请求/分钟）" type="number" min="1" />
                  <FormField name="max_concurrency" label="最大并发数" type="number" min="1" />
                  <div className="flex items-end"><Button type="submit">创建 Key</Button></div>
                </form>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>备注</TableHead><TableHead>状态</TableHead><TableHead>已用请求</TableHead>
                    <TableHead>配额 / 限制</TableHead><TableHead>创建时间</TableHead><TableHead>操作</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {keys.map((key) => (
                      <TableRow key={key.id}>
                        <TableCell><div className="font-medium">{key.alias || "未命名"}</div><code className="text-xs text-slate-500">{key.id}</code></TableCell>
                        <TableCell><Badge variant={key.status === "active" ? "success" : "secondary"}>{key.status}</Badge></TableCell>
                        <TableCell>{formatNumber(keyUsageRows.find((row) => row.dim === key.id)?.requests ?? 0)}</TableCell>
                        <TableCell className="min-w-64">
                          <form onSubmit={(event) => void updateKey(event, key)} className="grid grid-cols-2 gap-2">
                            <input className={smallInputClass} name="quota_requests" type="number" min="1" placeholder="次数不限" defaultValue={key.quota_requests ?? ""} aria-label="请求次数配额" />
                            <input className={smallInputClass} name="quota_amount" type="number" min="0" step="0.0001" placeholder="金额不限 USD" defaultValue={key.quota_amount == null ? "" : key.quota_amount / 10000} aria-label="金额配额 USD" />
                            <input className={smallInputClass} name="rate_rpm" type="number" min="1" placeholder="RPM 不限" defaultValue={key.rate_rpm ?? ""} aria-label="每分钟请求限制" />
                            <input className={smallInputClass} name="max_concurrency" type="number" min="1" placeholder="并发不限" defaultValue={key.max_concurrency ?? ""} aria-label="并发限制" />
                            <Button className="col-span-2" size="sm" variant="outline" type="submit">保存配额</Button>
                          </form>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{formatDateTime(key.created_at)}</TableCell>
                        <TableCell>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={key.status === "revoked"}
                              onClick={() => void mutate(() => request(`/admin/keys/${key.id}`, {
                                method: "PATCH",
                                body: { status: key.status === "active" ? "disabled" : "active" },
                              }))}
                            >{key.status === "active" ? "停用" : "启用"}</Button>
                            {key.status !== "revoked" && <Button size="sm" variant="destructive" onClick={() => {
                              if (window.confirm("确定吊销此 Key？现有使用方将立即无法调用。")) {
                                void mutate(() => request(`/admin/keys/${key.id}`, { method: "DELETE" }));
                              }
                            }}>吊销</Button>}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {!keys.length && <EmptyRow columns={6} />}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </section>
        )}

        {page === "providers" && (
          <section>
            <div className="mb-5">
              <h2 className="text-xl font-semibold">上游后端</h2>
              <p className="mt-1 text-sm text-slate-500">管理供应商连接。建议通过环境变量引用 API Key，避免明文密钥进入数据库。</p>
            </div>
            <Card className="mb-5">
              <CardHeader><CardTitle className="text-base">添加后端</CardTitle></CardHeader>
              <CardContent>
                <form onSubmit={(event) => void createProvider(event)} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <FormField name="id" label="后端 ID" placeholder="例如：openai-main" required />
                  <label className="grid gap-1 text-sm"><span>协议类型</span><select className={fieldClass} name="type" defaultValue="openai"><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select></label>
                  <FormField name="base_url" label="API Base URL" placeholder="https://api.example.com/v1" />
                  <FormField name="api_key_env" label="API Key 环境变量" placeholder="例如：OPENAI_API_KEY" />
                  <FormField name="api_key" label="API Key（可选）" type="password" autoComplete="new-password" />
                  <FormField name="timeout" label="超时（秒）" type="number" min="1" defaultValue="60" />
                  <FormField name="rpm" label="速率上限（请求/分钟）" type="number" min="1" />
                  <div className="flex items-end"><Button type="submit">添加后端</Button></div>
                </form>
              </CardContent>
            </Card>
            <div className="mb-5 grid gap-3">
              {providers.map((provider) => (
                <details key={`${provider.id}-${provider.api_key_env ?? "no-env"}`} className="rounded-md border bg-white p-4">
                  <summary className="cursor-pointer text-sm font-medium">编辑连接：{provider.id}</summary>
                  <p className="mt-3 text-sm text-slate-600">
                    环境变量框填写的是变量名，不是 Key。服务会在运行环境中按名称读取 Key；若未读取到，不会使用已保存的 Key。
                  </p>
                  <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm text-slate-700">
                    {provider.api_key_env ? (
                      <>
                        <p>
                          当前来源：环境变量 <code className="font-mono">{provider.api_key_env}</code>
                          {" — "}
                          <span className={provider.api_key_env_available ? "text-emerald-700" : "text-red-700"}>
                            {provider.api_key_env_available ? "服务已读取到值" : "服务未读取到值"}
                          </span>
                        </p>
                        {provider.has_stored_api_key && (
                          <p className="mt-1">数据库中另有已保存的 API Key，但当前环境变量优先，已保存的 Key 未被使用。</p>
                        )}
                      </>
                    ) : provider.has_stored_api_key ? (
                      <p>当前来源：数据库中已保存的 API Key。</p>
                    ) : (
                      <p>当前没有可用的 API Key。</p>
                    )}
                    <p className="mt-1 text-xs text-slate-500">
                      {provider.has_api_key ? "凭证值不会在控制台显示。" : "尚未解析出可用凭证；连通测试可能因鉴权失败。"}
                    </p>
                  </div>
                  <form onSubmit={(event) => void updateProvider(event, provider)} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <label className="grid gap-1 text-sm"><span>协议类型</span><select className={fieldClass} name="type" defaultValue={provider.type}><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select></label>
                    <FormField name="base_url" label="API Base URL" defaultValue={provider.base_url ?? ""} />
                    <FormField name="api_key_env" label="API Key 环境变量名" placeholder="例如：MOONSHOT_API_KEY" defaultValue={provider.api_key_env ?? ""} />
                    <FormField name="api_key" label="替换 API Key（留空不更改）" type="password" autoComplete="new-password" />
                    <FormField name="timeout" label="超时（秒）" type="number" min="1" defaultValue={String(provider.timeout)} />
                    <FormField name="rpm" label="速率限制（请求/分钟）" type="number" min="1" defaultValue={provider.rpm == null ? "" : String(provider.rpm)} />
                    <div className="flex items-end"><Button type="submit">保存连接设置</Button></div>
                  </form>
                  {provider.api_key_env && (
                    <Button
                      className="mt-3"
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void mutate(() => request(`/admin/providers/${encodeURIComponent(provider.id)}`, {
                        method: "PATCH",
                        body: { api_key_env: null },
                      }))}
                    >
                      清除环境变量引用
                    </Button>
                  )}
                </details>
              ))}
            </div>
            {providerTest && (
              <div role="status" className={`mb-4 rounded-md border p-3 text-sm ${providerTest.ok ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-amber-300 bg-amber-50 text-amber-900"}`}>
                {providerTest.id}: HTTP {providerTest.status} — {providerTest.message}
              </div>
            )}
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>ID</TableHead><TableHead>协议</TableHead><TableHead>Base URL</TableHead>
                    <TableHead>Key</TableHead><TableHead>状态</TableHead><TableHead>操作</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {providers.map((provider) => (
                      <TableRow key={provider.id}>
                        <TableCell className="font-medium">{provider.id}</TableCell>
                        <TableCell>{provider.type}</TableCell>
                        <TableCell className="max-w-xs truncate" title={provider.base_url ?? ""}>{provider.base_url || "—"}</TableCell>
                        <TableCell>
                          <Badge variant={provider.has_api_key ? "success" : "warning"}>
                            {provider.api_key_env
                              ? provider.api_key_env_available
                                ? `环境变量已读取：${provider.api_key_env}`
                                : `环境变量未读取：${provider.api_key_env}`
                              : provider.has_stored_api_key
                                ? "已保存"
                                : "缺失"}
                          </Badge>
                        </TableCell>
                        <TableCell><Badge variant={provider.enabled ? "success" : "secondary"}>{provider.enabled ? "启用" : "下架"}</Badge></TableCell>
                        <TableCell><div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" onClick={() => void testProvider(provider)}>连通测试</Button>
                          <Button size="sm" variant="outline" onClick={() => void mutate(() => request(`/admin/providers/${encodeURIComponent(provider.id)}`, {
                            method: "PATCH", body: { enabled: !provider.enabled },
                          }))}>{provider.enabled ? "下架" : "启用"}</Button>
                          <Button size="sm" variant="destructive" onClick={() => {
                            if (window.confirm(`确定删除后端 ${provider.id}？它关联的模型绑定也会被删除。`)) {
                              void mutate(() => request(`/admin/providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" }));
                            }
                          }}>删除</Button>
                        </div></TableCell>
                      </TableRow>
                    ))}
                    {!providers.length && <EmptyRow columns={6} />}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </section>
        )}

        {page === "models" && (
          <section>
            <div className="mb-5">
              <h2 className="text-xl font-semibold">模型目录与路由</h2>
              <p className="mt-1 text-sm text-slate-500">对外统一模型名映射到一个或多个上游后端；可设置优先级、单价和 fallback 顺序。</p>
            </div>
            <Card className="mb-5">
              <CardHeader><CardTitle className="text-base">创建模型</CardTitle></CardHeader>
              <CardContent>
                <form onSubmit={(event) => void createModel(event)} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <FormField name="id" label="统一模型 ID" placeholder="例如：fast-chat" required />
                  <FormField name="name" label="显示名称" />
                  <label className="grid gap-1 text-sm"><span>路由策略</span><StrategySelect name="strategy" /></label>
                  <BackendSelect providers={providers} />
                  <FormField name="backend_model" label="上游模型 ID" placeholder="默认使用统一模型 ID" />
                  <FormField name="input_price" label="输入单价 / 1k" type="number" min="0" step="0.000001" />
                  <FormField name="output_price" label="输出单价 / 1k" type="number" min="0" step="0.000001" />
                  <FormField name="currency" label="定价币种" defaultValue="USD" />
                  <div className="flex items-end"><Button type="submit">创建模型</Button></div>
                </form>
              </CardContent>
            </Card>
            <div className="grid gap-4">
              {models.map((model) => (
                <Card key={model.id}>
                  <CardHeader className="flex-row items-center justify-between space-y-0">
                    <div><CardTitle className="text-base">{model.name || model.id}</CardTitle><p className="mt-1 font-mono text-xs text-slate-500">{model.id}</p></div>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-2 text-xs text-slate-600">策略
                        <StrategySelect
                          name={`strategy-${model.id}`}
                          value={model.strategy ?? ""}
                          onChange={(value) => void mutate(() => request(`/admin/models/${encodeURIComponent(model.id)}`, {
                            method: "PATCH", body: { strategy: value },
                          }))}
                        />
                      </label>
                      <Badge variant={model.enabled ? "success" : "secondary"}>{model.enabled ? "已启用" : "已禁用"}</Badge>
                      <Button size="sm" variant="outline" onClick={() => void mutate(() => request(`/admin/models/${encodeURIComponent(model.id)}`, {
                        method: "PATCH", body: { enabled: !model.enabled },
                      }))}>{model.enabled ? "禁用" : "启用"}</Button>
                      <Button size="sm" variant="destructive" onClick={() => {
                        if (window.confirm(`确定删除模型 ${model.id} 及其全部绑定？`)) {
                          void mutate(() => request(`/admin/models/${encodeURIComponent(model.id)}`, { method: "DELETE" }));
                        }
                      }}>删除</Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader><TableRow>
                          <TableHead>后端</TableHead><TableHead>上游模型</TableHead><TableHead>优先级</TableHead>
                          <TableHead>输入 / 输出单价（每 1k）</TableHead><TableHead>状态</TableHead><TableHead />
                        </TableRow></TableHeader>
                        <TableBody>
                          {model.backends.map((binding) => (
                            <TableRow key={binding.id}>
                              <TableCell>{binding.backend}</TableCell>
                              <TableCell>{binding.backend_model || model.id}</TableCell>
                              <TableCell>{binding.priority}</TableCell>
                              <TableCell>{binding.input_price_per_1k ?? "—"} / {binding.output_price_per_1k ?? "—"} {binding.currency}</TableCell>
                              <TableCell><Badge variant={binding.enabled ? "success" : "secondary"}>{binding.enabled ? "启用" : "禁用"}</Badge></TableCell>
                              <TableCell><div className="flex gap-2">
                                <Button size="sm" variant="outline" onClick={() => void mutate(() => request(`/admin/models/bindings/${encodeURIComponent(binding.id)}`, {
                                  method: "PATCH", body: { enabled: !binding.enabled },
                                }))}>{binding.enabled ? "禁用" : "启用"}</Button>
                                <Button size="sm" variant="destructive" onClick={() => void mutate(() => request(`/admin/models/bindings/${encodeURIComponent(binding.id)}`, { method: "DELETE" }))}>删除</Button>
                              </div></TableCell>
                            </TableRow>
                          ))}
                          {!model.backends.length && <EmptyRow columns={6} />}
                        </TableBody>
                      </Table>
                    </div>
                    <form onSubmit={(event) => void addBinding(event, model)} className="mt-4 grid gap-2 border-t pt-4 sm:grid-cols-2 lg:grid-cols-7">
                      <BackendSelect providers={providers} />
                      <FormField name="backend_model" label="上游模型 ID" />
                      <FormField name="priority" label="优先级" type="number" min="0" defaultValue="100" />
                      <FormField name="weight" label="权重" type="number" min="1" defaultValue="1" />
                      <FormField name="input_price" label="输入 / 1k" type="number" min="0" step="0.000001" />
                      <FormField name="output_price" label="输出 / 1k" type="number" min="0" step="0.000001" />
                      <div className="flex items-end gap-2"><input className={fieldClass} name="currency" aria-label="定价币种" defaultValue="USD" /><Button type="submit">添加绑定</Button></div>
                    </form>
                  </CardContent>
                </Card>
              ))}
              {!models.length && <Card><CardContent className="py-10 text-center text-slate-500">暂无模型目录</CardContent></Card>}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function SummaryCard({ title, value }: { title: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-slate-500">{title}</CardTitle></CardHeader>
      <CardContent><p className="text-2xl font-semibold">{value}</p></CardContent>
    </Card>
  );
}

function Pager({
  offset,
  count,
  onChange,
}: {
  offset: number;
  count: number;
  onChange: (offset: number) => void;
}) {
  return (
    <div className="mt-4 flex items-center justify-end gap-3 text-sm text-slate-500">
      <span>第 {Math.floor(offset / 50) + 1} 页</span>
      <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - 50))}>上一页</Button>
      <Button variant="outline" size="sm" disabled={count < 50} onClick={() => onChange(offset + 50)}>下一页</Button>
    </div>
  );
}

const fieldClass =
  "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-blue-600";
const smallInputClass =
  "h-9 min-w-0 rounded-md border border-slate-300 bg-white px-2 text-xs outline-none focus:border-blue-600";

function FormField({
  name,
  label,
  type = "text",
  placeholder,
  min,
  step,
  defaultValue,
  required = false,
  autoComplete,
}: {
  name: string;
  label: string;
  type?: string;
  placeholder?: string;
  min?: string;
  step?: string;
  defaultValue?: string;
  required?: boolean;
  autoComplete?: string;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span>{label}</span>
      <input
        className={fieldClass}
        name={name}
        type={type}
        placeholder={placeholder}
        min={min}
        step={step}
        defaultValue={defaultValue}
        required={required}
        autoComplete={autoComplete}
      />
    </label>
  );
}

function BackendSelect({ providers }: { providers: ProviderInfo[] }) {
  return (
    <label className="grid gap-1 text-sm">
      <span>上游后端（可留空）</span>
      <select className={fieldClass} name="backend" defaultValue="">
        <option value="">暂不绑定</option>
        {providers.map((provider) => (
          <option key={provider.id} value={provider.id} disabled={!provider.enabled}>
            {provider.id}{provider.enabled ? "" : "（已下架）"}
          </option>
        ))}
      </select>
    </label>
  );
}

function StrategySelect({
  name,
  value,
  onChange,
}: {
  name: string;
  value?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <select
      className={fieldClass}
      name={name}
      value={value}
      defaultValue={value === undefined ? "" : undefined}
      onChange={onChange ? (event) => onChange(event.target.value) : undefined}
      aria-label="路由策略"
    >
      <option value="">默认策略</option>
      <option value="priority">优先级</option>
      <option value="round_robin">轮询</option>
      <option value="weight">权重</option>
      <option value="random">随机</option>
    </select>
  );
}

function EmptyRow({ columns }: { columns: number }) {
  return (
    <TableRow>
      <TableCell colSpan={columns} className="py-10 text-center text-slate-500">
        暂无记录
      </TableCell>
    </TableRow>
  );
}

function stringValue(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(data: FormData, name: string): number | null {
  const value = stringValue(data, name);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalNumberValue(data: FormData, name: string): number | null {
  return numberValue(data, name);
}

function usdLimitValue(data: FormData, name: string): number | null {
  const dollars = numberValue(data, name);
  return dollars === null ? null : Math.round(dollars * 10000);
}
