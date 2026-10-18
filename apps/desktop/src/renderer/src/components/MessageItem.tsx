import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { formatFileSize } from "../format";
import { type ChatMessage, flattenSegments, messageText, type ToolCallState } from "../store";
import { summarizeArgs, toolLabel } from "../tooling";
import { Icon } from "./Icon";
import { ImageLightbox } from "./ImageLightbox";
import { Markdown } from "./Markdown";

/** 用户气泡长文本折叠阈值（行）：MD 模式粘贴大段结构化文本/文件拼接回放时免刷屏 */
const COLLAPSE_LINES = 12;

/** 用户消息气泡（含图片附件缩略图点击放大、文件附件 chips；长文本默认折叠） */
function MessageItemImpl({ message }: { message: ChatMessage }) {
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
              title={`预览 ${img.name}`}
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
              title={`${f.name}（已随消息发送）`}
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
                …展开全部（共 {lineCount} 行 · {text.length} 字）
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
                  收起
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
 */
function NoticeItemImpl({ message }: { message: ChatMessage }) {
  const text = messageText(message);
  const summary = message.notice?.summary;
  const [open, setOpen] = useState(false);
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
            压缩摘要（模型上下文中看到的版本）
          </div>
          <Markdown text={summary} />
        </div>
      )}
    </div>
  );
}

export const NoticeItem = memo(NoticeItemImpl);

/**
 * 一次任务运行的渲染单元：把运行内所有回合的段拍平成一条时间线，
 * 严格按到达顺序从上往下渲染 —— 正文原位显示，思考/工具是时间线上
 * 的一行弱化条目（左轨 + 圆点），绝不发生"插叙"。
 *
 * 轨迹呈现参考 Codex CLI / Claude Code / Copilot CLI 的通行做法：
 * - 一行一步：每个工具调用一行「动作标签 + 参数摘要」，无边框卡片
 * - 思考不占版面：完成后收成一行「思考 · 首行摘要」，点击展开全文；
 *   流式期间实时展开，完成后自动收起
 * - 整体可折叠：运行中自动展开（跟踪动态），结束后自动收起（读正文）
 * - 任意行可展开完整参数与输出，执行轨迹可完整追溯
 *
 * active 由外层传入（会话 running && 最后一个运行）：回合间隙所有消息的
 * streaming 都是 false，若用消息级状态驱动折叠会在回合之间闪合闪开。
 */
function AssistantRunItemImpl({ messages, active }: { messages: ChatMessage[]; active: boolean }) {
  const segments = flattenSegments(messages);
  const toolCount = segments.reduce((n, s) => n + (s.kind === "tools" ? s.calls.length : 0), 0);
  const hasWork = segments.some((s) => s.kind !== "text");
  const hasText = segments.some((s) => s.kind === "text");
  // 首/尾工作段：左轨从首个圆点画到最后一个圆点，两端不留悬线
  const workIdxs = segments.map((s, i) => (s.kind === "text" ? -1 : i)).filter((i) => i >= 0);
  const firstWorkIdx = workIdxs[0] ?? -1;
  const lastWorkIdx = workIdxs[workIdxs.length - 1] ?? -1;

  const [workOpen, setWorkOpen] = useState(active);
  useEffect(() => setWorkOpen(active), [active]);

  return (
    <div className="mb-6">
      {hasWork && (
        <button
          type="button"
          onClick={() => setWorkOpen(!workOpen)}
          className="group mb-1 flex items-center gap-1.5 rounded-md py-0.5 text-[13px]"
        >
          <span className={`h-3 w-[2px] rounded-full ${active ? "bg-accent" : "bg-border-strong"}`} />
          {active ? (
            <span className="thinking-shimmer">正在工作…</span>
          ) : (
            <span className="text-text-secondary transition-colors group-hover:text-text-primary">
              工作完成{toolCount > 0 ? ` · ${toolCount} 步` : ""}
            </span>
          )}
          <Icon
            name="chevronDown"
            size={12}
            className={`text-text-tertiary transition-transform duration-150 ${workOpen ? "rotate-180" : ""}`}
          />
        </button>
      )}

      {segments.map((seg, si) => {
        if (seg.kind === "text") {
          return <Markdown key={seg.id} text={seg.text} />;
        }
        const railStart = si === firstWorkIdx;
        const railEnd = si === lastWorkIdx;
        return (
          <WorkEntry key={seg.id} open={workOpen}>
            {seg.kind === "thinking" ? (
              <ThinkingRow text={seg.text} streaming={!seg.done && active} railStart={railStart} railEnd={railEnd} />
            ) : (
              <ToolRowGroup calls={seg.calls} railStart={railStart} railEnd={railEnd} />
            )}
          </WorkEntry>
        );
      })}

      {active && !hasText && !hasWork && <ThinkingHeader streaming />}
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
  if (prev.messages.length !== next.messages.length) return false;
  return prev.messages.every((m, i) => m === next.messages[i]);
});

