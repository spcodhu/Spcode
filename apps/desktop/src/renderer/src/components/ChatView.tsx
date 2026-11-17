import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type ChatMessage, groupMessagesForRender, useStore } from "../store";
import { Composer } from "./Composer";
import { SessionEmptyState } from "./EmptyState";
import { GitChangesBar } from "./GitChangesBar";
import { Icon } from "./Icon";
import { AssistantRunItem, MessageItem, NoticeItem } from "./MessageItem";
import { PermissionInline } from "./PermissionCard";
import { QuestionInline } from "./QuestionCard";
import { RunStatusBar } from "./RunStatusBar";

export function ChatView({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("chat");
  const session = useStore((s) => s.sessions[sessionId]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** 用户是否停留在底部附近（上滑回看历史时暂停吸底——评审 P2-1） */
  const nearBottomRef = useRef(true);
  /** 离开底部时露出悬浮「回到最新」按钮（模型输出中尤其实用） */
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  /** 平滑回底期间忽略滚动反馈（到点后用截止时间兑底，避免动画被打断后永久卡住） */
  const jumpGuardUntilRef = useRef(0);
  const msgCount = session?.messages.length ?? 0;
  const lastLen = lastMessageLength(session?.messages);

  /** 按当前滚动位置同步「是否离开底部」；guard 窗口内只吸收动画自身的反馈 */
  const syncScrollState = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottomRef.current = distance < 80;
    if (Date.now() < jumpGuardUntilRef.current) {
      // 动画自身触发的滚动不参与判定：旧距离会让按钮又亮一下
      if (distance < 8) jumpGuardUntilRef.current = 0;
      else return;
    }
    setAwayFromBottom(distance >= 80);
  };

  const jumpToLatest = () => {
    nearBottomRef.current = true;
    // 用户中途滚轮/触控板打断动画时，截止时间一过就恢复正常判定，不会永久不再出按钮；
    // 到点再主动量一次：被打断后若用户不再滚动，不会再有 scroll 事件把按钮唤醒
    jumpGuardUntilRef.current = Date.now() + 800;
    setAwayFromBottom(false);
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    window.setTimeout(syncScrollState, 820);
  };

  // 内容增长（新消息/流式 delta）时吸底——仅当用户本来就停在底部附近
  // biome-ignore lint/correctness/useExhaustiveDependencies: msgCount/lastLen 仅作内容变化信号驱动吸底，effect 体内不直接使用
  useEffect(() => {
    if (nearBottomRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [msgCount, lastLen]);

  // 切换会话时复位吸底状态并滚到底
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在 sessionId 变化时复位
  useEffect(() => {
    nearBottomRef.current = true;
    setAwayFromBottom(false);
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [sessionId]);

  // 内容高度后涨（异步高亮/图片/流式渲染）时继续吸底：只有用户本来就停在底部才跟随，
  // 划上去回看历史时不受影响。
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (nearBottomRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!session) return null;
  const isEmpty = session.messages.length === 0;
  const items = groupMessagesForRender(session.messages);

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        {/* overflow-x-hidden：兜底拦住任何横向溢出（长串无断行文本等），
            页面级横滚条会破坏布局并出现在输入框上方 */}
        <div ref={scrollRef} onScroll={syncScrollState} className="h-full overflow-y-auto overflow-x-hidden">
          <div
            ref={contentRef}
            className={`mx-auto max-w-3xl px-6 py-6 ${isEmpty ? "relative flex min-h-full flex-col justify-center" : ""}`}
          >
            {isEmpty && <SessionEmptyState meta={session.meta} />}
            {items.map((item, idx) =>
              item.kind === "user" ? (
                <MessageItem key={item.key} message={item.message} />
              ) : item.kind === "notice" ? (
                <NoticeItem key={item.key} message={item.message} sessionId={sessionId} />
              ) : (
                <AssistantRunItem
                  key={item.key}
                  messages={item.messages}
                  active={session.running && idx === items.length - 1}
                  startedAt={session.running && idx === items.length - 1 ? session.runStartedAt : undefined}
                />
              ),
            )}
            <div ref={bottomRef} />
          </div>
        </div>
        {/* 划上去后悬浮在消息区右下方：与正文同宽对齐，不挡住输入框 */}
        {awayFromBottom && !isEmpty && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4">
            <div className="mx-auto flex max-w-3xl justify-end px-6">
              <button
                type="button"
                data-testid="chat-jump-bottom"
                onClick={jumpToLatest}
                title={t("run.jumpToLatest")}
                aria-label={t("run.jumpToLatest")}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border bg-bg-elevated/95 text-text-secondary shadow-[0_6px_20px_rgba(0,0,0,0.16)] backdrop-blur transition-colors hover:border-border-strong hover:bg-bg-hover hover:text-text-primary"
              >
                <Icon name="arrowDown" size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
      {/* 当前会话的待批权限/待答提问：均内嵌在输入框上方，不全局弹窗 */}
      <PermissionInline sessionId={sessionId} />
      <QuestionInline sessionId={sessionId} />
      {/* 会话改动条（R3-F2）：git 仓库里跑过的会话，改动可见/可还原 */}
      <GitChangesBar sessionId={sessionId} />
      {/* 运行状态条：常驻输入框正上方，不随消息流滚动（模型当前动作/等待态/耗时） */}
      <RunStatusBar sessionId={sessionId} onJumpToBottom={jumpToLatest} />
      <Composer sessionId={sessionId} />
    </div>
  );
}

function lastMessageLength(messages: ChatMessage[] | undefined): number {
  if (!messages || messages.length === 0) return 0;
  const last = messages[messages.length - 1];
  if (!last) return 0;
  // 段长度近似：文本/思考按字符数，工具段按调用数+输出长度（驱动自动滚动）
  return last.segments.reduce((n, s) => {
    if (s.kind === "tools") return n + s.calls.reduce((m, c) => m + c.output.length + 20, 0);
    return n + s.text.length;
  }, 0);
}
