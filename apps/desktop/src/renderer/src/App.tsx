import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChatView } from "./components/ChatView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ForkDialog } from "./components/ForkDialog";
import { PermissionCard } from "./components/PermissionCard";
import { SchedulePage } from "./components/SchedulePage";
import { SearchPalette } from "./components/SearchPalette";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { ToastRegion } from "./components/ToastRegion";
import { TopBar } from "./components/TopBar";
import { closeTopModal } from "./components/ui/Modal";
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
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenSchedule={() => setScheduleOpen(true)}
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
        <PermissionCard />
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