/** 工作条目（思考/工具行）：随运行头整体显隐，折叠走 grid 行高动画。
 *  注意：这里不能加行间距（pb-*），否则时间线左轨会被切成虚线；
 *  行间节奏由 TimelineEntry 自身的 py 控制，左轨自然连续。 */
function WorkEntry({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className="collapse-grid" data-open={open}>
      <div className="collapse-inner">{children}</div>
    </div>
  );
}

/** Kimi 风格思考头：细竖条 + 状态文字 + 小箭头，无边框盒子 */
function ThinkingHeader({ streaming, open }: { streaming: boolean; open?: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-[13px]">
      <span className="h-3 w-[2px] rounded-full bg-thinking/70" />
      {streaming ? (
        <span className="thinking-shimmer">思考中…</span>
      ) : (
        <span className="text-text-secondary transition-colors group-hover:text-text-primary">思考已完成</span>
      )}
      {open !== undefined && (
        <Icon
          name="chevronDown"
          size={12}
          className={`text-text-tertiary transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 轨迹时间线：左轨 + 圆点 + 单行条目（思考 / 工具调用共用一套骨架）
// ---------------------------------------------------------------------------

/**
 * 时间线条目外壳：左轨细线 + 状态圆点 + 可点击行头 + 展开详情区。
 * 左轨跨越行头与详情区，相邻条目首尾相接自动连成一条连续轨道；
 * 轨道从首个圆点画到最后一个圆点，两端不留悬线。
 */
function TimelineEntry({
  dot,
  railStart,
  railEnd,
  open,
  onClick,
  head,
  detail,
}: {
  dot: string;
  railStart?: boolean;
  railEnd?: boolean;
  open: boolean;
  onClick: () => void;
  head: ReactNode;
  detail: ReactNode;
}) {
  return (
    <div className="relative">
      {!(railStart && railEnd) && (
        <span
          aria-hidden
          className={`absolute left-[7px] w-px bg-border ${
            railStart ? "top-[13px] bottom-0" : railEnd ? "top-0 h-[13px]" : "inset-y-0"
          }`}
        />
      )}
      <span aria-hidden className={`absolute left-[4px] top-[9px] h-[7px] w-[7px] rounded-full ${dot}`} />
      <button
        type="button"
        onClick={onClick}
        className="group flex w-full items-center gap-2 rounded-md py-[3px] pl-6 pr-1 text-left transition-colors hover:bg-bg-hover/50"
      >
        {head}
      </button>
      <div className="collapse-grid" data-open={open}>
        <div className="collapse-inner">{detail}</div>
      </div>
    </div>
  );
}

/** 行头右侧的展开箭头 */
function RowChevron({ open }: { open: boolean }) {
  return (
    <Icon
      name="chevronDown"
      size={11}
      className={`shrink-0 text-text-tertiary opacity-0 transition-all duration-150 group-hover:opacity-100 ${open ? "rotate-180 opacity-100" : ""}`}
    />
  );
}

/** 取思考文本的首行做预览（去掉列表/引用前缀） */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.trim().replace(/^[-*>#\s]+/, "");
}

/**
 * 思考条目：完成后收成一行「思考 · 首行摘要」，点击展开全文；
 * 流式期间行头为「思考中…」流光并实时展开正文；空思考直接不渲染（去重）。
 */
function ThinkingRow({
  text,
  streaming,
  railStart,
  railEnd,
}: {
  text: string;
  streaming: boolean;
  railStart?: boolean;
  railEnd?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 贴底跟随标记：用户上翻暂停跟随，回滚到底部附近后恢复 */
  const stickRef = useRef(true);

  // 流式开始时重置贴底状态
  useEffect(() => {
    if (streaming) stickRef.current = true;
  }, [streaming]);

  // 流式期间思考文本增长时自动滚到底（仅在用户未上翻时）
  // biome-ignore lint/correctness/useExhaustiveDependencies: text 仅作内容增长信号驱动滚动，effect 体内只用 ref
  useEffect(() => {
    const el = bodyRef.current;
    if (streaming && el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [text, streaming]);

  if (!streaming && !text.trim()) return null;
  const preview = firstLine(text);
  const expanded = streaming || open;

  return (
    <TimelineEntry
      dot={streaming ? "bg-thinking animate-pulse" : "bg-thinking/35"}
      railStart={railStart}
      railEnd={railEnd}
      open={expanded}
      onClick={() => setOpen(!open)}
      head={
        <>
          <span className="shrink-0 text-[11.5px] text-text-tertiary">
            {streaming ? <span className="thinking-shimmer">思考中…</span> : "思考"}
          </span>
          {!streaming && (
            <span className="min-w-0 flex-1 truncate text-[12px] text-text-tertiary transition-colors group-hover:text-text-secondary">
              {preview}
            </span>
          )}
          {streaming && <span className="flex-1" />}
          {!streaming && <RowChevron open={open} />}
        </>
      }
      detail={
        <div
          ref={bodyRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="ml-6 mb-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap border-l-2 border-thinking/20 pl-3 pr-2 pt-0.5 text-[12px] leading-6 text-text-tertiary"
        >
          {text || "…"}
        </div>
      }
    />
  );
}

/**
 * 一段连续工具调用：每个调用一行「动作标签 + 参数摘要」（完整轨迹一目了然），
 * 点击行展开完整参数与输出；运行中行头流光，错误行摘要标红。
 */
function ToolRowGroup({
  calls,
  railStart,
  railEnd,
}: {
  calls: ToolCallState[];
  railStart?: boolean;
  railEnd?: boolean;
}) {
  return (
    <div>
      {calls.map((tc, i) => (
        <ToolRow
          key={tc.id}
          toolCall={tc}
          railStart={railStart && i === 0}
          railEnd={railEnd && i === calls.length - 1}
        />
      ))}
    </div>
  );
}

function ToolRow({
  toolCall,
  railStart,
  railEnd,
}: {
  toolCall: ToolCallState;
  railStart?: boolean;
  railEnd?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const running = toolCall.status === "running";
  const error = toolCall.status === "error";
  const dot = running ? "bg-warning animate-pulse" : error ? "bg-danger" : "bg-border-strong";
  const summary = summarizeArgs(toolCall.name, toolCall.args);

  return (
    <TimelineEntry
      dot={dot}
      railStart={railStart}
      railEnd={railEnd}
      open={open}
      onClick={() => setOpen(!open)}
      head={
        <>
          <span
            className="min-w-[52px] max-w-[112px] shrink-0 truncate text-[11.5px] text-text-tertiary"
            title={toolCall.name}
          >
            {toolLabel(toolCall.name)}
          </span>
          <span
            className={`mono min-w-0 flex-1 truncate text-[12px] ${
              running
                ? "thinking-shimmer"
                : error
                  ? "text-danger/90"
                  : "text-text-secondary transition-colors group-hover:text-text-primary"
            }`}
            title={summary}
          >
            {summary}
          </span>
          <RowChevron open={open} />
        </>
      }
      detail={
        <div className="ml-6 mb-1.5 rounded-lg border border-border bg-bg-elevated/60 px-3 py-2">
          <pre className="max-h-40 overflow-auto text-xs leading-5 text-text-tertiary">{formatArgs(toolCall.args)}</pre>
          {toolCall.output && (
            <pre className="mt-2 max-h-64 overflow-auto border-t border-border pt-2 text-xs leading-5 text-text-secondary">
              {toolCall.output.slice(0, 4000)}
              {toolCall.output.length > 4000 ? "\n…（已截断）" : ""}
            </pre>
          )}
        </div>
      }
    />
  );
}

function formatArgs(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2).slice(0, 2000);
  } catch {
    return String(args);
  }
}
