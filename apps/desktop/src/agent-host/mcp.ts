/**
 * MCP（Model Context Protocol）客户端管理器（评审 R3-F3，MVP：stdio 传输）。
 *
 * - 设置在设置页维护（AppSettings.mcpServers），主进程经 mcp.setServers 下发；
 *   管理器按配置 diff 启停（新增/变更连接，移除断开）；
 * - 每个服务器的工具枚举后包装成 pi ToolDefinition 注册（命名 mcp__<server>__<tool>），
 *   走权限网关：未知名工具默认 write 风险——ask 模式弹窗、act 模式放行、规则沉淀不适用
 *   （非 shell 工具），与内置工具同一裁决链；
 * - 单服务器失败不影响其他（连接/枚举错误记日志并从工具表剔除）；进程退出前 disposeAll。
 *
 * 会话创建时取当前工具表快照——设置变更对已有会话不生效（新会话生效），
 * 与高级搜索/沙盒同口径。
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "@spcode/shared";

interface ServerHandle {
  client: Client;
  transport: StdioClientTransport;
  /** 配置指纹（变更判定用） */
  fingerprint: string;
  tools: ToolDefinition[];
}

/** MCP 工具结果 content → pi 工具结果 content（text 直通，其余类型 JSON 兜底） */
function normalizeContent(content: unknown): { type: "text"; text: string }[] {
  if (!Array.isArray(content)) return [{ type: "text", text: String(content ?? "") }];
  return content.map((b) => {
    const block = b as { type?: string; text?: string };
    if (block.type === "text" && typeof block.text === "string") return { type: "text" as const, text: block.text };
    return { type: "text" as const, text: JSON.stringify(b) };
  });
}

function fingerprintOf(name: string, cfg: McpServerConfig): string {
  return JSON.stringify([name, cfg.command, cfg.args ?? [], cfg.env ?? {}]);
}

export class McpManager {
  private servers = new Map<string, ServerHandle>();

  /** 按配置 diff 启停：新增/变更连接，消失的断开。单服务器失败不影响其他。 */
  async syncServers(configs: Record<string, McpServerConfig>): Promise<void> {
    const wanted = new Map(Object.entries(configs).filter(([, c]) => c.enabled !== false && c.command.trim()));

    // 断开消失/变更的服务器
    for (const [name, h] of this.servers) {
      const cfg = wanted.get(name);
      if (!cfg || fingerprintOf(name, cfg) !== h.fingerprint) {
        this.servers.delete(name);
        await h.client.close().catch(() => {});
      }
    }
    // 连接新增的
    for (const [name, cfg] of wanted) {
      if (this.servers.has(name)) continue;
      try {
        this.servers.set(name, await this.connect(name, cfg));
      } catch (err) {
        console.warn(`[mcp] 服务器 ${name} 连接失败`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  private async connect(name: string, cfg: McpServerConfig): Promise<ServerHandle> {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (d: Buffer) => console.warn(`[mcp/${name}]`, d.toString().trim().slice(0, 300)));
    const client = new Client({ name: "spcode", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = (listed.tools ?? []).map((t): ToolDefinition => {
      const fqName = `mcp__${name}__${t.name}`;
      return {
        name: fqName,
        label: `${name}: ${t.title ?? t.name}`,
        description: `[MCP ${name}] ${t.description ?? ""}`,
        promptSnippet: t.description?.slice(0, 80),
        // MCP inputSchema 是 JSON Schema object；typebox 的校验器按 JSON Schema 语义工作，直接透传
        parameters: (t.inputSchema ?? { type: "object", properties: {} }) as never,
        execute: async (_id, args) => {
          const res = await client.callTool({ name: t.name, arguments: args as Record<string, unknown> });
          const isError = (res as { isError?: boolean }).isError === true;
          return {
            content: normalizeContent((res as { content?: unknown }).content),
            details: {},
            ...(isError ? { isError: true } : {}),
          };
        },
      } as ToolDefinition;
    });
    return { client, transport, fingerprint: fingerprintOf(name, cfg), tools };
  }

  /** 当前全部启用服务器的工具表（会话创建时取快照注册） */
  tools(): ToolDefinition[] {
    return [...this.servers.values()].flatMap((h) => h.tools);
  }

  /** 连接中的服务器名（诊断/设置页展示用） */
  connectedServers(): string[] {
    return [...this.servers.keys()];
  }

  async disposeAll(): Promise<void> {
    for (const [, h] of this.servers) await h.client.close().catch(() => {});
    this.servers.clear();
  }
}

let instance: McpManager | null = null;

export function getMcpManager(): McpManager {
  if (!instance) instance = new McpManager();
  return instance;
}

/** 测试用：重置单例 */
export function resetMcpManagerForTest(): void {
  instance = null;
}
