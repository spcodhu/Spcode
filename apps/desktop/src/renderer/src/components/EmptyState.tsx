/**
 * 空会话页（新会话 / 草稿会话的默认视图）：
 * 居中 hero + 项目上下文 + 建议卡片（点击预填输入框）+ 键位提示。
 * 交互参考主流 Agentic Code 工具（Cursor / Claude Code）的空态做法。
 */

import type { SessionMeta } from "@spcode/shared";
import { baseName } from "@spcode/shared";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { prefillComposer } from "./Composer";
import { Icon } from "./Icon";

const PROJECT_SUGGESTIONS = [
  { icon: "search", key: "understand" },
  { icon: "bug", key: "fix" },
  { icon: "clipboardCheck", key: "review" },
  { icon: "check", key: "test" },
] as const;

const CHAT_SUGGESTIONS = [
  { icon: "sparkles", key: "brainstorm" },
  { icon: "pen", key: "write" },
  { icon: "chart", key: "analyze" },
  { icon: "book", key: "learn" },
] as const;

function greetingKey(): `empty.greeting.${"night" | "morning" | "noon" | "afternoon" | "evening"}` {
  const h = new Date().getHours();
  if (h < 5) return "empty.greeting.night";
  if (h < 11) return "empty.greeting.morning";
  if (h < 14) return "empty.greeting.noon";
  if (h < 18) return "empty.greeting.afternoon";
  return "empty.greeting.evening";
}

export function SessionEmptyState({ meta }: { meta: SessionMeta }) {
  const { t } = useTranslation("chat");
  const isProject = meta.mode === "project";
  const suggestions = isProject ? PROJECT_SUGGESTIONS : CHAT_SUGGESTIONS;

  return (
    <div className="flex flex-col items-center" data-testid="empty-state">
      {/* 顶部微光晕：让居中块有呼吸感，不抢视觉 */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 h-64 w-[560px] -translate-x-1/2"
        style={{
          background: "radial-gradient(closest-side, var(--color-accent-soft), transparent)",
        }}
      />

      {/* 标志块 */}
      <div className="fade-up relative mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-bg-elevated shadow-lg">
        <div
          aria-hidden
          className="absolute inset-0 rounded-2xl"
          style={{
            background: "radial-gradient(closest-side, var(--color-accent-soft), transparent 75%)",
          }}
        />
        <Icon name="zap" size={22} className="relative text-accent" strokeWidth={1.9} />
      </div>

      {/* 标题 / 副标题 */}
      <h1
        className="fade-up text-[21px] font-semibold leading-snug text-text-primary"
        style={{ animationDelay: "50ms" }}
      >
        {t(greetingKey())}
      </h1>
      <p
        className="fade-up mt-1.5 text-center text-[13px] leading-relaxed text-text-tertiary"
        style={{ animationDelay: "90ms" }}
      >
        {isProject ? (
          <Trans
            t={t}
            i18nKey="empty.projectHint"
            values={{ project: baseName(meta.cwd) }}
            components={{ project: <span className="text-text-secondary" /> }}
          />
        ) : (
          t("empty.chatHint")
        )}
      </p>

      {/* 项目路径 chip（点击复制） */}
      {isProject && (
        <div className="fade-up mt-4" style={{ animationDelay: "130ms" }}>
          <CwdChip cwd={meta.cwd} />
        </div>
      )}

      {/* 建议卡片 */}
      <div className="mt-7 grid w-full grid-cols-2 gap-2.5">
        {suggestions.map((s, i) => (
          <button
            type="button"
            key={s.key}
            data-testid={`suggestion-${s.key}`}
            onClick={() => prefillComposer(t(`suggestion.${s.key}.prompt`))}
            className="fade-up group flex flex-col gap-1.5 rounded-2xl border border-border bg-bg-elevated/60 px-4 py-3.5 text-left transition-colors hover:border-border-strong hover:bg-bg-hover"
            style={{ animationDelay: `${170 + i * 55}ms` }}
          >
            <span className="flex items-center gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent transition-colors group-hover:bg-accent group-hover:text-on-accent">
                <Icon name={s.icon} size={13} strokeWidth={2} />
              </span>
              <span className="text-[13px] font-medium text-text-primary">{t(`suggestion.${s.key}.title`)}</span>
            </span>
            <span className="text-[12px] leading-relaxed text-text-tertiary">{t(`suggestion.${s.key}.desc`)}</span>
          </button>
        ))}
      </div>

      {/* 键位提示 */}
      <div
        className="fade-up mt-7 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[11.5px] text-text-tertiary"
        style={{ animationDelay: "420ms" }}
      >
        <span className="flex items-center gap-1">
          <Kbd>Enter</Kbd> {t("common.send")}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd> {t("empty.newLine")}
        </span>
        <span className="flex items-center gap-1">
          <Icon name="plus" size={11} /> {t("empty.images")}
        </span>
        {isProject && (
          <span className="flex items-center gap-1">
            <Icon name="clipboard" size={11} /> {t("empty.planHint")}
          </span>
        )}
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mono rounded-md border border-border bg-bg-elevated px-1.5 py-0.5 text-[10px] text-text-secondary">
      {children}
    </kbd>
  );
}

function CwdChip({ cwd }: { cwd: string }) {
  const { t } = useTranslation("chat");
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={t(copied ? "empty.pathCopied" : "empty.copyPath")}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(cwd)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => {});
      }}
      className="flex max-w-[420px] items-center gap-2 rounded-full border border-border bg-bg-elevated/60 px-3.5 py-1.5 text-[12px] transition-colors hover:border-border-strong hover:bg-bg-hover"
    >
      <Icon name="folder" size={13} className="shrink-0 text-accent" />
      <span className="truncate text-text-secondary">{cwd}</span>
      <Icon
        name={copied ? "check" : "copy"}
        size={12}
        className={`shrink-0 transition-colors ${copied ? "text-success" : "text-text-tertiary"}`}
      />
    </button>
  );
}
