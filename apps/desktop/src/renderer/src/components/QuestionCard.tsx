import { useState } from "react";
import { useStore } from "../store";
import type { QuestionRequest } from "@spcode/shared";
import { Icon } from "./Icon";

/**
 * 会话内嵌的提问卡片（Finch 风格）：
 * 只渲染属于当前会话的提问，不再全局弹窗——多个会话同时有提问时互不打扰，
 * 用户回到对应会话时自然看到并回答；侧栏会话行上有「?」标记提示。
 */
export function QuestionInline({ sessionId }: { sessionId: string }) {
  const pending = useStore((s) => s.pendingQuestions);
  const queue = pending.filter((q) => q.sessionId === sessionId);
  const request = queue[0];
  if (!request || request.questions.length === 0) return null;
  return (
    <div className="shrink-0 px-6 pb-2">
      <div className="mx-auto max-w-3xl">
        <QuestionCard key={request.requestId} request={request} queueSize={queue.length} />
      </div>
    </div>
  );
}

function QuestionCard({ request, queueSize }: { request: QuestionRequest; queueSize: number }) {
  const reply = useStore((s) => s.replyQuestion);
  // 每题一个答案，按题号索引（不按问题文本——同文案两题会互相覆盖，评审 P2-5）；
  // multiSelect 用逗号拼接
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [freeText, setFreeText] = useState<Record<number, string>>({});
  const [page, setPage] = useState(0);

  const total = request.questions.length;
  const idx = Math.min(page, total - 1);
  const q = request.questions[idx]!;

  const choose = (label: string) => {
    setAnswers((m) => {
      if (!q.multiSelect) return { ...m, [idx]: label };
      const cur = m[idx] ? m[idx]!.split(", ").filter(Boolean) : [];
      const next = cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label];
      return { ...m, [idx]: next.join(", ") };
    });
  };

  const isSelected = (label: string) => (answers[idx] ?? "").split(", ").includes(label);
  const answeredAny = request.questions.some(
    (_item, i) => freeText[i]?.trim() || answers[i],
  );

  const submit = () => {
    // 协议以问题文本为键（ask-user 工具渲染 Q/A 对）；同文案题后者覆盖前者，属可接受边界
    const merged: Record<string, string> = {};
    request.questions.forEach((item, i) => {
      merged[item.question] = freeText[i]?.trim() || answers[i] || "";
    });
    reply(request.requestId, merged);
  };

  return (
    <div className="rounded-2xl border border-accent/25 bg-bg-elevated shadow-lg">
      {/* 头部：问题标题 + 多题分页 */}
      <div className="flex items-start justify-between gap-3 px-4 pt-3.5">
        <div className="min-w-0">
          {q.header && <div className="mb-1 text-[11px] font-medium text-accent">{q.header}</div>}
          <div className="text-[14px] font-semibold leading-5 text-text-primary">{q.question}</div>
          {queueSize > 1 && (
            <div className="mt-0.5 text-[11px] text-text-tertiary">还有 {queueSize - 1} 组提问</div>
          )}
        </div>
        {total > 1 && (
          <div className="flex shrink-0 items-center gap-0.5 text-[12px] tabular-nums text-text-tertiary">
            <button
              disabled={idx === 0}
              onClick={() => setPage(idx - 1)}
              title="上一题"
              className="rounded p-1 hover:bg-bg-hover hover:text-text-secondary disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-tertiary"
            >
              <Icon name="chevronRight" size={12} className="rotate-180" />
            </button>
            <span>
              {idx + 1}/{total}
            </span>
            <button
              disabled={idx === total - 1}
              onClick={() => setPage(idx + 1)}
              title="下一题"
              className="rounded p-1 hover:bg-bg-hover hover:text-text-secondary disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-tertiary"
            >
              <Icon name="chevronRight" size={12} />
            </button>
          </div>
        )}
      </div>

      {/* 选项列表：编号徽标 + 标题 + 描述，选中高亮 */}
      {q.options && q.options.length > 0 && (
        <div className="space-y-1 px-2 pt-2.5">
          {q.options.map((o, i) => {
            const selected = isSelected(o.label);
            return (
              <button
                key={o.label}
                onClick={() => choose(o.label)}
                className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                  selected ? "bg-accent-soft" : "hover:bg-bg-hover"
                }`}
              >
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[11px] ${
                    selected
                      ? "border-accent/60 bg-accent/15 text-accent"
                      : "border-border text-text-tertiary"
                  }`}
                >
                  {selected && q.multiSelect ? <Icon name="check" size={11} /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span
                    className={`block text-[13px] leading-5 ${selected ? "text-accent" : "text-text-primary"}`}
                  >
                    {o.label}
                  </span>
                  {o.description && (
                    <span className="mt-0.5 block text-[12px] leading-4 text-text-tertiary">{o.description}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* 自由输入：任何题都可以直接打字回答，回车提交 */}
      <div className="px-4 pt-2.5">
        <input
          value={freeText[idx] ?? ""}
          onChange={(e) => setFreeText((m) => ({ ...m, [idx]: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="其他回答…"
          className="w-full rounded-lg bg-bg-main px-3 py-2 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:ring-1 focus:ring-accent/40"
        />
      </div>

      {/* 底部：取消 + 发送 */}
      <div className="flex items-center justify-end gap-3 px-4 py-3">
        <button
          onClick={() => reply(request.requestId, {})}
          className="text-[13px] text-text-tertiary transition-colors hover:text-text-secondary"
        >
          取消
        </button>
        <button
          onClick={submit}
          title="提交回答"
          className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
            answeredAny
              ? "bg-accent text-bg-root hover:bg-accent-dim"
              : "bg-bg-active text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
          }`}
        >
          <Icon name="arrowUp" size={14} strokeWidth={2.2} className="rotate-90" />
        </button>
      </div>
    </div>
  );
}
