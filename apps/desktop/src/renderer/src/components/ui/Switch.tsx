/**
 * Switch —— 可复用开关基础组件（macOS 风格）。
 *
 * 轨道 38×22，圆钮 18×18，滑动 16px：
 * - 开：雀绿轨道 + 圆钮贴右
 * - 关：描边深灰轨道 + 圆钮贴左
 *
 * 实现要点：圆钮必须显式设 left（absolute 不给 left 会按
 * button 的居中静态定位漂移，圆钮溢出轨道——上一版的教训）。
 * 点击不冒泡（开关常嵌在可点击的行里）。
 */
import type { ButtonHTMLAttributes } from "react";

export interface SwitchProps {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** 无障碍标签 */
  label?: string;
  className?: string;
  onClickCapture?: ButtonHTMLAttributes<HTMLButtonElement>["onClick"];
}

export function Switch({ on, onChange, disabled, label, className = "" }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!disabled) onChange(!on);
      }}
      className={`group relative inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ease-in-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? "bg-accent" : "border border-border-strong bg-bg-hover"
      } ${className}`}
    >
      <span
        className="pointer-events-none absolute left-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.35)] transition-transform duration-200 ease-in-out"
        style={{ transform: `translateX(${on ? 16 : 0}px)` }}
      />
    </button>
  );
}
