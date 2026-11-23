import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { resolveSpcodeHome } from "@spcode/shared/node";
import {
  DEFAULT_SUPERAGENT_CONFIG,
  parseSuperAgentCommand,
  SUPERAGENT_PROTOCOL_VERSION,
  type SuperAgentSnapshot,
} from "@spcode/shared/superagent";
import { SuperAgentEngine } from "@spcode/superagent";
import { WebSocketServer } from "ws";
import { AuthService, CONTROL_COOKIE, ensureDeviceToken, parseCookies } from "./auth.js";
import { DesktopHub } from "./desktop-hub.js";
import { removeRuntimeInfo, writeRuntimeInfo } from "./discovery.js";
import { GitWorkspaceManager } from "./git-workspace.js";
import { type FeishuApi, LarkFeishuApi } from "./integrations/feishu/api.js";
import { FeishuGateway } from "./integrations/feishu/gateway.js";
import { OutboxDispatcher } from "./integrations/feishu/outbox.js";
import { SourceStore } from "./source-store.js";
import { DigestService, GitHubConnector, type GitHubIssueConnector } from "./sources/github.js";
import { SqliteSuperAgentStore } from "./store-sqlite.js";
import { WorkerManager } from "./worker-manager.js";
import { createDefaultWorkerRunner, type WorkerRunner } from "./worker-runner.js";
import { WorkerStore } from "./worker-store.js";

