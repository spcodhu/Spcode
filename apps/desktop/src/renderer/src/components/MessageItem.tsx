import { i18n } from "@spcode/shared/i18n";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCompact, formatFileSize } from "../format";
import {
  type ActivitySegment,
  buildRunBlocks,
  currentRunProgress,
  type RunBlock,
  type RunProgressState,
  type RunTextBlock,
  splitCompletedRun,
} from "../run-activity";
import { type ChatMessage, flattenSegments, messageText, type ToolCallState } from "../store";
import { isCommandTool, summarizeArgs, toolLabel } from "../tooling";
import { DiffPatch } from "./DiffBlock";
import { Icon } from "./Icon";
import { ImageLightbox } from "./ImageLightbox";
import { Markdown } from "./Markdown";

/** 用户气泡长文本折叠阈值（行）：MD 模式粘贴大段结构化文本/文件拼接回放时免刷屏 */
const COLLAPSE_LINES = 12;

/** 用户消息气泡（含图片附件缩略图点击放大、文件附件 chips；长文本默认折叠） */
function MessageItemImpl({ message }: { message: ChatMessage }) {
  const { t } = useTranslation("chat");
  const text = messageText(message);
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const images = message.images ?? [];
  const files = message.files ?? [];
  const lineCount = text ? text.split("\n").length : 0;
  const collapsible = lineCount > COLLAPSE_LINES;
  return (
    <div className="mb-4 flex flex-col items-end gap-2">
      {images.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {images.map((img, i) => (
            <button
              type="button"
              key={`${img.name}-${img.data.length}`}
              onClick={() => setPreviewIdx(i)}
              title={t("common.previewFile", { name: img.name })}
              className="cursor-zoom-in"
            >
              <img
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={img.name}
                className="max-h-40 rounded-xl border border-border object-cover transition-opacity hover:opacity-85"
              />
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {files.map((f) => (
            <span
              key={`${f.name}-${f.size}`}
              title={t("message.sentFile", { name: f.name })}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-elevated px-2 py-1 text-[12px] text-text-secondary"
            >
              <Icon name="fileText" size={12} className="text-text-tertiary" />
              <span className="max-w-48 truncate">{f.name}</span>
              <span className="text-text-tertiary">{formatFileSize(f.size)}</span>
            </span>
          ))}
        </div>
      )}
      {text.trim() && (
        <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-sm border border-border bg-user-bubble px-4 py-2.5 text-sm">
          {collapsible && !expanded ? (
            <>
              {text.split("\n").slice(0, 5).join("\n")}
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="mt-1 block text-[12px] text-accent transition-colors hover:text-accent-dim"
              >
                {t("message.expand", { lines: lineCount, characters: text.length })}
              </button>
            </>
          ) : (
            <>
              {text}
              {collapsible && (
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="mt-1 block text-[12px] text-accent transition-colors hover:text-accent-dim"
                >
                  {t("common.collapse")}
                </button>
              )}
            </>
          )}
        </div>
      )}
      {previewIdx !== null && (
        <ImageLightbox
          images={images}
          index={previewIdx}
          onClose={() => setPreviewIdx(null)}
          onNavigate={setPreviewIdx}
        />
      )}
    </div>
  );
}

/** memo：旧用户消息对象引用不变即跳过渲染（评审 P2-1——流式期间不再整树重渲染） */
export const MessageItem = memo(MessageItemImpl);

/**
 * 通知分隔线（压缩完成/失败等）：居中细线 + 小字，不打断阅读流。
 * 压缩通知带摘要时可点击展开全文（恢复会话回放时摘要同样可见）。
 *
 * runError（额度不足/鉴权失败/限流耗尽…中断）是与上述完全不同的东西：
 * 它不是仪式性分隔线，而是「任务被掐断了」——渲染成危险色卡片，
 * 标题 + 处理建议 + 原始错误（直接展示，不再藏在一个「详情」按钮后面），
 * 且重启后仍可见（historyToMessages 回放）。
 */
function NoticeItemImpl({ message }: { message: ChatMessage }) {
  const { t } = useTranslation("chat");
  const compaction = message.notice?.kind === "compaction" ? message.notice : undefined;
  const text = compaction
    ? compaction.tokensBefore === undefined
      ? t("message.compacted")
      : compaction.tokensAfter === undefined
        ? t("message.compactedBefore", { before: formatCompact(compaction.tokensBefore) })
        : t("message.compactedRange", {
            before: formatCompact(compaction.tokensBefore),
            after: formatCompact(compaction.tokensAfter),
          })
    : messageText(message);
  const summary = compaction?.summary;
  const [open, setOpen] = useState(false);
  if (message.notice?.kind === "runError") return <RunErrorCard notice={message.notice} />;
  return (
    <div className="my-5">
      <button
        type="button"
        disabled={!summary}
        onClick={() => setOpen((v) => !v)}
        className={`group flex w-full items-center gap-3 ${summary ? "" : "cursor-default"}`}
      >
        <span className="h-px flex-1 bg-border" />
        <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-text-tertiary transition-colors group-hover:text-text-secondary">
          {text}
          {summary && (
            <Icon
              name="chevronDown"
              size={12}
              className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`}
            />
          )}
        </span>
        <span className="h-px flex-1 bg-border" />
      </button>
      {open && summary && (
        <div className="mt-3 rounded-xl border border-border bg-bg-elevated px-4 py-3 text-[13px] leading-relaxed text-text-secondary">
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
            {t("message.compactionSummary")}
          </div>
          <Markdown text={summary} />
        </div>
      )}
    </div>
  );
}

/** 运行被错误中断的持久错误卡（额度不足/凭证/限流/超长/网络） */
function RunErrorCard({ notice }: { notice: Extract<NonNullable<ChatMessage["notice"]>, { kind: "runError" }> }) {
  const { t } = useTranslation("chat");
  const { t: errorT } = useTranslation("errors");
  return (
    <div
      className="my-4 rounded-xl border border-danger/40 bg-danger/8 px-4 py-3"
      data-testid="run-error-card"
      data-error-kind={notice.errorKind}
    >
      <div className="flex items-start gap-2">
        <Icon name="alert" size={15} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-danger">{errorT(`run.${notice.errorKind}.title`)}</div>
          <div className="mt-1 text-[12.5px] leading-5 text-text-secondary">
            {errorT(`run.${notice.errorKind}.hint`)}
          </div>
          {notice.attempt && notice.attempt > 0 ? (
            <div className="mt-1 text-[11.5px] text-text-tertiary">
              {t("message.retryExhausted", { count: notice.attempt })}
            </div>
          ) : null}
          {/* 原始错误直接铺在外面：排查时最想看的就是这句话，多一次点击都是阻碍 */}
          {notice.raw && (
            <pre
              className="mono mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-bg-main px-3 py-2 text-[11.5px] leading-5 text-text-secondary"
              data-testid="run-error-raw"
            >
              {notice.raw}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export const NoticeItem = memo(NoticeItemImpl);

/**
 * 一次任务运行的渲染单元（Qoder 风格）：
 * - 连续的思考/工具调用收进一个可折叠的「活动组」，组头显示
 *   「正在执行中 · Ns」（运行中）或「已处理」（结束后）；
 * - 正文（阶段性说明与最终总结）按到达顺序内联在组与组之间；
 * - 组内一步一行：状态圆点（进行中/完成/失败）+ 动作标签 + 参数摘要，
 *   点击展开完整输入与输出；
 * - 运行中尾部始终显示当前步骤的进度行（思考/工具/输出/等待），活动组被
 *   用户收起时仍能告诉用户现在在做什么；
 * - 运行结束后只保留最后一段正文（总结），之前的阶段输出与活动组统一收进
 *   一个「过程」折叠区；展开后仍是完整的时间线，各活动组可继续展开。
 *
 * active 由外层传入（会话 running && 最后一个运行）：回合间隙所有消息的
 * streaming 都是 false，若用消息级状态驱动折叠会在回合之间闪合闪开。
 */
function AssistantRunItemImpl({
  messages,
  active,
  startedAt,
}: {
  messages: ChatMessage[];
  active: boolean;
  startedAt?: number;
}) {
  const segments = flattenSegments(messages);
  const blocks = buildRunBlocks(segments);

  if (!active) {
    // 任务结束：只留最后一段正文（总结），其余按到达顺序收进一个过程折叠区。
    const { process, summary } = splitCompletedRun(blocks);
    return (
      <div className="mb-6">
        {process.length > 0 ? (
          <RunProcess blocks={process} summary={summary} />
        ) : (
          summary && <Markdown key={summary.key} text={summary.text} />
        )}
      </div>
    );
  }

  // 只有运行中、且位于最末尾的活动组才是「进行中」——一旦后面接上正文，这组就已完成
  const activeGroupIdx = blocks[blocks.length - 1]?.kind === "activity" ? blocks.length - 1 : -1;
  const lastMessage = messages[messages.length - 1];
  const streamingTail = lastMessage?.streaming ? lastMessage.segments[lastMessage.segments.length - 1] : undefined;
  const progress = currentRunProgress(streamingTail);

  return (
    <div className="mb-6">
      {blocks.map((block, i) =>
        block.kind === "text" ? (
          <Markdown key={block.key} text={block.text} />
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
    </div>
  );
}

/**
 * memo 切断旧运行随流式 delta 的重渲染（评审 P2-1）。
 * 注意 delta 是原位修改流式消息对象（引用不变），所以激活运行必须每次真渲染；
 * 旧运行的消息引用逐元素比较全同则跳过。groupMessagesForRender 每次重建 run 数组，
 * 故不能按数组引用比较。
 */
export const AssistantRunItem = memo(AssistantRunItemImpl, (prev, next) => {
  if (prev.active || next.active) return false;
  if (prev.startedAt !== next.startedAt) return false;
  if (prev.messages.length !== next.messages.length) return false;
  return prev.messages.every((m, i) => m === next.messages[i]);
});

/**
 * 活动组：一步一行的时间线，外层一条细轨。
 * 运行中自动展开跟踪动态，结束后自动收起（用户手动开合不受影响）。
 */
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

/** 活动组 / 过程折叠共用的行头：方形箭头 + 文案 */
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
        <Icon
          name="chevronRight"
          size={12}
          className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

/**
 * 任务结束后的过程折叠：默认收起，只把最终总结留在页面上。
 * 展开后按到达顺序还原阶段正文与活动组，活动组仍可继续展开。
 */
function RunProcess({ blocks, summary }: { blocks: RunBlock[]; summary?: RunTextBlock }) {
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
                  <Markdown key={block.key} text={block.text} />
                ) : (
                  <ActivityGroup key={block.key} segments={block.segments} active={false} />
                ),
              )}
            </div>
          </div>
        </div>
      </div>
      {summary && <Markdown key={summary.key} text={summary.text} />}
    </>
  );
}

/** 进行中的活动组用运行起始时间计算耗时（Qoder：正在执行中 · 7s） */
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

/** 步骤状态圆点：进行中空心环旋转、完成绿底勾、失败红底叉 */
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
      <Icon name={status === "error" ? "x" : "check"} size={9} strokeWidth={3} />
    </span>
  );
}

/**
 * 运行中常驻进度行（Qoder：四点图标 + 闪光文案）。
 * 任务进行时始终显示，文案跟随当前步骤；活动组被用户收起时也不会消失。
 */
function RunProgress({ state }: { state: RunProgressState }) {
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

/** 取思考文本的首行做预览（去掉列表/引用前缀） */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.trim().replace(/^[-*>#\s]+/, "");
}

/**
 * 思考条目：完成后收成一行「已思考 · 首行摘要」，点击展开全文；
 * 流式期间行头为「思考中」并自动展开、跟随滚动。
 */
function ThinkingRow({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 贴底跟随标记：用户上翻暂停跟随，回滚到底部附近后恢复 */
  const stickRef = useRef(true);

  useEffect(() => {
    if (streaming) stickRef.current = true;
  }, [streaming]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: text 仅作内容增长信号驱动滚动，effect 体内只用 ref
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

/** 终端命令动作在行头带运行状态（Qoder：终端命令 已运行 / 运行中 / 运行失败） */
function toolStepTitle(name: string, status: ToolCallState["status"]): string {
  if (!isCommandTool(name)) return toolLabel(name);
  if (status === "running") return i18n.t("chat:message.commandRunning");
  if (status === "error") return i18n.t("chat:message.commandError");
  return i18n.t("chat:message.commandDone");
}

/**
 * 一段连续工具调用：每个调用一行「状态圆点 + 动作标签 + 参数摘要」，
 * 点击行展开完整输入与输出。
 */
function ToolRowGroup({ calls }: { calls: ToolCallState[] }) {
  return (
    <div className="min-w-0">
      {calls.map((tc) => (
        <ToolRow key={tc.id} toolCall={tc} />
      ))}
    </div>
  );
}

function ToolRow({ toolCall }: { toolCall: ToolCallState }) {
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
            {/* 评审 R3-F1：edit/write 有 patch 时渲染 diff（比原始 JSON 参数可读得多） */}
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
