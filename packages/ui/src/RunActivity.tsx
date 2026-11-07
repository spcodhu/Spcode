import type { RemoteToolCall } from "@spcode/shared";
import { i18n } from "@spcode/shared/i18n";
import type { ThemeBase } from "@spcode/shared/theme";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DiffPatch } from "./DiffPatch";
import { Markdown } from "./Markdown";
import {
  type ActivitySegment,
  buildRunBlocks,
  currentRunProgress,
  type RunBlock,
  type RunSegment,
  type RunTextBlock,
  splitCompletedRun,
} from "./run-activity";
import { isCommandTool, summarizeArgs, toolLabel } from "./tooling";

function RunIcon({
  name,
  size = 16,
  className,
  strokeWidth = 1.8,
}: {
  name: "check" | "x" | "chevronRight";
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  const d = name === "check" ? "M20 6 9 17l-5-5" : name === "x" ? "M18 6 6 18M6 6l12 12" : "m9 18 6-6-6-6";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

/** 双端共用的运行时间线：活动组、逐步工具状态、折叠过程与当前动作完全一致。 */
export function RunActivityTimeline({
  segments,
  active,
  progressSegment,
  startedAt,
  themeBase,
  renderText,
}: {
  segments: RunSegment[];
  active: boolean;
  progressSegment?: RunSegment;
  startedAt?: number;
  themeBase?: ThemeBase;
  /** 桌面注入本机 Plan 文件动作；手机缺省使用共享 Markdown。 */
  renderText?: (block: RunTextBlock) => ReactNode;
}) {
  const blocks = buildRunBlocks(segments);
  const renderBlock = (block: RunTextBlock): ReactNode =>
    renderText ? renderText(block) : <Markdown key={block.key} text={block.text} themeBase={themeBase} />;
  if (!active) {
    const { process, summary } = splitCompletedRun(blocks);
    return process.length > 0 ? (
      <RunProcess blocks={process} summary={summary} renderText={renderBlock} />
    ) : (
      summary && renderBlock(summary)
    );
  }

  const activeGroupIdx = blocks[blocks.length - 1]?.kind === "activity" ? blocks.length - 1 : -1;
  const progress = currentRunProgress(progressSegment);
  return (
    <>
      {blocks.map((block, i) =>
        block.kind === "text" ? (
          renderBlock(block)
        ) : (
          <ActivityGroup
            key={block.key}
            segments={block.segments}
            active={i === activeGroupIdx}
            startedAt={i === activeGroupIdx ? startedAt : undefined}
          />
        ),
      )}
      <RunProgress state={progress} />
    </>
  );
}

function ActivityGroup({
  segments,
  active,
  startedAt,
}: {
  segments: ActivitySegment[];
  active: boolean;
  startedAt?: number;
}) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(active);
  useEffect(() => setOpen(active), [active]);
  const elapsed = useElapsedSeconds(startedAt, active);

  return (
    <div className="mb-1 min-w-0" data-testid="run-activity" data-state={active ? "running" : "done"}>
      <ActivityHeader
        open={open}
        onToggle={() => setOpen(!open)}
        testId="run-activity-header"
        label={
          <>
            {t(active ? "message.running" : "message.processed")}
            {elapsed !== undefined && <span className="tabular-nums"> · {t("run.seconds", { seconds: elapsed })}</span>}
          </>
        }
      />
      <div className="collapse-grid" data-open={open} aria-hidden={!open} inert={!open}>
        <div className="collapse-inner">
          <div className="ml-[10px] border-l border-border pb-1 pl-4">
            <div className="min-w-0 space-y-0.5" data-testid="run-activity-steps">
              {segments.map((seg) =>
                seg.kind === "thinking" ? (
                  <ThinkingRow key={seg.id} text={seg.text} streaming={!seg.done && active} />
                ) : (
                  <ToolRowGroup key={seg.id} calls={seg.calls} />
                ),
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ActivityHeader({
  open,
  onToggle,
  label,
  testId,
}: {
  open: boolean;
  onToggle: () => void;
  label: ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      data-testid={testId}
      className="group grid min-h-8 w-full grid-cols-[20px_minmax(0,1fr)] items-center gap-2 rounded-md py-1.5 text-left text-[13px] leading-5 text-text-tertiary transition-colors hover:text-text-secondary"
    >
      <span className="flex size-5 items-center justify-center rounded-md border border-border bg-bg-elevated text-text-tertiary shadow-sm transition-colors group-hover:text-text-secondary">
        <RunIcon
          name="chevronRight"
          size={12}
          className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function RunProcess({
  blocks,
  summary,
  renderText,
}: {
  blocks: RunBlock[];
  summary?: RunTextBlock;
  renderText: (block: RunTextBlock) => ReactNode;
}) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  let toolCount = 0;
  let failedCount = 0;
  for (const block of blocks) {
    if (block.kind !== "activity") continue;
    for (const seg of block.segments) {
      if (seg.kind !== "tools") continue;
      toolCount += seg.calls.length;
      failedCount += seg.calls.filter((call) => call.status === "error").length;
    }
  }
  const label =
    toolCount === 0
      ? t("message.processed")
      : failedCount > 0
        ? t("message.toolsRanWithFailures", { count: toolCount, failed: failedCount })
        : t("message.toolsRan", { count: toolCount });

  return (
    <>
      <div className="mb-1 min-w-0" data-testid="run-process" data-state={open ? "expanded" : "collapsed"}>
        <ActivityHeader
          open={open}
          onToggle={() => setOpen(!open)}
          testId="run-process-header"
          label={<span className="tabular-nums">{label}</span>}
        />
        <div className="collapse-grid" data-open={open} aria-hidden={!open} inert={!open}>
          <div className="collapse-inner">
            <div className="min-w-0" data-testid="run-process-body">
              {blocks.map((block) =>
                block.kind === "text" ? (
                  renderText(block)
                ) : (
                  <ActivityGroup key={block.key} segments={block.segments} active={false} />
                ),
              )}
            </div>
          </div>
        </div>
      </div>
      {summary && renderText(summary)}
    </>
  );
}

function useElapsedSeconds(startedAt: number | undefined, active: boolean): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, startedAt]);
  if (!active || startedAt === undefined) return undefined;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

function StepStatusIcon({ status }: { status: "running" | "done" | "error" }) {
  if (status === "running") {
    return (
      <span
        aria-hidden
        className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-border-strong border-t-text-tertiary motion-reduce:animate-none"
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`flex size-3.5 shrink-0 items-center justify-center rounded-full text-on-accent ${
        status === "error" ? "bg-danger" : "bg-success"
      }`}
    >
      <RunIcon name={status === "error" ? "x" : "check"} size={9} strokeWidth={3} />
    </span>
  );
}

function RunProgress({ state }: { state: ReturnType<typeof currentRunProgress> }) {
  const { t } = useTranslation("chat");
  const label =
    state.kind === "tool"
      ? toolStepTitle(state.call.name, state.call.status)
      : state.kind === "thinking"
        ? t("message.thinking")
        : state.kind === "output"
          ? t("run.output")
          : t("message.continueThinking");
  const detail = state.kind === "tool" ? summarizeArgs(state.call.name, state.call.args) : "";

  return (
    <div
      className="flex min-h-7 min-w-0 items-center gap-2 px-0.5 py-1 text-[13px] leading-5 text-text-tertiary"
      data-testid="run-progress"
      data-kind={state.kind}
      data-tool={state.kind === "tool" ? state.call.name : undefined}
    >
      <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden>
        <span className="grid grid-cols-2 gap-[3px]">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className="size-[3px] animate-pulse rounded-full bg-text-tertiary"
              style={{ animationDelay: `${i * 140}ms` }}
            />
          ))}
        </span>
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="thinking-shimmer shrink-0">{label}</span>
        {detail && (
          <>
            <span className="shrink-0 text-text-tertiary">·</span>
            <span className="mono min-w-0 truncate text-[12px] text-text-tertiary" title={detail}>
              {detail}
            </span>
          </>
        )}
      </span>
    </div>
  );
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.trim().replace(/^[-*>#\s]+/, "");
}

function ThinkingRow({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    if (streaming) stickRef.current = true;
  }, [streaming]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: text 仅作内容增长信号驱动滚动
  useEffect(() => {
    const el = bodyRef.current;
    if (streaming && el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [text, streaming]);

  if (!streaming && !text.trim()) return null;
  const preview = firstLine(text);
  const expanded = streaming || open;

  return (
    <div className="min-w-0" data-testid="run-thinking">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen(!open)}
        className="group flex min-h-6 w-full min-w-0 items-center gap-2 rounded-md py-0.5 text-left transition-colors hover:bg-bg-hover/40"
      >
        <StepStatusIcon status={streaming ? "running" : "done"} />
        <span className="min-w-0 flex-1 truncate text-[13px] leading-5">
          <span className={streaming ? "thinking-shimmer" : "text-text-secondary"}>
            {t(streaming ? "message.thinking" : "message.thought")}
          </span>
          {!streaming && preview && (
            <>
              <span className="text-text-tertiary"> · </span>
              <span className="text-text-tertiary">{preview}</span>
            </>
          )}
        </span>
      </button>
      <div className="collapse-grid" data-open={expanded} aria-hidden={!expanded} inert={!expanded}>
        <div className="collapse-inner">
          <div
            ref={bodyRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
            className="ml-5 mt-0.5 mb-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-bg-elevated/70 px-2.5 py-1.5 text-[11.5px] leading-5 text-text-tertiary"
          >
            {text || "…"}
          </div>
        </div>
      </div>
    </div>
  );
}

function toolStepTitle(name: string, status: RemoteToolCall["status"]): string {
  if (!isCommandTool(name)) return toolLabel(name);
  if (status === "running") return i18n.t("chat:message.commandRunning");
  if (status === "error") return i18n.t("chat:message.commandError");
  return i18n.t("chat:message.commandDone");
}

function ToolRowGroup({ calls }: { calls: RemoteToolCall[] }) {
  return (
    <div className="min-w-0">
      {calls.map((tc) => (
        <ToolRow key={tc.id} toolCall={tc} />
      ))}
    </div>
  );
}

function ToolRow({ toolCall }: { toolCall: RemoteToolCall }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const error = toolCall.status === "error";
  const summary = summarizeArgs(toolCall.name, toolCall.args);

  return (
    <div className="min-w-0" data-testid="run-tool-step" data-tool={toolCall.name} data-status={toolCall.status}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group flex min-h-6 w-full min-w-0 items-center gap-2 rounded-md py-0.5 text-left transition-colors hover:bg-bg-hover/40"
      >
        <StepStatusIcon status={toolCall.status} />
        <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-text-secondary">
          <span title={toolCall.name}>{toolStepTitle(toolCall.name, toolCall.status)}</span>
          {summary && (
            <>
              <span className="text-text-tertiary"> · </span>
              <span className="mono text-[12px] text-text-tertiary" title={summary}>
                {summary}
              </span>
            </>
          )}
        </span>
      </button>
      <div className="collapse-grid" data-open={open} aria-hidden={!open} inert={!open}>
        <div className="collapse-inner">
          <div
            className="ml-5 mt-1 mb-1 overflow-hidden rounded-md bg-bg-elevated/70 px-2.5 py-1.5"
            data-testid="run-step-detail"
          >
            {toolCall.patch ? (
              <DiffPatch patch={toolCall.patch} />
            ) : (
              <>
                <div className="text-[10.5px] leading-4 text-text-tertiary">{t("message.input")}</div>
                <pre className="mono max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-[18px] text-text-secondary">
                  {formatArgs(toolCall.args)}
                </pre>
              </>
            )}
            {toolCall.output && (
              <>
                <div className={`mt-1 text-[10.5px] leading-4 ${error ? "text-danger/70" : "text-text-tertiary"}`}>
                  {t("message.response")}
                </div>
                <pre
                  className={`mono max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-[18px] ${
                    error ? "text-danger/90" : "text-text-secondary"
                  }`}
                >
                  {toolCall.output.slice(0, 4000)}
                  {toolCall.output.length > 4000 ? t("message.truncated") : ""}
                </pre>
              </>
            )}
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
