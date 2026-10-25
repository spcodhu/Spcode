/** Structured questions: requestId-keyed drafts survive a permission card temporarily taking focus. */
import {
  buildQuestionAnswers,
  dismissQuestionAnswers,
  type QuestionAnswers,
  type QuestionRequest,
} from "@spcode/shared";
import { renderMessage } from "@spcode/shared/i18n";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText } from "../lib/i18n";
import { replyQuestion } from "../state/controller";
import { useAppStore } from "../state/store";
import { FullScreenDialog } from "./Sheet";

export function QuestionCard({ request }: { request: QuestionRequest }) {
  // Reset only for a new request, never for a locale change.
  return <QuestionDraft key={request.requestId} request={request} />;
}

function QuestionDraft({ request }: { request: QuestionRequest }) {
  const { t } = useTranslation("questions");
  const { t: tMobile } = useTranslation("mobile");
  const session = useAppStore((s) => s.sessions[request.sessionId]);
  const draft = useAppStore((s) => s.questionDrafts[request.requestId]);
  const setQuestionDraft = useAppStore((s) => s.setQuestionDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const answers = draft?.answers ?? {};
  const freeText = draft?.freeText ?? {};

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const choose = (key: string, value: string, multi: boolean) => {
    const current = useAppStore.getState().questionDrafts[request.requestId];
    const selected = current?.answers ?? {};
    const cur = selected[key] ?? [];
    setQuestionDraft(request.requestId, {
      answers: {
        ...selected,
        [key]: multi ? (cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value]) : [value],
      },
      freeText: current?.freeText ?? {},
    });
  };

  const changeFreeText = (key: string, value: string) => {
    const current = useAppStore.getState().questionDrafts[request.requestId];
    setQuestionDraft(request.requestId, {
      answers: current?.answers ?? {},
      freeText: { ...(current?.freeText ?? {}), [key]: value },
    });
  };

  const submitAnswers = async (answersToSend: QuestionAnswers) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await replyQuestion(request.requestId, answersToSend);
    } catch (err) {
      if (mountedRef.current) setError(err);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const submit = () => {
    const current = useAppStore.getState().questionDrafts[request.requestId];
    void submitAnswers(buildQuestionAnswers(request, current?.answers ?? {}, current?.freeText ?? {}));
  };

  return (
    <FullScreenDialog
      role="alertdialog"
      busy={busy}
      title={t("card.title")}
      description={t("card.session", { title: session?.title ?? request.sessionId })}
      titleClassName="text-teal-200"
      footer={
        <div className="flex gap-3">
          <button
            type="button"
            data-testid="question-dismiss"
            disabled={busy}
            onClick={() => void submitAnswers(dismissQuestionAnswers(request))}
            className="min-h-12 rounded-xl px-4 py-3 text-sm text-slate-300 transition-colors active:bg-slate-800 disabled:opacity-40"
          >
            {t("card.cancel")}
          </button>
          <button
            type="button"
            data-testid="question-submit"
            disabled={busy}
            onClick={submit}
            className="min-h-12 flex-1 rounded-xl bg-teal-700 px-4 py-3 text-sm font-medium text-white transition-colors active:bg-teal-600 disabled:opacity-40"
          >
            {busy ? tMobile("request.submitting") : t("card.submit")}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {error != null && (
          <div
            role="alert"
            className="safe-break rounded-xl border border-red-900/60 bg-red-950/40 px-3 py-2.5 text-xs leading-5 text-red-300"
          >
            {errorText(error)}
          </div>
        )}
        {request.questions.map((q, qi) => {
          const key = String(qi);
          const isMulti = q.multiSelect ?? false;
          const questionText = q.presentation?.question ? renderMessage(q.presentation.question) : q.question;
          const questionId = `mobile-question-${qi}`;
          return (
            <section
              key={key}
              aria-labelledby={questionId}
              className="rounded-2xl border border-slate-700/80 bg-slate-900/60 p-4"
            >
              {q.header && (
                <div className="safe-break mb-1.5 text-xs font-medium text-teal-200">
                  {q.presentation?.header ? renderMessage(q.presentation.header) : q.header}
                </div>
              )}
              <div id={questionId} className="safe-break text-sm font-medium leading-6 text-slate-100">
                {questionText}
              </div>
              {isMulti && <div className="mt-1 text-xs text-slate-400">{t("card.multiSelect")}</div>}
              <div className="mt-3 flex flex-wrap gap-2">
                {q.options?.map((opt, oi) => {
                  const selected = (answers[key] ?? []).includes(opt.value);
                  const description = opt.presentation?.description
                    ? renderMessage(opt.presentation.description)
                    : opt.description;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      aria-pressed={selected}
                      data-testid={`question-option-${qi}-${oi}`}
                      disabled={busy}
                      onClick={() => choose(key, opt.value, isMulti)}
                      className={`safe-break min-h-11 max-w-full rounded-xl border px-3.5 py-2.5 text-left text-sm leading-5 transition-colors disabled:opacity-40 ${
                        selected
                          ? "border-teal-600 bg-teal-800/70 text-teal-50"
                          : "border-slate-700 bg-slate-800/80 text-slate-200"
                      }`}
                    >
                      <span className="block">
                        {opt.presentation?.label ? renderMessage(opt.presentation.label) : opt.label}
                      </span>
                      {description && <span className="mt-1 block text-xs leading-5 opacity-75">{description}</span>}
                    </button>
                  );
                })}
              </div>
              <input
                value={freeText[key] ?? ""}
                onChange={(e) => changeFreeText(key, e.target.value)}
                disabled={busy}
                placeholder={t(q.options?.length ? "card.typeInstead" : "card.typeAnswer")}
                aria-label={t(q.options?.length ? "card.typeInstead" : "card.typeAnswer")}
                data-testid={`question-free-text-${qi}`}
                className="mt-3 min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-base text-slate-100 outline-none placeholder:text-slate-600 focus:border-teal-500 disabled:opacity-40"
              />
            </section>
          );
        })}
      </div>
    </FullScreenDialog>
  );
}
