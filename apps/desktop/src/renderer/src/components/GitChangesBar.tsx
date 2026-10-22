/**
 * 会话改动条（评审 R3-F2）：项目会话在 git 仓库里跑过时，输入框上方常驻一条
 * 「改动 · stat 摘要 / 查看 diff / 还原」。
 * - 基线：主进程在会话首次 prompt 前记录（HEAD + status 指纹）；
 * - 还原 = git stash push（可恢复，git stash pop 可找回），不用 checkout -- . 这种不可逆操作；
 * - 刷新时机：会话从 running 落定（agent_settled）后拉一次。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import { DiffPatch } from "./DiffBlock";

export function GitChangesBar({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("chat");
  const running = useStore((s) => s.sessions[sessionId]?.running ?? false);
  const cwd = useStore((s) => s.sessions[sessionId]?.meta.cwd ?? "");
  const [state, setState] = useState<{ hasBaseline: boolean; changed: boolean; stat: string } | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diff, setDiff] = useState<{ stat: string; patch: string; untracked: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<"git.reverted" | "git.revertFailed" | null>(null);

  // 落定后刷新改动状态（挂载也拉一次）
  // biome-ignore lint/correctness/useExhaustiveDependencies: running 是刻意的触发信号（落定后重拉），effect 体内不引用
  useEffect(() => {
    if (!cwd) return;
    let stale = false;
    void window.spcode.sessionGitState(sessionId).then((s) => {
      if (!stale) setState(s);
    });
    return () => {
      stale = true;
    };
  }, [sessionId, cwd, running]);

  if (!cwd || !state?.hasBaseline || !state.changed) return null;

  const openDiff = async () => {
    setDiffOpen(true);
    setDiff(await window.spcode.sessionGitDiff(sessionId));
  };

  const revert = async () => {
    if (!window.confirm(t("git.confirmRevert"))) return;
    setBusy(true);
    try {
      const out = await window.spcode.sessionGitRevert(sessionId);
      setNotice(out ? "git.reverted" : "git.revertFailed");
      setDiffOpen(false);
      setState(await window.spcode.sessionGitState(sessionId));
    } finally {
      setBusy(false);
      setTimeout(() => setNotice(null), 5000);
    }
  };

  return (
    <div className="shrink-0 px-6 pb-2">
      <div className="mx-auto max-w-3xl">
        {notice && (
          <div className="mb-1.5 rounded-lg border border-border bg-bg-elevated px-3 py-1.5 text-[12px] text-text-secondary">
            {t(notice)}
          </div>
        )}
        <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-elevated px-3 py-1.5">
          <span className="text-[12px] text-warning">●</span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary" title={state.stat}>
            {state.stat ? t("git.changedStat", { stat: state.stat.split("\n").pop()?.trim() ?? "" }) : t("git.changed")}
          </span>
          <button
            type="button"
            onClick={() => void openDiff()}
            className="shrink-0 rounded px-2 py-0.5 text-[12px] text-accent hover:bg-bg-hover"
          >
            {t("git.viewDiff")}
          </button>
          <button
            type="button"
            onClick={() => void revert()}
            disabled={busy}
            className="shrink-0 rounded px-2 py-0.5 text-[12px] text-danger hover:bg-danger/10 disabled:opacity-40"
          >
            {t("git.revert")}
          </button>
        </div>
      </div>

      {diffOpen && (
        // biome-ignore lint/a11y/noStaticElementInteractions: 遮罩点外关闭（待统一 Modal 组件化收敛）
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDiffOpen(false);
          }}
        >
          <div className="flex max-h-[80vh] w-[760px] max-w-[94vw] flex-col rounded-2xl border border-border-strong bg-bg-main p-4 shadow-2xl">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[13px] font-semibold text-text-primary">{t("git.title")}</div>
              <button
                type="button"
                onClick={() => setDiffOpen(false)}
                className="rounded px-2 py-1 text-[12px] text-text-tertiary hover:bg-bg-hover"
              >
                {t("common.close")}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {diff ? (
                <>
                  {diff.patch ? (
                    <DiffPatch patch={diff.patch} maxChars={60000} />
                  ) : (
                    <div className="px-2 py-3 text-[12px] text-text-tertiary">{t("git.noTracked")}</div>
                  )}
                  {diff.untracked.length > 0 && (
                    <div className="mt-2 px-2 text-[12px] text-text-tertiary">
                      {t("git.untracked", { files: diff.untracked.join("\n") })}
                    </div>
                  )}
                </>
              ) : (
                <div className="px-2 py-3 text-[12px] text-text-tertiary">{t("git.loading")}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
