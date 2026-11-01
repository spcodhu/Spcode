import {
  DEFAULT_NETWORK_PROXY_SETTINGS,
  isValidNetworkProxyHost,
  type NetworkProxyProtocol,
  type NetworkProxySettings,
} from "@spcode/shared/proxy";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import { Select } from "./ui/Select";
import { Switch } from "./ui/Switch";

/** 通用设置里的统一出站代理；保存后主进程与各网络栈即时热更新。 */
export function NetworkProxySection() {
  const { t } = useTranslation("settings");
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const saved = settings?.proxy ?? DEFAULT_NETWORK_PROXY_SETTINGS;
  const [enabled, setEnabled] = useState(saved.enabled);
  const [protocol, setProtocol] = useState<NetworkProxyProtocol>(saved.protocol);
  const [host, setHost] = useState(saved.host);
  const [port, setPort] = useState(String(saved.port));
  const [username, setUsername] = useState(saved.username);
  const [password, setPassword] = useState(saved.password);
  const [hint, setHint] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current || !settings) return;
    hydrated.current = true;
    setEnabled(settings.proxy.enabled);
    setProtocol(settings.proxy.protocol);
    setHost(settings.proxy.host);
    setPort(String(settings.proxy.port));
    setUsername(settings.proxy.username);
    setPassword(settings.proxy.password);
  }, [settings]);

  const flash = (ok: boolean, text: string) => {
    setHint({ ok, text });
    setTimeout(() => setHint(null), 4000);
  };

  const save = async () => {
    const parsedPort = Number(port.trim());
    if (enabled && !isValidNetworkProxyHost(host)) {
      flash(false, t("proxy.invalidHost"));
      return;
    }
    if (!Number.isSafeInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      flash(false, t("proxy.invalidPort"));
      return;
    }
    const config: NetworkProxySettings = {
      enabled,
      protocol,
      host: host.trim(),
      port: parsedPort,
      username: username.trim(),
      password,
    };
    setSaving(true);
    try {
      await saveSettings({ proxy: config });
      flash(true, config.enabled ? t("proxy.savedEnabled") : t("proxy.savedDisabled"));
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "w-full rounded-lg border border-border bg-bg-main px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent/50";

  return (
    <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3" data-testid="settings-proxy">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[14px] text-text-primary">{t("proxy.enable")}</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">{t("proxy.enableDescription")}</div>
        </div>
        <Switch on={enabled} onChange={setEnabled} label={t("proxy.enable")} />
      </div>

      <div className="mt-3 grid grid-cols-[140px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
        <div className="text-[13px] text-text-secondary">{t("proxy.protocol")}</div>
        <Select
          value={protocol}
          options={[
            { value: "http", label: "HTTP" },
            { value: "https", label: "HTTPS" },
            { value: "socks5", label: "SOCKS5" },
          ]}
          onChange={(value) => setProtocol(value as NetworkProxyProtocol)}
        />

        <div className="text-[13px] text-text-secondary">{t("proxy.host")}</div>
        <input
          value={host}
          onChange={(event) => setHost(event.target.value)}
          placeholder={t("proxy.hostPlaceholder")}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={inputCls}
          data-testid="settings-proxy-host"
        />

        <div className="text-[13px] text-text-secondary">{t("proxy.port")}</div>
        <input
          value={port}
          onChange={(event) => setPort(event.target.value)}
          placeholder="8080"
          inputMode="numeric"
          className={inputCls}
          data-testid="settings-proxy-port"
        />

        <div className="text-[13px] text-text-secondary">{t("proxy.username")}</div>
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder={t("proxy.optional")}
          autoComplete="off"
          className={inputCls}
          data-testid="settings-proxy-username"
        />

        <div className="text-[13px] text-text-secondary">{t("proxy.password")}</div>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={t("proxy.optional")}
          autoComplete="new-password"
          className={inputCls}
          data-testid="settings-proxy-password"
        />
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-text-tertiary">{t("proxy.scope")}</p>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-lg bg-accent px-4 py-1.5 text-[13px] text-on-accent hover:bg-accent-dim disabled:opacity-40"
          data-testid="settings-proxy-save"
        >
          {saving ? t("saving") : t("save")}
        </button>
        {hint && <span className={`text-[12px] ${hint.ok ? "text-accent" : "text-danger"}`}>{hint.text}</span>}
      </div>
    </div>
  );
}
