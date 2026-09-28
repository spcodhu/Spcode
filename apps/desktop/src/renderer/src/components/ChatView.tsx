import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { MessageItem } from "./MessageItem";
import { Composer } from "./Composer";

export function ChatView({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const msgCount = session?.messages.length ?? 0;
  const lastLen = lastMessageLength(session?.messages);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [msgCount, lastLen]);

  if (!session) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6">
          {session.messages.length === 0 && (
            <div className="py-16 text-center text-sm text-text-tertiary">
              {session.meta.mode === "project" ? (
                <>
                  项目目录：<code className="text-text-secondary">{session.meta.cwd}</code>
                  <br />
                  <span className="mt-2 inline-block">直接说你要做什么，比如「读懂这个项目，告诉我它是干什么的」</span>
                </>
              ) : (
                "开始对话吧"
              )}
            </div>
          )}
          {session.messages.map((m) => (
            <MessageItem key={m.id} message={m} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
      <Composer sessionId={sessionId} />
    </div>
  );
}

function lastMessageLength(messages: { text: string; thinking: string }[] | undefined): number {
  if (!messages || messages.length === 0) return 0;
  const last = messages[messages.length - 1];
  return last ? last.text.length + last.thinking.length : 0;
}
