/**
 * SandboxService —— @anthropic-ai/sandbox-runtime 的进程级封装（agent-host 单例）。
 *
 * 职责：
 * - 平台/依赖可用性检测（macOS 需 sandbox-exec；Linux 需 bubblewrap+socat+ripgrep；
 *   Windows 上游仍是 alpha，直接不支持 → 降级纯审批网关）
 * - SandboxManager 生命周期：首次使用时 initialize（启动网络过滤代理），
 *   设置变更时 updateConfig；每次包装用 per-command customConfig 传会话级文件系统边界
 *   （sandbox-runtime 的 customConfig 是字段级覆盖，filesystem 整段随命令下发，
 *   network 用全局 initialize 的配置——代理端口固定、不能每条命令重启）
 * - 违规归因：wrap 时下发 commandId，执行完后取回违规事件喂给模型
 *
 * 失败策略：initialize/wrap 抛错一律 fail-closed（命令不执行、报明确错误），
 * 绝不静默退回无沙盒执行——用户关掉沙盒的合法路径是设置页开关。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { DEFAULT_SANDBOX_SETTINGS, type SandboxSettings } from "@spcode/shared";
import { resolveSpcodeHome } from "@spcode/shared/node";
import { buildSandboxRuntimeConfig } from "./config-builder.js";

export type SandboxState =
  | { state: "active" }
  | { state: "disabled" }
  | { state: "unavailable"; reason: string };

export interface SandboxViolation {
  line: string;
  command?: string;
}

class SandboxService {
  private settings: SandboxSettings | null = null;
  private initialized = false;
  private initFailedReason: string | null = null;
  private initPromise: Promise<void> | null = null;
  /** 网络域名交互审批（agent-host 注入；未注入时未知域名一律拒） */
  private networkAskHandler: ((host: string, port: number | undefined) => Promise<boolean>) | null = null;
  /** 本次运行内用户已放行的域名（应用级；永久放行需用户写进设置白名单） */
  private sessionAllowedHosts = new Set<string>();

  /** 注入网络域名审批回调（弹窗通道）。须在 initialize 之前调用才生效 */
  setNetworkAskHandler(handler: (host: string, port: number | undefined) => Promise<boolean>): void {
    this.networkAskHandler = handler;
  }

  /** 设置下发（main 经 sandbox.setConfig 推送；未下发前视为 disabled 之外的默认配置不可用） */
  configure(settings: SandboxSettings): void {
    this.settings = settings;
    // 已初始化且代理在跑：网络段热更新；文件系统段本来就走 per-command customConfig
    if (this.initialized) {
      try {
        const base = this.baseNetworkOnlyConfig(settings);
        SandboxManager.updateConfig(base);
      } catch (err) {
        console.warn("[sandbox] updateConfig failed:", err);
      }
    }
  }

  /** 当前设置快照（bash 工具读 excludedCommands/allowUnsandboxedCommands 等热生效字段用） */
  settingsSnapshot(): SandboxSettings {
    return this.settings ?? DEFAULT_SANDBOX_SETTINGS;
  }

  /**
   * 当前沙盒状态。同步可用：检测结果在首次 ensureReady 后缓存；
   * 未就绪时返回 unavailable（调用方据此先走 ensureReady 再决定工具集）。
   */
  status(): SandboxState {
    if (!this.settings?.enabled) return { state: "disabled" };
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return { state: "unavailable", reason: `平台 ${process.platform} 暂不支持沙盒（Windows 支持待上游成熟）` };
    }
    if (this.initFailedReason) return { state: "unavailable", reason: this.initFailedReason };
    if (!this.initialized) return { state: "unavailable", reason: "沙盒尚未初始化" };
    return { state: "active" };
  }

  /** 惰性初始化：幂等，失败缓存原因（不反复重试打日志） */
  async ensureReady(): Promise<SandboxState> {
    if (!this.settings?.enabled) return { state: "disabled" };
    if (process.platform !== "darwin" && process.platform !== "linux") return this.status();
    if (this.initialized) return { state: "active" };
    if (this.initFailedReason) return { state: "unavailable", reason: this.initFailedReason };
    if (this.initPromise) {
      await this.initPromise;
      return this.status();
    }
    this.initPromise = this.doInitialize();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
    return this.status();
  }

  private async doInitialize(): Promise<void> {
    const settings = this.settings;
    if (!settings) return;
    try {
      // macOS 前置自检：sandbox-exec 必须存在（理论上系统自带，防精简环境）
      if (process.platform === "darwin" && !existsSync("/usr/bin/sandbox-exec")) {
        this.initFailedReason = "缺少 /usr/bin/sandbox-exec";
        return;
      }
      // Linux 依赖检测（bwrap/socat/ripgrep），缺失则降级
      if (process.platform === "linux") {
        const check = await SandboxManager.checkDependenciesAsync();
        if (check.errors.length > 0) {
          this.initFailedReason = `Linux 沙盒依赖缺失：${check.errors.join("；")}`;
          return;
        }
      }
      await SandboxManager.initialize(
        this.baseNetworkOnlyConfig(settings),
        // 未知域名：会话内已放行 → 直接过；否则弹窗问用户（同意则记入会话放行集）
        async ({ host, port }) => {
          if (this.sessionAllowedHosts.has(host)) return true;
          if (!this.networkAskHandler) return false;
          const approved = await this.networkAskHandler(host, port);
          if (approved) this.sessionAllowedHosts.add(host);
          return approved;
        },
        // macOS 违规归因需要 seatbelt 日志监视器（否则 violations() 恒空）
        true,
      );
      this.initialized = true;
    } catch (err) {
      this.initFailedReason = `沙盒初始化失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * 全局配置只承载网络段（代理在 initialize 时启动、端口固定）；
   * 文件系统段给最严默认值，实际边界由每条命令的 customConfig 覆盖。
   * allowLocalBinding：dev server / playwright 等需要监听本地端口，默认开。
   */
  private baseNetworkOnlyConfig(settings: SandboxSettings): SandboxRuntimeConfig {
    return {
      network: {
        allowedDomains: [...settings.network.allowedDomains],
        deniedDomains: [...settings.network.deniedDomains],
        allowLocalBinding: settings.network.allowLocalBinding,
      },
      filesystem: {
        denyRead: [],
        allowWrite: [],
        denyWrite: [],
      },
    };
  }

  /**
   * 包装命令：返回可直接交给 shell 执行的沙盒化命令串。
   * 调用前必须 ensureReady 且 status 为 active；否则抛错（fail-closed）。
   */
  async wrap(command: string, cwd: string): Promise<{ command: string; commandId: string }> {
    const state = await this.ensureReady();
    if (state.state !== "active") {
      throw new Error(
        state.state === "disabled"
          ? "沙盒已关闭，不应调用 wrap"
          : `沙盒不可用：${state.reason}`,
      );
    }
    const settings = this.settings;
    if (!settings) throw new Error("沙盒设置未下发");
    const filesystemConfig = buildSandboxRuntimeConfig({ cwd, spcodeHome: resolveSpcodeHome(), settings });
    const commandId = randomUUID();
    const wrapped = await SandboxManager.wrapWithSandbox(
      command,
      undefined,
      { filesystem: filesystemConfig.filesystem },
      undefined,
      { commandId, commandText: command },
    );
    return { command: wrapped, commandId };
  }

  /** 取回某次命令执行期间的沙盒违规事件（seatbelt 拒绝、代理拦截等） */
  violations(commandId: string): SandboxViolation[] {
    if (!this.initialized) return [];
    try {
      return SandboxManager.getSandboxViolationStore()
        .getViolationsForCommand(commandId)
        .map((v) => ({ line: v.line, command: v.command }));
    } catch {
      return [];
    }
  }

  /** 测试/诊断用：会话级已放行域名快照 */
  approvedHostsSnapshot(): string[] {
    return [...this.sessionAllowedHosts];
  }
}

let instance: SandboxService | null = null;

export function getSandboxService(): SandboxService {
  if (!instance) instance = new SandboxService();
  return instance;
}

/** 测试用：重置单例 */
export function resetSandboxServiceForTest(): void {
  instance = null;
}
