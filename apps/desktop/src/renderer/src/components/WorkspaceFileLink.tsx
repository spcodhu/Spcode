import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import { Icon } from "./Icon";

/**
 * 模型正文中的本地文件入口：计划文件与项目/scratch 文件共用同一视觉语言，
 * 点击后由主进程校验路径并在右侧工作区面板预览，不在窗口内导航。
 */
export function WorkspaceFileLink({ path, label, kind }: { path: string; label: string; kind: "plan" | "file" }) {
  const { t } = useTranslation("chat");
  const openWorkspaceFile = useStore((s) => s.openWorkspaceFile);
  const isPlan = kind === "plan";
  return (
    <button
      type="button"
      data-testid={isPlan ? "plan-file-link" : "workspace-file-link"}
      title={path}
      onClick={() => void openWorkspaceFile({ path, kind, label })}
      className="my-1 inline-flex max-w-full items-center gap-2 rounded-xl border border-accent/35 bg-accent-soft px-3 py-1.5 text-left text-[12.5px] text-accent transition-colors hover:border-accent/60 hover:bg-accent/20"
    >
      <Icon name="fileText" size={15} className="shrink-0" />
      <span className="mono truncate font-medium">{label}</span>
      {isPlan && (
        <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10.5px]">{t("plan.fileBadge")}</span>
      )}
      <Icon name="panelRight" size={13} className="shrink-0" />
    </button>
  );
}
