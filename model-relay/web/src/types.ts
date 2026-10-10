/**与后端管理 API 对应的类型（字段名与 Pydantic 模型一致）。 */

export interface KeyInfo {
  id: string;
  tenant_id: string;
  alias: string | null;
  quota_requests: number | null;
  quota_amount: number | null;
  rate_rpm: number | null;
  max_concurrency: number | null;
  status: string;
  created_at: string;
  expires_at: string | null;
}

export interface CreatedKey extends KeyInfo {
  key: string;
}

export interface KeyPayload {
  alias?: string | null;
  quota_requests?: number | null;
  quota_amount?: number | null;
  rate_rpm?: number | null;
  max_concurrency?: number | null;
  expires_at?: string | null;
  status?: string;
}

export interface ProviderInfo {
  id: string;
  type: string;
  base_url: string | null;
  has_api_key: boolean;
  timeout: number;
  rpm: number | null;
  enabled: boolean;
}

export interface ProviderPayload {
  id?: string;
  type?: string;
  base_url?: string | null;
  api_key?: string | null;
  api_key_env?: string | null;
  timeout?: number;
  rpm?: number | null;
  enabled?: boolean;
}

export interface BindingInfo {
  id: string;
  backend: string;
  backend_model: string | null;
  priority: number;
  weight: number;
  input_price_per_1k: number | null;
  output_price_per_1k: number | null;
  currency: string;
  enabled: boolean;
}

export interface BindingPayload {
  backend?: string;
  backend_model?: string | null;
  priority?: number;
  weight?: number;
  input_price_per_1k?: number | null;
  output_price_per_1k?: number | null;
  currency?: string;
  enabled?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string | null;
  owned_by: string;
  strategy: string | null;
  enabled: boolean;
  backends: BindingInfo[];
}

export interface ModelPayload {
  id?: string;
  name?: string | null;
  owned_by?: string;
  strategy?: string | null;
  enabled?: boolean;
  backends?: BindingPayload[];
}

export type UsageGroupBy = "key" | "model" | "backend" | "day";

export interface UsageRow {
  dim: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
}

export interface LogItem {
  id: string;
  access_key_id: string | null;
  tenant_id: string;
  model: string;
  backend_id: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  tokens_estimated: boolean;
  duration_ms: number;
  fallback: boolean;
  attempts: number;
  cost_usd: number;
  status: string;
  error_type: string | null;
  created_at: string;
}

export interface LogPage {
  total: number;
  items: LogItem[];
}

export interface LogFilters {
  id?: string | null;
  key_id?: string | null;
  model?: string | null;
  backend_id?: string | null;
  status?: string | null;
  limit?: number;
  offset?: number;
}

export interface ProviderTestResult {
  id: string;
  ok: boolean;
  status: number;
  message: string;
}
