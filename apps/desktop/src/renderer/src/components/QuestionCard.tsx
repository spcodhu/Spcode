import { useState } from "react";
import { useStore } from "../store";
import type { QuestionRequest } from "@spcode/shared";

export function QuestionCard() {
  const pending = useStore((s) => s.pendingQuestions);
  const request = pending[0];
  if (!request) return null;
  return <QuestionDialog key={request.requestId} request={request} queueSize={pending.length} />;
}

function QuestionDialog({ request, queueSize }: { request: QuestionRequest; queueSize: number }) {
  const reply = useStore((s) => s.replyQuestion);
  // 每题一个答案；multiSelect 用逗号拼接
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});

  const choose = (q: string, label: string, multi?: boolean) => {
    setAnswers((m) => {
      if (!multi) return { ...m, [q]: label };
      const cur = m[q] ? m[q]!.split(", ").filter(Boolean) : [];
      const next = cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label];
      return { ...m, [q]: next.join(", ") };
    });
  };

  const submit = () => {
    const merged: Record<string, string> = {};
    for (const q of request.questions) {
      merged[q.question] = freeText[q.question]?.trim() || answers[q.question] || "";
    }
    reply(request.requestId, merged);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="max-h-[80vh] w-[520px] overflow-y-auto rounded-xl border border-border bg-bg-elevated shadow-2xl">
        <div className="border-b border-border px-5 py-3">
          <div className="text-sm font-semibold text-accent">Agent 想问你几个问题</div>
          {queueSize > 1 && <div className="mt-0.5 text-xs text-text-tertiary">还有 {queueSize - 1} 组提问</div>}
        </div>
        <div className="space-y-5 px-5 py-4">
          {request.questions.map((q) => (
            <div key={q.question}>
              <div className="mb-2 text-sm text-text-primary">{q.question}</div>
              {q.options && q.options.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {q.options.map((o) => {
                    const selected = (answers[q.question] ?? "").split(", ").includes(o.label);
                    return (
                      <button
                        key={o.label}
                        title={o.description}
                        onClick={() => choose(q.question, o.label, q.multiSelect)}
                        className={`rounded-md border px-3 py-1.5 text-xs ${
                          selected
                            ? "border-accent/60 bg-accent-soft text-accent"
                            : "border-border text-text-secondary hover:bg-bg-hover"
                        }`}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              )}
              <input
                value={freeText[q.question] ?? ""}
                onChange={(e) => setFreeText((m) => ({ ...m, [q.question]: e.target.value }))}
                placeholder="或直接输入回答…"
                className="w-full rounded-md border border-border bg-bg-main px-3 py-1.5 text-xs outline-none focus:border-accent/50"
              />
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            onClick={() => reply(request.requestId, {})}
            className="rounded-md border border-border px-4 py-1.5 text-xs text-text-tertiary hover:bg-bg-hover"
          >
            跳过
          </button>
          <button
            onClick={submit}
            className="rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-bg-root hover:bg-accent-dim"
          >
            提交回答
          </button>
        </div>
      </div>
    </div>
  );
}
