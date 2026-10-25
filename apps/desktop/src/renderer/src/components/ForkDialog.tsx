import type { ModelRef } from "@spcode/shared";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import { thinkingLevelLabel } from "../tooling";
import { Icon } from "./Icon";
import { Select } from "./ui/Select";
import { Switch } from "./ui/Switch";

/**
 * Fork 会话弹窗：复制源会话的完整上下文到一个新会话。
 * 标题 / 模型 / 思考档位 / 计划模式可在新会话上覆盖（未改的继承源会话），
 * 原会话不受任何影响、可继续独立使用（对照 Claude Code --fork-session 语义）。
 */
export function ForkDialog({ sourceId, onClose }: { sourceId: string; onClose: () => void }) {
  const { t } = useTranslation("chat");
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
    setTitle(t("fork.defaultTitle", { title: source.title }));
    const m = source.model ?? settings?.defaultModel ?? null;
    setModelKey(m ? `${m.provider}/${m.modelId}` : "");
    setThinkingLevel(source.thinkingLevel || settings?.defaultThinkingLevel || "medium");
    setPlanMode(source.planMode ?? false);
    setInitialized(true);
  }, [source, initialized, settings, t]);

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
    // biome-ignore lint/a11y/noStaticElementInteractions: 遮罩点外关闭，Esc 另有键盘关闭（评审 R3：待统一 Modal 组件化时收敛）
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
            <div className="text-[14px] font-medium text-text-primary">{t("sidebar.forkSession")}</div>
            <div className="truncate text-[12px] text-text-tertiary">
              {t("fork.description", { title: source.title })}
            </div>
          </div>
        </div>

        <div className="space-y-4 px-4 py-4">
          {/* 标题 */}
          <label className="block">
            <span className="mb-1.5 block text-[12px] text-text-tertiary">{t("fork.title")}</span>
            <input
              value={title}
              data-testid="fork-title"
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-[13px] text-text-primary outline-none focus:border-border-strong"
            />
          </label>

          {/* 模型（biome-ignore：Select 是自定义按钮式下拉，label 仅作视觉标题） */}
          {/* biome-ignore lint/a11y/noLabelWithoutControl: Select 为自定义组件，label 不关联原生控件 */}
          <label className="block">
            <span className="mb-1.5 block text-[12px] text-text-tertiary">{t("common.model")}</span>
            <Select
              value={modelKey}
              label={t("common.model")}
              testId="fork-model"
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
            // biome-ignore lint/a11y/noLabelWithoutControl: Select 为自定义组件，label 不关联原生控件
            <label className="block">
              <span className="mb-1.5 block text-[12px] text-text-tertiary">{t("fork.thinking")}</span>
              <Select
                value={thinkingLevel}
                label={t("fork.thinking")}
                testId="fork-thinking"
                options={thinkingLevels.map((lv) => ({ value: lv, label: thinkingLevelLabel(lv) }))}
                onChange={setThinkingLevel}
              />
            </label>
          )}

          {/* 计划模式 */}
          <div className="flex items-center justify-between rounded-lg border border-border bg-bg-elevated px-3 py-2.5">
            <div>
              <div className="text-[13px] text-text-primary">{t("common.planMode")}</div>
              <div className="text-[12px] text-text-tertiary">{t("fork.planHint")}</div>
            </div>
            <Switch on={planMode} onChange={setPlanMode} label={t("common.planMode")} />
          </div>

          {sourceRunning && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning">
              {t("fork.running")}
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
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            data-testid="fork-confirm"
            disabled={submitting || sourceRunning || !title.trim()}
            className="rounded-lg bg-accent px-3.5 py-1.5 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-dim disabled:opacity-40"
          >
            {t(submitting ? "fork.submitting" : "fork.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
