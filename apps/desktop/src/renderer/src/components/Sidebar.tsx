import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatRelative } from "../format";
import { useStore, type RegistrySession } from "../store";
import { baseName } from "@spcode/shared";
import { Icon } from "./Icon";

/** 空间内默认展示的会话数，超出部分折叠进「更多」 */
const SPACE_SESSION_LIMIT = 5;

/** 侧栏折叠状态持久化到 localStorage（重启后保持） */
function usePersistentState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`spcode.sidebar.${key}`);
      return raw ? { ...initial, ...JSON.parse(raw) } : initial;
    } catch {
      return initial;
    }
  });
  const update = (v: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
      try {
        localStorage.setItem(`spcode.sidebar.${key}`, JSON.stringify(next));
      } catch {
        /* 存储不可用时静默降级为内存态 */
      }
      return next;
    });
  };
  return [value, update];
}

export function Sidebar({
  onOpenSettings,
  onOpenSearch,
  onOpenSchedule,
}: {
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  onOpenSchedule: () => void;
}) {
  const sessions = useStore((s) => s.sessions);
  const registrySessions = useStore((s) => s.registrySessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const setActive = useStore((s) => s.setActive);
  const createSession = useStore((s) => s.createSession);
  const openSession = useStore((s) => s.openSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const pendingQuestions = useStore((s) => s.pendingQuestions);

  /** 有待回答提问的会话集合（侧栏「?」标记用） */
  const waitingSessionIds = useMemo(
    () => new Set(pendingQuestions.map((q) => q.sessionId)),
    [pendingQuestions],
  );

  /** 分区折叠状态（空间 / 聊天） */
  const [sectionCollapsed, setSectionCollapsed] = usePersistentState("sections", {
    spaces: false,
    chats: false,
  });
  /** 各空间的折叠状态（key = cwd，默认展开） */
  const [spaceCollapsed, setSpaceCollapsed] = usePersistentState<Record<string, boolean>>("spaces", {});
  /** 「更多」展开态：默认只展示前 SPACE_SESSION_LIMIT 个会话（不持久化） */
  const [spaceShowAll, setSpaceShowAll] = useState<Record<string, boolean>>({});

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
        name: baseName(cwd),
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

  /** 移除空间：删除该空间下全部会话（菜单里有二次确认） */
  const removeSpace = async (sp: { sessions: RegistrySession[] }) => {
    for (const r of sp.sessions) await deleteSession(r.id);
  };

  const clearAllChats = async () => {
    for (const r of chats) await deleteSession(r.id);
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
        <button
          onClick={onOpenSearch}
          className="titlebar-no-drag rounded-md p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
          title="搜索会话（Cmd+K）"
        >
          <Icon name="search" size={16} />
        </button>
        <button
          onClick={onOpenSchedule}
          className="titlebar-no-drag rounded-md p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
          title="定时任务"
        >
          <Icon name="clock" size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {/* 空间 */}
        <SectionHeader
          label="空间"
          collapsed={sectionCollapsed.spaces}
          onToggle={() => setSectionCollapsed((s) => ({ ...s, spaces: !s.spaces }))}
          menu={
            <SectionMenu
              title="空间操作"
              items={[
                {
                  key: "folder",
                  icon: "folder",
                  label: "选择文件夹开始…",
                  onClick: () => {
                    void (async () => {
                      const dir = await window.spcode.pickDirectory();
                      if (dir) await createSession("project", dir);
                    })();
                  },
                },
                { key: "chat", icon: "chat", label: "创建聊天频道", onClick: () => void createSession("chat") },
              ]}
            />
          }
        />
        {!sectionCollapsed.spaces && (
          <>
            {spaces.length === 0 && <EmptyHint text="还没有项目空间" />}
            {spaces.map((sp) => {
              const expanded = !spaceCollapsed[sp.cwd];
              const containsActive = sp.sessions.some((r) => r.id === activeSessionId);
              const showAll = !!spaceShowAll[sp.cwd];
              const visible = showAll ? sp.sessions : sp.sessions.slice(0, SPACE_SESSION_LIMIT);
              const hidden = sp.sessions.length - visible.length;
              return (
                <div key={sp.cwd} className="mb-0.5">
                  {/* 空间行：点击展开/收起会话列表 */}
                  <div
                    className={`group flex h-9 cursor-pointer items-center gap-1.5 rounded-lg px-2 transition-colors ${
                      containsActive ? "bg-bg-active" : "hover:bg-bg-hover"
                    }`}
                    onClick={() => setSpaceCollapsed((m) => ({ ...m, [sp.cwd]: expanded }))}
                    title={sp.cwd}
                  >
                    <Icon
                      name="chevronDown"
                      size={11}
                      className={`shrink-0 text-text-tertiary transition-transform duration-200 ${
                        expanded ? "" : "-rotate-90"
                      }`}
                    />
                    <Icon name="folder" size={15} className="shrink-0 text-text-tertiary" />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">{sp.name}</span>
                    {!expanded && (
                      <span className="shrink-0 text-[11px] text-text-tertiary group-hover:hidden">
                        {sp.sessions.length} 个会话
                      </span>
                    )}
                    {/* hover 出现的操作：… 更多菜单 + 新建会话（Finch 同款） */}
                    <div
                      className="hidden shrink-0 items-center gap-0.5 group-hover:flex"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <SectionMenu
                        title="空间菜单"
                        items={[
                          { key: "new", icon: "plus", label: "新对话", onClick: () => void newProjectInSpace(sp.cwd) },
                          {
                            key: "reveal",
                            icon: "folder",
                            label: "在 Finder 中显示",
                            onClick: () => void window.spcode.revealPath(sp.cwd),
                          },
                          {
                            key: "remove",
                            icon: "x",
                            label: "移除空间全部会话",
                            danger: true,
                            confirm: true,
                            onClick: () => void removeSpace(sp),
                          },
                        ]}
                      />
                      <button
                        onClick={() => void newProjectInSpace(sp.cwd)}
                        title="在该空间新建会话"
                        className="rounded p-0.5 text-text-tertiary hover:text-accent"
                      >
                        <Icon name="plus" size={13} />
                      </button>
                    </div>
                  </div>
                  {/* 空间下的会话列表（mt-0.5 与空间行高亮之间留一道细缝） */}
                  {expanded && (
                    <div className="mt-0.5 pb-1">
                      {visible.map((r) => (
                        <SessionRow
                          key={r.id}
                          r={r}
                          nested
                          active={activeSessionId === r.id}
                          running={sessions[r.id]?.running ?? false}
                          waiting={waitingSessionIds.has(r.id)}
                          menuItems={[
                            {
                              key: "reveal",
                              icon: "folder",
                              label: "在 Finder 中显示",
                              onClick: () => void window.spcode.revealPath(sp.cwd),
                            },
                            {
                              key: "del",
                              icon: "x",
                              label: "删除会话",
                              danger: true,
                              confirm: true,
                              onClick: () => void deleteSession(r.id),
                            },
                          ]}
                          onOpen={() => openRegistry(r)}
                          onDelete={() => void deleteSession(r.id)}
                        />
                      ))}
                      {hidden > 0 && (
                        <button
                          onClick={() => setSpaceShowAll((m) => ({ ...m, [sp.cwd]: true }))}
                          className="flex h-8 w-full items-center gap-2 rounded-lg pl-8 pr-2 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
                        >
                          <Icon name="dots" size={12} />
                          更多（还有 {hidden} 个会话）
                        </button>
                      )}
                      {showAll && sp.sessions.length > SPACE_SESSION_LIMIT && (
                        <button
                          onClick={() => setSpaceShowAll((m) => ({ ...m, [sp.cwd]: false }))}
                          className="flex h-8 w-full items-center gap-2 rounded-lg pl-8 pr-2 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
                        >
                          <Icon name="chevronDown" size={12} className="rotate-180" />
                          收起
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* 聊天 */}
        <div className="mt-4">
          <SectionHeader
            label="聊天"
            collapsed={sectionCollapsed.chats}
            onToggle={() => setSectionCollapsed((s) => ({ ...s, chats: !s.chats }))}
            menu={
              <SectionMenu
                title="聊天操作"
                items={[
                  { key: "new", icon: "plus", label: "新建聊天", onClick: () => void createSession("chat") },
                  { key: "clear", icon: "x", label: "清空聊天列表", danger: true, confirm: true, onClick: () => void clearAllChats() },
                ]}
              />
            }
          />
          {!sectionCollapsed.chats && (
            <>
              {chats.length === 0 && <EmptyHint text="还没有聊天" />}
              {chats.map((r) => (
                <SessionRow
                  key={r.id}
                  r={r}
                  active={activeSessionId === r.id}
                  running={sessions[r.id]?.running ?? false}
                  waiting={waitingSessionIds.has(r.id)}
                  menuItems={[
                    {
                      key: "del",
                      icon: "x",
                      label: "删除会话",
                      danger: true,
                      confirm: true,
                      onClick: () => void deleteSession(r.id),
                    },
                  ]}
                  onOpen={() => openRegistry(r)}
                  onDelete={() => void deleteSession(r.id)}
                />
              ))}
            </>
          )}
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

function EmptyHint({ text }: { text: string }) {
  return <div className="px-2 py-2 text-[12px] text-text-tertiary">{text}</div>;
}

/** 分区标题（空间/聊天共用）：整行可点击折叠/展开，箭头随状态旋转，hover 有反馈 */
function SectionHeader({
  label,
  collapsed,
  onToggle,
  menu,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  menu?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-2 pb-1 pt-3">
      <button
        onClick={onToggle}
        title={collapsed ? `展开${label}` : `收起${label}`}
        className={`-ml-1 flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors ${
          collapsed ? "text-text-tertiary" : "text-text-secondary"
        } hover:bg-bg-hover hover:text-text-primary`}
      >
        <Icon
          name="chevronDown"
          size={11}
          className={`transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
        />
        {label}
      </button>
      {menu}
    </div>
  );
}

/** 会话行（空间内嵌套 / 聊天列表共用）：bullet + 标题 + 状态标记 + 相对时间，hover 出现删除 */
function SessionRow({
  r,
  active,
  running,
  waiting,
  nested,
  menuItems,
  onOpen,
  onDelete,
}: {
  r: RegistrySession;
  active: boolean;
  running: boolean;
  /** Agent 在该会话有等待回答的提问 */
  waiting: boolean;
  /** 嵌套在空间下的紧凑行 */
  nested?: boolean;
  /** hover 时「…」菜单项（删除之外的操作，如在 Finder 中显示） */
  menuItems?: SectionMenuItem[];
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`group flex cursor-pointer items-center gap-2 rounded-lg transition-colors ${
        nested ? "h-8 pl-8 pr-2" : "h-9 px-2"
      } ${active ? "bg-accent-soft" : "hover:bg-bg-hover"}`}
      onClick={onOpen}
      title={r.title}
    >
      <span
        className={`shrink-0 rounded-full ${active ? "h-1.5 w-1.5 bg-accent" : "h-1 w-1 bg-text-tertiary/70"}`}
      />
      <span className={`min-w-0 flex-1 truncate text-[13px] ${active ? "text-accent" : "text-text-secondary"}`}>
        {r.title}
      </span>
      {waiting && (
        <span
          title="Agent 在等你回答"
          className="flex h-4 w-4 shrink-0 animate-pulse items-center justify-center rounded-full bg-accent-soft text-[10px] font-semibold text-accent"
        >
          ?
        </span>
      )}
      {running && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
      <span className="shrink-0 text-[11px] text-text-tertiary group-hover:hidden">{formatRelative(r.updatedAt)}</span>
      {menuItems && menuItems.length > 0 && (
        <span className="hidden shrink-0 group-hover:block" onClick={(e) => e.stopPropagation()}>
          <SectionMenu title="会话操作" items={menuItems} />
        </span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="删除会话"
        className="hidden shrink-0 text-text-tertiary hover:text-danger group-hover:block"
      >
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}

/** 分区标题右侧的 "…" 浮动菜单项 */
interface SectionMenuItem {
  key: string;
  label: string;
  icon?: string;
  /** 危险项（红色文案） */
  danger?: boolean;
  /** 需要二次确认：第一次点击变为「确认…?」，再点才执行 */
  confirm?: boolean;
  onClick: () => void;
}

/** 分区标题右侧的 "…" 浮动菜单（空间/聊天共用）。
 *  用 fixed 定位展开，避免被侧栏滚动容器裁切 */
function SectionMenu({ title, items }: { title: string; items: SectionMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.min(r.left, window.innerWidth - 220), y: r.bottom + 4 });
    setConfirmKey(null);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => (open ? setOpen(false) : openMenu())}
        className="rounded p-0.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
        title={title}
      >
        <Icon name="dots" size={13} />
      </button>
      {open && (
        <div
          ref={menuRef}
          style={{ left: pos.x, top: pos.y }}
          className="fixed z-[80] w-52 rounded-xl border border-border bg-bg-elevated p-1.5 shadow-2xl"
        >
          {items.map((item) => {
            const confirming = confirmKey === item.key;
            return (
              <button
                key={item.key}
                onClick={() => {
                  if (item.confirm && !confirming) {
                    setConfirmKey(item.key);
                    return;
                  }
                  setOpen(false);
                  setConfirmKey(null);
                  item.onClick();
                }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-bg-hover ${
                  item.danger || confirming ? "text-danger" : "text-text-primary"
                }`}
              >
                {item.icon && <Icon name={item.icon} size={14} className="shrink-0 text-text-tertiary" />}
                {confirming ? `确认${item.label}？` : item.label}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
