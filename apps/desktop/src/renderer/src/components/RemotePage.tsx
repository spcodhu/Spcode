import { Trans, useTranslation } from "react-i18next";
/**
 * 设置页「远程控制」分区（设计文档 4.4）：
 * 总开关 / 监听地址 / 配对二维码 + OTP / 已配对设备管理 /
 * relay 配置（M2）/ Tailscale 直连（M3）/ 通知推送开关（M2）/ 完整隐私说明（附录 B）。
 *
 * 仅渲染进程 UI 与 IPC 调用，协议与配对逻辑全部在 main 进程（src/main/remote/）。
 */

import type {
  PairedDevice,
  RemoteFeishuSettings,
  RemoteFeishuState,
  RemoteRelayState,
  RemoteSettings,
  RemoteStatus,
} from "@spcode/shared";
import { getLocale } from "@spcode/shared/i18n";
import { useCallback, useEffect, useState } from "react";
import QRCode from "react-qr-code";
import { formatRelative, formatTime } from "../format";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { Switch } from "./ui/Switch";

export function RemotePage() {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** OTP 倒计时用的当前时间（启用且有配对窗口时每秒刷新） */
  const [now, setNow] = useState(() => Date.now());
  /** relay 地址输入草稿（null = 未编辑，跟随 settings） */
  const [relayDraft, setRelayDraft] = useState<string | null>(null);
  /** 飞书 App ID / App Secret 输入草稿（null = 未编辑，跟随 settings） */
  const [feishuAppIdDraft, setFeishuAppIdDraft] = useState<string | null>(null);
  const [feishuAppSecretDraft, setFeishuAppSecretDraft] = useState<string | null>(null);
  const [feishuGuideOpen, setFeishuGuideOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const remoteCfg = settings?.remote ?? null;

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.spcode.remoteStatus());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!status?.enabled) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status?.enabled]);

  // relay / 飞书连接是异步的：启用期间每 5s 刷新一次状态徽章 / tailscale URL / 飞书绑定状态
  // （飞书通道独立于 remote.enabled 同步，轮询条件同理）
  useEffect(() => {
    if (!status?.enabled && !remoteCfg?.feishu?.enabled) return;
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [status?.enabled, remoteCfg?.feishu?.enabled, refresh]);

  const toggle = async (v: boolean) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      // remoteSetEnabled 返回最新 RemoteStatus，直接以它刷新 UI
      setStatus(await window.spcode.remoteSetEnabled(v));
      setNow(Date.now());
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const changePort = async () => {
    if (busy || !window.confirm(t("remote.portChangeConfirm"))) return;
    setBusy(true);
    setActionError(null);
    try {
      setStatus(await window.spcode.remoteSetEnabled(true, null));
      setNow(Date.now());
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const pairing = await window.spcode.remoteRegeneratePairing();
      setStatus((s) => (s ? { ...s, pairing } : s));
      setNow(Date.now());
    } finally {
      setBusy(false);
    }
  };

  const unpair = async (d: PairedDevice) => {
    if (!window.confirm(t("remote.unpairConfirm", { name: d.name }))) return;
    await window.spcode.remoteUnpairDevice(d.id);
    await refresh();
  };

  /** 更新 remote 子设置（relayUrl / tailscale / pushEnabled / feishu），随后刷新状态 */
  const patchRemote = async (
    patch: Partial<Omit<RemoteSettings, "feishu">> & { feishu?: Partial<RemoteFeishuSettings> },
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      // 总开关走 remoteSetEnabled IPC、不经过 settings store，本地 remoteCfg 的
      // enabled 可能过期——保存前拉最新设置再合并，避免把 enabled 覆盖回 false
      const fresh = await window.spcode.getSettings();
      // feishu 再嵌套一层（enabled / appId / appSecret），部分更新需深合并，
      // 否则开关切换会清空已保存的凭证
      const feishu = patch.feishu ? { ...fresh.remote.feishu, ...patch.feishu } : fresh.remote.feishu;
      await saveSettings({ remote: { ...fresh.remote, ...patch, feishu } });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const relayValue = relayDraft ?? remoteCfg?.relayUrl ?? "";

  const saveRelayUrl = async () => {
    const v = relayValue.trim();
    await patchRemote({ relayUrl: v || null });
    setRelayDraft(null);
    // relay 重连异步进行，稍后再刷一次让徽章反映 connecting → connected
    setTimeout(() => void refresh(), 1200);
  };

  const pairing = status?.pairing ?? null;
  const expired = pairing ? pairing.expiresAt <= now : false;

  // 飞书通道（M4）：独立于 remote.enabled，默认关闭；appSecret 不回传（configured 标记）
  const feishuCfg = remoteCfg?.feishu ?? null;
  const feishuStatus = status?.feishu ?? null;
  const feishuAppIdValue = feishuAppIdDraft ?? feishuCfg?.appId ?? "";
  const feishuAppSecretValue = feishuAppSecretDraft ?? feishuCfg?.appSecret ?? "";

  const saveFeishuCredentials = async () => {
    await patchRemote({ feishu: { appId: feishuAppIdValue.trim(), appSecret: feishuAppSecretValue.trim() } });
    setFeishuAppIdDraft(null);
    setFeishuAppSecretDraft(null);
    // 长连接建连异步进行，稍后再刷一次让徽章反映 connecting → connected / error
    setTimeout(() => void refresh(), 1200);
  };

  const unbindFeishu = async (openId: string) => {
    if (!window.confirm(t("remote.unbindConfirm", { name: truncateOpenId(openId) }))) return;
    await window.spcode.remoteFeishuUnbind(openId);
    await refresh();
  };

  return (
    <div data-testid="remote-page">
      <PageHeader title={t("nav.remote")} subtitle={t("remote.description")} />

      {status && (
        <div className="mb-3 rounded-xl border border-border bg-bg-elevated px-4 py-3" data-testid="remote-pwa-status">
          <div className="text-[13px] font-medium text-text-secondary">
            {status.mobilePwa.available ? t("remote.pwaIncluded") : t("remote.pwaMissing")}
          </div>
          <div className="mt-1 text-[12px] leading-5 text-text-tertiary">
            {status.mobilePwa.available
              ? t("remote.pwaIncludedDescription")
              : status.mobilePwa.packaged
                ? t("remote.pwaPackagedMissingDescription")
                : t("remote.pwaDevMissingDescription")}
          </div>
        </div>
      )}

      <details
        className="mb-3 rounded-xl border border-border bg-bg-elevated px-4 py-3"
        data-testid="remote-phone-guide"
      >
        <summary className="cursor-pointer select-none text-[13px] font-medium text-text-secondary">
          {t("remote.phoneGuide")}
        </summary>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[12px] leading-5 text-text-tertiary">
          <li>{t("remote.phoneGuide.enable")}</li>
          <li>{t("remote.phoneGuide.network")}</li>
          <li>{t("remote.phoneGuide.browser")}</li>
          <li>{t("remote.phoneGuide.pair")}</li>
          <li>{t("remote.phoneGuide.control")}</li>
        </ol>
        <p className="mt-3 border-t border-border pt-3 text-[12px] leading-5 text-text-tertiary">
          {t("remote.phoneGuide.httpNote")}
        </p>
        <p className="mt-2 text-[12px] leading-5 text-text-tertiary">{t("remote.phoneGuide.persistence")}</p>
      </details>

      {/* 总开关 */}
      <div className="flex items-center justify-between rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <div>
          <div className="text-[14px] text-text-primary">{t("remote.enable")}</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">
            {status?.enabled ? t("remote.listening") : t("remote.enableDescription")}
          </div>
        </div>
        <Switch
          on={status?.enabled ?? false}
          onChange={(v) => void toggle(v)}
          disabled={!status || busy}
          label={t("remote.enable")}
        />
      </div>

      {actionError && (
        <div role="alert" data-testid="remote-action-error" className="mt-3 text-[13px] leading-6 text-danger">
          {actionError}
        </div>
      )}

      {loadFailed && (
        <div
          role="alert"
          data-testid="remote-load-error"
          className="mt-3 flex items-center gap-3 text-[13px] text-danger"
        >
          <span>{t("remote.loadFailed")}</span>
          {!status && (
            <button
              type="button"
              data-testid="remote-retry"
              onClick={() => void refresh()}
              className="shrink-0 rounded-lg border border-danger/40 px-3 py-1 text-[12px] hover:bg-danger/10"
            >
              {t("retry")}
            </button>
          )}
        </div>
      )}

      {!status?.enabled && !loadFailed && (
        <p className="mt-3 text-[13px] leading-6 text-text-tertiary" data-testid="remote-intro">
          {t("remote.intro")}
        </p>
      )}

      {status?.enabled && (
        <>
          {/* 监听地址 */}
          <SectionTitle>{t("remote.addresses")}</SectionTitle>
          <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3" data-testid="remote-urls">
            {status.urls.length === 0 ? (
              <div className="text-[13px] text-text-tertiary">{t("remote.loadingAddresses")}</div>
            ) : (
              <div className="space-y-1.5">
                {status.urls.map((url) => (
                  <CopyRow key={url} text={url} />
                ))}
              </div>
            )}
            <div className="mt-2 text-[12px] text-text-tertiary">{t("remote.sameNetwork")}</div>
            <div className="mt-2 flex items-center justify-between gap-3 border-t border-border pt-2">
              <span className="text-[12px] text-text-tertiary" data-testid="remote-port">
                {t("remote.portValue", { port: status.port ?? "—" })}
              </span>
              <button
                type="button"
                data-testid="remote-change-port"
                disabled={busy}
                onClick={() => void changePort()}
                className="shrink-0 rounded-lg px-3 py-1 text-[12px] text-text-tertiary hover:bg-bg-hover hover:text-text-secondary disabled:opacity-40"
              >
                {t("remote.changePort")}
              </button>
            </div>
            <div className="mt-1 text-[12px] leading-5 text-text-tertiary">{t("remote.portHint")}</div>
          </div>

          {/* 配对二维码 + OTP */}
          <SectionTitle>{t("remote.pair")}</SectionTitle>
          <div className="rounded-xl border border-border bg-bg-elevated px-4 py-4" data-testid="remote-pairing">
            {pairing && !expired ? (
              <div className="flex items-start gap-5">
                <div className="shrink-0 rounded-xl bg-white p-3" data-testid="remote-qr">
                  <QRCode value={pairing.qrPayload} size={160} bgColor="#FFFFFF" fgColor="#000000" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-text-secondary">{t("remote.scan")}</div>
                  <div
                    className="mono mt-2 text-[28px] font-semibold tracking-[0.3em] text-text-primary"
                    data-testid="remote-otp"
                  >
                    {pairing.otp}
                  </div>
                  <OtpCountdown expiresAt={pairing.expiresAt} now={now} />
                  <div className="mt-1 text-[12px] leading-5 text-text-tertiary">{t("remote.otpHelp")}</div>
                  <button
                    type="button"
                    onClick={() => void regenerate()}
                    disabled={busy}
                    className="mt-3 rounded-lg border border-border px-4 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
                  >
                    {t("remote.regenerate")}
                  </button>
                  <PairingPayload key={pairing.qrPayload} payload={pairing.qrPayload} />
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div className="text-[13px] text-text-tertiary">
                  {pairing && expired ? t("remote.expired") : t("remote.noCode")}
                </div>
                <button
                  type="button"
                  onClick={() => void regenerate()}
                  disabled={busy}
                  className="rounded-lg bg-accent px-4 py-1.5 text-[13px] text-on-accent hover:bg-accent-dim disabled:opacity-40"
                >
                  {pairing && expired ? t("remote.regenerate") : t("remote.generate")}
                </button>
              </div>
            )}
          </div>

          {/* 已配对设备 */}
          <SectionTitle>{t("remote.devices")}</SectionTitle>
          <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3" data-testid="remote-devices">
            {status.devices.length === 0 ? (
              <div className="text-[13px] text-text-tertiary">{t("remote.noDevices")}</div>
            ) : (
              <div className="divide-y divide-border">
                {status.devices.map((d) => (
                  <div key={d.id} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <div className="truncate text-[14px] text-text-primary">{d.name}</div>
                      <div className="mt-0.5 text-[12px] text-text-tertiary">
                        {t("remote.pairedAt", { relative: formatRelative(d.pairedAt), time: formatTime(d.pairedAt) })}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void unpair(d)}
                      className="shrink-0 rounded-lg px-3 py-1.5 text-[12px] text-text-tertiary hover:text-danger"
                    >
                      {t("remote.unpair")}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 公网中继（relay） */}
          <SectionTitle>{t("remote.relay")}</SectionTitle>
          <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3" data-testid="remote-relay">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={relayValue}
                onChange={(e) => setRelayDraft(e.target.value)}
                placeholder="wss://relay.example.com"
                spellCheck={false}
                data-testid="remote-relay-input"
                className="mono min-w-0 flex-1 rounded-lg border border-border bg-bg-root px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
              />
              <RelayBadge state={status.relay} />
              <button
                type="button"
                onClick={() => void saveRelayUrl()}
                disabled={busy || !remoteCfg || relayDraft === null}
                className="shrink-0 rounded-lg bg-accent px-4 py-1.5 text-[13px] text-on-accent hover:bg-accent-dim disabled:opacity-40"
              >
                {t("save")}
              </button>
            </div>
            <div className="mt-2 text-[12px] leading-5 text-text-tertiary">{t("remote.relayDescription")}</div>
          </div>

          {/* Tailscale 直连 */}
          <SectionTitle>{t("remote.tailscale")}</SectionTitle>
          <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3" data-testid="remote-tailscale">
            {status.tailscale.available ? (
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <div className="text-[14px] text-text-primary">{t("remote.tailscaleEnable")}</div>
                  <div className="mt-0.5 text-[12px] text-text-tertiary">
                    {status.tailscale.enabled && status.tailscale.url ? (
                      <Trans
                        t={t}
                        i18nKey="remote.tailscaleActive"
                        values={{ url: status.tailscale.url }}
                        components={{ code: <span className="mono break-all text-text-secondary" /> }}
                      />
                    ) : (
                      t("remote.tailscaleDescription")
                    )}
                  </div>
                </div>
                <Switch
                  on={status.tailscale.enabled}
                  onChange={(v) => void patchRemote({ tailscale: v })}
                  disabled={busy || !remoteCfg}
                  label={t("remote.tailscaleEnable")}
                />
              </div>
            ) : (
              <div className="text-[13px] text-text-tertiary">{t("remote.tailscaleMissing")}</div>
            )}
          </div>

          {/* 通知推送 */}
          <SectionTitle>{t("remote.notifications")}</SectionTitle>
          <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3" data-testid="remote-push">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[14px] text-text-primary">{t("remote.webPush")}</div>
                <div className="mt-0.5 text-[12px] text-text-tertiary">{t("remote.webPushDescription")}</div>
              </div>
              <Switch
                on={remoteCfg?.pushEnabled ?? false}
                onChange={(v) => void patchRemote({ pushEnabled: v })}
                disabled={busy || !remoteCfg}
                label={t("remote.webPush")}
              />
            </div>
          </div>
        </>
      )}

      {/* 飞书机器人通道（M4）：独立于远程控制总开关，默认关闭 */}
      <SectionTitle>{t("remote.feishu")}</SectionTitle>
      <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3" data-testid="remote-feishu">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[14px] text-text-primary">{t("remote.feishuChannel")}</div>
            <div className="mt-0.5 text-[12px] text-text-tertiary">{t("remote.feishuDescription")}</div>
          </div>
          <Switch
            on={feishuCfg?.enabled ?? false}
            onChange={(v) => void patchRemote({ feishu: { enabled: v } })}
            disabled={busy || !remoteCfg}
            label={t("remote.feishuEnable")}
          />
        </div>

        {feishuCfg?.enabled && (
          <>
            {/* 隐私提示（设计文档 4.8 硬性要求）：非端到端加密，开启时必须显眼展示 */}
            <div
              className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] leading-5 text-warning"
              data-testid="remote-feishu-privacy-warning"
            >
              {t("remote.feishuWarning")}
            </div>

            {/* App ID / App Secret + 状态徽章 */}
            <div className="mt-3 space-y-2" data-testid="remote-feishu-credentials">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={feishuAppIdValue}
                  onChange={(e) => setFeishuAppIdDraft(e.target.value)}
                  placeholder={t("remote.appIdPlaceholder")}
                  spellCheck={false}
                  aria-label={t("remote.appId")}
                  data-testid="remote-feishu-appid"
                  className="mono min-w-0 flex-1 rounded-lg border border-border bg-bg-root px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={feishuAppSecretValue}
                  onChange={(e) => setFeishuAppSecretDraft(e.target.value)}
                  placeholder={t("remote.secretPlaceholder")}
                  spellCheck={false}
                  aria-label={t("remote.appSecret")}
                  data-testid="remote-feishu-appsecret"
                  className="mono min-w-0 flex-1 rounded-lg border border-border bg-bg-root px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
                {feishuStatus && <FeishuBadge state={feishuStatus.state} />}
                <button
                  type="button"
                  onClick={() => void saveFeishuCredentials()}
                  disabled={busy || (feishuAppIdDraft === null && feishuAppSecretDraft === null)}
                  className="shrink-0 rounded-lg bg-accent px-4 py-1.5 text-[13px] text-on-accent hover:bg-accent-dim disabled:opacity-40"
                >
                  {t("save")}
                </button>
              </div>
              <div className="text-[12px] leading-5 text-text-tertiary">
                {t("remote.credentialsPrivacy")}
                {feishuStatus?.state === "error" && <span className="text-danger"> {t("remote.connectionHelp")}</span>}
              </div>
            </div>

            {/* 待绑定验证码：已连接且有待绑定用户时大字展示 */}
            {feishuStatus?.state === "connected" && feishuStatus.pendingBindCode && (
              <div
                className="mt-3 rounded-lg border border-border bg-bg-root px-3 py-3 text-center"
                data-testid="remote-feishu-bind"
              >
                <div
                  className="mono text-[28px] font-semibold tracking-[0.3em] text-text-primary"
                  data-testid="remote-feishu-bind-code"
                >
                  {feishuStatus.pendingBindCode}
                </div>
                <div className="mt-1.5 text-[12px] text-text-tertiary">
                  <Trans
                    t={t}
                    i18nKey="remote.bindInstructions"
                    values={{ code: feishuStatus.pendingBindCode }}
                    components={{ code: <span className="mono text-text-secondary" /> }}
                  />
                </div>
              </div>
            )}

            {/* 授权用户白名单 */}
            <div className="mt-3 border-t border-border pt-3" data-testid="remote-feishu-allowlist">
              <div className="text-[12px] font-medium text-text-secondary">
                {t("remote.authorizedCount", { count: feishuStatus?.allowlistCount ?? 0 })}
              </div>
              {!feishuStatus || feishuStatus.allowlist.length === 0 ? (
                <div className="mt-1.5 text-[12px] text-text-tertiary">{t("remote.noUsers")}</div>
              ) : (
                <div className="mt-1 divide-y divide-border">
                  {feishuStatus.allowlist.map((u) => (
                    <div key={u.openId} className="flex items-center justify-between py-2">
                      <div className="min-w-0">
                        <div className="mono truncate text-[13px] text-text-primary" title={u.openId}>
                          {truncateOpenId(u.openId)}
                        </div>
                        <div className="mt-0.5 text-[12px] text-text-tertiary">
                          {t("remote.boundAt", { relative: formatRelative(u.boundAt), time: formatTime(u.boundAt) })}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void unbindFeishu(u.openId)}
                        aria-label={t("remote.unbindUser", { name: truncateOpenId(u.openId) })}
                        className="shrink-0 rounded-lg px-3 py-1.5 text-[12px] text-text-tertiary hover:text-danger"
                      >
                        {t("remote.unbind")}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* 接入教程（docs/feishu-setup.md 精简版，可展开） */}
        <div className="mt-3 border-t border-border pt-3">
          <button
            type="button"
            onClick={() => setFeishuGuideOpen((v) => !v)}
            data-testid="remote-feishu-guide-toggle"
            aria-expanded={feishuGuideOpen}
            className="flex w-full items-center justify-between text-left"
          >
            <span className="text-[13px] font-medium text-text-secondary">{t("remote.guide")}</span>
            <Icon name={feishuGuideOpen ? "chevronDown" : "chevronRight"} size={14} className="text-text-tertiary" />
          </button>
          {feishuGuideOpen && (
            <ol
              className="mt-2 list-decimal space-y-1.5 pl-5 text-[12px] leading-5 text-text-tertiary"
              data-testid="remote-feishu-guide"
            >
              <li>{t("remote.guide.register")}</li>
              <li>
                <Trans
                  t={t}
                  i18nKey="remote.guide.create"
                  components={{ em: <span className="text-text-secondary" /> }}
                />
              </li>
              <li>{t("remote.guide.bot")}</li>
              <li>
                <Trans
                  t={t}
                  i18nKey="remote.guide.permissions"
                  components={{ code: <span className="mono text-text-secondary" /> }}
                />
              </li>
              <li>
                <Trans
                  t={t}
                  i18nKey="remote.guide.events"
                  components={{
                    strong: <strong className="text-text-secondary" />,
                    code: <span className="mono text-text-secondary" />,
                  }}
                />
              </li>
              <li>{t("remote.guide.publish")}</li>
              <li>{t("remote.guide.credentials")}</li>
              <li>{t("remote.guide.bind")}</li>
            </ol>
          )}
        </div>
      </div>

      {/* 隐私说明（附录 B 全文，可展开） */}
      <div className="mt-6 rounded-xl border border-border bg-bg-elevated px-4 py-3" data-testid="remote-privacy">
        <button
          type="button"
          onClick={() => setPrivacyOpen((v) => !v)}
          data-testid="remote-privacy-toggle"
          aria-expanded={privacyOpen}
          className="flex w-full items-center justify-between text-left"
        >
          <span className="text-[13px] font-medium text-text-secondary">{t("remote.privacy")}</span>
          <Icon name={privacyOpen ? "chevronDown" : "chevronRight"} size={14} className="text-text-tertiary" />
        </button>
        <p className="mt-1.5 text-[12px] leading-5 text-text-tertiary">{t("remote.privacySummary")}</p>
        {privacyOpen && (
          <ol className="mt-3 list-decimal space-y-2 border-t border-border pt-3 pl-5 text-[12px] leading-5 text-text-tertiary">
            <li>{t("remote.privacy.optIn")}</li>
            <li>{t("remote.privacy.encryption")}</li>
            <li>
              <Trans
                t={t}
                i18nKey="remote.privacy.relay"
                components={{ strong: <strong className="text-text-secondary" /> }}
              />
            </li>
            <li>{t("remote.privacy.selfHosted")}</li>
            <li>{t("remote.privacy.push")}</li>
            <li>
              <Trans
                t={t}
                i18nKey="remote.privacy.feishu"
                components={{ strong: <strong className="text-text-secondary" /> }}
              />
            </li>
            <li>{t("remote.privacy.openSource")}</li>
            <li>{t("remote.privacy.noDataUse")}</li>
          </ol>
        )}
      </div>
    </div>
  );
}

/** relay 连接状态徽章 */
function RelayBadge({ state }: { state: RemoteRelayState }) {
  const { t } = useTranslation("settings");
  const styles: Record<RemoteRelayState, { text: string; cls: string }> = {
    disabled: { text: t("remote.disabled"), cls: "text-text-tertiary border-border" },
    connecting: { text: t("remote.connecting"), cls: "text-warning border-warning/40" },
    connected: { text: t("remote.connected"), cls: "text-accent border-accent/40" },
  };
  const s = styles[state];
  return (
    <span data-testid="remote-relay-badge" className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${s.cls}`}>
      {s.text}
    </span>
  );
}

/** 飞书通道连接状态徽章（disabled / connecting / connected / error 四态） */
function FeishuBadge({ state }: { state: RemoteFeishuState }) {
  const { t } = useTranslation("settings");
  const styles: Record<RemoteFeishuState, { text: string; cls: string }> = {
    disabled: { text: t("remote.disabled"), cls: "text-text-tertiary border-border" },
    connecting: { text: t("remote.connecting"), cls: "text-warning border-warning/40" },
    connected: { text: t("remote.connected"), cls: "text-accent border-accent/40" },
    error: { text: t("remote.connectionFailed"), cls: "text-danger border-danger/40" },
  };
  const s = styles[state];
  return (
    <span data-testid="remote-feishu-badge" className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${s.cls}`}>
      {s.text}
    </span>
  );
}

/** openId 截断显示（ou_ 开头长串，保留首尾便于核对） */
function truncateOpenId(openId: string): string {
  return openId.length > 14 ? `${openId.slice(0, 8)}…${openId.slice(-4)}` : openId;
}

/** 完整配对载荷：复制不触发重新生成；剪贴板不可用时自动展开供手动选择。 */
function PairingPayload({ payload }: { payload: string }) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(payload);
      setCopyState("copied");
    } catch {
      setCopyState("error");
      setOpen(true);
    }
  };

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="remote-copy-payload"
          onClick={() => void copy()}
          className="rounded-lg border border-border px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover"
        >
          {copyState === "copied" ? t("remote.copied") : t("remote.copyPayload")}
        </button>
        <button
          type="button"
          data-testid="remote-payload-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="rounded-lg px-3 py-1.5 text-[12px] text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
        >
          {open ? t("remote.hidePayload") : t("remote.showPayload")}
        </button>
      </div>
      {copyState === "error" && (
        <div role="alert" className="mt-2 text-[12px] leading-5 text-danger">
          {t("remote.copyPayloadFailed")}
        </div>
      )}
      {open && (
        <textarea
          readOnly
          data-testid="remote-payload"
          aria-label={t("remote.payloadLabel")}
          value={payload}
          rows={4}
          onFocus={(event) => event.currentTarget.select()}
          className="mono mt-2 w-full resize-y rounded-lg border border-border bg-bg-root px-3 py-2 text-[12px] leading-5 break-all text-text-secondary outline-none focus:border-accent"
        />
      )}
      <div className="mt-2 text-[12px] leading-5 text-text-tertiary">{t("remote.payloadValidity")}</div>
    </div>
  );
}

/** 单行可复制文本（监听地址） */
function CopyRow({ text }: { text: string }) {
  const { t } = useTranslation("settings");
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（权限被拒）时静默失败，用户仍可手动选择复制
    }
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="mono truncate text-[13px] text-text-primary">{text}</span>
      <button
        type="button"
        onClick={() => void copy()}
        title={copied ? t("remote.copied") : t("remote.copyAddress")}
        className="shrink-0 rounded-md p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
      >
        <Icon name={copied ? "clipboardCheck" : "copy"} size={14} />
      </button>
    </div>
  );
}

/** OTP 剩余有效期（mm:ss） */
function OtpCountdown({ expiresAt, now }: { expiresAt: number; now: number }) {
  const { t } = useTranslation("settings");
  const remain = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const mm = new Intl.NumberFormat(getLocale(), { useGrouping: false }).format(Math.floor(remain / 60));
  const ss = new Intl.NumberFormat(getLocale(), { minimumIntegerDigits: 2 }).format(remain % 60);
  return (
    <div className={`mt-1.5 text-[12px] ${remain <= 60 ? "text-danger" : "text-text-tertiary"}`}>
      {t("remote.countdown", { time: `${mm}:${ss}` })}
    </div>
  );
}

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-[22px] font-semibold text-text-primary">{title}</h1>
      <p className="mt-1 text-[13px] text-text-tertiary">{subtitle}</p>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 mt-6 text-[13px] font-semibold text-text-secondary first:mt-0">{children}</h2>;
}
