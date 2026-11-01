import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChatView } from "./components/ChatView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ForkDialog } from "./components/ForkDialog";
import { PlanPanel } from "./components/PlanPanel";
import { ResizeHandle } from "./components/ResizeHandle";
import { SchedulePage } from "./components/SchedulePage";
import { SearchPalette } from "./components/SearchPalette";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { ToastRegion } from "./components/ToastRegion";
import { TopBar } from "./components/TopBar";
import { closeTopModal } from "./components/ui/Modal";
import {
  constrainLayoutWidths,
  DEFAULT_LAYOUT_WIDTHS,
  LAYOUT_STORAGE_KEY,
  parseLayoutWidths,
  planRange,
  sidebarRange,
} from "./layout";
import { teardownHostEvents, useStore } from "./store";
import { applyAppearance } from "./theme";

export default function App() {
  const { t } = useTranslation("chat");
  const ready = useStore((s) => s.ready);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const forkDialogFor = useStore((s) => s.forkDialogFor);
  const setForkDialogFor = useStore((s) => s.setForkDialogFor);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const planOpen = useStore((s) => !!s.planPanel && s.planPanel.sessionId === s.activeSessionId);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [widths, setWidths] = useState(() => parseLayoutWidths(localStorage.getItem(LAYOUT_STORAGE_KEY)));
  const layout = constrainLayoutWidths(widths, viewportWidth, planOpen);
  const [sidebarMin, sidebarMax] = sidebarRange(viewportWidth, layout.plan, planOpen);
  const [planMin, planMax] = planRange(viewportWidth, layout.sidebar);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(widths));
    } catch {
      // 存储不可用时保留内存态，不影响拖拽
    }
  }, [widths]);

  useEffect(() => {
    void useStore.getState().init();
    // StrictMode 会挂载→卸载→重挂载：卸载时退订，保证任意时刻只有一个事件监听器
    return () => teardownHostEvents();
  }, []);

  // 快捷键：Cmd+, 切换设置；Cmd+K 用搜索替换当前弹层；Esc 只关闭最上层。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "," || e.code === "Comma")) {
        e.preventDefault();
        if (!closeTopModal()) setSettingsOpen((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.code === "KeyK")) {
        e.preventDefault();
        if (searchOpen) {
          setSearchOpen(false);
        } else {
          closeTopModal();
          setSearchOpen(true);
        }
      } else if (e.key === "Escape") {
        closeTopModal();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen]);

  // 外观设置变化时即时应用（主题/字体）
  const settings = useStore((s) => s.settings);
  useEffect(() => {
    if (settings) void applyAppearance(settings);
  }, [settings]);

  if (!ready) {
    return <div className="flex h-full items-center justify-center text-text-secondary">{t("app.starting")}</div>;
  }

  return (
    <ErrorBoundary label={t("app.application")}>
      <div className="flex h-full">
        <Sidebar
          width={layout.sidebar}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenSchedule={() => setScheduleOpen(true)}
        />
        <ResizeHandle
          label={t("layout.resizeSidebar")}
          testId="sidebar-resize-handle"
          value={layout.sidebar}
          min={sidebarMin}
          max={sidebarMax}
          direction={1}
          onChange={(sidebar) => setWidths((current) => ({ ...current, sidebar }))}
          onReset={() => setWidths((current) => ({ ...current, sidebar: DEFAULT_LAYOUT_WIDTHS.sidebar }))}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <div className="min-h-0 flex-1">
            {activeSessionId ? (
              // 会话区单独兜一层：消息渲染炸掉时侧栏/顶栏仍可用（评审 P2-6）
              <ErrorBoundary label={t("app.chatArea")} key={activeSessionId}>
                <ChatView sessionId={activeSessionId} />
              </ErrorBoundary>
            ) : (
              <EmptyHome />
            )}
          </div>
        </div>
        {planOpen && (
          <ResizeHandle
            label={t("layout.resizePlan")}
            testId="plan-resize-handle"
            value={layout.plan}
            min={planMin}
            max={planMax}
            direction={-1}
            onChange={(plan) => setWidths((current) => ({ ...current, plan }))}
            onReset={() => setWidths((current) => ({ ...current, plan: DEFAULT_LAYOUT_WIDTHS.plan }))}
          />
        )}
        <ErrorBoundary label={t("plan.panelTitle")}>
          <PlanPanel width={layout.plan} />
        </ErrorBoundary>
        {forkDialogFor && <ForkDialog sourceId={forkDialogFor} onClose={() => setForkDialogFor(null)} />}
        {settingsOpen && <SettingsPage onClose={() => setSettingsOpen(false)} />}
        {searchOpen && <SearchPalette onClose={() => setSearchOpen(false)} />}
        {scheduleOpen && <SchedulePage onClose={() => setScheduleOpen(false)} />}
        <ToastRegion />
      </div>
    </ErrorBoundary>
  );
}

function EmptyHome() {
  const { t } = useTranslation("chat");
  const createSession = useStore((s) => s.createSession);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6">
      <div className="text-center">
        <div className="mb-2 text-4xl">🐦</div>
        <h1 data-testid="brand" className="text-xl font-semibold text-text-primary">
          Spcod
        </h1>
        <p className="mt-1 text-sm text-text-secondary">{t("home.tagline")}</p>
      </div>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => void createSession("chat")}
          className="rounded-lg border border-border bg-bg-elevated px-5 py-3 text-sm hover:bg-bg-hover"
        >
          {t("home.newChat")}
          <div className="mt-1 text-xs text-text-tertiary">{t("home.chatHint")}</div>
        </button>
        <button
          type="button"
          onClick={() => {
            void (async () => {
              const dir = await window.spcode.pickDirectory();
              if (dir) await createSession("project", dir);
            })();
          }}
          className="rounded-lg border border-accent/40 bg-accent-soft px-5 py-3 text-sm text-accent hover:bg-accent/20"
        >
          {t("home.newProject")}
          <div className="mt-1 text-xs text-text-tertiary">{t("home.projectHint")}</div>
        </button>
      </div>
    </div>
  );
}
