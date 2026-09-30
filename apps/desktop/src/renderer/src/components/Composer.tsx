import type { ImageAttachment, ModelInfo, ModelRef } from "@spcode/shared";
import { useEffect, useRef, useState } from "react";
import type { SessionState } from "../store";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { ImageLightbox } from "./ImageLightbox";

// ---------------------------------------------------------------------------
// 外部预填输入框（空态建议卡片等场景点击后把提示词填进输入框并聚焦）
// ---------------------------------------------------------------------------

const COMPOSER_PREFILL_EVENT = "spcode:composer-prefill";

export function prefillComposer(text: string): void {
  window.dispatchEvent(new CustomEvent(COMPOSER_PREFILL_EVENT, { detail: { text } }));
}

export function Composer({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const session = useStore((s) => s.sessions[sessionId]);
  const running = session?.running ?? false;
  const models = useStore((s) => s.models);
  const settings = useStore((s) => s.settings);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const abort = useStore((s) => s.abort);
  const setModel = useStore((s) => s.setModel);
  const setThinkingLevel = useStore((s) => s.setThinkingLevel);
  const setPlanMode = useStore((s) => s.setPlanMode);
  const saveSettings = useStore((s) => s.saveSettings);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 监听外部预填请求：填入文本、聚焦并把光标移到末尾
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail?.text ?? "";
      setText(text);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        el?.focus();
        el?.setSelectionRange(text.length, text.length);
      });
    };
    window.addEventListener(COMPOSER_PREFILL_EVENT, onPrefill);
    return () => window.removeEventListener(COMPOSER_PREFILL_EVENT, onPrefill);
  }, []);

  const canSend = !!text.trim() || attachments.length > 0;
  const planMode = session?.planMode ?? false;

  const send = () => {
    if (!canSend || running) return;
    const value = text.trim();
    const imgs = attachments;
    setText("");
    setAttachments([]);
    void sendPrompt(value, imgs.length ? imgs : undefined);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const pickAttachments = async () => {
    const imgs = await window.spcode.pickImages().catch(() => []);
    if (imgs.length) setAttachments((a) => [...a, ...imgs]);
  };

  const actMode = settings?.permissionMode === "act";
  const enabledModels = models.filter(
    (m) =>
      !(settings?.disabledProviders ?? []).includes(m.provider) &&
      !(settings?.disabledModels ?? []).includes(`${m.provider}/${m.modelId}`),
  );

  return (
    <div className="shrink-0 px-6 pb-4 pt-1">
      <div className="mx-auto max-w-3xl">
        <div
          className={`relative rounded-2xl border bg-bg-elevated shadow-lg transition-colors ${
            planMode
              ? "border-accent/40 focus-within:border-accent/70"
              : "border-border focus-within:border-border-strong"
          }`}
        >
          {/* 计划模式挂签：浮在输入框右上角的标签牌，一眼可见，点击退出 */}
          {planMode && (
            <button
              type="button"
              onClick={() => void setPlanMode(false)}
              title="计划模式：模型只出计划、不改文件 · 点击退出"
              className="absolute -top-[10px] right-5 z-10 flex items-center gap-1 rounded-full bg-accent px-2.5 py-[3px] text-[11px] font-medium text-white shadow-md transition-colors hover:bg-accent-dim"
            >
              <Icon name="clipboardCheck" size={11} strokeWidth={2.2} />
              计划模式
            </button>
          )}
          {/* 图片附件 chips（缩略图 + 移除） */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3.5 pt-3">
              {attachments.map((img, i) => (
                <div key={`${img.name}-${img.data.length}`} className="group/chip relative">
                  <button
                    type="button"
                    onClick={() => setPreviewIdx(i)}
                    title={`预览 ${img.name}`}
                    className="cursor-zoom-in"
                  >
                    <img
                      src={`data:${img.mimeType};base64,${img.data}`}
                      alt={img.name}
                      className="h-12 w-12 rounded-lg border border-border object-cover"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => setAttachments((a) => a.filter((_, j) => j !== i))}
                    title={`移除 ${img.name}`}
                    className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-bg-active text-text-tertiary opacity-0 transition-opacity hover:text-text-primary group-hover/chip:opacity-100"
                  >
                    <Icon name="x" size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
            rows={Math.min(8, Math.max(2, text.split("\n").length))}
            className="w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14px] leading-6 outline-none placeholder:text-text-tertiary"
          />

          {/* 底部胶囊工具栏 */}
          <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
            <ToolButton title="添加图片附件" onClick={() => void pickAttachments()}>
              <Icon name="plus" size={16} />
            </ToolButton>

            {/* 权限模式 */}
            <button
              type="button"
              onClick={() => void saveSettings({ permissionMode: actMode ? "ask" : "act" })}
              title={actMode ? "行动模式：仅危险命令确认" : "询问模式：写操作/Shell 每次确认"}
              className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] transition-colors ${
                actMode
                  ? "bg-warning/15 text-warning"
                  : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
              }`}
            >
              <Icon name={actMode ? "zap" : "shield"} size={13} />
              {actMode ? "行动" : "询问"}
            </button>

            {/* 计划模式 */}
            <button
              type="button"
              onClick={() => void setPlanMode(!planMode)}
              title={planMode ? "退出计划模式" : "计划模式:模型先出完整计划,你批准后才执行"}
              className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] transition-colors ${
                planMode ? "bg-accent/20 text-accent" : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
              }`}
            >
              <Icon name={planMode ? "clipboardCheck" : "clipboard"} size={13} />
              计划
            </button>

            <div className="flex-1" />

            {/* 上下文占用环（悬浮看明细） */}
            {settings?.quickQuota && session?.meta.model && (
              <ContextRing model={session.meta.model} lastUsage={session.lastUsage} models={models} />
            )}

            {/* 模型选择（两级弹出菜单） */}
            <ModelMenu
              models={enabledModels}
              value={session?.meta.model ?? null}
              thinkingLevel={session?.meta.thinkingLevel ?? ""}
              thinkingLevels={session?.supportedThinkingLevels ?? []}
              onChange={(ref) => void setModel(ref)}
              onThinkingChange={(lv) => void setThinkingLevel(lv)}
            />

            {/* 发送 / 停止 */}
            {running ? (
              <button
                type="button"
                onClick={() => void abort()}
                title="停止"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-danger/15 text-danger transition-colors hover:bg-danger/25"
              >
                <span className="text-[11px]">■</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!canSend}
                title="发送"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white transition-colors hover:bg-accent-dim disabled:opacity-30"
              >
                <Icon name="arrowUp" size={16} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>
      {previewIdx !== null && (
        <ImageLightbox
          images={attachments}
          index={previewIdx}
          onClose={() => setPreviewIdx(null)}
          onNavigate={setPreviewIdx}
        />
      )}
    </div>
  );
}

function ToolButton({ children, title, onClick }: { children: React.ReactNode; title: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 上下文占用环：当前会话最近一次请求的上下文占用 / 模型上下文窗口
// 悬浮显示自绘明细卡（不用原生 title，深色主题下原生提示太违和）
// ---------------------------------------------------------------------------

/** 紧凑格式：385k / 1.0M（Finch 同款） */
function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function ContextRing({
  model,
  lastUsage,
  models,
}: {
  model: ModelRef;
  lastUsage: SessionState["lastUsage"];
  models: ModelInfo[];
}) {
  const info = models.find((m) => m.provider === model.provider && m.modelId === model.modelId);
  const window = info?.contextWindow ?? 0;
  if (window <= 0) return null;

  // 上下文占用 = 最近一次请求的 输入 + 缓存读（累计值会爆窗口，不能求和）
  const used = lastUsage ? lastUsage.input + lastUsage.cacheRead : 0;
  const pct = Math.min(100, Math.round((used / window) * 100));
  const color = pct >= 90 ? "var(--color-danger)" : pct >= 70 ? "var(--color-warning)" : "var(--color-accent)";

  const R = 7;
  const C = 2 * Math.PI * R;
  return (
    <div className="group relative flex h-7 w-7 items-center justify-center">
      <svg width="18" height="18" viewBox="0 0 18 18" role="img" aria-label={`上下文占用 ${pct}%`}>
        <circle cx="9" cy="9" r={R} fill="none" stroke="var(--color-bg-hover)" strokeWidth="2.5" />
        <circle
          cx="9"
          cy="9"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeDasharray={`${(pct / 100) * C} ${C}`}
          strokeLinecap="round"
          transform="rotate(-90 9 9)"
        />
      </svg>
      {/* 悬浮明细卡 */}
      <div className="pointer-events-none absolute bottom-8 right-0 z-50 w-64 rounded-xl border border-border bg-bg-elevated p-3 opacity-0 shadow-2xl transition-opacity duration-150 group-hover:opacity-100">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] font-medium text-text-primary">上下文使用</span>
          <span className="text-[13px] text-text-secondary">
            {formatCompact(used)} / {formatCompact(window)}（{pct}%）
          </span>
        </div>
        {lastUsage ? (
          <div className="mt-2 space-y-1 text-[12px]">
            <div className="flex justify-between">
              <span className="text-text-tertiary">输入 / 缓存</span>
              <span className="text-text-secondary">
                {lastUsage.input.toLocaleString()} / {lastUsage.cacheRead.toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-tertiary">输出</span>
              <span className="text-text-secondary">{lastUsage.output.toLocaleString()}</span>
            </div>
          </div>
        ) : (
          <div className="mt-2 text-[12px] text-text-tertiary">本轮还没有请求记录</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 模型菜单：胶囊 → 上弹面板（模型行 + 推理强度行 → 各自二级列表）
// ---------------------------------------------------------------------------

interface ModelOption {
  provider: string;
  modelId: string;
  displayName: string;
}

type MenuView = "main" | "models" | "levels";

function ModelMenu({
  models,
  value,
  thinkingLevel,
  thinkingLevels,
  onChange,
  onThinkingChange,
}: {
  models: ModelOption[];
  value: ModelRef | null;
  thinkingLevel: string;
  thinkingLevels: string[];
  onChange: (ref: ModelRef) => void;
  onThinkingChange: (level: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<MenuView>("main");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const current = value ? models.find((m) => m.provider === value.provider && m.modelId === value.modelId) : null;
  const pillText = current
    ? `${current.displayName}${thinkingLevel && thinkingLevel !== "off" ? ` ${thinkingLevel}` : ""}`
    : "选择模型";

  return (
    <div ref={rootRef} className="relative">
      {/* 胶囊按钮 */}
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          setView("main");
        }}
        className="flex items-center gap-1 rounded-full border border-border bg-bg-main px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:border-border-strong"
      >
        <Icon name="cpu" size={13} className="text-text-tertiary" />
        <span className="max-w-44 truncate">{pillText}</span>
        <Icon name="chevronDown" size={11} className="text-text-tertiary" />
      </button>

      {/* 弹出面板 */}
      {open && (
        <div className="absolute bottom-9 right-0 z-50 w-72 rounded-2xl border border-border bg-bg-elevated p-2 shadow-2xl">
          {view === "main" && (
            <>
              <div className="px-2.5 pb-1 pt-1.5 text-[12px] text-text-tertiary">模型</div>
              <button
                type="button"
                onClick={() => setView("models")}
                className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 hover:bg-bg-hover"
              >
                <Icon name="cpu" size={16} className="shrink-0 text-text-tertiary" />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[14px] text-text-primary">
                    {current?.displayName ?? "选择模型"}
                  </span>
                  <span className="block truncate text-[12px] text-text-tertiary">{value?.provider ?? ""}</span>
                </span>
                <Icon name="chevronRight" size={14} className="shrink-0 text-text-tertiary" />
              </button>
              <div className="my-1.5 border-t border-border" />
              <button
                type="button"
                onClick={() => thinkingLevels.length > 0 && setView("levels")}
                className={`w-full rounded-xl bg-bg-hover/60 px-2.5 py-2.5 ${thinkingLevels.length === 0 ? "opacity-50" : "hover:bg-bg-hover"}`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon name="brain" size={15} className="shrink-0 text-text-tertiary" />
                  <span className="flex-1 text-left text-[14px] text-text-primary">
                    推理强度：{thinkingLevel || "off"}
                  </span>
                  {thinkingLevels.length > 0 && (
                    <Icon name="chevronRight" size={14} className="shrink-0 text-text-tertiary" />
                  )}
                </span>
              </button>
            </>
          )}

          {view === "models" && (
            <>
              <MenuHeader title="选择模型" onBack={() => setView("main")} />
              <div className="max-h-72 overflow-y-auto">
                {models.length === 0 && (
                  <div className="px-3 py-4 text-[12px] text-text-tertiary">
                    未配置模型，请先在设置 → 模型里填 API Key
                  </div>
                )}
                {models.map((m) => {
                  const active = value?.provider === m.provider && value?.modelId === m.modelId;
                  return (
                    <button
                      type="button"
                      key={`${m.provider}/${m.modelId}`}
                      onClick={() => {
                        onChange({ provider: m.provider, modelId: m.modelId });
                        setOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-bg-hover ${active ? "text-accent" : "text-text-primary"}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px]">{m.displayName}</span>
                        <span className="block truncate text-[11px] text-text-tertiary">{m.provider}</span>
                      </span>
                      {active && <Icon name="check" size={14} className="shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {view === "levels" && (
            <>
              <MenuHeader title="推理强度" onBack={() => setView("main")} />
              {thinkingLevels.map((lv) => {
                const active = lv === thinkingLevel;
                return (
                  <button
                    type="button"
                    key={lv}
                    onClick={() => {
                      onThinkingChange(lv);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-bg-hover ${active ? "text-accent" : "text-text-primary"}`}
                  >
                    <span className="flex-1">{lv}</span>
                    {active && <Icon name="check" size={14} className="shrink-0" />}
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="mb-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] text-text-tertiary hover:bg-bg-hover"
    >
      <Icon name="chevronRight" size={12} style={{ transform: "rotate(180deg)" }} />
      {title}
    </button>
  );
}
