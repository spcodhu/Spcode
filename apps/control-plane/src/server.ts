import { type ChildProcess, fork } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { resolveSpcodeHome } from "@spcode/shared/node";
import {
  DEFAULT_SUPERAGENT_CONFIG,
  parseSuperAgentCommand,
  SUPERAGENT_PROTOCOL_VERSION,
  type SuperAgentSnapshot,
} from "@spcode/shared/superagent";
import { WORKER_NODE_PROTOCOL_VERSION, type WorkerNodeCapabilities } from "@spcode/shared/worker-node";
import { SuperAgentEngine } from "@spcode/superagent";
import { WebSocketServer } from "ws";
import { AuthService, CONTROL_COOKIE, ensureDeviceToken, parseCookies, tokensEqual } from "./auth.js";
import { ConfigStore } from "./config.js";
import { DesktopHub } from "./desktop-hub.js";
import { readRuntimeInfo, removeRuntimeInfo, writeRuntimeInfo } from "./discovery.js";
import { GitWorkspaceManager } from "./git-workspace.js";
import { type FeishuApi, LarkFeishuApi } from "./integrations/feishu/api.js";
import { FeishuGateway } from "./integrations/feishu/gateway.js";
import { OutboxDispatcher } from "./integrations/feishu/outbox.js";
import {
  assertPublicOptions,
  IdentityStore,
  type OidcOptions,
  OidcVerifier,
  type PublicPrincipal,
  type PublicSecurityOptions,
  RateLimiter,
} from "./public-security.js";
import { RouterStore } from "./router-store.js";
import { SourceStore } from "./source-store.js";
import { DigestService, GitHubConnector, type GitHubIssueConnector } from "./sources/github.js";
import { PostgresSuperAgentStore } from "./store-postgres.js";
import { SqliteSuperAgentStore } from "./store-sqlite.js";
import type { WatchdogHealth } from "./watchdog.js";
import { WatchdogStore } from "./watchdog-store.js";
import { WorkerManager } from "./worker-manager.js";
import { WorkerNodeService } from "./worker-node-service.js";
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

function sanitizeCapabilities(value: unknown): WorkerNodeCapabilities {
  const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const list = (key: string) =>
    Array.isArray(input[key])
      ? input[key].filter((item): item is string => typeof item === "string").slice(0, 100)
      : [];
  const capacity = Number(input.capacity);
  return {
    platform: typeof input.platform === "string" ? input.platform.slice(0, 50) : process.platform,
    hostname: typeof input.hostname === "string" ? input.hostname.slice(0, 200) : "worker-node",
    capacity: Number.isSafeInteger(capacity) && capacity >= 1 && capacity <= 4 ? capacity : 1,
    repos: list("repos"),
    models: list("models"),
  };
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
  watchdogEnabled?: boolean;
  watchdogEntry?: string;
  watchdogPollMs?: number;
  exitOnStop?: boolean;
  afterOutboxSend?: () => void;
  public?: PublicSecurityOptions;
  oidc?: OidcOptions;
  postgres?: { connectionString: string; workerFile: URL };
  /** false 表示仅使用远程 Worker Node，不在本 Router 启动本地 WorkerManager。 */
  localWorkerEnabled?: boolean;
}

