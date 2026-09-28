import { useEffect, useState } from "react";
import { useStore } from "./store";
import { applyAppearance } from "./theme";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { TopBar } from "./components/TopBar";
import { PermissionCard } from "./components/PermissionCard";
import { QuestionCard } from "./components/QuestionCard";
import { SettingsPanel } from "./components/SettingsPanel";

export default function App() {
  const ready = useStore((s) => s.ready);
  const lastError = useStore((s) => s.lastError);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    void useStore.getState().init();
  }, []);

  // 外观设置变化时即时应用（主题/字体）
  const settings = useStore((s) => s.settings);
  useEffect(() => {
    if (settings) void applyAppearance(settings);
  }, [settings]);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-text-secondary">
        Spcode 启动中…
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
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
      <QuestionCard />
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {lastError && (
        <div className="fixed bottom-4 right-4 max-w-md rounded-lg border border-danger/40 bg-bg-elevated px-4 py-3 text-sm text-danger shadow-xl">
          {lastError}
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
