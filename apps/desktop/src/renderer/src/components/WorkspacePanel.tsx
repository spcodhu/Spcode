/**
 * 右侧工作区面板：顶部是悬浮任务卡片，下方在「会话文件列表 / 文件预览」间切换。
 * 会话文件只从助手正文明确分享的 file:/本地文件链接派生；工具过程文件仍可手动预览，
 * 但不会自动混入列表。面板关闭后由右侧悬浮按钮随时唤回，空会话也展示明确空态。
 */
import type { TaskActivity, TodoItem } from "@spcode/shared";
import { baseName } from "@spcode/shared";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { langOf } from "../file-blocks";
import { formatCompact } from "../format";
import { usePresence } from "../presence";
import { formatElapsed } from "../run-status";
import { useStore, type WorkspaceFileTab, workspacePanelVisible } from "../store";
import { type WorkspaceDeliverable, workspaceDeliverables } from "../workspace-deliverables";
import { ErrorBoundary } from "./ErrorBoundary";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { ResizeHandle } from "./ResizeHandle";

const WORKSPACE_PANEL_TRANSITION_MS = 300;

/** 右栏连同拖宽手柄一起做实际占位宽度过渡，中间正文随 flex 布局同步收缩/放开。 */
export function WorkspacePanelFrame({
  width,
  min,
  max,
  onChange,
  onReset,
}: {
  width: number;
  min: number;
  max: number;
  onChange: (width: number) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation("chat");
  const open = useStore((s) => {
    const id = s.activeSessionId;
    return !!id && workspacePanelVisible(s.sessions[id], s.workspacePanels[id]);
  });
  const presence = usePresence(open, WORKSPACE_PANEL_TRANSITION_MS);
  if (!presence.mounted) return null;

  const fullWidth = width + 8;
  const settled = presence.visible && !presence.animating;
  return (
    <div
      data-testid="workspace-panel-frame"
      data-open={presence.visible}
      data-animating={presence.animating}
      aria-hidden={!open}
      inert={!open}
      className={`flex h-full shrink-0 ${settled ? "" : "overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"} ${open ? "" : "pointer-events-none"}`}
      style={{ width: presence.visible ? fullWidth : 0 }}
    >
      <div
        className={`flex h-full shrink-0 transition-opacity duration-200 ${presence.visible ? "opacity-100" : "opacity-0"}`}
        style={{ width: fullWidth }}
      >
        <ResizeHandle
          label={t("layout.resizePlan")}
          testId="workspace-resize-handle"
          value={width}
          min={min}
          max={max}
          direction={-1}
          onChange={onChange}
          onReset={onReset}
        />
        <ErrorBoundary label={t("workspace.panelTitle")}>
          <WorkspacePanel width={width} forceVisible />
        </ErrorBoundary>
      </div>
    </div>
  );
}

export function WorkspacePanel({ width = 560, forceVisible = false }: { width?: number; forceVisible?: boolean }) {
  const { t } = useTranslation("chat");
  const activeSessionId = useStore((s) => s.activeSessionId);
  const session = useStore((s) => (activeSessionId ? s.sessions[activeSessionId] : undefined));
  const panel = useStore((s) => (activeSessionId ? s.workspacePanels[activeSessionId] : undefined));
  const dismissWorkspacePanel = useStore((s) => s.dismissWorkspacePanel);
  const closeWorkspaceFile = useStore((s) => s.closeWorkspaceFile);
  const focusWorkspaceFile = useStore((s) => s.focusWorkspaceFile);
  const showWorkspaceLibrary = useStore((s) => s.showWorkspaceLibrary);
  const openWorkspaceFile = useStore((s) => s.openWorkspaceFile);
  const showWorkspaceFileMenu = useStore((s) => s.showWorkspaceFileMenu);
  const startPlanExecution = useStore((s) => s.startPlanExecution);
  const [starting, setStarting] = useState(false);
  const deliverables = useMemo(() => workspaceDeliverables(session?.messages ?? []), [session?.messages]);

  if (!session || (!forceVisible && !workspacePanelVisible(session, panel))) return null;

  const files = panel?.files ?? [];
  const activeFile = files.find((f) => f.path === panel?.activePath) ?? null;
  const showExecuteFooter = !!activeFile && activeFile.kind === "plan" && session.planMode;

  return (
    <aside
      data-testid="workspace-panel"
      className="flex shrink-0 flex-col border-l border-border bg-bg-main"
      style={{ width }}
      aria-label={t("workspace.panelTitle")}
    >
      <header className="titlebar-drag window-controls-overlay-inset flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
        <button
          type="button"
          data-testid="workspace-panel-collapse"
          onClick={dismissWorkspacePanel}
          title={t("workspace.close")}
          aria-label={t("workspace.close")}
          aria-expanded={true}
          className="titlebar-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent transition-colors hover:bg-bg-hover"
        >
          <Icon name="panelRight" size={14} />
        </button>
        <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">
          {t("workspace.panelTitle")}
        </div>
        <button
          type="button"
          data-testid="workspace-panel-close"
          onClick={dismissWorkspacePanel}
          title={t("workspace.close")}
          aria-label={t("workspace.close")}
          className="titlebar-no-drag rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <Icon name="x" size={14} />
        </button>
      </header>

      <TodoSection todos={session.todos} planMode={session.planMode} />

      <SubtaskSection tasks={session.tasks} />

      {activeFile && files.length > 0 && (
        <FileTabs
          files={files}
          activePath={panel?.activePath ?? null}
          onFocus={focusWorkspaceFile}
          onClose={closeWorkspaceFile}
          onShowLibrary={showWorkspaceLibrary}
          onContextMenu={(file) => void showWorkspaceFileMenu({ path: file.path, kind: file.kind })}
        />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {activeFile ? (
          <FileContent key={activeFile.path} file={activeFile} />
        ) : (
          <FileLibrary
            files={deliverables}
            onOpen={(file) => void openWorkspaceFile(file)}
            onContextMenu={(file) => void showWorkspaceFileMenu({ path: file.path, kind: file.kind })}
          />
        )}
      </div>

      {showExecuteFooter && (
        <footer className="shrink-0 border-t border-border p-4">
          <button
            type="button"
            data-testid="plan-start-execution"
            disabled={starting}
            onClick={() => {
              setStarting(true);
              void startPlanExecution().finally(() => setStarting(false));
            }}
            className="flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-accent px-4 py-2.5 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-dim disabled:opacity-50"
          >
            <Icon name="arrowUp" size={15} />
            {t(starting ? "plan.starting" : "plan.start")}
          </button>
          <div className="mt-2 text-center text-[11.5px] text-text-tertiary">{t("plan.startHint")}</div>
        </footer>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// 任务清单：左右留白的悬浮卡片；有任务时默认展开，固定高度，清单内部滚动。
// ---------------------------------------------------------------------------

function TodoSection({ todos, planMode }: { todos: TodoItem[]; planMode: boolean }) {
  const { t } = useTranslation("chat");
  const done = todos.filter((x) => x.status === "completed").length;
  const current = todos.find((x) => x.status === "in_progress");
  const hasTodos = todos.length > 0;
  const allDone = hasTodos && done === todos.length;
  const [open, setOpen] = useState(true);

  if (!hasTodos && !planMode) return null;

  return (
    <div data-testid="workspace-todo-section" className="shrink-0 px-3 pt-3">
      <div
        className={`overflow-hidden rounded-2xl border border-border bg-bg-elevated shadow-[0_8px_28px_rgba(0,0,0,0.07)] ${
          open && hasTodos ? "flex h-[260px] flex-col" : ""
        }`}
      >
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          data-testid="workspace-todo-toggle"
          className="flex min-h-11 w-full shrink-0 items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-bg-hover/50"
        >
          <Icon
            name="chevronRight"
            size={12}
            className={`shrink-0 text-text-tertiary transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          />
          <span
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${
              allDone ? "bg-success/15 text-success" : "bg-accent-soft text-accent"
            }`}
          >
            <Icon name={allDone ? "check" : hasTodos ? "clipboardCheck" : "clipboard"} size={11} strokeWidth={2.2} />
          </span>

          {hasTodos ? (
            <>
              <span className="shrink-0 text-[12.5px] font-medium text-text-primary">{t("work.tasks")}</span>
              <span className="shrink-0 text-[11.5px] text-text-tertiary">
                {done}/{todos.length}
              </span>
              <span className="h-[3px] w-12 shrink-0 overflow-hidden rounded-full bg-bg-hover">
                <span
                  className="block h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${todos.length ? (done / todos.length) * 100 : 0}%`,
                    background: allDone ? "var(--color-success)" : "var(--color-accent)",
                  }}
                />
              </span>
            </>
          ) : (
            <span className="shrink-0 text-[12.5px] font-medium text-text-primary">{t("common.planMode")}</span>
          )}

          <span className="min-w-0 flex-1" />

          {planMode && hasTodos && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10.5px] text-accent">
              <Icon name="clipboard" size={10} strokeWidth={2.2} />
              {t("common.planMode")}
            </span>
          )}
          {hasTodos &&
            (current ? (
              <span className="flex min-w-0 max-w-[42%] items-center gap-1.5 text-[11.5px] text-accent">
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
                <span className="truncate">{current.activeForm ?? current.content}</span>
              </span>
            ) : (
              allDone && <span className="shrink-0 text-[11.5px] text-success">{t("work.allDone")}</span>
            ))}
        </button>
        {open && (
          <div data-testid="workspace-todo-list" className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-3.5">
            {planMode && (
              <div className="mb-2 flex items-start gap-2 rounded-xl border border-accent/25 bg-accent/10 px-3 py-2 text-[12px] leading-5 text-accent">
                <Icon name="info" size={13} className="mt-[3px] shrink-0" />
                <span>{t("work.planHint")}</span>
              </div>
            )}
            {hasTodos && (
              <div className="space-y-0.5">
                {todos.map((td) => (
                  // TodoWrite 每次全量下发且同清单内 content 不重复
                  <TaskRow key={td.content} todo={td} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TaskRow({ todo }: { todo: TodoItem }) {
  const { t } = useTranslation("chat");
  const isDone = todo.status === "completed";
  const isCurrent = todo.status === "in_progress";
  return (
    <div className="flex items-start gap-2.5 py-[3px]" data-testid="work-task" data-status={todo.status}>
      <span
        title={t(isDone ? "work.completed" : isCurrent ? "work.inProgress" : "work.pending")}
        className={`mt-[2px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
          isDone
            ? "border-transparent bg-success/15 text-success"
            : isCurrent
              ? "border-accent/60"
              : "border-border-strong"
        }`}
      >
        {isDone ? (
          <Icon name="check" size={10} strokeWidth={2.6} />
        ) : isCurrent ? (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
        ) : null}
      </span>
      <span
        className={`text-[12.5px] leading-5 ${
          isDone ? "text-text-tertiary" : isCurrent ? "text-text-primary" : "text-text-secondary"
        }`}
      >
        {isCurrent && todo.activeForm ? todo.activeForm : todo.content}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子任务活动：默认只显示运行中/排队中的状态芯片，点开查看完整状态（含已完成）
// ---------------------------------------------------------------------------

const SUBTASK_CHIP_LIMIT = 5;

function isTaskActive(task: TaskActivity): boolean {
  return task.status === "queued" || task.status === "running";
}

const SUBTASK_DOT_CLASS: Record<TaskActivity["status"], string> = {
  queued: "bg-bg-hover",
  running: "bg-accent",
  completed: "bg-success",
  partial: "bg-warning",
  blocked: "bg-warning",
  failed: "bg-danger",
  cancelled: "bg-border-strong",
};

const SUBTASK_STATUS_COLOR: Record<TaskActivity["status"], string> = {
  queued: "text-text-tertiary",
  running: "text-accent",
  completed: "text-success",
  partial: "text-warning",
  blocked: "text-warning",
  failed: "text-danger",
  cancelled: "text-text-tertiary",
};

const SUBTASK_STATUS_KEY = {
  queued: "subtasks.queued",
  running: "subtasks.running",
  completed: "subtasks.completed",
  partial: "subtasks.partial",
  blocked: "subtasks.blocked",
  failed: "subtasks.failed",
  cancelled: "subtasks.cancelled",
} as const;

function SubtaskSection({ tasks }: { tasks: TaskActivity[] }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const activeCount = tasks.filter(isTaskActive).length;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (activeCount === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeCount]);

  if (tasks.length === 0) return null;

  const done = tasks.filter((task) => task.status === "completed").length;
  const visibleTasks = open ? tasks : tasks.filter(isTaskActive);
  const chips = open ? visibleTasks : visibleTasks.slice(0, SUBTASK_CHIP_LIMIT);
  const overflow = open ? 0 : visibleTasks.length - SUBTASK_CHIP_LIMIT;

  return (
    <div data-testid="workspace-subtask-section" className="shrink-0 px-3 pt-2">
      <div className="overflow-hidden rounded-2xl border border-border bg-bg-elevated shadow-[0_8px_28px_rgba(0,0,0,0.07)]">
        <button
          type="button"
          data-testid="workspace-subtask-toggle"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex min-h-11 w-full shrink-0 items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-bg-hover/50"
        >
          <Icon
            name="chevronRight"
            size={12}
            className={`shrink-0 text-text-tertiary transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          />
          <span
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${
              activeCount > 0 ? "bg-accent-soft text-accent" : "bg-bg-hover text-text-tertiary"
            }`}
          >
            <Icon name="zap" size={11} strokeWidth={2.2} />
          </span>
          <span className="shrink-0 text-[12.5px] font-medium text-text-primary">{t("subtasks.title")}</span>
          {activeCount > 0 ? (
            <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-accent">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              <span className="tabular-nums">{t("subtasks.runningCount", { count: activeCount })}</span>
            </span>
          ) : (
            <span className="shrink-0 tabular-nums text-[11.5px] text-text-tertiary">
              {t("subtasks.doneCount", { done, total: tasks.length })}
            </span>
          )}
        </button>
        {open ? (
          <div data-testid="workspace-subtask-list" className="space-y-1 px-3.5 pb-3.5">
            {visibleTasks.map((task) => (
              <SubtaskRow key={task.taskId} task={task} now={now} />
            ))}
          </div>
        ) : (
          <div data-testid="workspace-subtask-chips" className="flex flex-wrap gap-1.5 px-3.5 pb-3">
            {chips.map((task) => (
              <SubtaskChip key={task.taskId} task={task} onExpand={() => setOpen(true)} />
            ))}
            {overflow > 0 && (
              <button
                type="button"
                data-testid="workspace-subtask-more"
                onClick={() => setOpen(true)}
                className="flex items-center rounded-full border border-border bg-bg-main px-2.5 py-1 text-[11.5px] text-text-tertiary transition-colors hover:border-accent/40 hover:text-accent"
              >
                {t("subtasks.more", { count: overflow })}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SubtaskChip({ task, onExpand }: { task: TaskActivity; onExpand: () => void }) {
  const { t } = useTranslation("chat");
  return (
    <button
      type="button"
      data-testid="workspace-subtask-chip"
      data-status={task.status}
      onClick={onExpand}
      title={task.description}
      className="flex max-w-full items-center gap-1.5 rounded-full border border-border bg-bg-main px-2.5 py-1 text-[11.5px] transition-colors hover:border-accent/40 hover:bg-accent-soft/40"
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${SUBTASK_DOT_CLASS[task.status]} ${
          isTaskActive(task) ? "animate-pulse" : ""
        }`}
      />
      <span className="max-w-44 truncate text-text-secondary">{task.description}</span>
      <span className="mono shrink-0 tabular-nums text-text-tertiary">
        {t("subtasks.turns", { turns: task.turns, maxTurns: task.maxTurns })}
      </span>
    </button>
  );
}

function SubtaskRow({ task, now }: { task: TaskActivity; now: number }) {
  const { t } = useTranslation("chat");
  const tokens = task.usage.input + task.usage.output + task.usage.cacheRead + task.usage.cacheWrite;
  const seconds = Math.max(0, Math.floor(((task.endedAt ?? now) - task.startedAt) / 1000));
  return (
    <div
      data-testid="workspace-subtask-row"
      data-status={task.status}
      data-depth={task.depth}
      style={task.depth > 0 ? { marginLeft: 12 * task.depth } : undefined}
      className="rounded-xl border border-border/60 bg-bg-main/60 px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${SUBTASK_DOT_CLASS[task.status]} ${
            isTaskActive(task) ? "animate-pulse" : ""
          }`}
        />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text-primary" title={task.description}>
          {task.description}
        </span>
        <span className={`shrink-0 text-[11px] ${SUBTASK_STATUS_COLOR[task.status]}`}>
          {t(SUBTASK_STATUS_KEY[task.status])}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-text-tertiary">
        {task.depth > 0 && <span className="mono">{t("subtasks.nested", { depth: task.depth })}</span>}
        <span className="rounded-full bg-bg-hover px-1.5 py-px text-[10.5px]">
          {t(task.role === "write" ? "subtasks.roleWrite" : "subtasks.roleReadonly")}
        </span>
        <span className="mono tabular-nums">{t("subtasks.turns", { turns: task.turns, maxTurns: task.maxTurns })}</span>
        <span className="mono tabular-nums">{formatCompact(tokens)}</span>
        <span className="mono tabular-nums">{formatElapsed(seconds)}</span>
        {task.lastTool && (
          <span className="min-w-0 max-w-full truncate">{t("subtasks.lastTool", { tool: task.lastTool })}</span>
        )}
      </div>
      {task.summary && (
        <p
          data-testid="workspace-subtask-summary"
          className="mt-1.5 line-clamp-2 text-[11.5px] leading-4 text-text-secondary"
        >
          {task.summary}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 会话文件列表 + 已打开文件标签 + 预览内容
// ---------------------------------------------------------------------------

function FileLibrary({
  files,
  onOpen,
  onContextMenu,
}: {
  files: WorkspaceDeliverable[];
  onOpen: (file: WorkspaceDeliverable) => void;
  onContextMenu: (file: WorkspaceDeliverable) => void;
}) {
  const { t } = useTranslation("chat");
  if (files.length === 0) {
    return (
      <div
        data-testid="workspace-empty"
        className="flex h-full flex-col items-center justify-center gap-2.5 px-10 text-center"
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-bg-elevated text-text-tertiary">
          <Icon name="fileText" size={18} />
        </span>
        <p className="text-[13px] font-medium text-text-secondary">{t("workspace.empty")}</p>
        <p className="text-[12px] leading-5 text-text-tertiary">{t("workspace.emptyHint")}</p>
      </div>
    );
  }
  return (
    <section data-testid="workspace-file-list" className="p-3" aria-label={t("workspace.files")}>
      <div className="mb-2 flex items-center gap-2 px-1 text-[12px] text-text-tertiary">
        <Icon name="folder" size={13} />
        <span className="font-medium text-text-secondary">{t("workspace.files")}</span>
        <span>{files.length}</span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-bg-elevated shadow-sm">
        {files.map((file, index) => (
          <button
            type="button"
            key={`${file.kind}:${file.path}`}
            data-testid="workspace-delivered-file"
            data-path={file.path}
            title={file.path}
            onClick={() => onOpen(file)}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu(file);
            }}
            className={`flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-bg-hover/70 ${
              index > 0 ? "border-t border-border" : ""
            }`}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-text-secondary">
              <Icon name={file.kind === "plan" ? "clipboard" : "fileText"} size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium text-text-primary">{file.label}</span>
              <span className="mono mt-0.5 block truncate text-[10.5px] text-text-tertiary">
                {baseName(file.path) || file.path}
              </span>
            </span>
            <Icon name="chevronRight" size={13} className="shrink-0 text-text-tertiary" />
          </button>
        ))}
      </div>
    </section>
  );
}

function FileTabs({
  files,
  activePath,
  onFocus,
  onClose,
  onShowLibrary,
  onContextMenu,
}: {
  files: WorkspaceFileTab[];
  activePath: string | null;
  onFocus: (path: string) => void;
  onClose: (path: string) => void;
  onShowLibrary: () => void;
  onContextMenu: (file: WorkspaceFileTab) => void;
}) {
  const { t } = useTranslation("chat");
  return (
    <div
      data-testid="workspace-file-tabs"
      className="mx-3 mt-2 flex shrink-0 items-center gap-1 overflow-x-auto rounded-xl border border-border bg-bg-elevated/70 p-1.5"
    >
      <button
        type="button"
        data-testid="workspace-file-list-back"
        onClick={onShowLibrary}
        title={t("workspace.files")}
        aria-label={t("workspace.files")}
        className="mr-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
      >
        <Icon name="list" size={13} />
      </button>
      {files.map((f) => {
        const active = f.path === activePath;
        return (
          <div
            key={f.path}
            data-testid="workspace-file-tab"
            data-path={f.path}
            data-active={active}
            className={`group flex shrink-0 items-center gap-1 rounded-lg py-1 pl-2.5 pr-1 text-[12px] transition-colors ${
              active ? "bg-bg-main text-text-primary shadow-sm" : "text-text-tertiary hover:bg-bg-hover"
            }`}
          >
            <button
              type="button"
              data-testid="workspace-file-tab-open"
              title={f.path}
              onClick={() => onFocus(f.path)}
              onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu(f);
              }}
              className="flex min-w-0 items-center gap-1.5"
            >
              <Icon name={f.kind === "plan" ? "clipboard" : "fileText"} size={12} className="shrink-0" />
              <span className="max-w-28 truncate">{f.label}</span>
            </button>
            <button
              type="button"
              onClick={() => onClose(f.path)}
              title={t("workspace.closeFile", { name: f.label })}
              aria-label={t("workspace.closeFile", { name: f.label })}
              className="shrink-0 rounded p-0.5 text-text-tertiary opacity-0 transition-opacity hover:bg-bg-hover hover:text-text-primary group-hover:opacity-100"
            >
              <Icon name="x" size={10} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function FileContent({ file }: { file: WorkspaceFileTab }) {
  const isMarkdown = /\.(md|markdown)$/i.test(file.path);
  const content = isMarkdown ? file.text : fencedCodeBlock(file.path, file.text);
  return (
    <div data-testid="workspace-file-content" className="px-6 py-5">
      <Markdown text={content} workspaceDocumentPath={file.path} />
    </div>
  );
}

/** 非 Markdown 文件包进围栏代码块复用 Markdown 渲染器自带的 Shiki 高亮与复制按钮 */
function fencedCodeBlock(path: string, text: string): string {
  const fence = text.includes("```") ? "````" : "```";
  return `${fence}${langOf(baseName(path))}\n${text}\n${fence}`;
}
