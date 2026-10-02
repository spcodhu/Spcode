/**
 * 设置页「远程控制」分区（设计文档 4.4）：
 * 总开关 / 监听地址 / 配对二维码 + OTP / 已配对设备管理。
 *
 * 仅渲染进程 UI 与 IPC 调用，协议与配对逻辑全部在 main 进程（src/main/remote/）。
 */
import { useCallback, useEffect, useState } from "react";
import QRCode from "react-qr-code";
import type { PairedDevice, RemoteStatus } from "@spcode/shared";
import { formatRelative, formatTime } from "../format";
import { Icon } from "./Icon";
import { Switch } from "./ui/Switch";

export function RemotePage() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** OTP 倒计时用的当前时间（启用且有配对窗口时每秒刷新） */
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.spcode.remoteStatus());
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

  const toggle = async (v: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      // remoteSetEnabled 返回最新 RemoteStatus，直接以它刷新 UI
      setStatus(await window.spcode.remoteSetEnabled(v));
      setNow(Date.now());
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
    if (!window.confirm(`确定解除与「${d.name}」的配对吗？该设备将无法再连接本机。`)) return;
    await window.spcode.remoteUnpairDevice(d.id);
    await refresh();
  };

  const pairing = status?.pairing ?? null;
  const expired = pairing ? pairing.expiresAt <= now : false;

  return (
    <div data-testid="remote-page">
      <PageHeader title="远程控制" subtitle="手机扫码配对后，可在局域网内远程查看会话、批准权限请求" />

      {/* 总开关 */}
      <div className="flex items-center justify-between rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <div>
          <div className="text-[14px] text-text-primary">启用远程控制</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">
            {status?.enabled ? "本机正在监听局域网连接" : "开启后，手机扫码配对即可远程连接本机"}
          </div>
        </div>
        <Switch on={status?.enabled ?? false} onChange={(v) => void toggle(v)} disabled={!status || busy} label="启用远程控制" />
      </div>

      {loadFailed && <div className="mt-3 text-[13px] text-danger">远程控制状态读取失败，请重启应用后重试</div>}

      {!status?.enabled && !loadFailed && (
        <p className="mt-3 text-[13px] leading-6 text-text-tertiary" data-testid="remote-intro">
          远程控制让你用手机随时查看 agent 进度、回复提问、批准权限请求。默认关闭，开启后需扫码配对才会生效。
        </p>
      )}

      {status?.enabled && (
        <>
          {/* 监听地址 */}
          <SectionTitle>监听地址</SectionTitle>
          <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3" data-testid="remote-urls">
            {status.urls.length === 0 ? (
              <div className="text-[13px] text-text-tertiary">监听地址获取中…</div>
            ) : (
              <div className="space-y-1.5">
                {status.urls.map((url) => (
                  <CopyRow key={url} text={url} />
                ))}
              </div>
            )}
            <div className="mt-2 text-[12px] text-text-tertiary">手机需与电脑连接同一局域网</div>
          </div>

          {/* 配对二维码 + OTP */}
          <SectionTitle>配对新设备</SectionTitle>
          <div className="rounded-xl border border-border bg-bg-elevated px-4 py-4" data-testid="remote-pairing">
            {pairing && !expired ? (
              <div className="flex items-start gap-5">
                <div className="shrink-0 rounded-xl bg-white p-3" data-testid="remote-qr">
                  <QRCode value={pairing.qrPayload} size={160} bgColor="#FFFFFF" fgColor="#000000" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-text-secondary">用手机 Spcode App 扫码，或手动输入配对码：</div>
                  <div className="mono mt-2 text-[28px] font-semibold tracking-[0.3em] text-text-primary" data-testid="remote-otp">
                    {pairing.otp}
                  </div>
                  <OtpCountdown expiresAt={pairing.expiresAt} now={now} />
                  <button
                    type="button"
                    onClick={() => void regenerate()}
                    disabled={busy}
                    className="mt-3 rounded-lg border border-border px-4 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
                  >
                    重新生成配对码
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div className="text-[13px] text-text-tertiary">
                  {pairing && expired ? "配对码已过期，请重新生成" : "尚未生成配对码"}
                </div>
                <button
                  type="button"
                  onClick={() => void regenerate()}
                  disabled={busy}
                  className="rounded-lg bg-accent px-4 py-1.5 text-[13px] text-white hover:bg-accent-dim disabled:opacity-40"
                >
                  {pairing && expired ? "重新生成配对码" : "生成配对码"}
                </button>
              </div>
            )}
          </div>

          {/* 已配对设备 */}
          <SectionTitle>已配对设备</SectionTitle>
          <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3" data-testid="remote-devices">
            {status.devices.length === 0 ? (
              <div className="text-[13px] text-text-tertiary">暂无已配对设备</div>
            ) : (
              <div className="divide-y divide-border">
                {status.devices.map((d) => (
                  <div key={d.id} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <div className="truncate text-[14px] text-text-primary">{d.name}</div>
                      <div className="mt-0.5 text-[12px] text-text-tertiary">
                        配对于 {formatRelative(d.pairedAt)} {formatTime(d.pairedAt)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void unpair(d)}
                      className="shrink-0 rounded-lg px-3 py-1.5 text-[12px] text-text-tertiary hover:text-danger"
                    >
                      解除配对
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* 隐私说明 */}
      <p className="mt-6 rounded-xl border border-border bg-bg-elevated px-4 py-3 text-[12px] leading-5 text-text-tertiary">
        远程通信全程端到端加密；仅局域网可达（公网中继将在后续版本提供）。
      </p>
    </div>
  );
}

/** 单行可复制文本（监听地址） */
function CopyRow({ text }: { text: string }) {
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
        title={copied ? "已复制" : "复制地址"}
        className="shrink-0 rounded-md p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
      >
        <Icon name={copied ? "clipboardCheck" : "copy"} size={14} />
      </button>
    </div>
  );
}

/** OTP 剩余有效期（mm:ss） */
function OtpCountdown({ expiresAt, now }: { expiresAt: number; now: number }) {
  const remain = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const mm = String(Math.floor(remain / 60));
  const ss = String(remain % 60).padStart(2, "0");
  return (
    <div className={`mt-1.5 text-[12px] ${remain <= 60 ? "text-danger" : "text-text-tertiary"}`}>
      配对码 {mm}:{ss} 后过期，单次有效
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
