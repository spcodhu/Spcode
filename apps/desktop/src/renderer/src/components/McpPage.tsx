import { Trans, useTranslation } from "react-i18next";
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
  const { t } = useTranslation("settings");
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
      setError(t("mcp.invalidName"));
      return;
    }
    if (!cmd) {
      setError(t("mcp.missingCommand"));
      return;
    }
    if (servers[n]) {
      setError(t("mcp.duplicate"));
      return;
    }
    // env：每行 KEY=VALUE
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const entry = line.trim();
      if (!entry) continue;
      const eq = entry.indexOf("=");
      if (eq <= 0) {
        setError(t("mcp.invalidEnv", { entry }));
        return;
      }
      env[entry.slice(0, eq).trim()] = entry.slice(eq + 1).trim();
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
      <div className="mb-1 text-[18px] font-semibold text-text-primary">{t("mcp.title")}</div>
      <div className="mb-5 text-[12px] leading-5 text-text-tertiary">
        <Trans t={t} i18nKey="mcp.description" components={{ code: <code className="mono" />, b: <b /> }} />
      </div>

      {/* 已配置列表 */}
      {Object.keys(servers).length === 0 && (
        <div className="mb-4 rounded-xl border border-border bg-bg-elevated px-4 py-6 text-center text-[12px] text-text-tertiary">
          {t("mcp.empty")}
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
            label={t("mcp.toggle")}
          />
          <button
            type="button"
            title={t("mcp.delete")}
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
        <div className="mb-3 text-[13px] font-medium text-text-secondary">{t("mcp.add")}</div>
        <div className="grid grid-cols-2 gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("mcp.namePlaceholder")}
            className="min-w-0 rounded-lg border border-border bg-bg-main px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent"
          />
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={t("mcp.commandPlaceholder")}
            className="min-w-0 rounded-lg border border-border bg-bg-main px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent"
          />
        </div>
        <div className="mt-2 text-[11.5px] leading-5 text-text-tertiary">{t("mcp.stdioDescription")}</div>
        <input
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          placeholder={t("mcp.argsPlaceholder")}
          className="mono mt-2 w-full rounded-lg border border-border bg-bg-main px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent"
        />
        <textarea
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          placeholder={t("mcp.envPlaceholder")}
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
            {t("add")}
          </button>
        </div>
      </div>
    </div>
  );
}
