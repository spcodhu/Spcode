import { useState } from "react";
import { Streamdown } from "streamdown";
import type { ChatMessage, ToolCallState } from "../store";

export function MessageItem({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="mb-4 flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-sm border border-border bg-user-bubble px-4 py-2.5 text-sm">
          {message.text}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-6">
      {message.thinking && <ThinkingBlock text={message.thinking} streaming={message.streaming} />}
      {message.toolCalls.map((tc) => (
        <ToolCallCard key={tc.id} toolCall={tc} />
      ))}
      {message.text && (
        <div className="md-body text-sm leading-6">
          <Streamdown>{message.text}</Streamdown>
        </div>
      )}
      {message.streaming && !message.text && !message.thinking && message.toolCalls.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-text-tertiary">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          思考中…
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2 rounded-lg border border-thinking/30 bg-thinking/5">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-thinking"
      >
        <span>{open ? "▾" : "▸"}</span>
        思考过程{streaming && !open ? "（进行中…）" : ""}
      </button>
      {open && (
        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap px-3 pb-2 text-xs leading-5 text-text-tertiary">
          {text}
        </div>
      )}
    </div>
  );
}

function ToolCallCard({ toolCall }: { toolCall: ToolCallState }) {
  const [open, setOpen] = useState(false);
  const statusIcon =
    toolCall.status === "running" ? (
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
    ) : toolCall.status === "error" ? (
      <span className="text-danger">✕</span>
    ) : (
      <span className="text-success">✓</span>
    );

  return (
    <div className="mb-2 rounded-lg border border-border bg-bg-elevated">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs"
      >
        {statusIcon}
        <span className="mono text-text-secondary">{toolCall.name}</span>
        <span className="min-w-0 flex-1 truncate text-left text-text-tertiary">
          {summarizeArgs(toolCall.name, toolCall.args)}
        </span>
        <span className="text-text-tertiary">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2">
          <pre className="max-h-40 overflow-auto text-xs text-text-tertiary">
            {formatArgs(toolCall.args)}
          </pre>
          {toolCall.output && (
            <pre className="mt-2 max-h-64 overflow-auto border-t border-border pt-2 text-xs text-text-secondary">
              {toolCall.output.slice(0, 4000)}
              {toolCall.output.length > 4000 ? "\n…（已截断）" : ""}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function summarizeArgs(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const pick = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  switch (name.toLowerCase()) {
    case "read":
    case "write":
    case "edit":
      return pick("path") || pick("file_path");
    case "bash":
    case "powershell":
      return pick("command").slice(0, 80);
    case "grep":
      return `/${pick("pattern")}/`;
    case "websearch":
      return pick("query");
    case "webfetch":
      return pick("url");
    default:
      return "";
  }
}

function formatArgs(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2).slice(0, 2000);
  } catch {
    return String(args);
  }
}
