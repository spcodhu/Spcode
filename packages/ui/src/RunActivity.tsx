import type { RemoteToolCall } from "@spcode/shared";
import { i18n } from "@spcode/shared/i18n";
import type { ThemeBase } from "@spcode/shared/theme";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DiffPatch } from "./DiffPatch";
import { Markdown } from "./Markdown";
import {
  buildRunBlocks,
  currentRunProgress,
  type RunSegment,
  type RunTextBlock,
  splitCompletedRun,
} from "./run-activity";
import { isCommandTool, summarizeArgs, toolLabel } from "./tooling";

const PREVIEWABLE_TOOLS = new Set(["read", "write", "edit"]);
const ICON_PATHS = {
  check: "M20 6 9 17l-5-5",
  error: "M12 8v5m0 4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  chevronRight: "m9 18 6-6-6-6",
  panelRight: "M3 4h18v16H3zm12 0v16",
  thinking: "M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 2H9s0-1-1-2Z",
  file: "M14 3H5v18h14V8Zm0 0v5h5M8 12h8m-8 4h6",
  edit: "m14 5 5 5M5 19l4-1L20 7a2 2 0 0 0-4-4L5 14ZM4 22h16",
  terminal: "m5 7 5 5-5 5m8 0h6",
  tool: "m8 4-6 8 6 8m8-16 6 8-6 8M14 3l-4 18",
} as const;

type IconName = keyof typeof ICON_PATHS;

function RunIcon({ name, size = 14, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-border border-t-text-secondary motion-reduce:animate-none"
    />
  );
}

function NodeIcon({ name, running = false, error = false }: { name: IconName; running?: boolean; error?: boolean }) {
  return (
    <span
      aria-hidden
      className={`absolute top-1 left-4 flex h-5 w-5 items-center justify-center bg-bg-root ${error ? "text-danger" : "text-text-tertiary"}`}
    >
      {running ? <Spinner /> : <RunIcon name={error ? "error" : name} />}
    </span>
  );
}

