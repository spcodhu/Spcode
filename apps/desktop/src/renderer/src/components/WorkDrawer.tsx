/**
 * 工作抽屉（Kimi / Finch 风格）：悬浮在输入框上方的工作面板，
 * 形如书柜抽屉 —— 面板脸永远贴着输入框，顶部有抓手，内容腔向上"拉出"。
 *
 * 承载两样工作状态：
 * - 任务清单（TodoWrite 实时状态）：进行中自动展开（当前项高亮 + 转圈），
 *   全部完成后自动收起成一行摘要；手动开合随时可用
 * - 计划模式提示：开启时面板挂小徽章，腔内显示说明（不再占一条大横幅）
 */

import type { TodoItem } from "@spcode/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";

export function WorkDrawer({ todos, planMode }: { todos: TodoItem[]; planMode: boolean }) {
  const { t } = useTranslation("chat");
  const done = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress");
  const hasTodos = todos.length > 0;
  const allDone = hasTodos && done === todos.length;

  const [open, setOpen] = useState(!allDone);
  // 自动跟随完成态翻转：进行中→展开，全部完成→收起。
  // 但用户手动开合过就不再强制复位（评审 N2：原 effect 在 allDone 每次翻转时都覆盖用户状态）——
  // 只当当前开合仍等于"上次自动值"（用户没动过）时才跟随。
  const lastAuto = useRef(!allDone);
  useEffect(() => {
    const auto = !allDone;
    setOpen((cur) => (cur === lastAuto.current ? auto : cur));
    lastAuto.current = auto;
  }, [allDone]);

  if (!hasTodos && !planMode) return null;

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-bg-elevated shadow-lg">
      {/* 屉腔：内容向上展开（计划说明 + 任务明细） */}
      <div className="collapse-grid" data-open={open}>
        <div className="collapse-inner">
          <div className="border-b border-border px-3.5 py-2.5">
            {planMode && (
              <div className="mb-2 flex items-start gap-2 rounded-xl border border-accent/25 bg-accent/10 px-3 py-2 text-[12px] leading-5 text-accent">
                <Icon name="info" size={13} className="mt-[3px] shrink-0" />
                <span>{t("work.planHint")}</span>
              </div>
            )}
            {hasTodos && (
              <div className="space-y-0.5">
                {todos.map((t) => (
                  // TodoWrite 每次全量下发且同清单内 content 不重复（重复项渲染完全等价，无内部状态）
                  <TaskRow key={t.content} todo={t} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 抽屉面板脸：永远贴着输入框，带抓手；点击开合 */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        data-testid="work-drawer-toggle"
        className="group relative flex w-full items-center gap-2.5 px-3.5 pb-2.5 pt-3 text-left"
      >
        {/* 抓手 */}
        <span
          aria-hidden
          className="absolute left-1/2 top-[5px] h-[3px] w-8 -translate-x-1/2 rounded-full bg-border-strong transition-colors group-hover:bg-text-tertiary"
        />
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${
            allDone ? "bg-success/15 text-success" : "bg-accent-soft text-accent"
          }`}
        >
          <Icon name={allDone ? "check" : hasTodos ? "clipboardCheck" : "clipboard"} size={11} strokeWidth={2.2} />
        </span>

        {hasTodos ? (
          <>
            <span className="shrink-0 text-[12.5px] font-medium text-text-primary">{t("work.tasks")}</span>
            <span className="shrink-0 text-[11.5px] text-text-tertiary">
              {done}/{todos.length}
            </span>
            {/* 进度条 */}
            <span className="h-[3px] w-14 shrink-0 overflow-hidden rounded-full bg-bg-hover">
              <span
                className="block h-full rounded-full transition-all duration-300"
                style={{
                  width: `${todos.length ? (done / todos.length) * 100 : 0}%`,
                  background: allDone ? "var(--color-success)" : "var(--color-accent)",
                }}
              />
            </span>
          </>
        ) : (
          <span className="shrink-0 text-[12.5px] font-medium text-text-primary">{t("common.planMode")}</span>
        )}

        <span className="flex-1" />

        {planMode && hasTodos && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10.5px] text-accent">
            <Icon name="clipboard" size={10} strokeWidth={2.2} />
            {t("common.planMode")}
          </span>
        )}
        {hasTodos ? (
          current ? (
            <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-accent">
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
              <span className="truncate">{current.activeForm ?? current.content}</span>
            </span>
          ) : allDone ? (
            <span className="shrink-0 text-[11.5px] text-success">{t("work.allDone")}</span>
          ) : null
        ) : (
          <span className="min-w-0 truncate text-[11.5px] text-text-tertiary">{t("work.planSummary")}</span>
        )}

        {/* 抽屉拉手方向：收起时箭头朝上（向上拉开），展开后朝下（收回） */}
        <Icon
          name="chevronDown"
          size={12}
          className={`shrink-0 text-text-tertiary transition-transform duration-150 ${open ? "" : "rotate-180"}`}
        />
      </button>
    </div>
  );
}

function TaskRow({ todo }: { todo: TodoItem }) {
  const { t } = useTranslation("chat");
  const isDone = todo.status === "completed";
  const isCurrent = todo.status === "in_progress";
  return (
    <div className="flex items-start gap-2.5 py-[3px]">
      <span
        title={t(isDone ? "work.completed" : isCurrent ? "work.inProgress" : "work.pending")}
        className={`mt-[2px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
          isDone
            ? "border-transparent bg-success/15 text-success"
            : isCurrent
              ? "border-accent/60"
              : "border-border-strong"
        }`}
      >
        {isDone ? (
          <Icon name="check" size={10} strokeWidth={2.6} />
        ) : isCurrent ? (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
        ) : null}
      </span>
      <span
        className={`text-[12.5px] leading-5 ${
          isDone ? "text-text-tertiary" : isCurrent ? "text-text-primary" : "text-text-secondary"
        }`}
      >
        {isCurrent && todo.activeForm ? todo.activeForm : todo.content}
      </span>
    </div>
  );
}