export class ControlPlane {
  readonly startedAt = Date.now();
  readonly baseDir: string;
  readonly host: string;
  private readonly requestedPort: number;
  private readonly workbenchDir: string;
  private readonly store: SqliteSuperAgentStore;
  private readonly router: RouterStore;
  private readonly workerNodes: WorkerNodeService;
  private readonly routerId = `router_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  private readonly workers: WorkerStore;
  private readonly sources: SourceStore;
  private feishuApi: FeishuApi | null = null;
  private readonly configuration: ConfigStore;
  private readonly watchdog: WatchdogStore;
  private readonly digest: DigestService;
  private readonly auth: AuthService;
  private readonly identities: IdentityStore;
  private readonly oidc: OidcVerifier | null;
  private readonly rateLimiter: RateLimiter;
  private readonly publicSecurity: PublicSecurityOptions;
  private readonly server: Server;
  private readonly browserWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private readonly desktopWss = new WebSocketServer({ noServer: true, maxPayload: 25 * 1024 * 1024 });
  private hub!: DesktopHub;
  private engine!: SuperAgentEngine;
  private workerManager: WorkerManager | null = null;
  private feishuGateway: FeishuGateway | null = null;
  private outboxDispatcher: OutboxDispatcher | null = null;
  private digestTimer: NodeJS.Timeout | null = null;
  private routerTimer: NodeJS.Timeout | null = null;
  private readonly sourceLeases = new Set<string>();
  private sourcesRunning = false;
  private sourceConnected = false;
  private watchdogChild: ChildProcess | null = null;
  private port = 0;
  private closing = false;

  private get publicMode(): boolean {
    return !!this.publicSecurity.publicUrl;
  }

  private get enabled(): boolean {
    return this.options.superAgentEnabled ?? this.configuration.get().enabled;
  }

  constructor(private readonly options: ControlPlaneOptions) {
    this.baseDir = options.baseDir ?? join(resolveSpcodeHome(), "superagent");
    this.host = options.host ?? "127.0.0.1";
    if (this.host !== "127.0.0.1" && this.host !== "localhost") throw new Error("阶段一控制面只允许监听 loopback");
    this.requestedPort = options.port ?? 0;
    this.workbenchDir = resolve(options.workbenchDir);
    this.store = options.postgres
      ? new PostgresSuperAgentStore({ ...options.postgres, baseDir: this.baseDir })
      : new SqliteSuperAgentStore(options.databaseFile ?? join(this.baseDir, "control.sqlite"));
    this.router = new RouterStore(this.store.db);
    this.configuration = new ConfigStore(this.baseDir, options.superAgentEnabled);
    this.watchdog = new WatchdogStore(this.store.db);
    this.workers = new WorkerStore(this.store.db, (sequence, workItemId) => this.publishEvent(sequence, workItemId));
    this.sources = new SourceStore(this.store.db, this.store, (sequence, workItemId) =>
      this.publishEvent(sequence, workItemId),
    );
    this.workerNodes = new WorkerNodeService(this.store, this.workers, this.router, () => this.enabled);
    this.digest = new DigestService(
      this.sources,
      options.githubConnector ?? new GitHubConnector({ token: process.env.SPCODE_GITHUB_TOKEN }),
    );
    this.auth = new AuthService(this.store.db, ensureDeviceToken(this.baseDir));
    this.identities = new IdentityStore(this.store.db);
    this.oidc = options.oidc ? new OidcVerifier(options.oidc) : null;
    this.publicSecurity = options.public ?? {};
    assertPublicOptions(this.publicSecurity);
    this.rateLimiter = new RateLimiter(this.publicSecurity.rateLimitPerMinute ?? (this.publicMode ? 120 : 6000));
    this.server = createServer((request, response) => void this.handle(request, response));
    this.server.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
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
    this.router.register(this.routerId, `http://${this.host}:${this.port}`);
    this.workerNodes.attachEngine(this.engine);
    this.workerNodes.start();
    this.routerTimer = setInterval(() => {
      this.router.heartbeat(this.routerId);
      for (const source of this.sourceLeases) this.router.renewSourceLease(source, this.routerId);
    }, 5000);
    await this.initializeFeishu();
    this.sources.recoverSending();
    this.sources.projectNotifications();
    await this.startSuperAgent();
    this.startWatchdog();
    return { port: this.port, deviceToken: ensureDeviceToken(this.baseDir) };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.watchdogChild?.kill("SIGTERM");
    this.watchdogChild = null;
    if (this.routerTimer) clearInterval(this.routerTimer);
    this.routerTimer = null;
    await this.stopSuperAgent();
    this.router.offline(this.routerId);
    this.workerNodes.close();
    this.hub?.close();
    this.browserWss.close();
    this.desktopWss.close();
    await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
    this.store.close();
    removeRuntimeInfo(this.baseDir);
    if (this.options.exitOnStop) process.exit(0);
  }

  private startWatchdog(): void {
    if (this.options.watchdogEnabled === false || this.watchdogChild) return;
    const entry =
      this.options.watchdogEntry ?? resolve(dirname(fileURLToPath(import.meta.url)), "../dist/watchdog.mjs");
    if (!existsSync(entry)) return;
    const child = fork(entry, [], {
      detached: true,
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SPCODE_SUPERAGENT_DIR: this.baseDir,
        SPCODE_WATCHDOG_POLL_MS: String(this.options.watchdogPollMs ?? 5000),
      },
    });
    child.stdout?.on("data", (data) => console.warn("[watchdog]", String(data).trim()));
    child.stderr?.on("data", (data) => console.error("[watchdog]", String(data).trim()));
    child.unref();
    child.once("exit", (code) => {
      if (this.watchdogChild === child) this.watchdogChild = null;
      console.warn(`[watchdog] 进程退出 code=${code}`);
    });
    this.watchdogChild = child;
  }

  private async initializeFeishu(): Promise<void> {
    const appId = process.env.SPCODE_FEISHU_APP_ID?.trim();
    const appSecret = process.env.SPCODE_FEISHU_APP_SECRET?.trim();
    const botOpenId = process.env.SPCODE_FEISHU_BOT_OPEN_ID?.trim();
    this.feishuApi =
      this.options.feishuApi ??
      (appId && appSecret && botOpenId ? await LarkFeishuApi.create({ appId, appSecret, botOpenId }) : null);
    if (!this.feishuApi) return;
    this.feishuGateway = new FeishuGateway(
      this.sources,
      this.feishuApi,
      () => ({
        enabled: this.enabled,
        allowedChats: this.configuration.get().allowedChats,
        authorizedOperators: this.configuration.get().authorizedOperators,
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
    this.outboxDispatcher = new OutboxDispatcher(this.sources, this.feishuApi, {
      pollMs: this.options.outboxPollMs,
      afterSend: this.options.afterOutboxSend,
    });
  }

  private async startSuperAgent(): Promise<void> {
    if (!this.enabled || this.closing) return;
    if (!this.sourcesRunning) {
      if (this.feishuGateway) {
        try {
          if (this.acquireSource("feishu")) {
            await this.feishuGateway.start();
            this.outboxDispatcher?.start();
            this.sourceConnected = true;
          }
        } catch (error) {
          this.sourceConnected = false;
          console.error("[feishu] 长连接启动失败，Outbox 保持持久化等待恢复", error);
        }
      }
      await this.runDueDigests();
      this.digestTimer = setInterval(() => void this.runDueDigests(), 30_000);
      this.sourcesRunning = true;
    }
    if (this.workerManager) return;
    if (this.options.localWorkerEnabled === false) return;
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
      artifacts: this.store.artifacts,
      concurrency: () => this.configuration.get().concurrency,
      budgetUsd: () => this.configuration.get().budgetUsd,
      model: this.configuration.get().model ?? undefined,
      pollMs: this.options.workerPollMs,
      afterCommit: this.options.afterCommit,
      onError: (error, workItemId) => console.error(`[worker] ${workItemId}:`, error),
    });
    await this.workerManager.start();
  }

  private async stopSuperAgent(): Promise<void> {
    if (this.digestTimer) clearInterval(this.digestTimer);
    this.digestTimer = null;
    await this.outboxDispatcher?.stop();
    await this.feishuGateway?.stop().catch(() => {});
    this.sourceConnected = false;
    this.sourcesRunning = false;
    await this.workerManager?.stop();
    this.workerManager = null;
    this.releaseSources();
  }

  private acquireSource(source: string): boolean {
    const acquired = this.router.acquireSourceLease(source, this.routerId);
    if (acquired) this.sourceLeases.add(source);
    return acquired;
  }

  private releaseSources(): void {
    for (const source of this.sourceLeases) this.router.releaseSourceLease(source, this.routerId);
    this.sourceLeases.clear();
  }

  recoverWorkerNodes(): void {
    this.workerNodes.recoverStale();
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
    const configuredRepo = this.configuration.get().repositories.find((candidate) => candidate.repo === repo);
    if (configuredRepo?.localPath) return configuredRepo.localPath;
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
    if (localPath && repo === this.configuration.get().defaultRepo) return localPath;
    return `https://github.com/${repo}.git`;
  }

  private snapshot(): SuperAgentSnapshot {
    return {
      ...this.store.snapshot(),
      findings: this.watchdog.list(),
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

  private digestChatId(repo: string): string {
    const config = this.configuration.get();
    return (
      config.repositories.find((candidate) => candidate.repo === repo)?.chatId ||
      this.options.digestChatId ||
      config.digestChatId ||
      process.env.SPCODE_SUPERAGENT_DIGEST_CHAT_ID ||
      ""
    );
  }

  private async runDueDigests(): Promise<void> {
    if (!this.enabled || this.closing || this.options.digestSchedulerEnabled === false) return;
    const repos = envList(process.env.SPCODE_SUPERAGENT_DIGEST_REPOS);
    const config = this.configuration.get();
    const configuredRepos = config.repositories.length ? config.repositories.map((item) => item.repo) : repos;
    for (const repo of configuredRepos.length ? configuredRepos : [config.defaultRepo]) {
      const chatId = this.digestChatId(repo);
      try {
        if (
          this.digest.dueDaily(repo, config.timezone, config.dailyDigestTime) &&
          this.acquireSource(`digest:${repo}`)
        ) {
          await this.digest.run({ repo, chatId, mode: "daily", timezone: config.timezone });
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
      if (this.publicMode && this.publicSecurity.requireTls !== false) {
        const forwarded = request.headers["x-forwarded-proto"];
        if (forwarded !== "https" && !this.publicSecurity.allowInsecureForTest) {
          this.json(response, 403, { error: { code: "TLS_REQUIRED", message: "公网请求必须经 HTTPS 反向代理" } });
          return;
        }
      }
      const clientIp = this.publicSecurity.trustProxy
        ? String(request.headers["x-forwarded-for"] ?? request.socket.remoteAddress ?? "unknown")
            .split(",")[0]!
            .trim()
        : (request.socket.remoteAddress ?? "unknown");
      const rate = this.rateLimiter.check(`${clientIp}:${url.pathname}`);
      if (!rate.allowed) {
        response.setHeader("Retry-After", String(rate.retryAfterSeconds));
        this.json(response, 429, { error: { code: "RATE_LIMITED", message: "请求过于频繁" } });
        return;
      }
      if (url.pathname === "/api/v1/health" && request.method === "GET") {
        this.json(response, 200, {
          ok: true,
          protocolVersion: SUPERAGENT_PROTOCOL_VERSION,
          pid: process.pid,
          startedAt: this.startedAt,
          desktopConnected: this.hub.connected,
          authMode: this.publicMode ? "oidc" : "device",
        });
        return;
      }
      if (url.pathname === "/api/v1/watchdog/health" && request.method === "GET" && this.internalAuthorized(request)) {
        const outbox = this.sources.listOutbox();
        const pending = outbox.filter((item) => item.status === "PENDING" || item.status === "RETRY");
        const oldest = pending.length ? Math.min(...pending.map((item) => item.createdAt)) : null;
        const health: WatchdogHealth = {
          controlPlane: { pid: process.pid, startedAt: this.startedAt, database: true },
          processingPaused: this.store.processingPaused(),
          attempts: this.workers.listActiveAttempts().map((attempt) => ({
            id: attempt.id,
            workItemId: attempt.workItemId,
            role: attempt.role,
            status: attempt.status,
            heartbeatAt: attempt.heartbeatAt,
            leaseExpiresAt: attempt.leaseExpiresAt,
            workerPid: attempt.workerPid,
            fence: attempt.fence,
          })),
          outbox: {
            pendingCount: pending.length,
            oldestPendingAgeMs: oldest === null ? null : Date.now() - oldest,
            unknownCount: outbox.filter((item) => item.status === "UNKNOWN").length,
            failedCount: outbox.filter((item) => item.status === "FAILED").length,
          },
          source: { configured: !!this.feishuApi, connected: this.sourceConnected },
        };
        this.json(response, 200, health);
        return;
      }
      if (
        url.pathname === "/api/v1/watchdog/findings" &&
        request.method === "POST" &&
        this.internalAuthorized(request)
      ) {
        const action = (await this.readJson(request)) as {
          open?: { type?: string; subjectId?: string; workItemId?: string; evidence?: Record<string, unknown> };
        };
        if (!action.open?.type || !action.open.subjectId || !action.open.evidence) throw new Error("Finding 格式无效");
        this.watchdog.open(action.open.type, action.open.subjectId, action.open.evidence, action.open.workItemId);
        this.hub.publish(this.store.snapshot().revision);
        this.json(response, 200, { ok: true });
        return;
      }
      if (
        url.pathname === "/api/v1/watchdog/resolve" &&
        request.method === "POST" &&
        this.internalAuthorized(request)
      ) {
        const action = (await this.readJson(request)) as { type?: string; subjectId?: string };
        if (!action.type || !action.subjectId) throw new Error("Finding 解决格式无效");
        this.watchdog.resolve(action.type, action.subjectId);
        this.hub.publish(this.store.snapshot().revision);
        this.json(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/v1/worker-nodes/pair" && request.method === "POST") {
        const principal = this.principal(request);
        if (!this.internalAuthorized(request) && !principal?.roles.includes("admin")) {
          this.json(response, 403, {
            error: { code: "FORBIDDEN", message: "只有 admin 或本地 serviceToken 可以配对节点" },
          });
          return;
        }
        if (!this.validMutation(request, response)) return;
        const input = (await this.readJson(request)) as {
          name?: string;
          protocolVersion?: number;
          capabilities?: WorkerNodeCapabilities;
        };
        const capabilities = sanitizeCapabilities(input.capabilities);
        const paired = this.workerNodes.pair(
          String(input.name ?? ""),
          Number(input.protocolVersion ?? WORKER_NODE_PROTOCOL_VERSION),
          capabilities,
        );
        this.json(response, 200, paired);
        return;
      }
      if (url.pathname === "/api/v1/worker-nodes/revoke" && request.method === "POST") {
        const principal = this.principal(request);
        if (!this.internalAuthorized(request) && !principal?.roles.includes("admin")) {
          this.json(response, 403, {
            error: { code: "FORBIDDEN", message: "只有 admin 或本地 serviceToken 可以吊销节点" },
          });
          return;
        }
        if (!this.validMutation(request, response)) return;
        const input = (await this.readJson(request)) as { nodeId?: string };
        if (!input.nodeId) throw new Error("nodeId 必填");
        this.workerNodes.revoke(input.nodeId);
        this.json(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/v1/worker-nodes" && request.method === "GET") {
        if (!this.principal(request)) {
          this.json(response, 401, { error: { code: "UNAUTHENTICATED", message: "请先登录" } });
          return;
        }
        this.json(response, 200, { nodes: this.workerNodes.nodes() });
        return;
      }
      if (url.pathname === "/api/v1/worker-node/artifacts" && request.method === "POST") {
        const body = await this.readBody(request, 16 * 1024 * 1024);
        const artifact = await this.workerNodes.handleArtifact(request, body);
        this.json(response, 200, { id: artifact.id, sha256: artifact.sha256, size: artifact.size });
        return;
      }
      if (url.pathname === "/api/v1/auth/oidc" && request.method === "POST") {
        if (!this.publicMode || !this.oidc) {
          this.json(response, 403, { error: { code: "OIDC_DISABLED", message: "公网 OIDC 未启用" } });
          return;
        }
        if (!this.validMutation(request, response)) return;
        const input = (await this.readJson(request)) as { token?: unknown };
        if (typeof input.token !== "string" || input.token.length > 32_000) throw new Error("OIDC token 无效");
        const principal = await this.oidc.verify(input.token);
        const token = this.identities.create(principal);
        response.setHeader(
          "Set-Cookie",
          `${CONTROL_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}${this.publicSecurity.publicUrl?.startsWith("https:") ? "; Secure" : ""}`,
        );
        this.json(response, 200, { subject: principal.subject, roles: principal.roles });
        return;
      }
      if (url.pathname === "/api/v1/auth/bootstrap" && request.method === "POST") {
        if (this.publicMode) {
          this.json(response, 403, { error: { code: "DEVICE_BOOTSTRAP_DISABLED", message: "公网模式必须使用 OIDC" } });
          return;
        }
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
        const principal = this.principal(request);
        if (!principal) {
          this.json(response, 401, {
            error: {
              code: "UNAUTHENTICATED",
              message: this.publicMode ? "请先通过 OIDC 登录" : "请先使用本地启动链接完成设备认证",
            },
          });
          return;
        }
        if (!this.authorized(principal, request.method ?? "GET", url)) {
          this.json(response, 403, { error: { code: "FORBIDDEN", message: "当前身份无权执行此动作" } });
          return;
        }
        if (request.method !== "GET" && !this.validMutation(request, response)) return;
        if (this.closing && request.method !== "GET") {
          this.json(response, 503, { error: { code: "STOPPING", message: "控制面正在停止，不再接收新命令" } });
          return;
        }
        if (url.pathname === "/api/v1/service/stop" && request.method === "POST") {
          this.json(response, 200, { ok: true });
          setImmediate(() => void this.close());
          return;
        }
        if (url.pathname === "/api/v1/superagent/snapshot" && request.method === "GET") {
          this.json(response, 200, this.snapshot());
          return;
        }
        if (url.pathname === "/api/v1/superagent/config" && request.method === "GET") {
          this.json(response, 200, this.configuration.public());
          return;
        }
        const workItemEventsMatch = url.pathname.match(
          /^\/api\/v1\/superagent\/workitems\/(wi_[A-Za-z0-9_-]+)\/events$/,
        );
        if (workItemEventsMatch && request.method === "GET") {
          this.json(response, 200, { events: this.workers.workerEvents(workItemEventsMatch[1]!) });
          return;
        }
        const artifactMatch = url.pathname.match(/^\/api\/v1\/artifacts\/(ar_[A-Za-z0-9_-]+)$/);
        if (artifactMatch && request.method === "GET") {
          const artifact = this.store.artifacts.get(artifactMatch[1]!);
          if (!artifact) {
            this.json(response, 404, { error: { code: "NOT_FOUND", message: "Artifact 不存在" } });
            return;
          }
          const content = this.store.artifacts.read(artifact);
          response.writeHead(200, {
            "Content-Type": artifact.mimeType,
            "Content-Length": content.byteLength,
            "Content-Disposition": `attachment; filename="${artifact.id}"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'",
          });
          response.end(content);
          return;
        }
        if (url.pathname === "/api/v1/superagent/commands" && request.method === "POST") {
          const command = parseSuperAgentCommand(await this.readJson(request));
          if (command.type === "config.update") {
            if (!principal.roles.includes("admin")) {
              this.json(response, 403, { error: { code: "FORBIDDEN", message: "只有 admin 可以修改配置" } });
              return;
            }
            const wasEnabled = this.enabled;
            this.configuration.set(command.patch);
            if (wasEnabled !== this.enabled) {
              if (this.enabled) await this.startSuperAgent();
              else await this.stopSuperAgent();
            }
            this.hub.publish(this.store.snapshot().revision);
            this.json(response, 200, this.snapshot());
            return;
          }
          if (command.type === "digest.run") {
            if (!this.enabled) throw new Error("SuperAgent 未启用");
            const chatId = this.digestChatId(command.repo);
            if (!chatId) throw new Error("请先配置 SPCODE_SUPERAGENT_DIGEST_CHAT_ID");
            await this.digest.run({
              repo: command.repo,
              chatId,
              mode: "manual",
              requestId: command.requestId,
              timezone: this.configuration.get().timezone,
            });
          } else if (command.type === "digest.resolve") {
            this.sources.resolveDigestItem({
              ...command,
              actorId: this.commandActor(principal),
              chatId: this.sources.digestConversation(command.digestId),
            });
          } else if (command.type === "outbox.reconcile") {
            this.sources.reconcileOutbox(command.id, command.outcome, command.externalId);
          } else {
            this.engine.execute(command, this.commandActor(principal));
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
    if (this.publicMode && this.publicSecurity.requireTls !== false && !this.publicSecurity.allowInsecureForTest) {
      if (request.headers["x-forwarded-proto"] !== "https") {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    if (url.pathname === "/api/v1/worker-node") {
      this.workerNodes.handleUpgrade(request, socket, head);
      return;
    }
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

  private internalAuthorized(request: IncomingMessage): boolean {
    const runtime = readRuntimeInfo(this.baseDir);
    const authorization = request.headers.authorization ?? "";
    return (
      !!runtime && authorization.startsWith("Bearer ") && tokensEqual(authorization.slice(7), runtime.serviceToken)
    );
  }

  private authenticated(request: IncomingMessage): boolean {
    return !!this.principal(request);
  }

  private principal(request: IncomingMessage): PublicPrincipal | null {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[CONTROL_COOKIE];
    if (this.publicMode) return this.identities.authenticate(token);
    return this.auth.authenticate(token) ? { subject: "local-device", roles: ["admin"], issuer: "local" } : null;
  }

  private authorized(principal: PublicPrincipal, method: string, url: URL): boolean {
    if (method === "GET" || method === "HEAD") return true;
    const admin = principal.roles.includes("admin");
    if (url.pathname === "/api/v1/service/stop" || url.pathname === "/api/v1/desktop/invoke") return admin;
    if (url.pathname === "/api/v1/superagent/commands" && !admin) {
      // config.update 需要 admin，其余工作项命令 operator 即可；请求体由后续运行时校验。
      return principal.roles.includes("operator");
    }
    return admin || principal.roles.includes("operator");
  }

  private commandActor(principal: PublicPrincipal): string {
    return this.publicMode ? `external:${principal.subject}` : "local-device";
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
      if (this.publicMode) {
        const trusted = new Set([
          ...(this.publicSecurity.trustedOrigins ?? []),
          ...(this.publicSecurity.publicUrl ? [new URL(this.publicSecurity.publicUrl).origin] : []),
        ]);
        return trusted.has(url.origin);
      }
      return (url.protocol === "http:" || url.protocol === "https:") && this.validHost(url.host);
    } catch {
      return false;
    }
  }

  private validHost(host: string | undefined): boolean {
    if (!host) return false;
    if (this.publicMode) {
      const publicHost = this.publicSecurity.publicUrl ? new URL(this.publicSecurity.publicUrl).host : null;
      const trusted = new Set([...(this.publicSecurity.trustedHosts ?? []), ...(publicHost ? [publicHost] : [])]);
      return trusted.has(host) || host === `${this.host}:${this.port}` || host === `127.0.0.1:${this.port}`;
    }
    return (
      host === `${this.host}:${this.port}` || host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`
    );
  }

  private async readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw new Error("请求体超过大小限制");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
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
