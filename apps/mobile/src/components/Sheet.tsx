import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface ModalEntry {
  panel: HTMLElement;
  returnFocus: HTMLElement | null;
}

const modalStack: ModalEntry[] = [];
let backgroundLockCount = 0;
let backgroundSnapshot: {
  root: HTMLElement | null;
  inert: boolean;
  ariaHidden: string | null;
  bodyOverflow: string;
} | null = null;

function lockBackground(): () => void {
  if (backgroundLockCount === 0) {
    const root = document.getElementById("root");
    backgroundSnapshot = {
      root,
      inert: root?.inert ?? false,
      ariaHidden: root?.getAttribute("aria-hidden") ?? null,
      bodyOverflow: document.body.style.overflow,
    };
    if (root) {
      root.inert = true;
      root.setAttribute("aria-hidden", "true");
    }
    document.body.style.overflow = "hidden";
  }
  backgroundLockCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    backgroundLockCount = Math.max(0, backgroundLockCount - 1);
    if (backgroundLockCount > 0 || !backgroundSnapshot) return;
    const snapshot = backgroundSnapshot;
    backgroundSnapshot = null;
    if (snapshot.root) {
      snapshot.root.inert = snapshot.inert;
      if (snapshot.ariaHidden == null) snapshot.root.removeAttribute("aria-hidden");
      else snapshot.root.setAttribute("aria-hidden", snapshot.ariaHidden);
    }
    document.body.style.overflow = snapshot.bodyOverflow;
  };
}

function focus(element: HTMLElement | null | undefined): void {
  if (!element?.isConnected) return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

function focusableElements(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.getAttribute("aria-hidden") !== "true" && !element.closest("[inert]"),
  );
}

interface ModalSurfaceProps {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  busy?: boolean;
  variant: "sheet" | "fullscreen";
  role?: "dialog" | "alertdialog";
  titleClassName?: string;
  panelClassName?: string;
  bodyClassName?: string;
}

function ModalSurface({
  title,
  description,
  children,
  footer,
  onClose,
  busy = false,
  variant,
  role = "dialog",
  titleClassName = "",
  panelClassName = "",
  bodyClassName = "",
}: ModalSurfaceProps) {
  const { t } = useTranslation("mobile");
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  const [returnFocus] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );
  onCloseRef.current = onClose;
  busyRef.current = busy;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const entry: ModalEntry = { panel, returnFocus };
    modalStack.push(entry);
    const unlockBackground = lockBackground();

    if (!panel.contains(document.activeElement)) {
      focus(panel.querySelector<HTMLElement>("[data-dialog-initial-focus]") ?? panel);
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== entry) return;
      if (event.key === "Escape" || event.key === "Esc") {
        if (!onCloseRef.current || busyRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableElements(panel);
      if (items.length === 0) {
        event.preventDefault();
        focus(panel);
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (active === panel || !panel.contains(active)) {
        event.preventDefault();
        focus(event.shiftKey ? last : first);
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        focus(last);
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        focus(first);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const wasTop = modalStack[modalStack.length - 1] === entry;
      const index = modalStack.indexOf(entry);
      if (index >= 0) modalStack.splice(index, 1);
      unlockBackground();
      if (wasTop) {
        const underlying = modalStack[modalStack.length - 1]?.panel;
        focus(underlying ?? returnFocus);
      }
    };
  }, [returnFocus]);

  const closeFromBackdrop = () => {
    if (!busyRef.current) onCloseRef.current?.();
  };

  const content = (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: 仅遮罩空白区响应点击；键盘统一由 Dialog 的 Esc 与关闭按钮处理
    <div
      className={`mobile-modal-layer ${variant === "sheet" ? "mobile-sheet-layer" : "mobile-fullscreen-layer"}`}
      data-testid={variant === "sheet" ? "sheet-backdrop" : "fullscreen-dialog-backdrop"}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeFromBackdrop();
      }}
    >
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: dialog 与 alertdialog 均支持 aria-modal，动态联合角色无法被规则识别 */}
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={busy || undefined}
        tabIndex={-1}
        className={`mobile-dialog-panel ${
          variant === "sheet" ? "mobile-sheet-panel" : "mobile-fullscreen-panel"
        } ${panelClassName}`}
        data-dialog-panel
      >
        <div className="mobile-dialog-header">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className={`mobile-dialog-title ${titleClassName}`}>
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mobile-dialog-description safe-break">
                {description}
              </p>
            )}
          </div>
          {onClose && (
            <button
              type="button"
              disabled={busy}
              onClick={() => !busyRef.current && onCloseRef.current?.()}
              aria-label={t("common.cancel")}
              data-sheet-close
              className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl leading-none text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40"
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
        </div>
        <div className={`thin-scroll mobile-dialog-body ${footer ? "" : "mobile-dialog-body-safe"} ${bodyClassName}`}>
          {children}
        </div>
        {footer && <div className="mobile-dialog-footer">{footer}</div>}
      </div>
    </div>
  );

  return typeof document !== "undefined" && document.body ? createPortal(content, document.body) : content;
}

export function Sheet(props: Omit<ModalSurfaceProps, "variant" | "role" | "onClose"> & { onClose: () => void }) {
  return <ModalSurface {...props} variant="sheet" role="dialog" />;
}

export function FullScreenDialog(props: Omit<ModalSurfaceProps, "variant" | "onClose">) {
  return <ModalSurface {...props} variant="fullscreen" />;
}
