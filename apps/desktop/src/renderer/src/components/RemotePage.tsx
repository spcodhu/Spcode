/**
 * 设置页「远程控制」分区（设计文档 4.4）：
 * 总开关 / 监听地址 / 配对二维码 + OTP / 已配对设备管理 /
 * relay 配置（M2）/ Tailscale 直连（M3）/ 通知推送开关（M2）/ 完整隐私说明（附录 B）。
 *
 * 仅渲染进程 UI 与 IPC 调用，协议与配对逻辑全部在 main 进程（src/main/remote/）。
 */
import { useCallback, useEffect, useState } from "react";
import QRCode from "react-qr-code";
import type {
  PairedDevice,
  RemoteFeishuSettings,
  RemoteFeishuState,
  RemoteRelayState,
  RemoteStatus,
  RemoteSettings,
} from "@spcode/shared";
import { formatRelative, formatTime } from "../format";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { Switch } from "./ui/Switch";

export function RemotePage() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
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

  /** 更新 remote 子设置（relayUrl / tailscale / pushEnabled / feishu），随后刷新状态 */
  const patchRemote = async (patch: Partial<Omit<RemoteSettings, "feishu">> & { feishu?: Partial<RemoteFeishuSettings> }) => {
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
    if (!window.confirm(`确定解绑飞书用户「${truncateOpenId(openId)}」吗？该用户将无法再通过机器人控制本机。`)) return;
    await window.spcode.remoteFeishuUnbind(openId);
    await refresh();
  };

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

          {/* 公网中继（relay） */}
          <SectionTitle>公网中继</SectionTitle>
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
                className="shrink-0 rounded-lg bg-accent px-4 py-1.5 text-[13px] text-white hover:bg-accent-dim disabled:opacity-40"
              >
                保存
              </button>
            </div>
            <div className="mt-2 text-[12px] leading-5 text-text-tertiary">
              填入后手机在任意网络下都能连接本机。自建中继只转发密文，看不到代码、提示词与会话内容；留空则仅局域网/Tailscale
              可达。
            </div>
          </div>

          {/* Tailscale 直连 */}
          <SectionTitle>Tailscale 直连</SectionTitle>
          <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3" data-testid="remote-tailscale">
            {status.tailscale.available ? (
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <div className="text-[14px] text-text-primary">通过 Tailscale 暴露本机</div>
                  <div className="mt-0.5 text-[12px] text-text-tertiary">
                    {status.tailscale.enabled && status.tailscale.url ? (
                      <>
                        已开启：
                        <span className="mono text-text-secondary">{status.tailscale.url}</span>
                        （仅你的 tailnet 内可达）
                      </>
                    ) : (
                      "开启后执行 tailscale serve，把远程服务映射到 tailnet 的 https 地址"
                    )}
                  </div>
                </div>
                <Switch
                  on={status.tailscale.enabled}
                  onChange={(v) => void patchRemote({ tailscale: v })}
                  disabled={busy || !remoteCfg}
                  label="通过 Tailscale 暴露本机"
                />
              </div>
            ) : (
              <div className="text-[13px] text-text-tertiary">未检测到 tailscaled（安装并登录 Tailscale 后可启用直连）</div>
            )}
          </div>

          {/* 通知推送 */}
          <SectionTitle>通知推送</SectionTitle>
          <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3" data-testid="remote-push">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[14px] text-text-primary">Web Push 通知</div>
                <div className="mt-0.5 text-[12px] text-text-tertiary">
                  有权限请求、提问或定时任务触发时推送提醒到已配对手机；推送内容不含任何任务数据
                </div>
              </div>
              <Switch
                on={remoteCfg?.pushEnabled ?? false}
                onChange={(v) => void patchRemote({ pushEnabled: v })}
                disabled={busy || !remoteCfg}
                label="Web Push 通知"
              />
            </div>
          </div>
        </>
      )}

      {/* 飞书机器人通道（M4）：独立于远程控制总开关，默认关闭 */}
      <SectionTitle>飞书机器人</SectionTitle>
      <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3" data-testid="remote-feishu">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[14px] text-text-primary">飞书机器人通道</div>
            <div className="mt-0.5 text-[12px] text-text-tertiary">
              通过你自己创建的飞书应用收发消息，无需公网地址与中继，支持卡片批准权限请求
            </div>
          </div>
          <Switch
            on={feishuCfg?.enabled ?? false}
            onChange={(v) => void patchRemote({ feishu: { enabled: v } })}
            disabled={busy || !remoteCfg}
            label="启用飞书机器人通道"
          />
        </div>

        {feishuCfg?.enabled && (
          <>
            {/* 隐私提示（设计文档 4.8 硬性要求）：非端到端加密，开启时必须显眼展示 */}
            <div
              className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] leading-5 text-warning"
              data-testid="remote-feishu-privacy-warning"
            >
              此通道的消息内容对飞书平台可见，非端到端加密。敏感项目请使用端到端加密的 PWA 通道。
            </div>

            {/* App ID / App Secret + 状态徽章 */}
            <div className="mt-3 space-y-2" data-testid="remote-feishu-credentials">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={feishuAppIdValue}
                  onChange={(e) => setFeishuAppIdDraft(e.target.value)}
                  placeholder="App ID（cli_ 开头）"
                  spellCheck={false}
                  aria-label="飞书 App ID"
                  data-testid="remote-feishu-appid"
                  className="mono min-w-0 flex-1 rounded-lg border border-border bg-bg-root px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={feishuAppSecretValue}
                  onChange={(e) => setFeishuAppSecretDraft(e.target.value)}
                  placeholder="App Secret"
                  spellCheck={false}
                  aria-label="飞书 App Secret"
                  data-testid="remote-feishu-appsecret"
                  className="mono min-w-0 flex-1 rounded-lg border border-border bg-bg-root px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                />
                {feishuStatus && <FeishuBadge state={feishuStatus.state} />}
                <button
                  type="button"
                  onClick={() => void saveFeishuCredentials()}
                  disabled={busy || (feishuAppIdDraft === null && feishuAppSecretDraft === null)}
                  className="shrink-0 rounded-lg bg-accent px-4 py-1.5 text-[13px] text-white hover:bg-accent-dim disabled:opacity-40"
                >
                  保存
                </button>
              </div>
              <div className="text-[12px] leading-5 text-text-tertiary">
                凭证仅存本机，不会上传到我们的服务器；保存后自动建立长连接。
                {feishuStatus?.state === "error" && <span className="text-danger"> 连接失败，请检查 App ID / Secret 与事件订阅配置。</span>}
              </div>
            </div>

            {/* 待绑定验证码：已连接且有待绑定用户时大字展示 */}
            {feishuStatus?.state === "connected" && feishuStatus.pendingBindCode && (
              <div className="mt-3 rounded-lg border border-border bg-bg-root px-3 py-3 text-center" data-testid="remote-feishu-bind">
                <div className="mono text-[28px] font-semibold tracking-[0.3em] text-text-primary" data-testid="remote-feishu-bind-code">
                  {feishuStatus.pendingBindCode}
                </div>
                <div className="mt-1.5 text-[12px] text-text-tertiary">
                  在飞书向机器人发送 <span className="mono text-text-secondary">/bind {feishuStatus.pendingBindCode}</span> 完成绑定（5 分钟内有效）
                </div>
              </div>
            )}

            {/* 授权用户白名单 */}
            <div className="mt-3 border-t border-border pt-3" data-testid="remote-feishu-allowlist">
              <div className="text-[12px] font-medium text-text-secondary">授权用户（{feishuStatus?.allowlistCount ?? 0}）</div>
              {!feishuStatus || feishuStatus.allowlist.length === 0 ? (
                <div className="mt-1.5 text-[12px] text-text-tertiary">
                  暂无授权用户。连接成功后，在飞书私聊机器人发送任意消息获取验证码，再用 /bind 完成绑定。
                </div>
              ) : (
                <div className="mt-1 divide-y divide-border">
                  {feishuStatus.allowlist.map((u) => (
                    <div key={u.openId} className="flex items-center justify-between py-2">
                      <div className="min-w-0">
                        <div className="mono truncate text-[13px] text-text-primary" title={u.openId}>
                          {truncateOpenId(u.openId)}
                        </div>
                        <div className="mt-0.5 text-[12px] text-text-tertiary">
                          绑定于 {formatRelative(u.boundAt)} {formatTime(u.boundAt)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void unbindFeishu(u.openId)}
                        aria-label={`解绑飞书用户 ${truncateOpenId(u.openId)}`}
                        className="shrink-0 rounded-lg px-3 py-1.5 text-[12px] text-text-tertiary hover:text-danger"
                      >
                        解绑
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
            <span className="text-[13px] font-medium text-text-secondary">接入教程（约 15–30 分钟，一次性）</span>
            <Icon name={feishuGuideOpen ? "chevronDown" : "chevronRight"} size={14} className="text-text-tertiary" />
          </button>
          {feishuGuideOpen && (
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[12px] leading-5 text-text-tertiary" data-testid="remote-feishu-guide">
              <li>注册飞书并创建一个免费团队（已有团队可跳过）。</li>
              <li>
                登录<span className="text-text-secondary">飞书开放平台</span>（open.feishu.cn），创建「企业自建应用」——个人账号即可，无需企业认证。
              </li>
              <li>在应用「添加应用能力」中启用「机器人」。</li>
              <li>
                开通权限：<span className="mono text-text-secondary">im:message</span>、
                <span className="mono text-text-secondary">im:message:send_as_bot</span>、
                <span className="mono text-text-secondary">im:chat:readonly</span>、
                <span className="mono text-text-secondary">contact:user.id:readonly</span>
                （可用开放平台的「批量导入权限」功能一次导入）。
              </li>
              <li>
                「事件订阅」选择<strong className="text-text-secondary">使用长连接接收事件</strong>，添加事件
                <span className="mono text-text-secondary"> im.message.receive_v1</span>
                （保存长连接配置时，请确保本应用已启动且飞书通道已开启）。
              </li>
              <li>创建版本并发布（自建应用自己审批即可）。</li>
              <li>把 App ID 与 App Secret 填入上方输入框并保存。</li>
              <li>在飞书中私聊你的机器人，按屏幕上的验证码发送 /bind 完成绑定。</li>
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
          <span className="text-[13px] font-medium text-text-secondary">远程功能隐私说明</span>
          <Icon name={privacyOpen ? "chevronDown" : "chevronRight"} size={14} className="text-text-tertiary" />
        </button>
        <p className="mt-1.5 text-[12px] leading-5 text-text-tertiary">
          端到端加密，中继只转发密文；推送不含任务数据。点击展开完整说明。
        </p>
        {privacyOpen && (
          <ol className="mt-3 list-decimal space-y-2 border-t border-border pt-3 pl-5 text-[12px] leading-5 text-text-tertiary">
            <li>远程功能默认关闭，由您手动开启并扫码配对后才生效。</li>
            <li>
              您的手机与电脑之间的所有通信采用端到端加密（X25519 密钥交换 +
              XSalsa20-Poly1305）。加密密钥仅存储在您的两台设备上，配对通过本机展示的二维码带外完成。
            </li>
            <li>
              为使手机在任意网络下可达您的电脑，消息会经过一台中继服务器（relay）。中继服务器只存储和转发
              <strong className="text-text-secondary">加密后的数据</strong>
              ，无法读取其中的代码、提示词、会话内容或定时任务内容。中继服务器可见的信息仅限于：连接时间、数据量等元数据。
            </li>
            <li>
              您可以在设置中将中继服务器替换为自行部署的实例（开源，一键部署），或通过 Tailscale
              直连；此时您的数据完全不经过我们运营或关联的任何服务器。
            </li>
            <li>任务通知推送（如“有权限请求待批准”）通过系统推送通道送达，推送内容不含任何任务数据。</li>
            <li>
              【可选通道】飞书机器人通道：您输入的提示词与 agent 返回的内容将以
              <strong className="text-text-secondary">明文</strong>
              经过飞书（字节跳动）的服务器，飞书平台理论上可见这些内容。此通道不经过我们运营或关联的任何服务器（连接发生在您的电脑与您自己创建的飞书应用之间）。处理敏感项目时，请改用端到端加密的
              PWA 通道。飞书通道默认关闭，开启即视为知悉并接受本条。
            </li>
            <li>本功能全部代码（桌面端、中继、手机端、飞书通道）开源，欢迎审计。</li>
            <li>我们不出售、不分析、不训练您的任何数据——架构上我们也做不到。</li>
          </ol>
        )}
      </div>
    </div>
  );
}

/** relay 连接状态徽章 */
function RelayBadge({ state }: { state: RemoteRelayState }) {
  const styles: Record<RemoteRelayState, { text: string; cls: string }> = {
    disabled: { text: "未启用", cls: "text-text-tertiary border-border" },
    connecting: { text: "连接中", cls: "text-warning border-warning/40" },
    connected: { text: "已连接", cls: "text-accent border-accent/40" },
  };
  const s = styles[state];
  return (
    <span
      data-testid="remote-relay-badge"
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${s.cls}`}
    >
      {s.text}
    </span>
  );
}

/** 飞书通道连接状态徽章（disabled / connecting / connected / error 四态） */
function FeishuBadge({ state }: { state: RemoteFeishuState }) {
  const styles: Record<RemoteFeishuState, { text: string; cls: string }> = {
    disabled: { text: "未启用", cls: "text-text-tertiary border-border" },
    connecting: { text: "连接中", cls: "text-warning border-warning/40" },
    connected: { text: "已连接", cls: "text-accent border-accent/40" },
    error: { text: "连接失败", cls: "text-danger border-danger/40" },
  };
  const s = styles[state];
  return (
    <span
      data-testid="remote-feishu-badge"
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${s.cls}`}
    >
      {s.text}
    </span>
  );
}

/** openId 截断显示（ou_ 开头长串，保留首尾便于核对） */
function truncateOpenId(openId: string): string {
  return openId.length > 14 ? `${openId.slice(0, 8)}…${openId.slice(-4)}` : openId;
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
