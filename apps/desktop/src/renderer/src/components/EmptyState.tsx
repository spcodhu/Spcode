/**
 * 空会话页（新会话 / 草稿会话的默认视图）：
 * 居中 hero + 项目上下文 + 建议卡片（点击预填输入框）+ 键位提示。
 * 交互参考主流 Agentic Code 工具（Cursor / Claude Code）的空态做法。
 */
import { useState } from "react";
import type { SessionMeta } from "@spcode/shared";
import { Icon } from "./Icon";
import { prefillComposer } from "./Composer";

interface Suggestion {
  icon: string;
  title: string;
  desc: string;
  prompt: string;
}

const PROJECT_SUGGESTIONS: Suggestion[] = [
  {
    icon: "search",
    title: "读懂这个项目",
    desc: "梳理架构、核心模块与技术栈",
    prompt: "读懂这个项目，告诉我它是干什么的：整体架构、核心模块、技术栈，以及上手需要先看哪些文件。",
  },
  {
    icon: "bug",
    title: "定位并修复问题",
    desc: "描述现象，我来排查根因并修改",
    prompt: "帮我定位并修复这个问题：",
  },
  {
    icon: "clipboardCheck",
    title: "审查最近改动",
    desc: "检查 git diff，指出风险与隐患",
    prompt: "审查当前分支最近的改动（git diff），指出潜在 bug、风险与可以改进的地方。",
  },
  {
    icon: "check",
    title: "补充测试",
    desc: "为核心逻辑补单元测试",
    prompt: "先看一下项目现有测试覆盖情况，然后为核心逻辑补充单元测试。",
  },
];

const CHAT_SUGGESTIONS: Suggestion[] = [
  {
    icon: "sparkles",
    title: "头脑风暴",
    desc: "一起发散想法，整理成可行方案",
    prompt: "我们来头脑风暴一下：",
  },
  {
    icon: "pen",
    title: "写作与润色",
    desc: "起草、改写、压缩或翻译文本",
    prompt: "帮我写一段：",
  },
  {
    icon: "chart",
    title: "分析与研究",
    desc: "拆解问题，给出结构化结论",
    prompt: "帮我分析这个问题：",
  },
  {
    icon: "book",
    title: "学习答疑",
    desc: "讲清概念，配合例子与类比",
    prompt: "给我讲讲：",
  },
];

function greetingOf(): string {
  const h = new Date().getHours();
  if (h < 5) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

function baseName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function SessionEmptyState({ meta }: { meta: SessionMeta }) {
  const isProject = meta.mode === "project";
  const suggestions = isProject ? PROJECT_SUGGESTIONS : CHAT_SUGGESTIONS;

  return (
    <div className="flex flex-col items-center">
      {/* 顶部微光晕：让居中块有呼吸感，不抢视觉 */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 h-64 w-[560px] -translate-x-1/2"
        style={{
          background:
            "radial-gradient(closest-side, var(--color-accent-soft), transparent)",
        }}
      />

      {/* 标志块 */}
      <div className="fade-up relative mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-bg-elevated shadow-lg">
        <div
          aria-hidden
          className="absolute inset-0 rounded-2xl"
          style={{
            background:
              "radial-gradient(closest-side, var(--color-accent-soft), transparent 75%)",
          }}
        />
        <Icon name="zap" size={22} className="relative text-accent" strokeWidth={1.9} />
      </div>

      {/* 标题 / 副标题 */}
      <h1 className="fade-up text-[21px] font-semibold leading-snug text-text-primary" style={{ animationDelay: "50ms" }}>
        {greetingOf()}，今天想做点什么？
      </h1>
      <p className="fade-up mt-1.5 text-center text-[13px] leading-relaxed text-text-tertiary" style={{ animationDelay: "90ms" }}>
        {isProject ? (
          <>
            在 <span className="text-text-secondary">{baseName(meta.cwd)}</span> 里直接说你要做什么，剩下的交给我
          </>
        ) : (
          <>直接说你要做什么，我可以写作、分析、答疑，也能帮你处理文件</>
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
            key={s.title}
            onClick={() => prefillComposer(s.prompt)}
            className="fade-up group flex flex-col gap-1.5 rounded-2xl border border-border bg-bg-elevated/60 px-4 py-3.5 text-left transition-colors hover:border-border-strong hover:bg-bg-hover"
            style={{ animationDelay: `${170 + i * 55}ms` }}
          >
            <span className="flex items-center gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent transition-colors group-hover:bg-accent group-hover:text-white">
                <Icon name={s.icon} size={13} strokeWidth={2} />
              </span>
              <span className="text-[13px] font-medium text-text-primary">{s.title}</span>
            </span>
            <span className="text-[12px] leading-relaxed text-text-tertiary">{s.desc}</span>
          </button>
        ))}
      </div>

      {/* 键位提示 */}
      <div className="fade-up mt-7 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[11.5px] text-text-tertiary" style={{ animationDelay: "420ms" }}>
        <span className="flex items-center gap-1">
          <Kbd>Enter</Kbd> 发送
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd> 换行
        </span>
        <span className="flex items-center gap-1">
          <Icon name="plus" size={11} /> 粘贴 / 拖入图片
        </span>
        {isProject && (
          <span className="flex items-center gap-1">
            <Icon name="clipboard" size={11} /> 「计划」先出方案再执行
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
  const [copied, setCopied] = useState(false);
  return (
    <button
      title="复制项目路径"
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
