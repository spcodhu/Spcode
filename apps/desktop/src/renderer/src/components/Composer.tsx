import { useRef, useState } from "react";
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

  const modelValue = session?.meta.model
    ? `${session.meta.model.provider}/${session.meta.model.modelId}`
    : "";
  const actMode = settings?.permissionMode === "act";

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

            {/* 模型选择（含思考强度） */}
            <ModelPicker
              models={models}
              value={modelValue}
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

interface ModelOption {
  provider: string;
  modelId: string;
  displayName: string;
}

function ModelPicker({
  models,
  value,
  thinkingLevel,
  thinkingLevels,
  onChange,
  onThinkingChange,
}: {
  models: ModelOption[];
  value: string;
  thinkingLevel: string;
  thinkingLevels: string[];
  onChange: (ref: ModelRef) => void;
  onThinkingChange: (level: string) => void;
}) {
  const current = models.find((m) => `${m.provider}/${m.modelId}` === value);
  return (
    <div className="flex items-center gap-1 rounded-full border border-border bg-bg-main px-1 py-0.5">
      <select
        value={value}
        onChange={(e) => {
          const [provider, ...rest] = e.target.value.split("/");
          if (provider && rest.length) onChange({ provider, modelId: rest.join("/") });
        }}
        className="max-w-40 cursor-pointer truncate rounded-full bg-transparent px-1.5 py-0.5 text-[12px] text-text-secondary outline-none"
      >
        {models.length === 0 && <option value="">未配置模型</option>}
        {models.map((m) => (
          <option key={`${m.provider}/${m.modelId}`} value={`${m.provider}/${m.modelId}`}>
            {m.displayName}
          </option>
        ))}
        {models.length > 0 && !current && value && <option value={value}>{value}</option>}
      </select>
      {thinkingLevels.length > 0 && (
        <select
          value={thinkingLevel}
          onChange={(e) => onThinkingChange(e.target.value)}
          title="思考强度"
          className="cursor-pointer rounded-full bg-transparent px-1 py-0.5 text-[12px] text-text-tertiary outline-none"
        >
          {thinkingLevels.map((lv) => (
            <option key={lv} value={lv}>
              {lv}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
