import { useStore } from "../store";

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const sessionOrder = useStore((s) => s.sessionOrder);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const setActive = useStore((s) => s.setActive);
  const createSession = useStore((s) => s.createSession);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-bg-sidebar">
      {/* 标题栏拖拽区 */}
      <div className="titlebar-drag flex h-12 items-center justify-end px-3">
        <span className="text-sm font-semibold tracking-wide text-text-secondary">Spcode</span>
      </div>

      <div className="flex gap-2 px-3 pb-3">
        <button
          onClick={() => void createSession("chat")}
          className="flex-1 rounded-md border border-border bg-bg-elevated px-2 py-1.5 text-xs hover:bg-bg-hover"
        >
          + 聊天
        </button>
        <button
          onClick={() => {
            void (async () => {
              const dir = await window.spcode.pickDirectory();
              if (dir) await createSession("project", dir);
            })();
          }}
          className="flex-1 rounded-md border border-accent/40 bg-accent-soft px-2 py-1.5 text-xs text-accent hover:bg-accent/20"
        >
          + 项目
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {sessionOrder.length === 0 && (
          <div className="px-2 py-8 text-center text-xs text-text-tertiary">
            还没有会话
            <br />
            从上方新建聊天或项目
          </div>
        )}
        {sessionOrder.map((id) => {
          const session = sessions[id];
          if (!session) return null;
          const active = id === activeSessionId;
          return (
            <button
              key={id}
              onClick={() => setActive(id)}
              className={`mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                active ? "bg-bg-active text-text-primary" : "text-text-secondary hover:bg-bg-hover"
              }`}
            >
              <span className="shrink-0">{session.meta.mode === "chat" ? "💬" : "📁"}</span>
              <span className="min-w-0 flex-1 truncate">{session.meta.title}</span>
              {session.running && (
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
              )}
            </button>
          );
        })}
      </div>

      <div className="border-t border-border p-2">
        <button
          onClick={onOpenSettings}
          className="w-full rounded-md px-2.5 py-2 text-left text-sm text-text-secondary hover:bg-bg-hover"
        >
          ⚙️ 设置
        </button>
      </div>
    </aside>
  );
}
