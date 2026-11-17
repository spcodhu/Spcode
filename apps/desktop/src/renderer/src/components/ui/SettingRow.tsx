import type { ReactNode } from "react";

/** 设置页通用行卡：左标题+描述、右控件；统一开关类设置的卡片节奏与间距 */
export function SettingRow({
  title,
  desc,
  children,
  className = "",
}: {
  title: string;
  desc?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 rounded-xl border border-border bg-bg-elevated px-4 py-3 ${className}`}
    >
      <div className="min-w-0">
        <div className="text-[14px] text-text-primary">{title}</div>
        {desc && <div className="mt-0.5 text-[12px] text-text-tertiary">{desc}</div>}
      </div>
      {children}
    </div>
  );
}
