import { useEffect } from "react";
import { PermissionCard } from "./components/PermissionCard";
import { QuestionCard } from "./components/QuestionCard";
import { PairPage } from "./pages/PairPage";
import { SchedulesPage } from "./pages/SchedulesPage";
import { SessionDetailPage } from "./pages/SessionDetailPage";
import { SessionsPage } from "./pages/SessionsPage";
import { boot } from "./state/controller";
import { useAppStore } from "./state/store";

/** 连接状态横幅（非配对页时显示） */
function ConnBanner() {
  const connState = useAppStore((s) => s.connState);
  const detail = useAppStore((s) => s.connDetail);
  if (connState === "ready" || connState === "stopped") return null;
  const text =
    connState === "connecting"
      ? "正在连接桌面端…"
      : connState === "reconnecting"
        ? `连接已断开，正在重连…${detail ? `（${detail}）` : ""}`
        : connState === "unpaired"
          ? (detail ?? "桌面端已移除本设备，请重新扫码配对")
          : null;
  if (!text) return null;
  return (
    <div
      className={`px-4 py-2 text-center text-xs ${
        connState === "unpaired" ? "bg-red-900/80 text-red-100" : "bg-amber-900/70 text-amber-100"
      }`}
    >
      {text}
    </div>
  );
}

export default function App() {
  const route = useAppStore((s) => s.route);
  const topPermission = useAppStore((s) => s.permissions[0] ?? null);
  const topQuestion = useAppStore((s) => s.questions[0] ?? null);

  useEffect(() => {
    void boot();
  }, []);

  return (
    <div className="mx-auto flex h-full max-w-md flex-col bg-[#0b0f14]">
      {route.name !== "pair" && <ConnBanner />}

      <div className="min-h-0 flex-1">
        {route.name === "pair" && <PairPage />}
        {route.name === "sessions" && <SessionsPage />}
        {route.name === "session" && <SessionDetailPage sessionId={route.id} />}
        {route.name === "schedules" && <SchedulesPage />}
      </div>

      {/* 权限批准卡：全屏置顶，一次只处理最上面一张（先到先得） */}
      {topPermission && <PermissionCard key={topPermission.requestId} request={topPermission} />}
      {!topPermission && topQuestion && <QuestionCard key={topQuestion.requestId} request={topQuestion} />}
    </div>
  );
}
