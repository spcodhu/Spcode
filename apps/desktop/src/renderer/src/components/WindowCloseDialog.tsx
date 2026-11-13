import type { WindowCloseAction } from "@spcode/shared";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import { Modal } from "./ui/Modal";

/** Windows 点窗口叉号：明确区分退出进程与仅最小化窗口。 */
export function WindowCloseDialog({ onAction }: { onAction: (action: WindowCloseAction) => void }) {
  const { t } = useTranslation("chat");
  return (
    <Modal
      title={t("window.closeTitle")}
      description={t("window.closeDescription")}
      role="alertdialog"
      onClose={() => onAction("cancel")}
      closeOnBackdrop={false}
      testId="window-close-dialog"
      layerClassName="items-center justify-center"
      panelClassName="w-[440px] max-w-[92vw] rounded-2xl border border-border bg-bg-elevated p-5 shadow-2xl"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning">
          <Icon name="alert" size={17} />
        </span>
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-text-primary">{t("window.closeTitle")}</h3>
          <p className="mt-2 text-[13px] leading-6 text-text-secondary">{t("window.closeDescription")}</p>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          data-testid="window-close-cancel"
          data-modal-initial-focus
          onClick={() => onAction("cancel")}
          className="rounded-lg px-3 py-1.5 text-[12.5px] text-text-secondary transition-colors hover:bg-bg-hover"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          data-testid="window-close-minimize"
          onClick={() => onAction("minimize")}
          className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-on-accent transition-colors hover:bg-accent-dim"
        >
          {t("window.closeMinimize")}
        </button>
        <button
          type="button"
          data-testid="window-close-quit"
          onClick={() => onAction("quit")}
          className="rounded-lg bg-danger px-3 py-1.5 text-[12.5px] font-medium text-on-danger transition-colors hover:bg-danger/85"
        >
          {t("window.closeQuit")}
        </button>
      </div>
    </Modal>
  );
}
