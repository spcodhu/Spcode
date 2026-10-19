/**
 * MCP 设置页（评审 R3-F3）：stdio 服务器列表管理（增删/启停）。
 * 变更实时下发宿主；工具列表在会话创建时取快照——已有会话不生效，新会话生效。
 */

import type { McpServerConfig } from "@spcode/shared";
import { useState } from "react";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { Switch } from "./ui/Switch";

export function McpPage() {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const servers = settings?.mcpServers ?? {};

  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const patchServers = (next: Record<string, McpServerConfig>) => void saveSettings({ mcpServers: next });

  const add = () => {
    const n = name.trim();
    const cmd = command.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(n)) {
      setError("名称只能包含字母、数字、-、_（会出现在工具名里）");
      return;
    }
    if (!cmd) {
      setError("请填写可执行命令（如 npx / uvx / 绝对路径）");
      return;
    }
    if (servers[n]) {
      setError("同名服务器已存在");
      return;
    }
    // env：每行 KEY=VALUE
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) {
        setError(`环境变量格式错误（KEY=VALUE）：${t}`);
        return;
      }
      env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    patchServers({
      ...servers,
      [n]: { command: cmd, args: argsText.trim() ? argsText.trim().split(/\s+/) : [], env },
    });
    setName("");
    setCommand("");
    setArgsText("");
    setEnvText("");
    setError(null);
  };

  return (
    <div>
      <div className="mb-1 text-[18px] font-semibold text-text-primary">MCP 服务器</div>
      <div className="mb-5 text-[12px] leading-5 text-text-tertiary">
        接入 Model Context Protocol 服务器（stdio 传输）。工具以 <code className="mono">mcp__服务器__工具</code>{" "}
        注册，默认按写操作走权限审批；配置变更对<b>新会话</b>生效。
      </div>

      {/* 已配置列表 */}
      {Object.keys(servers).length === 0 && (
        <div className="mb-4 rounded-xl border border-border bg-bg-elevated px-4 py-6 text-center text-[12px] text-text-tertiary">
          还没有配置 MCP 服务器
        </div>
      )}
      {Object.entries(servers).map(([n, cfg]) => (
        <div key={n} className="mb-2 flex items-center gap-3 rounded-xl border border-border bg-bg-elevated px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-text-primary">{n}</div>
            <div
              className="mono mt-0.5 truncate text-[11px] text-text-tertiary"
              title={[cfg.command, ...(cfg.args ?? [])].join(" ")}
            >
              {cfg.command} {(cfg.args ?? []).join(" ")}
            </div>
          </div>
          <Switch
            on={cfg.enabled !== false}
            onChange={(on) => patchServers({ ...servers, [n]: { ...cfg, enabled: on } })}
            label="启用/停用"
          />
          <button
            type="button"
            title="删除服务器"
            onClick={() => {
              const next = { ...servers };
              delete next[n];
              patchServers(next);
            }}
            className="shrink-0 rounded p-1 text-text-tertiary hover:bg-danger/10 hover:text-danger"
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}

      {/* 新增表单 */}
      <div className="mt-4 rounded-xl border border-border bg-bg-elevated p-4">
        <div className="mb-3 text-[13px] font-medium text-text-secondary">添加服务器</div>
        <div className="grid grid-cols-2 gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="名称（如 github）"
            className="rounded-lg border border-border bg-bg-main px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent"
          />
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="命令（如 npx）"
            className="rounded-lg border border-border bg-bg-main px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent"
          />
        </div>
        <div className="mt-2 text-[11.5px] leading-5 text-text-tertiary">
          stdio 传输：npx / uvx 等命令直接填即可（Windows 下会自动经 cmd.exe 启动）。
          修改对已打开的会话不生效，需新建会话。
        </div>
        <input
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          placeholder="参数（空格分隔，如 -y @modelcontextprotocol/server-github）"
          className="mono mt-2 w-full rounded-lg border border-border bg-bg-main px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent"
        />
        <textarea
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          placeholder={"环境变量（每行 KEY=VALUE，可选）"}
          rows={2}
          className="mono mt-2 w-full resize-none rounded-lg border border-border bg-bg-main px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent"
        />
        {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={add}
            className="rounded-lg bg-accent px-4 py-1.5 text-[12px] font-medium text-white hover:bg-accent-dim"
          >
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
