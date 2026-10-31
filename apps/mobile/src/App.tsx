import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { PermissionCard } from "./components/PermissionCard";
import { QuestionCard } from "./components/QuestionCard";
import { errorText } from "./lib/i18n";
import { PairPage } from "./pages/PairPage";
import { SchedulesPage } from "./pages/SchedulesPage";
import { SessionDetailPage } from "./pages/SessionDetailPage";
import { SessionsPage } from "./pages/SessionsPage";
import { boot, unpair } from "./state/controller";
import { useAppStore } from "./state/store";

function ConnBanner() {
  const { t } = useTranslation("mobile");
  const connState = useAppStore((s) => s.connState);
  const detail = useAppStore((s) => s.connDetail);
  if (connState === "ready" || connState === "stopped") return null;
  const message =
    connState === "connecting"
      ? t("connection.connecting")
      : connState === "reconnecting"
        ? t("connection.reconnecting")
        : connState === "incompatible"
          ? t("connection.incompatible")
          : t("connection.unpaired");
  const text = detail ? t("connection.detail", { message, detail: errorText(detail) }) : message;
  return (
    <div
      role={connState === "unpaired" ? "alert" : "status"}
      className={`safe-break px-4 py-2 text-center text-xs leading-5 ${
        connState === "unpaired" ? "bg-red-950 text-red-100" : "bg-amber-950/90 text-amber-100"
      }`}
    >
      <span>{text}</span>
      {connState === "unpaired" && (
        <button type="button" onClick={() => void unpair()} className="ml-2 min-h-11 px-2 font-medium underline">
          {t("connection.repair")}
        </button>
      )}
    </div>
  );
}

export default function App() {
  const { t } = useTranslation("mobile");
  const route = useAppStore((s) => s.route);
  const localeReady = useAppStore((s) => s.localeReady);
  const connState = useAppStore((s) => s.connState);
  const topPermission = useAppStore((s) => s.permissions[0] ?? null);
  const topQuestion = useAppStore((s) => s.questions[0] ?? null);
  // Keep disconnected cached content accessible, but do not render a fresh snapshot in the
  // cached language while the authenticated desktop's hello is still in flight.
  const showContent =
    route.name === "pair" ||
    localeReady ||
    connState === "reconnecting" ||
    connState === "unpaired" ||
    connState === "incompatible" ||
    connState === "stopped";

  useEffect(() => {
    void boot();
  }, []);

  return (
    <div className="mobile-app relative mx-auto flex w-full max-w-md flex-col bg-[#0b100f]">
      {route.name !== "pair" && <ConnBanner />}
      <div className="min-h-0 flex-1">
        {!showContent && (
          <div role="status" data-testid="locale-pending" className="px-4 py-8 text-center text-sm text-slate-400">
            {t("connection.localePending")}
          </div>
        )}
        <div hidden={!showContent} data-testid="session-content" className="h-full">
          {route.name === "pair" && <PairPage />}
          {route.name === "sessions" && <SessionsPage />}
          {route.name === "session" && <SessionDetailPage key={route.id} sessionId={route.id} />}
          {route.name === "schedules" && <SchedulesPage />}
        </div>
      </div>
      <div hidden={!showContent}>
        {topPermission && <PermissionCard key={topPermission.requestId} request={topPermission} />}
        {!topPermission && topQuestion && <QuestionCard key={topQuestion.requestId} request={topQuestion} />}
      </div>
    </div>
  );
}
