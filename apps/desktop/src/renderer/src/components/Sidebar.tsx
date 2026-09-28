import { useStore, type RegistrySession } from "../store";

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const sessionOrder = useStore((s) => s.sessionOrder);
  const registrySessions = useStore((s) => s.registrySessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const setActive = useStore((s) => s.setActive);
  const createSession = useStore((s) => s.createSession);
  const openSession = useStore((s) => s.openSession);
  const deleteSession = useStore((s) => s.deleteSession);

  // 已激活的排在前面（带运行状态），未激活的来自注册表
  const activeIds = new Set(sessionOrder);
  const closedSessions = registrySessions.filter((r) => !activeIds.has(r.id));

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
        {sessionOrder.length === 0 && closedSessions.length === 0 && (
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
            <SessionRow
              key={id}
              title={session.meta.title}
              mode={session.meta.mode}
              active={active}
              running={session.running}
              onClick={() => setActive(id)}
              onDelete={() => void deleteSession(id)}
            />
          );
        })}

        {closedSessions.map((r: RegistrySession) => (
          <SessionRow
            key={r.id}
            title={r.title}
            mode={r.mode}
            active={false}
            running={false}
            dimmed
            onClick={() => void openSession(r)}
            onDelete={() => void deleteSession(r.id)}
          />
        ))}
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

function SessionRow({
  title,
  mode,
  active,
  running,
  dimmed,
  onClick,
  onDelete,
}: {
  title: string;
  mode: "chat" | "project";
  active: boolean;
  running: boolean;
  dimmed?: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`group mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
        active
          ? "bg-bg-active text-text-primary"
          : dimmed
            ? "text-text-tertiary hover:bg-bg-hover"
            : "text-text-secondary hover:bg-bg-hover"
      }`}
    >
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0">{mode === "chat" ? "💬" : "📁"}</span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {running && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="删除会话"
        className="hidden shrink-0 text-text-tertiary hover:text-danger group-hover:block"
      >
        ✕
      </button>
    </div>
  );
}
