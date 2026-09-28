import { useMemo } from "react";
import { formatRelative } from "../format";
import { useStore, type RegistrySession } from "../store";
import { Icon } from "./Icon";

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const registrySessions = useStore((s) => s.registrySessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const setActive = useStore((s) => s.setActive);
  const createSession = useStore((s) => s.createSession);
  const openSession = useStore((s) => s.openSession);
  const deleteSession = useStore((s) => s.deleteSession);

  /** 空间 = 按 cwd 分组的项目会话 */
  const spaces = useMemo(() => {
    const map = new Map<string, RegistrySession[]>();
    for (const r of registrySessions) {
      if (r.mode !== "project" || !r.cwd) continue;
      const list = map.get(r.cwd) ?? [];
      list.push(r);
      map.set(r.cwd, list);
    }
    return [...map.entries()]
      .map(([cwd, list]) => ({
        cwd,
        name: cwd.split("/").pop() ?? cwd,
        sessions: list.sort((a, b) => b.updatedAt - a.updatedAt),
      }))
      .sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0));
  }, [registrySessions]);

  /** 聊天会话按更新时间倒序 */
  const chats = useMemo(
    () =>
      registrySessions
        .filter((r) => r.mode === "chat")
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 20),
    [registrySessions],
  );

  const openRegistry = (r: RegistrySession) => {
    if (sessions[r.id]) setActive(r.id);
    else void openSession(r);
  };

  const newProjectInSpace = async (cwd: string) => {
    await createSession("project", cwd);
  };

  return (
    <aside className="flex w-[248px] shrink-0 flex-col bg-bg-sidebar">
      {/* 顶部：首页 / 搜索 / 历史（标题栏拖拽区） */}
      <div className="titlebar-drag flex h-12 items-center gap-1 px-3 pl-20">
        <button
          onClick={() => setActive("")}
          className="titlebar-no-drag flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-text-primary hover:bg-bg-hover"
        >
          <Icon name="home" size={16} />
          首页
        </button>
        <div className="flex-1" />
        <button className="titlebar-no-drag rounded-md p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary" title="搜索（即将上线）">
          <Icon name="search" size={16} />
        </button>
        <button className="titlebar-no-drag rounded-md p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary" title="历史">
          <Icon name="clock" size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {/* 空间 */}
        <SectionLabel>空间</SectionLabel>
        {spaces.length === 0 && <EmptyHint text="还没有项目空间" />}
        {spaces.map((sp) => {
          const latest = sp.sessions[0];
          const isActiveSpace = latest ? activeSessionId === latest.id : false;
          return (
            <div key={sp.cwd}>
              <div
                className={`group flex h-9 cursor-pointer items-center gap-2 rounded-lg px-2 ${
                  isActiveSpace ? "bg-bg-active" : "hover:bg-bg-hover"
                }`}
                onClick={() => latest && openRegistry(latest)}
                title={sp.cwd}
              >
                <Icon name="folder" size={15} className="shrink-0 text-text-tertiary" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">{sp.name}</span>
                <span className="shrink-0 text-[11px] text-text-tertiary">{sp.sessions.length} 个会话</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void newProjectInSpace(sp.cwd);
                  }}
                  title="在该空间新建会话"
                  className="hidden shrink-0 rounded p-0.5 text-text-tertiary hover:text-accent group-hover:block"
                >
                  <Icon name="plus" size={13} />
                </button>
              </div>
            </div>
          );
        })}

        {/* 聊天 */}
        <div className="mt-4">
          <SectionLabel>聊天</SectionLabel>
          {chats.length === 0 && <EmptyHint text="还没有聊天" />}
          {chats.map((r) => {
            const active = activeSessionId === r.id;
            const running = sessions[r.id]?.running ?? false;
            return (
              <div
                key={r.id}
                className={`group flex h-9 cursor-pointer items-center gap-2 rounded-lg px-2 ${
                  active ? "bg-accent-soft" : "hover:bg-bg-hover"
                }`}
                onClick={() => openRegistry(r)}
              >
                {active ? (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                ) : (
                  <Icon name="chat" size={14} className="shrink-0 text-text-tertiary" />
                )}
                <span
                  className={`min-w-0 flex-1 truncate text-[13px] ${
                    active ? "text-accent" : "text-text-secondary"
                  }`}
                >
                  {r.title}
                </span>
                {running && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
                <span className="shrink-0 text-[11px] text-text-tertiary group-hover:hidden">
                  {formatRelative(r.updatedAt)}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteSession(r.id);
                  }}
                  title="删除会话"
                  className="hidden shrink-0 text-text-tertiary hover:text-danger group-hover:block"
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* 底部：新对话 + 设置 */}
      <div className="flex items-center gap-1 border-t border-border px-2 py-2">
        <button
          onClick={() => void createSession("chat")}
          className="flex flex-1 items-center gap-2 rounded-lg px-2 py-2 text-[13px] text-text-primary hover:bg-bg-hover"
        >
          <Icon name="plus" size={16} className="text-text-secondary" />
          新对话
        </button>
        <button
          onClick={() => {
            void (async () => {
              const dir = await window.spcode.pickDirectory();
              if (dir) await createSession("project", dir);
            })();
          }}
          title="打开项目文件夹"
          className="rounded-lg p-2 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
        >
          <Icon name="folder" size={16} />
        </button>
        <button
          onClick={onOpenSettings}
          title="设置"
          className="rounded-lg p-2 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
        >
          <Icon name="gear" size={16} />
        </button>
      </div>
    </aside>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pb-1 pt-3 text-[11px] font-medium text-text-tertiary">{children}</div>;
}

function EmptyHint({ text }: { text: string }) {
  return <div className="px-2 py-2 text-[12px] text-text-tertiary">{text}</div>;
}
