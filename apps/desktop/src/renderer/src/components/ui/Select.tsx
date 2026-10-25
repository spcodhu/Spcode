/** 应用内风格下拉选择器：替代原生 <select>（原生弹层在深色主题下是浅色 OS 样式，很刺眼） */
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../Icon";

export interface SelectOption {
  value: string;
  label?: string;
}

export function Select({
  value,
  options,
  onChange,
  className,
  label,
  testId,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  label?: string;
  testId?: string;
}) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const listboxId = useId();

  const openMenu = (position: "current" | "first" | "last" = "current") => {
    const target =
      position === "first"
        ? options[0]
        : position === "last"
          ? options[options.length - 1]
          : (options.find((option) => option.value === value) ?? options[0]);
    setActiveValue(target?.value ?? null);
    setOpen(true);
  };

  const closeWithTriggerFocus = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const selectOption = (nextValue: string) => {
    onChange(nextValue);
    closeWithTriggerFocus();
  };

  // 点击外部关闭；Esc 只关闭当前弹层，不把事件继续交给页面级快捷键。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // 阻止同路径上的后续监听（例如 App/Modal 的全局 Esc），焦点只还给本组件 trigger。
      e.stopImmediatePropagation();
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // 打开或键盘移动后聚焦活动项；长列表中同时保证它滚动到可见区域。
  useEffect(() => {
    if (!open || activeValue === null) return;
    const frame = requestAnimationFrame(() => {
      const target = optionRefs.current.get(activeValue);
      target?.focus();
      target?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, activeValue]);

  // options 动态变化时保留仍存在活动项的 DOM 焦点；仅活动项被删除时才另选合法项。
  useEffect(() => {
    if (!open) return;
    if (activeValue !== null && options.some((option) => option.value === activeValue)) return;
    const next = options.find((option) => option.value === value) ?? options[0];
    setActiveValue(next?.value ?? null);
  }, [open, options, value, activeValue]);

  const current = options.find((o) => o.value === value);
  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (open) return;
    if (e.key === "Enter" || e.key === " ") {
      // button 的原生 click 在 jsdom 不会由 keydown 合成；阻止默认也避免真实浏览器重复开关。
      e.preventDefault();
      openMenu();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openMenu();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      openMenu(e.key === "Home" ? "first" : "last");
    }
  };

  const onOptionKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, optionValue: string, index: number) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectOption(optionValue);
      return;
    }
    if (e.key === "Tab") {
      // 不拦截标准焦点导航，只在焦点离开时收起弹层。
      setOpen(false);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || options.length === 0) return;
    e.preventDefault();
    const nextIndex =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? options.length - 1
          : e.key === "ArrowDown"
            ? (index + 1) % options.length
            : (index - 1 + options.length) % options.length;
    setActiveValue(options[nextIndex]?.value ?? null);
  };

  return (
    <div ref={rootRef} className={`relative ${className ?? ""}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        data-testid={testId}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border bg-bg-elevated px-3 text-[13px] text-text-primary transition-colors hover:border-border-strong"
      >
        <span>{current?.label ?? current?.value ?? t("common.select")}</span>
        <Icon
          name="chevronDown"
          size={13}
          className={`shrink-0 text-text-tertiary transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={label}
          className="absolute left-0 top-full z-50 mt-1.5 max-h-64 w-full overflow-y-auto rounded-xl border border-border bg-bg-elevated p-1 shadow-2xl"
        >
          {options.map((o, index) => {
            const selected = o.value === value;
            return (
              <button
                ref={(element) => {
                  if (element) optionRefs.current.set(o.value, element);
                  else optionRefs.current.delete(o.value);
                }}
                key={o.value}
                type="button"
                role="option"
                aria-selected={selected}
                tabIndex={o.value === activeValue ? 0 : -1}
                onKeyDown={(e) => onOptionKeyDown(e, o.value, index)}
                onClick={() => selectOption(o.value)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors ${
                  selected ? "text-accent" : "text-text-primary hover:bg-bg-hover"
                }`}
              >
                <span className="flex-1">{o.label ?? o.value}</span>
                {selected && <Icon name="check" size={13} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
