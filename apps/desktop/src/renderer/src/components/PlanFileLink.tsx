import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import { Icon } from "./Icon";

/** AI 总结中的 Plan 文件入口：只展示文件名标识，真实路径用于右侧栏读取。 */
export function PlanFileLink({ path, label }: { path: string; label: string }) {
  const { t } = useTranslation("chat");
  const openPlanFile = useStore((s) => s.openPlanFile);
  return (
    <button
      type="button"
      data-testid="plan-file-link"
      title={path}
      onClick={() => openPlanFile(path)}
      className="my-1 inline-flex items-center gap-2 rounded-xl border border-accent/35 bg-accent-soft px-3 py-1.5 text-left text-[12.5px] text-accent transition-colors hover:border-accent/60 hover:bg-accent/20"
    >
      <Icon name="fileText" size={15} className="shrink-0" />
      <span className="mono font-medium">{label}</span>
      <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10.5px]">{t("plan.fileBadge")}</span>
      <Icon name="panelRight" size={13} className="shrink-0" />
    </button>
  );
}
