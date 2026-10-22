import { useEffect, useRef } from "react";
import { type ChatMessage, groupMessagesForRender, useStore } from "../store";
import { Composer } from "./Composer";
import { SessionEmptyState } from "./EmptyState";
import { GitChangesBar } from "./GitChangesBar";
import { AssistantRunItem, MessageItem, NoticeItem } from "./MessageItem";
import { QuestionInline } from "./QuestionCard";
import { RunStatusBar } from "./RunStatusBar";
import { WorkDrawer } from "./WorkDrawer";

export function ChatView({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 用户是否停留在底部附近（上滑回看历史时暂停吸底——评审 P2-1） */
  const nearBottomRef = useRef(true);
  const msgCount = session?.messages.length ?? 0;
  const lastLen = lastMessageLength(session?.messages);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
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
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [sessionId]);

  if (!session) return null;
  const isEmpty = session.messages.length === 0;
  const items = groupMessagesForRender(session.messages);

  return (
    <div className="flex h-full flex-col">
      {/* overflow-x-hidden：兜底拦住任何横向溢出（长串无断行文本等），
          页面级横滚条会破坏布局并出现在输入框上方 */}
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div
          className={`mx-auto max-w-3xl px-6 py-6 ${isEmpty ? "relative flex min-h-full flex-col justify-center" : ""}`}
        >
          {isEmpty && <SessionEmptyState meta={session.meta} />}
          {items.map((item, idx) =>
            item.kind === "user" ? (
              <MessageItem key={item.key} message={item.message} />
            ) : item.kind === "notice" ? (
              <NoticeItem key={item.key} message={item.message} />
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
      {/* 工作抽屉：悬浮在输入框上方，不随内容滚动（进行中展开、完成后收起） */}
      {(session.todos.length > 0 || session.planMode) && (
        <div className="shrink-0 px-6 pb-2">
          <div className="mx-auto max-w-3xl">
            <WorkDrawer todos={session.todos} planMode={session.planMode} />
          </div>
        </div>
      )}
      {/* 当前会话的待回答提问：内嵌在输入框上方，不全局弹窗 */}
      <QuestionInline sessionId={sessionId} />
      {/* 会话改动条（R3-F2）：git 仓库里跑过的会话，改动可见/可还原 */}
      <GitChangesBar sessionId={sessionId} />
      {/* 运行状态条：常驻输入框正上方，不随消息流滚动（模型当前动作/等待态/耗时） */}
      <RunStatusBar
        sessionId={sessionId}
        onJumpToBottom={() => bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" })}
      />
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
