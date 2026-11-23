import {
  parseSuperAgentSnapshot,
  type SuperAgentCommand,
  type SuperAgentPublicConfig,
  type SuperAgentSnapshot,
} from "./superagent.js";

export interface ControlHealth {
  ok: true;
  protocolVersion: number;
  pid: number;
  startedAt: number;
  desktopConnected: boolean;
}

export class ControlApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ControlApiError";
  }
}

export interface ControlClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** 版本化控制面 SDK。所有写请求带自定义头，配合同源 Origin 校验形成 CSRF 边界。 */
export class ControlClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ControlClientOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/$/, "") ?? "";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    parse: (value: unknown) => T = (value) => value as T,
  ): Promise<T> {
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    headers.set("X-Spcode-Control-Client", "1");
    if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
    const raw = await response.text();
    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        throw new ControlApiError(response.status, "INVALID_RESPONSE", "控制面返回了无法解析的响应");
      }
    }
    if (!response.ok) {
      const record =
        body && typeof body === "object" ? (body as { error?: { code?: unknown; message?: unknown } }) : null;
      throw new ControlApiError(
        response.status,
        typeof record?.error?.code === "string" ? record.error.code : "REQUEST_FAILED",
        typeof record?.error?.message === "string"
          ? record.error.message
          : `控制面请求失败（${method} ${response.status}）`,
      );
    }
    return parse(body);
  }

  async health(): Promise<ControlHealth> {
    return this.request("/api/v1/health");
  }

  async serviceStop(): Promise<void> {
    await this.request("/api/v1/service/stop", { method: "POST", body: JSON.stringify({}) });
  }

  async bootstrap(token: string): Promise<void> {
    await this.request("/api/v1/auth/bootstrap", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
  }

  async superAgentSnapshot(): Promise<SuperAgentSnapshot> {
    return this.request("/api/v1/superagent/snapshot", {}, parseSuperAgentSnapshot);
  }

  async superAgentConfig(): Promise<SuperAgentPublicConfig> {
    return this.request("/api/v1/superagent/config");
  }

  async superAgentCommand(command: SuperAgentCommand): Promise<SuperAgentSnapshot> {
    return this.request(
      "/api/v1/superagent/commands",
      { method: "POST", body: JSON.stringify(command) },
      parseSuperAgentSnapshot,
    );
  }

  async workItemEvents(
    id: string,
  ): Promise<Array<{ id: number; seq: number; type: string; payload: unknown; createdAt: number }>> {
    return this.request(`/api/v1/superagent/workitems/${encodeURIComponent(id)}/events`, {}, (value) => {
      if (!value || typeof value !== "object" || !Array.isArray((value as { events?: unknown }).events)) {
        throw new Error("Invalid Worker event response");
      }
      return (
        value as { events: Array<{ id: number; seq: number; type: string; payload: unknown; createdAt: number }> }
      ).events;
    });
  }

  artifactUrl(id: string): string {
    return `${this.baseUrl}/api/v1/artifacts/${encodeURIComponent(id)}`;
  }

  async desktopInvoke<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
    const envelope = await this.request<{ result: T }>("/api/v1/desktop/invoke", {
      method: "POST",
      body: JSON.stringify({ method, args }),
    });
    return envelope.result;
  }
}
