import { useRef, useState } from "react";
import { useStore } from "../store";

export function Composer({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState("");
  const running = useStore((s) => s.sessions[sessionId]?.running ?? false);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const abort = useStore((s) => s.abort);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const value = text.trim();
    if (!value || running) return;
    setText("");
    void sendPrompt(value);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  return (
    <div className="shrink-0 border-t border-border bg-bg-main px-6 py-4">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-xl border border-border bg-bg-elevated focus-within:border-accent/50">
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
            className="w-full resize-none bg-transparent px-4 py-3 text-sm outline-none placeholder:text-text-tertiary"
          />
          <div className="flex items-center justify-between px-3 pb-2">
            <span className="text-xs text-text-tertiary">
              {running ? "Agent 工作中，可继续输入插队（steer）" : ""}
            </span>
            {running ? (
              <button
                onClick={() => void abort()}
                className="rounded-md border border-danger/50 bg-danger/10 px-3 py-1 text-xs text-danger hover:bg-danger/20"
              >
                ■ 停止
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!text.trim()}
                className="rounded-md bg-accent px-4 py-1 text-xs font-medium text-bg-root hover:bg-accent-dim disabled:opacity-40"
              >
                发送
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
