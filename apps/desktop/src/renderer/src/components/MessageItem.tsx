import { RunActivityTimeline } from "@spcode/ui";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCompact, formatFileSize, formatMessageTimestamp } from "../format";
import { openImageContextMenu } from "../image-actions";
import { buildRunBlocks, type RunTextBlock } from "../run-activity";
import { type ChatMessage, flattenSegments, messageText, useStore } from "../store";
import { prefillComposer } from "./Composer";
import { Icon } from "./Icon";
import { ImageLightbox } from "./ImageLightbox";
import { Markdown } from "./Markdown";

/** 用户气泡长文本折叠阈值（行）：MD 模式粘贴大段结构化文本/文件拼接回放时免刷屏 */
const COLLAPSE_LINES = 12;

/** 悬浮/聚焦时显示的消息元信息：时间、复制，以及仅回填输入框的编辑。 */
function MessageHoverMeta({
  timestamp,
  copyText,
  onEdit,
  align,
}: {
  timestamp?: number;
  copyText: string;
  onEdit?: () => void;
  align: "start" | "end";
}) {
  const { t } = useTranslation("chat");
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = async () => {
    if (!copyText.trim() || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      // 剪贴板不可用时保持原图标，不伪造成功反馈。
    }
  };

  return (
    <div
      data-testid="message-meta"
      className={`pointer-events-none flex h-6 items-center gap-2 opacity-0 transition-opacity ${
        align === "end" ? "justify-end" : "justify-start"
      } group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100`}
    >
      {timestamp !== undefined && (
        <time
          data-testid="message-time"
          dateTime={new Date(timestamp).toISOString()}
          className="text-[11px] tabular-nums text-text-tertiary"
        >
          {formatMessageTimestamp(timestamp)}
        </time>
      )}
      {copyText.trim() && (
        <button
          type="button"
          onClick={() => void copy()}
          title={t(copied ? "message.copied" : "message.copy")}
          aria-label={t(copied ? "message.copied" : "message.copy")}
          data-testid="message-copy"
          className="rounded p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
        >
          <Icon name={copied ? "check" : "copy"} size={13} className={copied ? "text-success" : undefined} />
        </button>
      )}
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          title={t("message.edit")}
          aria-label={t("message.edit")}
          data-testid="message-edit"
          className="rounded p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
        >
          <Icon name="pen" size={13} />
        </button>
      )}
    </div>
  );
}

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
    <div className="group/message mb-4 flex flex-col items-end gap-2" data-testid="user-message">
      {images.length > 0 && (
        <div
          data-testid="message-image-strip"
          className="ml-auto flex max-w-[85%] flex-nowrap gap-2 overflow-x-auto pb-1"
        >
          {images.map((img, i) => (
            <button
              type="button"
              key={`${img.name}-${img.data.length}`}
              onClick={() => setPreviewIdx(i)}
              title={t("common.previewFile", { name: img.name })}
              className="shrink-0 cursor-zoom-in"
            >
              <img
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={img.name}
                data-testid="message-image"
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void openImageContextMenu(img);
                }}
                className="h-36 w-52 rounded-xl border border-border object-cover transition-opacity hover:opacity-85"
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
        <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-sm border border-border bg-user-bubble px-4 py-2.5 text-sm [overflow-wrap:anywhere]">
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
      <MessageHoverMeta
        timestamp={message.timestamp}
        copyText={text}
        align="end"
        onEdit={text.trim() || images.length > 0 ? () => prefillComposer(text, images) : undefined}
      />
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
function NoticeItemImpl({ message, sessionId }: { message: ChatMessage; sessionId: string }) {
  const { t } = useTranslation("chat");
  const compaction = message.notice?.kind === "compaction" ? message.notice : undefined;
  const compactionKeys =
    compaction?.trigger === "auto"
      ? ({
          single: "message.autoCompacted",
          before: "message.autoCompactedBefore",
          range: "message.autoCompactedRange",
        } as const)
      : compaction?.trigger === "manual"
        ? ({
            single: "message.manualCompacted",
            before: "message.manualCompactedBefore",
            range: "message.manualCompactedRange",
          } as const)
        : ({
            single: "message.compacted",
            before: "message.compactedBefore",
            range: "message.compactedRange",
          } as const);
  const text = compaction
    ? compaction.tokensBefore === undefined
      ? t(compactionKeys.single)
      : compaction.tokensAfter === undefined
        ? t(compactionKeys.before, { before: formatCompact(compaction.tokensBefore) })
        : t(compactionKeys.range, {
            before: formatCompact(compaction.tokensBefore),
            after: formatCompact(compaction.tokensAfter),
          })
    : messageText(message);
  const summary = compaction?.summary;
  const [open, setOpen] = useState(false);
  if (message.notice?.kind === "runError") return <RunErrorCard message={message} sessionId={sessionId} />;
  return (
    <div className="my-5" data-testid={compaction ? "compaction-notice" : undefined} data-trigger={compaction?.trigger}>
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

function localDateTimeInput(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 运行被错误中断的持久错误卡（额度不足/凭证/限流/超长/网络） */
function RunErrorCard({ message, sessionId }: { message: ChatMessage; sessionId: string }) {
  const notice = message.notice as Extract<NonNullable<ChatMessage["notice"]>, { kind: "runError" }>;
  const { t } = useTranslation("chat");
  const { t: errorT } = useTranslation("errors");
  const session = useStore((state) => state.sessions[sessionId]);
  const scheduled = useStore((state) =>
    (state.runRetries ?? []).find((retry) => retry.sessionId === sessionId),
  );
  const scheduleRunRetry = useStore((state) => state.scheduleRunRetry);
  const cancelRunRetry = useStore((state) => state.cancelRunRetry);
  const [open, setOpen] = useState(false);
  const [exactTime, setExactTime] = useState(() => localDateTimeInput(Date.now() + 3 * 3_600_000));
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const messages = session?.messages ?? [];
  const noticeIndex = messages.findIndex((item) => item.id === message.id);
  let source: ChatMessage | undefined;
  for (let index = noticeIndex - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") {
      source = messages[index];
      break;
    }
  }
  const hasLaterActivity = messages
    .slice(Math.max(0, noticeIndex + 1))
    .some((item) => item.role === "user" || item.role === "assistant");
  const canSchedule = noticeIndex >= 0 && !hasLaterActivity && !session?.running && !!source;

  const schedule = async (runAt: number) => {
    if (!source || busy) return;
    if (!Number.isFinite(runAt) || runAt <= Date.now()) {
      setRetryError(t("message.retryTimeInvalid"));
      return;
    }
    setBusy(true);
    setRetryError(null);
    try {
      await scheduleRunRetry({
        sessionId,
        text: messageText(source),
        ...(source.images?.length ? { images: source.images } : {}),
        runAt,
      });
      setOpen(false);
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

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
          {canSchedule && (
            <div className="mt-3 border-t border-danger/20 pt-3">
              {scheduled ? (
                <div
                  className="flex flex-wrap items-center gap-2 text-[12px] text-text-secondary"
                  data-testid="run-retry-scheduled"
                >
                  <Icon name="clock" size={13} className="text-accent" />
                  <span>{t("message.retryScheduled", { time: formatMessageTimestamp(scheduled.runAt) })}</span>
                  <button
                    type="button"
                    data-testid="run-retry-cancel"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setRetryError(null);
                      void cancelRunRetry(scheduled.id)
                        .catch((error) => setRetryError(error instanceof Error ? error.message : String(error)))
                        .finally(() => setBusy(false));
                    }}
                    className="rounded-md px-2 py-1 text-accent hover:bg-bg-hover disabled:opacity-40"
                  >
                    {t("message.cancelScheduledRetry")}
                  </button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    data-testid="run-retry-toggle"
                    onClick={() => setOpen((value) => !value)}
                    className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-main px-2.5 py-1.5 text-[12px] text-text-primary hover:border-accent/50"
                  >
                    <Icon name="clock" size={13} />
                    {t("message.scheduleRetry")}
                  </button>
                  {open && (
                    <div className="mt-2 rounded-lg border border-border bg-bg-main p-3" data-testid="run-retry-panel">
                      <div className="text-[11.5px] leading-5 text-text-tertiary">{t("message.retryDescription")}</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          data-testid="run-retry-1h"
                          disabled={busy}
                          onClick={() => void schedule(Date.now() + 3_600_000)}
                          className="rounded-md bg-bg-elevated px-2.5 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
                        >
                          {t("message.retryIn1Hour")}
                        </button>
                        <button
                          type="button"
                          data-testid="run-retry-3h"
                          disabled={busy}
                          onClick={() => void schedule(Date.now() + 3 * 3_600_000)}
                          className="rounded-md bg-bg-elevated px-2.5 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
                        >
                          {t("message.retryIn3Hours")}
                        </button>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input
                          type="datetime-local"
                          aria-label={t("message.retryExactTime")}
                          data-testid="run-retry-exact"
                          value={exactTime}
                          onChange={(event) => setExactTime(event.target.value)}
                          className="rounded-md border border-border bg-bg-elevated px-2 py-1.5 text-[12px] text-text-primary"
                        />
                        <button
                          type="button"
                          data-testid="run-retry-exact-submit"
                          disabled={busy}
                          onClick={() => void schedule(new Date(exactTime).getTime())}
                          className="rounded-md bg-accent px-2.5 py-1.5 text-[12px] text-on-accent disabled:opacity-40"
                        >
                          {t("message.confirmScheduledRetry")}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
              {retryError && (
                <div role="alert" className="mt-2 text-[12px] text-danger" data-testid="run-retry-error">
                  {retryError}
                </div>
              )}
            </div>
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
  const lastMessage = messages[messages.length - 1];
  const streamingTail = lastMessage?.streaming ? lastMessage.segments[lastMessage.segments.length - 1] : undefined;
  const renderText = (block: RunTextBlock) => <Markdown key={block.key} text={block.text} />;

  if (!active) {
    const copyText = blocks
      .filter((block): block is RunTextBlock => block.kind === "text")
      .map((block) => block.text)
      .join("\n\n");
    const timestamp = messages[messages.length - 1]?.timestamp ?? messages[0]?.timestamp;
    return (
      <div className="group/message mb-6">
        <RunActivityTimeline segments={segments} active={false} renderText={renderText} />
        <MessageHoverMeta timestamp={timestamp} copyText={copyText} align="start" />
      </div>
    );
  }

  return (
    <div className="mb-6">
      <RunActivityTimeline
        segments={segments}
        active
        progressSegment={streamingTail}
        startedAt={startedAt}
        renderText={renderText}
      />
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
