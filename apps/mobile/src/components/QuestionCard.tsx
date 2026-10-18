/**
 * 结构化提问卡（AskUserQuestion）：选项单选/多选 + 自由文本兜底。
 * 回复后本地移除（与权限卡同「先到先得」语义）。
 */

import type { QuestionRequest } from "@spcode/shared";
import { useState } from "react";
import { replyQuestion } from "../state/controller";
import { useAppStore } from "../state/store";

export function QuestionCard({ request }: { request: QuestionRequest }) {
  const session = useAppStore((s) => s.sessions[request.sessionId]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [multi, setMulti] = useState<Record<string, string[]>>({});

  const setAnswer = (key: string, value: string) => setAnswers((a) => ({ ...a, [key]: value }));

  const toggleMulti = (key: string, label: string) =>
    setMulti((m) => {
      const cur = m[key] ?? [];
      return { ...m, [key]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
    });

  const submit = () => {
    const merged: Record<string, string> = { ...answers };
    for (const [k, v] of Object.entries(multi)) if (v.length) merged[k] = v.join("、");
    void replyQuestion(request.requestId, merged);
  };

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-[#0b0f14f2]">
      <div className="px-5 pt-10">
        <div className="text-lg font-bold text-sky-200">agent 在提问</div>
        <div className="mt-1 text-xs text-slate-400">会话：{session?.title ?? request.sessionId}</div>
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {request.questions.map((q, qi) => {
          const key = String(qi); // 协议键 = 题号索引（三端统一，ask-user 按索引还原题目文本）
          const isMulti = q.multiSelect ?? false;
          return (
            <div key={key} className="mb-5 rounded-xl border border-slate-700 bg-slate-900/70 p-4">
              <div className="text-sm font-medium text-slate-100">{q.question}</div>
              {isMulti && <div className="mt-1 text-[11px] text-slate-500">可多选</div>}
              <div className="mt-3 flex flex-wrap gap-2">
                {q.options?.map((opt) => {
                  const selected = isMulti ? (multi[key] ?? []).includes(opt.label) : answers[key] === opt.label;
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      title={opt.description}
                      onClick={() => (isMulti ? toggleMulti(key, opt.label) : setAnswer(key, opt.label))}
                      className={`rounded-full px-3 py-1.5 text-xs ${
                        selected ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300"
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <input
                value={answers[key] ?? ""}
                onChange={(e) => setAnswer(key, e.target.value)}
                placeholder={q.options?.length ? "或直接输入…" : "输入回答…"}
                className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
              />
            </div>
          );
        })}
      </div>

      <div className="flex gap-3 px-5 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={submit}
          className="flex-1 rounded-xl bg-sky-600 py-3 text-sm font-medium text-white"
        >
          提交回答
        </button>
      </div>
    </div>
  );
}