const DESKTOP_METHODS = new Set([
  "command",
  "getSettings",
  "setSettings",
  "listSessions",
  "removeSession",
  "searchSessions",
  "getComposerDrafts",
  "setComposerDrafts",
  "runRetryList",
  "runRetrySchedule",
  "runRetryCancel",
  "usageSession",
  "usageSummary",
  "usageAggregate",
  "quotaQuery",
  "sandboxStatus",
  "scheduleList",
  "scheduleCreate",
  "scheduleUpdate",
  "scheduleDelete",
  "scheduleRunNow",
  "replyPermission",
  "replyQuestion",
  "revokePermissions",
  "sessionGitState",
  "sessionGitDiff",
  "sessionGitRevert",
  "readPlanFile",
  "readWorkspaceFile",
  "readWorkspaceImage",
]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

function envList(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export interface ControlPlaneOptions {
  baseDir?: string;
  databaseFile?: string;
  workbenchDir: string;
  host?: string;
  port?: number;
  superAgentEnabled?: boolean;
  spcodeHome?: string;
  resolveRepoPath?: (repo: string) => string;
  workerRunner?: WorkerRunner;
  workerPollMs?: number;
  afterCommit?: () => void;
  githubConnector?: GitHubIssueConnector;
  feishuApi?: FeishuApi;
  digestChatId?: string;
  digestSchedulerEnabled?: boolean;
  outboxPollMs?: number;
}

export class ControlPlane {
  readonly startedAt = Date.now();
  readonly baseDir: string;
  readonly host: string;
  private readonly requestedPort: number;
  private readonly workbenchDir: string;
  private readonly store: SqliteSuperAgentStore;
  private readonly workers: WorkerStore;
  private readonly sources: SourceStore;
  private readonly feishuApi: FeishuApi | null;
  private readonly digest: DigestService;
  private readonly enabled: boolean;
  private readonly auth: AuthService;
  private readonly server: Server;
  private readonly browserWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private readonly desktopWss = new WebSocketServer({ noServer: true, maxPayload: 25 * 1024 * 1024 });
  private hub!: DesktopHub;
  private engine!: SuperAgentEngine;
  private workerManager: WorkerManager | null = null;
  private feishuGateway: FeishuGateway | null = null;
  private outboxDispatcher: OutboxDispatcher | null = null;
  private digestTimer: NodeJS.Timeout | null = null;
  private port = 0;
  private closing = false;

  constructor(private readonly options: ControlPlaneOptions) {
    this.baseDir = options.baseDir ?? join(resolveSpcodeHome(), "superagent");
    this.host = options.host ?? "127.0.0.1";
    if (this.host !== "127.0.0.1" && this.host !== "localhost") throw new Error("阶段一控制面只允许监听 loopback");
    this.requestedPort = options.port ?? 0;
    this.workbenchDir = resolve(options.workbenchDir);
    this.store = new SqliteSuperAgentStore(options.databaseFile ?? join(this.baseDir, "control.sqlite"));
    this.workers = new WorkerStore(this.store.db, (sequence, workItemId) => this.publishEvent(sequence, workItemId));
    this.sources = new SourceStore(this.store.db, this.store, (sequence, workItemId) =>
      this.publishEvent(sequence, workItemId),
    );
    this.digest = new DigestService(
      this.sources,
      options.githubConnector ?? new GitHubConnector({ token: process.env.SPCODE_GITHUB_TOKEN }),
    );
    this.enabled = options.superAgentEnabled ?? process.env.SPCODE_SUPERAGENT_ENABLED === "1";
    this.auth = new AuthService(this.store.db, ensureDeviceToken(this.baseDir));
    this.server = createServer((request, response) => void this.handle(request, response));
    this.server.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
    const appId = process.env.SPCODE_FEISHU_APP_ID?.trim();
    const appSecret = process.env.SPCODE_FEISHU_APP_SECRET?.trim();
    const botOpenId = process.env.SPCODE_FEISHU_BOT_OPEN_ID?.trim();
    const feishuApi =
      options.feishuApi ??
      (appId && appSecret && botOpenId ? new LarkFeishuApi({ appId, appSecret, botOpenId }) : null);
    this.feishuApi = feishuApi;
    if (feishuApi) {
      this.feishuGateway = new FeishuGateway(
        this.sources,
        feishuApi,
        () => ({
          enabled: this.enabled,
          allowedChats: envList(process.env.SPCODE_SUPERAGENT_ALLOWED_CHATS),
          authorizedOperators: envList(process.env.SPCODE_SUPERAGENT_AUTHORIZED_OPERATORS),
          defaultRepo: DEFAULT_SUPERAGENT_CONFIG.defaultRepo,
          botOpenId: process.env.SPCODE_FEISHU_BOT_OPEN_ID ?? "",
        }),
        (input) => {
          this.engine.execute(
            { type: "plan.approve", workItemId: input.workItemId, planId: input.planId, planHash: input.planHash },
            `feishu:${input.actorId}`,
          );
          this.sources.projectNotifications();
        },
        async (message) => {
          await this.hub.invoke("feishu.privateMessage", [message]).catch(() => {});
        },
        async (action) => {
          await this.hub.invoke("feishu.privateCard", [action]).catch(() => {});
        },
      );
      this.outboxDispatcher = new OutboxDispatcher(this.sources, feishuApi, { pollMs: this.options.outboxPollMs });
    }
  }

  async start(): Promise<{ port: number; deviceToken: string }> {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => rejectListen(error);
      this.server.once("error", onError);
      this.server.listen(this.requestedPort, this.host, () => {
        this.server.off("error", onError);
        resolveListen();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("控制面端口绑定失败");
    this.port = address.port;
    const runtime = writeRuntimeInfo(this.baseDir, this.port, this.startedAt);
    this.hub = new DesktopHub(
      runtime.serviceToken,
      () => {},
      (method, args) => this.desktopControl(method, args),
    );
    this.engine = new SuperAgentEngine(this.store, {
      publish: (event) => this.publishEvent(event.sequence, event.workItemId),
    });
    this.sources.recoverSending();
    this.sources.projectNotifications();
    if (this.enabled) {
      if (this.feishuGateway) {
        try {
          await this.feishuGateway.start();
          this.outboxDispatcher?.start();
        } catch (error) {
          console.error("[feishu] 长连接启动失败，Outbox 保持持久化等待恢复", error);
        }
      }
      await this.runDueDigests();
      this.digestTimer = setInterval(() => void this.runDueDigests(), 30_000);
      const git = new GitWorkspaceManager(this.baseDir, (repo) => this.repoSource(repo));
      this.workerManager = new WorkerManager({
        baseDir: this.baseDir,
        store: this.store,
        workers: this.workers,
        git,
        runner:
          this.options.workerRunner ??
          createDefaultWorkerRunner(this.baseDir, this.options.spcodeHome ?? dirname(this.baseDir)),
        engine: this.engine,
        pollMs: this.options.workerPollMs,
        afterCommit: this.options.afterCommit,
        onError: (error, workItemId) => console.error(`[worker] ${workItemId}:`, error),
      });
      await this.workerManager.start();
    }
    return { port: this.port, deviceToken: ensureDeviceToken(this.baseDir) };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.digestTimer) clearInterval(this.digestTimer);
    this.digestTimer = null;
    this.outboxDispatcher?.stop();
    await this.feishuGateway?.stop().catch(() => {});
    await this.workerManager?.stop();
    this.hub?.close();
    this.browserWss.close();
    this.desktopWss.close();
    await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
    this.store.close();
    removeRuntimeInfo(this.baseDir);
  }

  private async desktopControl(method: string, args: unknown[]): Promise<unknown> {
    if (!this.feishuApi) throw new Error("飞书控制面未配置");
    if (method === "feishu.sendPrivateText") {
      if (!this.feishuApi.sendPrivateText) throw new Error("当前飞书 Provider 不支持私聊文本");
      return this.feishuApi.sendPrivateText(String(args[0]), String(args[1]));
    }
    if (method === "feishu.sendPrivateCard") {
      if (!this.feishuApi.sendPrivateCard) throw new Error("当前飞书 Provider 不支持私聊卡片");
      return this.feishuApi.sendPrivateCard(String(args[0]), args[1] as Record<string, unknown>);
    }
    if (method === "feishu.updateCard") {
      return this.feishuApi.updateCard(String(args[0]), args[1] as Record<string, unknown>);
    }
    throw new Error(`未知控制面回调：${method}`);
  }

  private repoSource(repo: string): string {
    if (this.options.resolveRepoPath) return this.options.resolveRepoPath(repo);
    const configured = process.env.SPCODE_SUPERAGENT_REPOS?.trim();
    if (configured) {
      try {
        const parsed = JSON.parse(configured) as Record<string, unknown>;
        if (typeof parsed[repo] === "string") return parsed[repo];
      } catch {
        throw new Error('SPCODE_SUPERAGENT_REPOS 必须是 {"owner/repo":"本地路径"} JSON');
      }
    }
    const localPath = process.env.SPCODE_SUPERAGENT_REPO_PATH?.trim();
    if (localPath && repo === DEFAULT_SUPERAGENT_CONFIG.defaultRepo) return localPath;
    return `https://github.com/${repo}.git`;
  }

  private snapshot(): SuperAgentSnapshot {
    return {
      ...this.store.snapshot(),
      enabled: this.enabled,
      digests: this.sources.listDigests(),
      outbox: this.sources.listOutbox().map((record) => ({
        id: record.id,
        conversationId: record.conversationId,
        kind: record.kind,
        status: record.status,
        externalId: record.externalId,
        attemptCount: record.attemptCount,
        lastError: record.lastError,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })),
      service: {
        protocolVersion: SUPERAGENT_PROTOCOL_VERSION,
        startedAt: this.startedAt,
        database: "sqlite",
        desktopConnected: this.hub.connected,
        processingPaused: this.store.processingPaused(),
      },
    };
  }

  private publishEvent(sequence: number, workItemId?: string): void {
    this.hub?.publish(sequence, workItemId);
    this.sources?.projectNotifications();
  }

  private async runDueDigests(): Promise<void> {
    if (!this.enabled || this.closing || this.options.digestSchedulerEnabled === false) return;
    const chatId = this.options.digestChatId ?? process.env.SPCODE_SUPERAGENT_DIGEST_CHAT_ID ?? "";
    if (!chatId) return;
    const repos = envList(process.env.SPCODE_SUPERAGENT_DIGEST_REPOS);
    for (const repo of repos.length ? repos : [DEFAULT_SUPERAGENT_CONFIG.defaultRepo]) {
      try {
        if (this.digest.dueDaily(repo, DEFAULT_SUPERAGENT_CONFIG.timezone, DEFAULT_SUPERAGENT_CONFIG.dailyDigestTime)) {
          await this.digest.run({ repo, chatId, mode: "daily", timezone: DEFAULT_SUPERAGENT_CONFIG.timezone });
        }
      } catch (error) {
        console.error(`[digest] ${repo}:`, error);
      }
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.validHost(request.headers.host)) {
        this.json(response, 403, { error: { code: "UNTRUSTED_HOST", message: "不可信的 Host" } });
        return;
      }
      const url = new URL(request.url ?? "/", `http://${this.host}:${this.port}`);
      if (url.pathname === "/api/v1/health" && request.method === "GET") {
        this.json(response, 200, {
          ok: true,
          protocolVersion: SUPERAGENT_PROTOCOL_VERSION,
          pid: process.pid,
          startedAt: this.startedAt,
          desktopConnected: this.hub.connected,
        });
        return;
      }
      if (url.pathname === "/api/v1/auth/bootstrap" && request.method === "POST") {
        if (!this.validMutation(request, response)) return;
        const authorization = request.headers.authorization ?? "";
        const token = authorization.startsWith("Bearer ") ? this.auth.bootstrap(authorization.slice(7)) : null;
        if (!token) {
          this.json(response, 401, { error: { code: "INVALID_BOOTSTRAP", message: "本地设备引导令牌无效" } });
          return;
        }
        response.setHeader(
          "Set-Cookie",
          `${CONTROL_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}`,
        );
        this.json(response, 200, { ok: true });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (!this.authenticated(request)) {
          this.json(response, 401, { error: { code: "UNAUTHENTICATED", message: "请先使用本地启动链接完成设备认证" } });
          return;
        }
        if (request.method !== "GET" && !this.validMutation(request, response)) return;
        if (this.closing && request.method !== "GET") {
          this.json(response, 503, { error: { code: "STOPPING", message: "控制面正在停止，不再接收新命令" } });
          return;
        }
        if (url.pathname === "/api/v1/superagent/snapshot" && request.method === "GET") {
          this.json(response, 200, this.snapshot());
          return;
        }
        if (url.pathname === "/api/v1/superagent/commands" && request.method === "POST") {
          const command = parseSuperAgentCommand(await this.readJson(request));
          if (command.type === "digest.run") {
            if (!this.enabled) throw new Error("SuperAgent 未启用");
            const chatId = this.options.digestChatId ?? process.env.SPCODE_SUPERAGENT_DIGEST_CHAT_ID ?? "";
            if (!chatId) throw new Error("请先配置 SPCODE_SUPERAGENT_DIGEST_CHAT_ID");
            await this.digest.run({
              repo: command.repo,
              chatId,
              mode: "manual",
              requestId: command.requestId,
              timezone: DEFAULT_SUPERAGENT_CONFIG.timezone,
            });
          } else if (command.type === "digest.resolve") {
            this.sources.resolveDigestItem({
              ...command,
              actorId: "local-device",
              chatId: this.sources.digestConversation(command.digestId),
            });
          } else if (command.type === "outbox.reconcile") {
            this.sources.reconcileOutbox(command.id, command.outcome, command.externalId);
          } else {
            this.engine.execute(command, "local-device");
            if (command.type === "workitem.cancel") await this.workerManager?.cancel(command.workItemId);
          }
          this.json(response, 200, this.snapshot());
          return;
        }
        if (url.pathname === "/api/v1/desktop/invoke" && request.method === "POST") {
          const input = await this.readJson(request);
          if (
            !input ||
            typeof input !== "object" ||
            typeof (input as { method?: unknown }).method !== "string" ||
            !Array.isArray((input as { args?: unknown }).args)
          ) {
            throw new Error("桌面调用格式无效");
          }
          const { method, args } = input as { method: string; args: unknown[] };
          if (!DESKTOP_METHODS.has(method)) {
            this.json(response, 403, { error: { code: "METHOD_NOT_ALLOWED", message: "该桌面能力尚未开放 Web 适配" } });
            return;
          }
          this.json(response, 200, { result: await this.hub.invoke(method, args) });
          return;
        }
        this.json(response, 404, { error: { code: "NOT_FOUND", message: "控制面接口不存在" } });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        this.json(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "静态工作台只支持 GET" } });
        return;
      }
      this.serveStatic(url.pathname, request.method === "HEAD", response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.json(response, 400, { error: { code: "BAD_REQUEST", message } });
    }
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.validHost(request.headers.host)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", `http://${this.host}:${this.port}`);
    if (url.pathname === "/api/v1/desktop") {
      this.hub.handleDesktopUpgrade(request, socket, head, this.desktopWss);
      return;
    }
    if (url.pathname === "/api/v1/events" && this.authenticated(request) && this.validOrigin(request.headers.origin)) {
      this.hub.handleBrowserUpgrade(request, socket, head, this.browserWss);
      return;
    }
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
  }

  private authenticated(request: IncomingMessage): boolean {
    const cookies = parseCookies(request.headers.cookie);
    return this.auth.authenticate(cookies[CONTROL_COOKIE]);
  }

  private validMutation(request: IncomingMessage, response: ServerResponse): boolean {
    if (request.headers["x-spcode-control-client"] !== "1" || !this.validOrigin(request.headers.origin)) {
      this.json(response, 403, { error: { code: "CSRF_REJECTED", message: "请求来源或客户端标记不受信任" } });
      return false;
    }
    return true;
  }

  private validOrigin(origin: string | undefined): boolean {
    if (!origin) return true;
    try {
      const url = new URL(origin);
      return (url.protocol === "http:" || url.protocol === "https:") && this.validHost(url.host);
    } catch {
      return false;
    }
  }

  private validHost(host: string | undefined): boolean {
    if (!host) return false;
    return (
      host === `${this.host}:${this.port}` || host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`
    );
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 25 * 1024 * 1024) throw new Error("请求体超过 25MB 限制");
      chunks.push(buffer);
    }
    if (size === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) return;
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(body));
  }

  private serveStatic(pathname: string, headOnly: boolean, response: ServerResponse): void {
    const requested = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
    let file = resolve(this.workbenchDir, `.${requested}`);
    if (!file.startsWith(`${this.workbenchDir}${sep}`) && file !== join(this.workbenchDir, "index.html")) {
      this.json(response, 403, { error: { code: "INVALID_PATH", message: "静态资源路径无效" } });
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (extname(requested)) {
        this.json(response, 404, { error: { code: "NOT_FOUND", message: "静态资源不存在" } });
        return;
      }
      file = join(this.workbenchDir, "index.html");
    }
    if (!existsSync(file)) {
      this.json(response, 503, {
        error: {
          code: "WORKBENCH_NOT_BUILT",
          message: "工作台尚未构建，请先运行 pnpm --filter @spcode/workbench build",
        },
      });
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": extname(file) === ".html" ? "no-store" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    if (headOnly) response.end();
    else createReadStream(file).pipe(response);
  }
}
