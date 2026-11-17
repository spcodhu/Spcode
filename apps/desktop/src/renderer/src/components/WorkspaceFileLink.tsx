import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import { Icon } from "./Icon";

/**
 * 模型正文中的本地文件入口：计划文件与项目/scratch 文件共用同一视觉语言，
 * 点击后由主进程校验路径并在右侧工作区面板预览，不在窗口内导航。
 * 右键弹原生菜单（默认应用打开 / 复制路径 / 在文件管理器中显示），
 * 菜单目标同样是绝对路径，仍由主进程按工作区守卫解析。
 */
export function WorkspaceFileLink({ path, label, kind }: { path: string; label: string; kind: "plan" | "file" }) {
  const { t } = useTranslation("chat");
  const openWorkspaceFile = useStore((s) => s.openWorkspaceFile);
  const showWorkspaceFileMenu = useStore((s) => s.showWorkspaceFileMenu);
  const isPlan = kind === "plan";
  return (
    <button
      type="button"
      data-testid={isPlan ? "plan-file-link" : "workspace-file-link"}
      title={path}
      onClick={() => void openWorkspaceFile({ path, kind, label })}
      onContextMenu={(e) => {
        e.preventDefault();
        void showWorkspaceFileMenu({ path, kind });
      }}
      className="mx-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-bg-elevated/70 px-2 py-0.5 align-middle text-left text-[12px] leading-5 text-text-secondary transition-colors hover:border-border-strong hover:bg-bg-hover hover:text-text-primary"
    >
      <Icon name="fileText" size={12} className="shrink-0 text-text-tertiary" />
      <span className="mono truncate">{label}</span>
      {isPlan && (
        <span className="shrink-0 rounded bg-accent-soft px-1 py-0 text-[10px] leading-4 text-text-tertiary">
          {t("plan.fileBadge")}
        </span>
      )}
    </button>
  );
}
