import { useEffect, useRef } from "react";
import { useStore, groupMessagesForRender, type ChatMessage } from "../store";
import { AssistantRunItem, MessageItem } from "./MessageItem";
import { Composer } from "./Composer";
import { QuestionInline } from "./QuestionCard";
import { SessionEmptyState } from "./EmptyState";
import { WorkDrawer } from "./WorkDrawer";

export function ChatView({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const msgCount = session?.messages.length ?? 0;
  const lastLen = lastMessageLength(session?.messages);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [msgCount, lastLen]);

  if (!session) return null;
  const isEmpty = session.messages.length === 0;
  const items = groupMessagesForRender(session.messages);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={`mx-auto max-w-3xl px-6 py-6 ${
            isEmpty ? "relative flex min-h-full flex-col justify-center" : ""
          }`}
        >
          {isEmpty && <SessionEmptyState meta={session.meta} />}
          {items.map((item, idx) =>
            item.kind === "user" ? (
              <MessageItem key={item.key} message={item.message} />
            ) : (
              <AssistantRunItem
                key={item.key}
                messages={item.messages}
                active={session.running && idx === items.length - 1}
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


