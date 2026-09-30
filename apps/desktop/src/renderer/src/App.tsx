import { useEffect, useState } from "react";
import { useStore, teardownHostEvents } from "./store";
import { applyAppearance } from "./theme";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { TopBar } from "./components/TopBar";
import { PermissionCard } from "./components/PermissionCard";
import { SettingsPage } from "./components/SettingsPage";
import { SearchPalette } from "./components/SearchPalette";
import { SchedulePage } from "./components/SchedulePage";
import { Icon } from "./components/Icon";

export default function App() {
  const ready = useStore((s) => s.ready);
  const lastError = useStore((s) => s.lastError);
  const notice = useStore((s) => s.notice);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  useEffect(() => {
    void useStore.getState().init();
    // StrictMode 会挂载→卸载→重挂载：卸载时退订，保证任意时刻只有一个事件监听器
    return () => teardownHostEvents();
  }, []);

  // 快捷键：Cmd+, 开关设置面板，Cmd+K 搜索会话，ESC 关闭各浮层
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "," || e.code === "Comma")) {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.code === "KeyK")) {
        e.preventDefault();
        setSearchOpen((v) => !v);
      } else if (e.key === "Escape") {
        setSettingsOpen(false);
        setSearchOpen(false);
        setScheduleOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 外观设置变化时即时应用（主题/字体）
  const settings = useStore((s) => s.settings);
  useEffect(() => {
    if (settings) void applyAppearance(settings);
  }, [settings]);

  // 错误提示：6 秒自动消失，也可手动关闭
  useEffect(() => {
    if (!lastError) return;
    const timer = setTimeout(() => useStore.setState({ lastError: null }), 6000);
    return () => clearTimeout(timer);
  }, [lastError]);

  // 定时任务触发通知：8 秒自动消失
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => useStore.setState({ notice: null }), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-text-secondary">
        Spcode 启动中…
      </div>
    );
  }

  return (
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
            <ChatView sessionId={activeSessionId} />
          ) : (
            <EmptyHome />
          )}
        </div>
      </div>
      <PermissionCard />
      {settingsOpen && <SettingsPage onClose={() => setSettingsOpen(false)} />}
      {searchOpen && <SearchPalette onClose={() => setSearchOpen(false)} />}
      {scheduleOpen && <SchedulePage onClose={() => setScheduleOpen(false)} />}
      {notice && (
        <button
          onClick={() => {
            if (notice.sessionId) void useStore.getState().openSessionById(notice.sessionId);
            useStore.setState({ notice: null });
          }}
          className="fixed bottom-4 right-4 z-50 flex max-w-md items-start gap-2 rounded-lg border border-accent/40 bg-bg-elevated px-4 py-3 text-left text-sm text-text-primary shadow-xl"
        >
          <Icon name="clock" size={15} className="mt-0.5 shrink-0 text-accent" />
          <span className="flex-1">{notice.text}</span>
          <span
            onClick={(e) => {
              e.stopPropagation();
              useStore.setState({ notice: null });
            }}
            className="shrink-0 text-text-tertiary hover:text-text-primary"
          >
            ✕
          </span>
        </button>
      )}
      {lastError && (
        <div className="fixed bottom-4 right-4 z-50 flex max-w-md items-start gap-2 rounded-lg border border-danger/40 bg-bg-elevated px-4 py-3 text-sm text-danger shadow-xl">
          <span className="flex-1">{lastError}</span>
          <button
            onClick={() => useStore.setState({ lastError: null })}
            className="shrink-0 text-text-tertiary hover:text-text-primary"
            title="关闭"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

function EmptyHome() {
  const createSession = useStore((s) => s.createSession);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6">
      <div className="text-center">
        <div className="mb-2 text-4xl">🐦</div>
        <h1 className="text-xl font-semibold text-text-primary">Spcode</h1>
        <p className="mt-1 text-sm text-text-secondary">以 Pi 为引擎的 Agentic Code 工作台</p>
      </div>
      <div className="flex gap-3">
        <button
          onClick={() => void createSession("chat")}
          className="rounded-lg border border-border bg-bg-elevated px-5 py-3 text-sm hover:bg-bg-hover"
        >
          💬 新建聊天
          <div className="mt-1 text-xs text-text-tertiary">仅对话，不绑定文件夹</div>
        </button>
        <button
          onClick={() => {
            void (async () => {
              const dir = await window.spcode.pickDirectory();
              if (dir) await createSession("project", dir);
            })();
          }}
          className="rounded-lg border border-accent/40 bg-accent-soft px-5 py-3 text-sm text-accent hover:bg-accent/20"
        >
          📁 新建项目
          <div className="mt-1 text-xs text-text-tertiary">选择文件夹开始工作</div>
        </button>
      </div>
    </div>
  );
}