function Chevron({ open, size = 11 }: { open: boolean; size?: number }) {
  return (
    <RunIcon
      name="chevronRight"
      size={size}
      className={`shrink-0 text-text-tertiary transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
    />
  );
}

export function RunActivityTimeline({
  segments,
  active,
  progressSegment,
  startedAt,
  themeBase,
  renderText,
  onOpenFile,
}: {
  segments: RunSegment[];
  active: boolean;
  progressSegment?: RunSegment;
  startedAt?: number;
  themeBase?: ThemeBase;
  renderText?: (block: RunTextBlock) => ReactNode;
  onOpenFile?: (rawPath: string) => void;
}) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const elapsed = useElapsedSeconds(startedAt, active);
  const blocks = buildRunBlocks(segments);
  const { process, summary } = active ? { process: blocks, summary: undefined } : splitCompletedRun(blocks);
  const progress = currentRunProgress(progressSegment);
  const calls = blocks.flatMap((block) => (block.kind === "tools" ? block.calls : []));
  const failedCount = calls.filter((call) => call.status === "error").length;
  const hasProcess = active || process.length > 0;
  const renderBlock = (block: RunTextBlock): ReactNode =>
    renderText ? renderText(block) : <Markdown text={block.text} themeBase={themeBase} />;

  return (
    <>
      {hasProcess && (
        <div
          className="mb-2 min-w-0"
          data-testid="run-process"
          data-state={open ? "expanded" : "collapsed"}
          data-active={active}
        >
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen(!open)}
            data-testid="run-process-header"
            className="group flex min-h-9 w-full min-w-0 items-start gap-2 px-0 py-1 text-left text-text-primary motion-reduce:transition-none"
          >
            <span
              className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-text-tertiary transition-colors group-hover:text-text-primary"
              data-testid="run-process-icon"
            >
              <Chevron open={open} size={14} />
            </span>
            <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
              {active ? (
                <RunProgress state={progress} />
              ) : (
                <span className="text-[14px] leading-5 font-semibold">{t("run.process")}</span>
              )}
              {elapsed !== undefined && (
                <span className="shrink-0 text-[11px] text-text-tertiary tabular-nums" data-testid="run-elapsed">
                  ·{" "}
                  {elapsed < 60
                    ? t("run.seconds", { seconds: elapsed })
                    : t("run.minutesSeconds", { minutes: Math.floor(elapsed / 60), seconds: elapsed % 60 })}
                </span>
              )}
              {calls.length > 0 && (
                <span className="shrink-0 text-[11px] text-text-tertiary tabular-nums" data-testid="run-tool-count">
                  · {t("run.toolCalls", { count: calls.length })}
                </span>
              )}
              {failedCount > 0 && (
                <span className="shrink-0 text-[11px] text-danger tabular-nums" data-testid="run-failed-count">
                  · {t("run.failedCalls", { count: failedCount })}
                </span>
              )}
            </span>
          </button>
          <div id={bodyId} className="collapse-grid" data-open={open} aria-hidden={!open} inert={!open}>
            <div className="collapse-inner">
              <ol className="ml-[9px] min-w-0 pt-1" data-testid="run-process-body">
                {process.map((block) => (
                  <li
                    key={block.key}
                    data-testid="run-timeline-item"
                    data-kind={block.kind}
                    className="relative min-w-0 pb-2 pl-10 before:absolute before:top-0 before:bottom-0 before:left-0 before:w-px before:bg-border after:absolute after:top-[14px] after:left-0 after:h-px after:w-3 after:bg-border last:pb-1 last:before:bottom-auto last:before:h-[14px]"
                  >
                    {block.kind === "text" ? (
                      <>
                        <span
                          aria-hidden
                          className={`absolute top-[11px] left-[23px] size-[5px] rounded-full ${active && progressSegment?.id === block.key ? "animate-pulse bg-text-tertiary motion-reduce:animate-none" : "bg-border-strong"}`}
                        />
                        <div data-testid="run-stage-output" className="min-w-0 pb-1 [&_.md-body]:mb-0">
                          {renderBlock(block)}
                        </div>
                      </>
                    ) : block.kind === "thinking" ? (
                      <ThinkingRow text={block.text} streaming={active && !block.done} />
                    ) : (
                      <ToolRowGroup calls={block.calls} active={active} onOpenFile={onOpenFile} />
                    )}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      )}
      {summary && (
        <div data-testid="run-summary" className={hasProcess ? "mt-3 min-w-0 border-t border-border pt-4" : "min-w-0"}>
          {renderBlock(summary)}
        </div>
      )}
    </>
  );
}

function useElapsedSeconds(startedAt: number | undefined, active: boolean): number | undefined {
  const [elapsed, setElapsed] = useState<number>();
  useEffect(() => {
    if (!active || startedAt === undefined) return;
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [active, startedAt]);
  return elapsed;
}

function RunProgress({ state }: { state: ReturnType<typeof currentRunProgress> }) {
  const { t } = useTranslation("chat");
  const label =
    state.kind === "tool"
      ? isCommandTool(state.call.name)
        ? t("run.command")
        : t("run.tool", { tool: toolLabel(state.call.name) })
      : state.kind === "thinking"
        ? t("message.thinking")
        : state.kind === "output"
          ? t("run.output")
          : t("message.continueThinking");
  const detail = state.kind === "tool" ? summarizeArgs(state.call.name, state.call.args) : "";
  return (
    <span
      className="flex min-w-0 max-w-full items-baseline gap-1.5"
      data-testid="run-progress"
      data-kind={state.kind}
      data-tool={state.kind === "tool" ? state.call.name : undefined}
    >
      <span className="shrink-0 text-[14px] leading-5 font-semibold text-text-primary">{label}</span>
      {detail && (
        <span className="mono min-w-0 truncate text-[11px] text-text-tertiary" title={detail}>
          · {detail}
        </span>
      )}
    </span>
  );
}

const THOUGHT_PREVIEW_MAX_LENGTH = 160;

/** 折叠时展示最近的思考尾部，而不是一直停留在首句。 */
function recentThought(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const sentences = normalized.match(/[^.!?。！？]+[.!?。！？]*/g) ?? [normalized];
  const recent = sentences.slice(-2).join("").trim();
  return recent.length > THOUGHT_PREVIEW_MAX_LENGTH
    ? `…${recent.slice(-(THOUGHT_PREVIEW_MAX_LENGTH - 1)).trimStart()}`
    : recent;
}

function ThinkingRow({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    if (streaming) stickRef.current = true;
  }, [streaming]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: text 仅作内容增长信号驱动滚动
  useEffect(() => {
    const el = bodyRef.current;
    if (streaming && open && el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [text, streaming, open]);

  return (
    <div className="min-w-0" data-testid="run-thinking">
      <NodeIcon name="thinking" running={streaming} />
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
        className="flex min-h-7 w-full min-w-0 items-center gap-2 rounded py-0.5 text-left text-[12px] leading-5 hover:bg-bg-hover/40"
      >
        <span className={`shrink-0 ${streaming ? "text-text-primary" : "text-text-secondary"}`}>
          {t(streaming ? "message.thinking" : "run.thought")}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-text-tertiary" data-testid="run-thinking-preview">
          {recentThought(text)}
        </span>
        <Chevron open={open} />
      </button>
      <div id={bodyId} className="collapse-grid" data-open={open} aria-hidden={!open} inert={!open}>
        <div className="collapse-inner">
          <div
            ref={bodyRef}
            onScroll={(event) => {
              const el = event.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
            className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-bg-hover/50 px-3 py-2 text-[11.5px] leading-5 text-text-secondary"
          >
            {text || "…"}
          </div>
        </div>
      </div>
    </div>
  );
}

function toolIcon(name: string): IconName {
  if (isCommandTool(name)) return "terminal";
  if (name.toLowerCase() === "read") return "file";
  if (name.toLowerCase() === "write" || name.toLowerCase() === "edit") return "edit";
  return "tool";
}

function toolGroupTitle(name: string, count: number): string {
  if (count === 1) return toolLabel(name);
  return i18n.t("chat:run.toolGroup", { tool: toolLabel(name), count });
}

function FilePreview({ call, onOpenFile }: { call: RemoteToolCall; onOpenFile?: (rawPath: string) => void }) {
  const { t } = useTranslation("chat");
  const path = summarizeArgs(call.name, call.args);
  if (!onOpenFile || !path || !PREVIEWABLE_TOOLS.has(call.name.toLowerCase())) return null;
  return (
    <button
      type="button"
      data-testid="run-tool-preview"
      title={`${t("message.previewFile")} · ${path}`}
      aria-label={`${t("message.previewFile")} · ${path}`}
      onClick={() => onOpenFile(path)}
      className="shrink-0 rounded p-1 text-text-tertiary hover:bg-bg-hover hover:text-accent"
    >
      <RunIcon name="panelRight" size={13} />
    </button>
  );
}

function ToolRowGroup({
  calls,
  active,
  onOpenFile,
}: {
  calls: RemoteToolCall[];
  active: boolean;
  onOpenFile?: (rawPath: string) => void;
}) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const first = calls[0]!;
  const failedCount = calls.filter((call) => call.status === "error").length;
  const running = active && calls.some((call) => call.status === "running");
  const status = running ? "running" : failedCount > 0 ? "error" : "done";
  const summary = calls
    .map((call) => summarizeArgs(call.name, call.args))
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className="min-w-0"
      data-testid="run-tool-step"
      data-tool={first.name}
      data-status={status}
      data-count={calls.length}
    >
      <NodeIcon name={toolIcon(first.name)} running={running} error={failedCount > 0} />
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
          className="flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded py-0.5 text-left text-[12px] leading-5 hover:bg-bg-hover/40"
        >
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
            <span
              className={`max-w-full break-words ${failedCount > 0 ? "text-danger" : running ? "text-text-primary" : "text-text-secondary"}`}
            >
              {toolGroupTitle(first.name, calls.length)}
            </span>
            <span className="mono min-w-0 flex-1 basis-24 truncate text-[11px] text-text-tertiary" title={summary}>
              {summary}
            </span>
            {failedCount > 0 && (
              <span data-testid="run-failed-count" className="shrink-0 text-[11px] text-danger">
                {t("run.failedCalls", { count: failedCount })}
              </span>
            )}
          </span>
          <Chevron open={open} />
        </button>
        {calls.length === 1 && <FilePreview call={first} onOpenFile={onOpenFile} />}
      </div>
      <div id={bodyId} className="collapse-grid" data-open={open} aria-hidden={!open} inert={!open}>
        <div className="collapse-inner">
          <div
            className="mt-1.5 divide-y divide-border overflow-hidden rounded-md bg-bg-hover/50 px-3"
            data-testid="run-step-detail"
          >
            {calls.map((call) => (
              <div
                key={call.id}
                className="min-w-0 py-2"
                data-testid="run-tool-call"
                data-call-id={call.id}
                data-status={call.status}
              >
                {calls.length > 1 && (
                  <div className="mb-1 flex min-w-0 items-center gap-2 text-[11px] text-text-tertiary">
                    {active && call.status === "running" ? (
                      <Spinner />
                    ) : (
                      <RunIcon
                        name={call.status === "error" ? "error" : "check"}
                        size={12}
                        className={call.status === "error" ? "shrink-0 text-danger" : "shrink-0"}
                      />
                    )}
                    <span className="mono min-w-0 flex-1 break-all">
                      {summarizeArgs(call.name, call.args) || call.name}
                    </span>
                    <FilePreview call={call} onOpenFile={onOpenFile} />
                  </div>
                )}
                {call.patch ? (
                  <DiffPatch patch={call.patch} />
                ) : (
                  <>
                    <div className="text-[10.5px] leading-4 text-text-tertiary">{t("message.input")}</div>
                    <pre className="mono max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-[18px] text-text-secondary">
                      {formatArgs(call.args)}
                    </pre>
                  </>
                )}
                {call.output && (
                  <>
                    <div
                      className={`mt-2 text-[10.5px] leading-4 ${call.status === "error" ? "text-danger" : "text-text-tertiary"}`}
                    >
                      {t("message.response")}
                    </div>
                    <pre
                      className={`mono max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-[18px] ${call.status === "error" ? "text-danger" : "text-text-secondary"}`}
                    >
                      {call.output.slice(0, 4000)}
                      {call.output.length > 4000 ? t("message.truncated") : ""}
                    </pre>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatArgs(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2).slice(0, 2000);
  } catch {
    return String(args);
  }
}
