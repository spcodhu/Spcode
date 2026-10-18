/** 应用内风格下拉选择器：替代原生 <select>（原生弹层在深色主题下是浅色 OS 样式，很刺眼） */
import { useEffect, useRef, useState } from "react";
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
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击外部 / Esc 收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // stopImmediatePropagation：阻止同路径上后续监听（App 的全局 Esc 会连设置页一起关——评审 R3-C11）
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div ref={rootRef} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-[13px] text-text-primary transition-colors hover:border-border-strong"
      >
        <span>{current?.label ?? current?.value ?? "选择…"}</span>
        <Icon
          name="chevronDown"
          size={13}
          className={`shrink-0 text-text-tertiary transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1.5 max-h-64 w-full overflow-y-auto rounded-xl border border-border bg-bg-elevated p-1 shadow-2xl">
          {options.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors ${
                  active ? "text-accent" : "text-text-primary hover:bg-bg-hover"
                }`}
              >
                <span className="flex-1">{o.label ?? o.value}</span>
                {active && <Icon name="check" size={13} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
