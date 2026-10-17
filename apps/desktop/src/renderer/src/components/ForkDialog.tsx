import { useEffect, useMemo, useState } from "react";
import type { ModelRef } from "@spcode/shared";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { Select } from "./ui/Select";
import { Switch } from "./ui/Switch";

/**
 * Fork 会话弹窗：复制源会话的完整上下文到一个新会话。
 * 标题 / 模型 / 思考档位 / 计划模式可在新会话上覆盖（未改的继承源会话），
 * 原会话不受任何影响、可继续独立使用（对照 Claude Code --fork-session 语义）。
 */
export function ForkDialog({ sourceId, onClose }: { sourceId: string; onClose: () => void }) {
  const source = useStore((s) => s.registrySessions.find((r) => r.id === sourceId));
  const sourceRunning = useStore((s) => s.sessions[sourceId]?.running ?? false);
  const models = useStore((s) => s.models);
  const settings = useStore((s) => s.settings);
  const forkSession = useStore((s) => s.forkSession);

  const [title, setTitle] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [planMode, setPlanMode] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 源条目就绪后初始化表单（弹窗打开时一次性落定）
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (!source || initialized) return;
    setTitle(`${source.title} · 分叉`);
    const m = source.model ?? settings?.defaultModel ?? null;
    setModelKey(m ? `${m.provider}/${m.modelId}` : "");
    setThinkingLevel(source.thinkingLevel || settings?.defaultThinkingLevel || "medium");
    setPlanMode(source.planMode ?? false);
    setInitialized(true);
  }, [source, initialized, settings]);

  // Esc 关闭（Select 自身的 Esc 收起先触发；弹窗级 Esc 兜底）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** 可选模型：过滤掉设置里停用的厂商/模型（与 Composer 口径一致） */
  const enabledModels = useMemo(
    () =>
      models.filter(
        (m) =>
          !(settings?.disabledProviders ?? []).includes(m.provider) &&
          !(settings?.disabledModels ?? []).includes(`${m.provider}/${m.modelId}`),
      ),
    [models, settings],
  );

  const selectedModel = enabledModels.find((m) => `${m.provider}/${m.modelId}` === modelKey) ?? null;
  const thinkingLevels = selectedModel?.thinkingLevels ?? [];

  if (!source) return null;

  const confirm = async () => {
    if (submitting || sourceRunning) return;
    setSubmitting(true);
    setError(null);
    const model: ModelRef | undefined = selectedModel
      ? { provider: selectedModel.provider, modelId: selectedModel.modelId }
      : undefined;
    try {
      await forkSession(sourceId, {
        title,
        model,
        thinkingLevel: thinkingLevel || undefined,
        planMode,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/55 pt-[16vh] backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[440px] max-w-[92vw] rounded-2xl border border-border-strong bg-bg-main shadow-2xl">
        {/* 头部 */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Icon name="branch" size={16} className="shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium text-text-primary">Fork 会话</div>
            <div className="truncate text-[12px] text-text-tertiary">
              复制「{source.title}」的全部上下文到新会话，原会话可继续独立使用
            </div>
          </div>
        </div>

        <div className="space-y-4 px-4 py-4">
          {/* 标题 */}
          <label className="block">
            <span className="mb-1.5 block text-[12px] text-text-tertiary">新会话标题</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-[13px] text-text-primary outline-none focus:border-border-strong"
            />
          </label>

          {/* 模型 */}
          <label className="block">
            <span className="mb-1.5 block text-[12px] text-text-tertiary">模型</span>
            <Select
              value={modelKey}
              options={enabledModels.map((m) => ({
                value: `${m.provider}/${m.modelId}`,
                label: `${m.displayName}（${m.provider}）`,
              }))}
              onChange={(v) => {
                setModelKey(v);
                // 切换模型后思考档位跟随新模型的支持列表
                const next = enabledModels.find((m) => `${m.provider}/${m.modelId}` === v);
                const levels = next?.thinkingLevels ?? [];
                if (levels.length > 0 && !levels.includes(thinkingLevel)) {
                  setThinkingLevel(levels.includes("medium") ? "medium" : (levels[0] ?? ""));
                }
              }}
            />
          </label>

          {/* 思考档位 */}
          {thinkingLevels.length > 0 && (
            <label className="block">
              <span className="mb-1.5 block text-[12px] text-text-tertiary">思考档位</span>
              <Select
                value={thinkingLevel}
                options={thinkingLevels.map((lv) => ({ value: lv }))}
                onChange={setThinkingLevel}
              />
            </label>
          )}

          {/* 计划模式 */}
          <div className="flex items-center justify-between rounded-lg border border-border bg-bg-elevated px-3 py-2.5">
            <div>
              <div className="text-[13px] text-text-primary">计划模式</div>
              <div className="text-[12px] text-text-tertiary">新会话先只读调研、出完整计划，你批准后才执行</div>
            </div>
            <Switch on={planMode} onChange={setPlanMode} label="计划模式" />
          </div>

          {sourceRunning && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning">
              源会话正在运行，等它停下或先中止后再分叉
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              {error}
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3.5 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={submitting || sourceRunning || !title.trim()}
            className="rounded-lg bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-dim disabled:opacity-40"
          >
            {submitting ? "分叉中…" : "Fork"}
          </button>
        </div>
      </div>
    </div>
  );
}
