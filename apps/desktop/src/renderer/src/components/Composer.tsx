import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { ModelRef } from "@spcode/shared";
import { Icon } from "./Icon";

export function Composer({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState("");
  const session = useStore((s) => s.sessions[sessionId]);
  const running = session?.running ?? false;
  const models = useStore((s) => s.models);
  const settings = useStore((s) => s.settings);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const abort = useStore((s) => s.abort);
  const setModel = useStore((s) => s.setModel);
  const setThinkingLevel = useStore((s) => s.setThinkingLevel);
  const saveSettings = useStore((s) => s.saveSettings);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const value = text.trim();
    if (!value || running) return;
    setText("");
    void sendPrompt(value);
    requestAnimationFrame(() => textareaRef.current?.focus());
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
        <div className="rounded-2xl border border-border bg-bg-elevated shadow-lg focus-within:border-border-strong">
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
            <ToolButton title="附件（即将上线）">
              <Icon name="plus" size={16} />
            </ToolButton>

            {/* 权限模式 */}
            <button
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

            <div className="flex-1" />

            {/* 配额圆环（快捷展示配额） */}
            {settings?.quickQuota && session?.meta.model && (
              <QuotaRing provider={session.meta.model.provider} />
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
                onClick={() => void abort()}
                title="停止"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-danger/15 text-danger transition-colors hover:bg-danger/25"
              >
                <span className="text-[11px]">■</span>
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!text.trim()}
                title="发送"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white transition-colors hover:bg-accent-dim disabled:opacity-30"
              >
                <Icon name="arrowUp" size={16} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolButton({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <button
      title={title}
      className="flex h-7 w-7 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 配额圆环：当前模型所属厂商的用量占比（点击去配额页）
// ---------------------------------------------------------------------------

function QuotaRing({ provider }: { provider: string }) {
  const [pct, setPct] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    void window.spcode
      .quotaQuery()
      .then((list) => {
        if (!alive) return;
        const q = (list as { provider: string; limits?: { usedPercent: number | null }[] }[]).find(
          (x) => x.provider === provider || provider.startsWith(x.provider),
        );
        const p = q?.limits?.find((l) => l.usedPercent != null)?.usedPercent ?? null;
        setPct(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [provider]);

  const R = 7;
  const C = 2 * Math.PI * R;
  const used = pct ?? 0;
  return (
    <div title={pct != null ? `配额已用 ${pct}%` : "配额"} className="flex h-7 w-7 items-center justify-center">
      <svg width="18" height="18" viewBox="0 0 18 18">
        <circle cx="9" cy="9" r={R} fill="none" stroke="var(--color-bg-hover)" strokeWidth="2.5" />
        <circle
          cx="9"
          cy="9"
          r={R}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2.5"
          strokeDasharray={`${(used / 100) * C} ${C}`}
          strokeLinecap="round"
          transform="rotate(-90 9 9)"
        />
      </svg>
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
                onClick={() => thinkingLevels.length > 0 && setView("levels")}
                className={`w-full rounded-xl bg-bg-hover/60 px-2.5 py-2.5 ${thinkingLevels.length === 0 ? "opacity-50" : "hover:bg-bg-hover"}`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon name="brain" size={15} className="shrink-0 text-text-tertiary" />
                  <span className="flex-1 text-left text-[14px] text-text-primary">
                    推理强度：{thinkingLevel || "off"}
                  </span>
                  {thinkingLevels.length > 0 && <Icon name="chevronRight" size={14} className="shrink-0 text-text-tertiary" />}
                </span>
              </button>
            </>
          )}

          {view === "models" && (
            <>
              <MenuHeader title="选择模型" onBack={() => setView("main")} />
              <div className="max-h-72 overflow-y-auto">
                {models.length === 0 && <div className="px-3 py-4 text-[12px] text-text-tertiary">未配置模型，请先在设置 → 模型里填 API Key</div>}
                {models.map((m) => {
                  const active = value?.provider === m.provider && value?.modelId === m.modelId;
                  return (
                    <button
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
    <button onClick={onBack} className="mb-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] text-text-tertiary hover:bg-bg-hover">
      <Icon name="chevronRight" size={12} style={{ transform: "rotate(180deg)" }} />
      {title}
    </button>
  );
}
