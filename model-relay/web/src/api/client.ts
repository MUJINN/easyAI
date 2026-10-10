/**同源 fetch 封装：附加 Admin Key、解析错误。

控制台与管理 API 同进程同源（requirements 10.5），故使用相对路径，
容器 / 本机 / 局域网部署都无需配置 base URL。
*/

const ADMIN_KEY_STORAGE = "model-relay-admin-key";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function getAdminKey(): string {
  return localStorage.getItem(ADMIN_KEY_STORAGE) ?? "";
}

export function setAdminKey(key: string) {
  localStorage.setItem(ADMIN_KEY_STORAGE, key.trim());
}

export function clearAdminKey() {
  localStorage.removeItem(ADMIN_KEY_STORAGE);
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | null | undefined>;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== null && value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${getAdminKey()}`,
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const resp = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (resp.status === 204) {
    return undefined as T;
  }

  const text = await resp.text();
  const data = text ? safeJsonParse(text) : undefined;

  if (!resp.ok) {
    const message = extractErrorMessage(data) ?? `请求失败（HTTP ${resp.status}）`;
    throw new ApiError(resp.status, message);
  }

  return data as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractErrorMessage(data: unknown): string | null {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.detail === "string") return obj.detail;
    const error = obj.error;
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
  }
  return null;
}
