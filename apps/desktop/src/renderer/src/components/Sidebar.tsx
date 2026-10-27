import { baseName } from "@spcode/shared";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatRelative } from "../format";
import { type RegistrySession, useStore } from "../store";
import { Icon } from "./Icon";
import { UpdateButton } from "./UpdateButton";

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
  const { t } = useTranslation("chat");
  const sessions = useStore((s) => s.sessions);
  const registrySessions = useStore((s) => s.registrySessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const setActive = useStore((s) => s.setActive);
  const createSession = useStore((s) => s.createSession);
  const openSession = useStore((s) => s.openSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const setForkDialogFor = useStore((s) => s.setForkDialogFor);
  const exportSessionContext = useStore((s) => s.exportSessionContext);
  const pendingQuestions = useStore((s) => s.pendingQuestions);
  const pendingPermissions = useStore((s) => s.pendingPermissions);

  /** 有待回答提问 / 待批准权限的会话集合（侧栏状态标记用） */
  const waitingSessionIds = useMemo(() => new Set(pendingQuestions.map((q) => q.sessionId)), [pendingQuestions]);
  const permissionWaitingSessionIds = useMemo(
    () => new Set(pendingPermissions.map((p) => p.sessionId)),
    [pendingPermissions],
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

  /** 分叉会话的 tooltip 溯源标注：「分叉自《源标题》」（源已删则如实标注） */
  const forkOriginTitle = (r: RegistrySession): string | undefined => {
    if (!r.forkedFrom) return undefined;
    return registrySessions.find((x) => x.id === r.forkedFrom)?.title ?? t("sidebar.deletedSession");
  };

  /** Fork 菜单项（空间会话与聊天会话共用）：源会话运行中或未落盘时禁用 */
  const forkMenuItem = (r: RegistrySession): SectionMenuItem => {
    const running = sessions[r.id]?.running ?? false;
    const disabled = running || !r.sessionFile;
    return {
      key: "fork",
      icon: "branch",
      label: t("sidebar.forkSession"),
      disabled,
      disabledHint: t(running ? "sidebar.forkRunning" : "sidebar.forkEmpty"),
      onClick: () => setForkDialogFor(r.id),
    };
  };

  /** 导出会话上下文菜单项（共用）：未落盘时禁用；导出+复制提示词一步到位 */
  const exportMenuItem = (r: RegistrySession): SectionMenuItem => ({
    key: "export",
    icon: "copy",
    label: t("sidebar.exportContext"),
    disabled: !r.sessionFile,
    disabledHint: t("sidebar.exportEmpty"),
    onClick: () => void exportSessionContext(r.id),
  });

  const newProjectInSpace = async (cwd: string) => {
    await createSession("project", cwd);
  };

  /** 移除空间：删除该空间下全部会话（菜单里有二次确认） */
  const removeSpace = async (sp: { sessions: RegistrySession[] }) => {
    for (const r of sp.sessions) await deleteSession(r.id);
  };

  /** 清空聊天列表：遍历全量注册表（评审 R3-C11：chats 展示只截取前 20 条，不能按它删） */
  const clearAllChats = async () => {
    for (const r of registrySessions.filter((x) => x.mode === "chat")) await deleteSession(r.id);
  };

  return (
    <aside className="flex w-[248px] shrink-0 flex-col bg-bg-sidebar">
      {/* 顶部：首页 / 搜索 / 历史（标题栏拖拽区） */}
      <div className="titlebar-drag flex h-12 items-center gap-1 px-3 pl-20">
        <button
          type="button"
          onClick={() => setActive("")}
          className="titlebar-no-drag flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-text-primary hover:bg-bg-hover"
        >
          <Icon name="home" size={16} />
          {t("sidebar.home")}
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onOpenSearch}
          className="titlebar-no-drag rounded-md p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
          title={t("sidebar.search")}
          aria-label={t("sidebar.search")}
          data-testid="sidebar-search"
        >
          <Icon name="search" size={16} />
        </button>
        <button
          type="button"
          onClick={onOpenSchedule}
          className="titlebar-no-drag rounded-md p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
          title={t("sidebar.schedule")}
          aria-label={t("sidebar.schedule")}
          data-testid="sidebar-schedule"
        >
          <Icon name="clock" size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {/* 空间 */}
        <SectionHeader
          label={t("sidebar.spaces")}
          collapsed={sectionCollapsed.spaces}
          onToggle={() => setSectionCollapsed((s) => ({ ...s, spaces: !s.spaces }))}
          menu={
            <SectionMenu
              title={t("sidebar.spaceActions")}
              items={[
                {
                  key: "folder",
                  icon: "folder",
                  label: t("sidebar.pickFolder"),
                  onClick: () => {
                    void (async () => {
                      const dir = await window.spcode.pickDirectory();
                      if (dir) await createSession("project", dir);
                    })();
                  },
                },
                {
                  key: "chat",
                  icon: "chat",
                  label: t("sidebar.createChat"),
                  onClick: () => void createSession("chat"),
                },
              ]}
            />
          }
        />
        {!sectionCollapsed.spaces && (
          <>
            {spaces.length === 0 && <EmptyHint text={t("sidebar.emptySpaces")} />}
            {spaces.map((sp) => {
              const expanded = !spaceCollapsed[sp.cwd];
              const containsActive = sp.sessions.some((r) => r.id === activeSessionId);
              const showAll = !!spaceShowAll[sp.cwd];
              const visible = showAll ? sp.sessions : sp.sessions.slice(0, SPACE_SESSION_LIMIT);
              const hidden = sp.sessions.length - visible.length;
              return (
                <div key={sp.cwd} className="mb-0.5">
                  {/* 空间行：点击展开/收起会话列表；行内含嵌套按钮故不能用原生 button，role+键盘事件补齐可访问性 */}
                  {/* biome-ignore lint/a11y/useSemanticElements: 行内含嵌套按钮（菜单/新建），原生 button 不能嵌套交互元素 */}
                  <div
                    className={`group flex h-9 cursor-pointer items-center gap-1.5 rounded-lg px-2 transition-colors ${
                      containsActive ? "bg-bg-hover/45" : "hover:bg-bg-hover"
                    }`}
                    onClick={() => setSpaceCollapsed((m) => ({ ...m, [sp.cwd]: expanded }))}
                    role="button"
                    tabIndex={0}
                    aria-expanded={expanded}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSpaceCollapsed((m) => ({ ...m, [sp.cwd]: expanded }));
                      }
                    }}
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
                      <span className="shrink-0 text-[11px] text-text-tertiary transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                        {t("sidebar.sessionCount", { count: sp.sessions.length })}
                      </span>
                    )}
                    {/* hover 出现的操作：… 更多菜单 + 新建会话（Finch 同款） */}
                    {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: 纯事件隔离容器，阻止冒泡到行点击，本身不是控件 */}
                    <div
                      className="pointer-events-none flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <SectionMenu
                        title={t("sidebar.spaceMenu")}
                        items={[
                          {
                            key: "new",
                            icon: "plus",
                            label: t("sidebar.newConversation"),
                            onClick: () => void newProjectInSpace(sp.cwd),
                          },
                          {
                            key: "reveal",
                            icon: "folder",
                            label: t("sidebar.reveal"),
                            onClick: () => void window.spcode.revealPath(sp.cwd),
                          },
                          {
                            key: "remove",
                            icon: "x",
                            label: t("sidebar.removeSpace"),
                            danger: true,
                            confirm: true,
                            onClick: () => void removeSpace(sp),
                          },
                        ]}
                      />
                      <button
                        type="button"
                        onClick={() => void newProjectInSpace(sp.cwd)}
                        title={t("sidebar.newInSpace")}
                        aria-label={t("sidebar.newInSpace")}
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
                          permissionWaiting={permissionWaitingSessionIds.has(r.id)}
                          menuItems={[
                            forkMenuItem(r),
                            exportMenuItem(r),
                            {
                              key: "reveal",
                              icon: "folder",
                              label: t("sidebar.reveal"),
                              onClick: () => void window.spcode.revealPath(sp.cwd),
                            },
                            {
                              key: "del",
                              icon: "x",
                              label: t("sidebar.deleteSession"),
                              danger: true,
                              confirm: true,
                              onClick: () => void deleteSession(r.id),
                            },
                          ]}
                          forkedFromTitle={forkOriginTitle(r)}
                          onOpen={() => openRegistry(r)}
                          onDelete={() => void deleteSession(r.id)}
                        />
                      ))}
                      {hidden > 0 && (
                        <button
                          type="button"
                          onClick={() => setSpaceShowAll((m) => ({ ...m, [sp.cwd]: true }))}
                          className="flex h-8 w-full items-center gap-2 rounded-lg pl-8 pr-2 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
                        >
                          <Icon name="dots" size={12} />
                          {t("sidebar.moreSessions", { count: hidden })}
                        </button>
                      )}
                      {showAll && sp.sessions.length > SPACE_SESSION_LIMIT && (
                        <button
                          type="button"
                          onClick={() => setSpaceShowAll((m) => ({ ...m, [sp.cwd]: false }))}
                          className="flex h-8 w-full items-center gap-2 rounded-lg pl-8 pr-2 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
                        >
                          <Icon name="chevronDown" size={12} className="rotate-180" />
                          {t("common.collapse")}
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
            label={t("sidebar.chats")}
            collapsed={sectionCollapsed.chats}
            onToggle={() => setSectionCollapsed((s) => ({ ...s, chats: !s.chats }))}
            menu={
              <SectionMenu
                title={t("sidebar.chatActions")}
                items={[
                  { key: "new", icon: "plus", label: t("home.newChat"), onClick: () => void createSession("chat") },
                  {
                    key: "clear",
                    icon: "x",
                    label: t("sidebar.clearChats"),
                    danger: true,
                    confirm: true,
                    onClick: () => void clearAllChats(),
                  },
                ]}
              />
            }
          />
          {!sectionCollapsed.chats && (
            <>
              {chats.length === 0 && <EmptyHint text={t("sidebar.emptyChats")} />}
              {chats.map((r) => (
                <SessionRow
                  key={r.id}
                  r={r}
                  active={activeSessionId === r.id}
                  running={sessions[r.id]?.running ?? false}
                  waiting={waitingSessionIds.has(r.id)}
                  permissionWaiting={permissionWaitingSessionIds.has(r.id)}
                  menuItems={[
                    forkMenuItem(r),
                    exportMenuItem(r),
                    {
                      key: "del",
                      icon: "x",
                      label: t("sidebar.deleteSession"),
                      danger: true,
                      confirm: true,
                      onClick: () => void deleteSession(r.id),
                    },
                  ]}
                  forkedFromTitle={forkOriginTitle(r)}
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
          type="button"
          onClick={() => void createSession("chat")}
          data-testid="sidebar-new-chat"
          className="flex flex-1 items-center gap-2 rounded-lg px-2 py-2 text-[13px] text-text-primary hover:bg-bg-hover"
        >
          <Icon name="plus" size={16} className="text-text-secondary" />
          {t("sidebar.newConversation")}
        </button>
        {/* 更新入口：仅在有更新动作时出现（available/downloading/downloaded/error） */}
        <UpdateButton />
        <button
          type="button"
          onClick={() => {
            void (async () => {
              const dir = await window.spcode.pickDirectory();
              if (dir) await createSession("project", dir);
            })();
          }}
          title={t("sidebar.openProject")}
          aria-label={t("sidebar.openProject")}
          data-testid="sidebar-open-project"
          className="rounded-lg p-2 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
        >
          <Icon name="folder" size={16} />
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          title={t("sidebar.settings")}
          aria-label={t("sidebar.settings")}
          data-testid="sidebar-settings"
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
  const { t } = useTranslation("chat");
  return (
    <div className="flex items-center justify-between px-2 pb-1 pt-3">
      <button
        type="button"
        onClick={onToggle}
        title={t(collapsed ? "sidebar.expandSection" : "sidebar.collapseSection", { label })}
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
export function SessionRow({
  r,
  active,
  running,
  waiting,
  permissionWaiting = false,
  nested,
  menuItems,
  forkedFromTitle,
  onOpen,
  onDelete,
}: {
  r: RegistrySession;
  active: boolean;
  running: boolean;
  /** Agent 在该会话有等待回答的提问 */
  waiting: boolean;
  /** 该会话有待批准的权限请求 */
  permissionWaiting?: boolean;
  /** 嵌套在空间下的紧凑行 */
  nested?: boolean;
  /** hover 时「…」菜单项（删除之外的操作，如在 Finder 中显示） */
  menuItems?: SectionMenuItem[];
  /** Fork 会话的溯源标注（「分叉自《xxx》」tooltip） */
  forkedFromTitle?: string;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("chat");
  return (
    // biome-ignore lint/a11y/useSemanticElements: 行内含嵌套按钮（删除/菜单），原生 button 不能嵌套交互元素；role+键盘事件补齐可访问性
    <div
      className={`group flex cursor-pointer items-center gap-2 rounded-lg transition-colors ${
        nested ? "h-8 pl-8 pr-2" : "h-9 px-2"
      } ${active ? "bg-accent-soft" : "hover:bg-bg-hover"}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-current={active ? "page" : undefined}
      title={forkedFromTitle ? t("sidebar.forkOrigin", { title: r.title, source: forkedFromTitle }) : r.title}
    >
      <span aria-hidden className="flex h-3 w-3 shrink-0 items-center justify-center">
        <span className={`rounded-full ${active ? "h-1.5 w-1.5 bg-accent" : "h-1 w-1 bg-text-tertiary/40"}`} />
      </span>
      <span className={`min-w-0 flex-1 truncate text-[13px] ${active ? "text-accent" : "text-text-secondary"}`}>
        {r.title}
      </span>
      {permissionWaiting && (
        <span
          title={t("sidebar.permissionWaiting")}
          aria-label={t("sidebar.permissionWaiting")}
          data-testid="sidebar-permission-waiting"
          className="flex h-4 w-4 shrink-0 animate-pulse items-center justify-center rounded-full bg-warning/15 text-warning"
        >
          <Icon name="shield" size={11} />
        </span>
      )}
      {waiting && (
        <span
          title={t("sidebar.waiting")}
          className="flex h-4 w-4 shrink-0 animate-pulse items-center justify-center rounded-full bg-accent-soft text-[10px] font-semibold text-accent"
        >
          ?
        </span>
      )}
      {running && (
        <span title={t("sidebar.running")} className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
      )}
      <div className="relative h-6 w-16 shrink-0">
        <span className="absolute inset-0 flex items-center justify-end text-[11px] text-text-tertiary transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
          {formatRelative(r.updatedAt)}
        </span>
        {/* 操作始终可 Tab 到达；行获得焦点即显现，且不再替换时间造成布局位移。 */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: 纯事件隔离容器，本身不是控件 */}
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          {menuItems && menuItems.length > 0 && (
            // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: 纯事件隔离容器，阻止冒泡到行点击，本身不是控件
            <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
              <SectionMenu title={t("sidebar.sessionActions")} items={menuItems} />
            </span>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              // 评审 R3-C11：行内删除与菜单删除同款二次确认（误点不可恢复）
              if (window.confirm(t("sidebar.confirmDelete", { title: r.title }))) onDelete();
            }}
            title={t("sidebar.deleteSession")}
            aria-label={t("sidebar.deleteSession")}
            data-testid="sidebar-delete-session"
            className="shrink-0 text-text-tertiary hover:text-danger"
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      </div>
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
  /** 禁用（灰显、不响应点击；disabledHint 为悬浮提示的禁用原因） */
  disabled?: boolean;
  disabledHint?: string;
  onClick: () => void;
}

/** 分区标题右侧的 "…" 浮动菜单（空间/聊天共用）。
 *  用 fixed 定位展开，避免被侧栏滚动容器裁切 */
function SectionMenu({ title, items }: { title: string; items: SectionMenuItem[] }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const closeWithFocus = () => {
    setOpen(false);
    requestAnimationFrame(() => btnRef.current?.focus());
  };
  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      setPos({
        x: Math.max(8, Math.min(r.left, window.innerWidth - 220)),
        y: Math.min(r.bottom + 4, window.innerHeight - 16),
      });
    }
    setConfirmKey(null);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus(),
    );
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !btnRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setOpen(false);
      requestAnimationFrame(() => btnRef.current?.focus());
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const options = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    if (options.length === 0) return;
    e.preventDefault();
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? options.length - 1
          : index < 0
            ? e.key === "ArrowDown"
              ? 0
              : options.length - 1
            : e.key === "ArrowDown"
              ? (index + 1) % options.length
              : (index - 1 + options.length) % options.length;
    options[next]?.focus();
  };

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openMenu();
          }
        }}
        className="rounded p-0.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        <Icon name="dots" size={13} />
      </button>
      {open && (
        <div
          id={menuId}
          ref={menuRef}
          role="menu"
          aria-label={title}
          onKeyDown={onMenuKeyDown}
          style={{ left: pos.x, top: pos.y }}
          className="fixed z-[80] w-52 rounded-xl border border-border bg-bg-elevated p-1.5 shadow-2xl"
        >
          {items.map((item) => {
            const confirming = confirmKey === item.key;
            return (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                key={item.key}
                disabled={item.disabled}
                title={item.disabled ? item.disabledHint : undefined}
                onClick={() => {
                  if (item.disabled) return;
                  if (item.confirm && !confirming) {
                    setConfirmKey(item.key);
                    return;
                  }
                  setConfirmKey(null);
                  item.onClick();
                  closeWithFocus();
                }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] ${
                  item.disabled
                    ? "cursor-not-allowed text-text-tertiary opacity-50"
                    : `hover:bg-bg-hover ${item.danger || confirming ? "text-danger" : "text-text-primary"}`
                }`}
              >
                {item.icon && <Icon name={item.icon} size={14} className="shrink-0 text-text-tertiary" />}
                {confirming ? t("sidebar.confirmAction", { action: item.label }) : item.label}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
