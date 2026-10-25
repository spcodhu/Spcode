import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  close: () => boolean;
}

const stack: ModalEntry[] = [];
let lockCount = 0;
let snapshot: { root: HTMLElement | null; inert: boolean; ariaHidden: string | null; overflow: string } | null = null;

function lockBackground(): () => void {
  if (lockCount === 0) {
    const root = document.getElementById("root");
    snapshot = {
      root,
      inert: root?.inert ?? false,
      ariaHidden: root?.getAttribute("aria-hidden") ?? null,
      overflow: document.body.style.overflow,
    };
    if (root) {
      root.inert = true;
      root.setAttribute("aria-hidden", "true");
    }
    document.body.style.overflow = "hidden";
  }
  lockCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount > 0 || !snapshot) return;
    const current = snapshot;
    snapshot = null;
    if (current.root) {
      current.root.inert = current.inert;
      if (current.ariaHidden == null) current.root.removeAttribute("aria-hidden");
      else current.root.setAttribute("aria-hidden", current.ariaHidden);
    }
    document.body.style.overflow = current.overflow;
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

function focusable(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.getAttribute("aria-hidden") !== "true" && !element.closest("[inert]"),
  );
}

/** 供 App 全局快捷键使用：只尝试关闭最上层，不串改多个弹层的本地状态。 */
export function closeTopModal(): boolean {
  return stack[stack.length - 1]?.close() ?? false;
}

export interface ModalProps {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  onClose?: () => void;
  busy?: boolean;
  role?: "dialog" | "alertdialog";
  layerClassName: string;
  panelClassName: string;
  closeOnBackdrop?: boolean;
  testId?: string;
}

export function Modal({
  title,
  description,
  children,
  onClose,
  busy = false,
  role = "dialog",
  layerClassName,
  panelClassName,
  closeOnBackdrop = true,
  testId,
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  const backdropRef = useRef(closeOnBackdrop);
  const [returnFocus] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );
  onCloseRef.current = onClose;
  busyRef.current = busy;
  backdropRef.current = closeOnBackdrop;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const entry: ModalEntry = {
      panel,
      returnFocus,
      close: () => {
        if (!onCloseRef.current || busyRef.current) return false;
        onCloseRef.current();
        return true;
      },
    };
    stack.push(entry);
    const unlock = lockBackground();
    if (!panel.contains(document.activeElement)) {
      focus(panel.querySelector<HTMLElement>("[data-modal-initial-focus]") ?? focusable(panel)[0] ?? panel);
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || stack[stack.length - 1] !== entry) return;
      if (event.key === "Escape") {
        if (event.isComposing) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (onCloseRef.current && !busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable(panel);
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
      const wasTop = stack[stack.length - 1] === entry;
      const index = stack.indexOf(entry);
      if (index >= 0) stack.splice(index, 1);
      unlock();
      if (wasTop) focus(stack[stack.length - 1]?.panel ?? returnFocus);
    };
  }, [returnFocus]);

  const content = (
    // biome-ignore lint/a11y/noStaticElementInteractions: 遮罩空白区关闭，键盘由 Esc 与焦点圈定处理
    <div
      className={`fixed inset-0 z-[70] flex bg-black/55 backdrop-blur-[2px] ${layerClassName}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && backdropRef.current && !busyRef.current) onCloseRef.current?.();
      }}
      data-testid={testId}
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
        className={`outline-none ${panelClassName}`}
      >
        <h2 id={titleId} className="sr-only">
          {title}
        </h2>
        {description && (
          <p id={descriptionId} className="sr-only">
            {description}
          </p>
        )}
        {children}
      </div>
    </div>
  );
  return typeof document !== "undefined" && document.body ? createPortal(content, document.body) : content;
}
