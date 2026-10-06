/**
 * Tailscale 直连通道（M3，设计文档 4.4 transport/tailscale.ts）：
 * 不实现 RemoteTransport（不产生连接）——它把已在跑的 LAN HTTP+WS 端口
 * 通过 `tailscale serve` 映射到 tailnet 的 https 地址，连接最终仍落在 LanTransport 上。
 *
 * 安全模型：
 * - 检测全程只读：`tailscale status --json`（3s 超时；命令不存在 / tailscaled
 *   未运行 / BackendState 非 Running 一律视为不可用）；
 * - serve / off 命令仅在用户显式开启 settings.remote.tailscale 后执行；
 * - serve 走 tailnet 内 https（MagicDNS 证书），不开启 Funnel，公网不可达。
 *
 * CLI 语法校准（2026-10-06，按 tailscale serve --help / 官方文档核对）：
 * - 开启：`tailscale serve --bg --https=443 http://localhost:<port>`
 *   （--bg 写入节点持久 serve 配置，重启后仍生效）；
 * - 关闭：`tailscale serve --https=443 off`（off 需带与创建时相同的端口参数）；
 * - MagicDNS 名取自 `tailscale status --json` 的 Self.DNSName（带尾部点，需去除）。
 */

// 注意：本项目 tsconfig（types: ["vite/client"] + bundler 解析）下 "node:child_process"
// 会绑定到一个缺 EventEmitter 方法的 ChildProcess 声明（on/close 事件不可类型化），
// 裸 "child_process" 解析正常——故此处刻意不用 node: 前缀（2026-10-06 实测）。
import { spawn, type ChildProcess } from "child_process";
import type { RemoteTailscaleStatus } from "@spcode/shared";

const DETECT_TIMEOUT_MS = 3000;
const CMD_TIMEOUT_MS = 10_000;
/** 检测结果缓存：设置页轮询 status 时避免每次 spawn */
const DETECT_CACHE_MS = 15_000;

export interface TailscaleDetection {
  available: boolean;
  /** MagicDNS 名（已去尾部点），不可用时为 null */
  dnsName: string | null;
}

export interface TailscaleRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 进程执行器（测试注入假实现，避免依赖本机 tailscale） */
export type TailscaleRunner = (args: string[], timeoutMs: number) => Promise<TailscaleRunResult>;

/** 默认执行器：spawn tailscale CLI，超时强杀 */
const defaultRunner: TailscaleRunner = (args, timeoutMs) =>
  new Promise((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn("tailscale", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      // spawn 同步抛错（罕见）：按不可用处理
      resolvePromise({ code: -1, stdout: "", stderr: "spawn failed" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(-1);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", () => finish(-1)); // ENOENT 等：tailscale 未安装
    child.on("close", (code) => finish(code ?? -1));
  });

/** 解析 `tailscale status --json`：Running 且有 MagicDNS 名才算可用 */
export function parseTailscaleStatus(stdout: string): TailscaleDetection {
  try {
    const data = JSON.parse(stdout) as {
      BackendState?: string;
      Self?: { DNSName?: string };
    };
    if (data.BackendState !== "Running") return { available: false, dnsName: null };
    const dnsName = typeof data.Self?.DNSName === "string" ? data.Self.DNSName.replace(/\.$/, "") : "";
    if (!dnsName) return { available: false, dnsName: null };
    return { available: true, dnsName };
  } catch {
    return { available: false, dnsName: null };
  }
}

export class TailscaleManager {
  private readonly run: TailscaleRunner;
  private readonly log: (msg: string, extra?: unknown) => void;
  private detection: TailscaleDetection | null = null;
  private detectedAt = 0;
  private serving = false;
  private servingUrl: string | null = null;

  constructor(opts: { run?: TailscaleRunner; log?: (msg: string, extra?: unknown) => void } = {}) {
    this.run = opts.run ?? defaultRunner;
    this.log = opts.log ?? (() => {});
  }

  /** 检测 tailscaled（带 15s 缓存；force=true 强制重测） */
  async detect(force = false): Promise<TailscaleDetection> {
    if (!force && this.detection && Date.now() - this.detectedAt < DETECT_CACHE_MS) return this.detection;
    const r = await this.run(["status", "--json"], DETECT_TIMEOUT_MS);
    this.detection = r.code === 0 ? parseTailscaleStatus(r.stdout) : { available: false, dnsName: null };
    this.detectedAt = Date.now();
    return this.detection;
  }

  /**
   * 开启 serve：把 LAN 端口映射到 tailnet https 443。
   * 返回对外 https URL；tailscale 不可用或命令失败时返回 null（不抛错，不影响主流程）。
   */
  async enable(lanPort: number): Promise<string | null> {
    const d = await this.detect(true);
    if (!d.available || !d.dnsName) return null;
    const r = await this.run(["serve", "--bg", "--https=443", `http://localhost:${lanPort}`], CMD_TIMEOUT_MS);
    if (r.code !== 0) {
      this.log("tailscale serve 失败", { code: r.code, stderr: r.stderr.trim().slice(0, 300) });
      this.serving = false;
      this.servingUrl = null;
      return null;
    }
    this.serving = true;
    this.servingUrl = `https://${d.dnsName}`;
    this.log("tailscale serve 已开启", { url: this.servingUrl, lanPort });
    return this.servingUrl;
  }

  /** 关闭 serve（仅在我们认为已开启时执行 off；失败只记日志） */
  async disable(): Promise<void> {
    if (!this.serving) return;
    this.serving = false;
    this.servingUrl = null;
    const r = await this.run(["serve", "--https=443", "off"], CMD_TIMEOUT_MS);
    if (r.code !== 0) this.log("tailscale serve off 失败", { code: r.code, stderr: r.stderr.trim().slice(0, 300) });
  }

  status(): RemoteTailscaleStatus {
    return {
      available: this.detection?.available ?? false,
      enabled: this.serving,
      url: this.serving ? this.servingUrl : null,
    };
  }
}
