/** Structured questions: stable option selections, verbatim free text, explicit dismissal. */
import { buildQuestionAnswers, dismissQuestionAnswers, type QuestionRequest } from "@spcode/shared";
import { renderMessage } from "@spcode/shared/i18n";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { replyQuestion } from "../state/controller";
import { useAppStore } from "../state/store";

export function QuestionCard({ request }: { request: QuestionRequest }) {
  // Reset only for a new request, never for a locale change.
  return <QuestionDraft key={request.requestId} request={request} />;
}

function QuestionDraft({ request }: { request: QuestionRequest }) {
  const { t } = useTranslation("questions");
  const session = useAppStore((s) => s.sessions[request.sessionId]);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});

  const choose = (key: string, value: string, multi: boolean) =>
    setAnswers((m) => {
      const cur = m[key] ?? [];
      return {
        ...m,
        [key]: multi ? (cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value]) : [value],
      };
    });

  const submit = () => void replyQuestion(request.requestId, buildQuestionAnswers(request, answers, freeText));

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-[#0b0f14f2]">
      <div className="px-5 pt-10">
        <div className="text-lg font-bold text-sky-200">{t("card.title")}</div>
        <div className="mt-1 text-xs text-slate-400">
          {t("card.session", { title: session?.title ?? request.sessionId })}
        </div>
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {request.questions.map((q, qi) => {
          const key = String(qi);
          const isMulti = q.multiSelect ?? false;
          return (
            <div key={key} className="mb-5 rounded-xl border border-slate-700 bg-slate-900/70 p-4">
              {q.header && (
                <div className="mb-1 text-xs text-sky-200">
                  {q.presentation?.header ? renderMessage(q.presentation.header) : q.header}
                </div>
              )}
              <div className="text-sm font-medium text-slate-100">
                {q.presentation?.question ? renderMessage(q.presentation.question) : q.question}
              </div>
              {isMulti && <div className="mt-1 text-[11px] text-slate-500">{t("card.multiSelect")}</div>}
              <div className="mt-3 flex flex-wrap gap-2">
                {q.options?.map((opt, oi) => {
                  const selected = (answers[key] ?? []).includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      title={
                        opt.presentation?.description ? renderMessage(opt.presentation.description) : opt.description
                      }
                      aria-pressed={selected}
                      data-testid={`question-option-${qi}-${oi}`}
                      onClick={() => choose(key, opt.value, isMulti)}
                      className={`rounded-full px-3 py-1.5 text-xs ${
                        selected ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300"
                      }`}
                    >
                      {opt.presentation?.label ? renderMessage(opt.presentation.label) : opt.label}
                    </button>
                  );
                })}
              </div>
              <input
                value={freeText[key] ?? ""}
                onChange={(e) => setFreeText((m) => ({ ...m, [key]: e.target.value }))}
                placeholder={t(q.options?.length ? "card.typeInstead" : "card.typeAnswer")}
                data-testid={`question-free-text-${qi}`}
                className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
              />
            </div>
          );
        })}
      </div>

      <div className="flex gap-3 px-5 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          data-testid="question-dismiss"
          onClick={() => void replyQuestion(request.requestId, dismissQuestionAnswers(request))}
          className="rounded-xl px-3 py-3 text-sm text-slate-300"
        >
          {t("card.cancel")}
        </button>
        <button
          type="button"
          data-testid="question-submit"
          onClick={submit}
          className="flex-1 rounded-xl bg-sky-600 py-3 text-sm font-medium text-white"
        >
          {t("card.submit")}
        </button>
      </div>
    </div>
  );
}
