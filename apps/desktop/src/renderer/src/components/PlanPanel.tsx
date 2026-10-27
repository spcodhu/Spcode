import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

export function PlanPanel() {
  const panel = useStore((s) => s.planPanel);
  const activeSessionId = useStore((s) => s.activeSessionId);
  if (!panel || panel.sessionId !== activeSessionId) return null;
  return <PlanPanelContent key={panel.path} sessionId={panel.sessionId} path={panel.path} />;
}

function PlanPanelContent({ sessionId, path }: { sessionId: string; path: string }) {
  const { t } = useTranslation("chat");
  const closePlanFile = useStore((s) => s.closePlanFile);
  const startPlanExecution = useStore((s) => s.startPlanExecution);
  const planMode = useStore((s) => s.sessions[sessionId]?.planMode ?? false);
  const [state, setState] = useState<{ text: string; error: string | null }>({ text: "", error: null });
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let alive = true;
    window.spcode
      .readPlanFile(path)
      .then((text) => {
        if (alive) setState({ text, error: null });
      })
      .catch((error) => {
        if (alive) setState({ text: "", error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      alive = false;
    };
  }, [path]);

  return (
    <aside
      data-testid="plan-panel"
      className="flex w-[42%] min-w-[320px] max-w-[760px] shrink-0 flex-col border-l border-border bg-bg-main"
      aria-label={t("plan.panelTitle")}
    >
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Icon name="clipboard" size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-text-primary">{t("plan.panelTitle")}</div>
          <div className="mono truncate text-[11px] text-text-tertiary" title={path}>
            {t("plan.fileName")}
          </div>
        </div>
        <button
          type="button"
          data-testid="plan-panel-close"
          onClick={closePlanFile}
          title={t("plan.close")}
          aria-label={t("plan.close")}
          className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <Icon name="x" size={14} />
        </button>
      </header>

      <div data-testid="plan-content" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-5">
        {state.error ? (
          <div className="rounded-xl border border-danger/35 bg-danger/10 px-4 py-3 text-[12.5px] text-danger">
            {t("plan.loadError", { error: state.error })}
          </div>
        ) : state.text ? (
          <Markdown text={state.text} />
        ) : (
          <div className="text-[13px] text-text-tertiary">{t("plan.loading")}</div>
        )}
      </div>

      {planMode && (
        <footer className="shrink-0 border-t border-border p-4">
          <button
            type="button"
            data-testid="plan-start-execution"
            disabled={starting}
            onClick={() => {
              setStarting(true);
              void startPlanExecution().finally(() => setStarting(false));
            }}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-dim disabled:opacity-50"
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
