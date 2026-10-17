/** 轻量 SVG 图标（Feather 风格，stroke 描边），避免引入图标库依赖 */
import type { CSSProperties } from "react";

const PATHS: Record<string, string> = {
  home: "M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.35-4.35",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-14v6l4 2",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2.1-1.6-2-3.5-2.5 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-5l-.4 2.5a7.5 7.5 0 0 0-2 1.2l-2.5-1-2 3.5L4.7 10.8a7.4 7.4 0 0 0 0 2.4l-2.1 1.6 2 3.5 2.5-1a7.5 7.5 0 0 0 2 1.2l.4 2.5h5l.4-2.5a7.5 7.5 0 0 0 2-1.2l2.5 1 2-3.5-2.1-1.6c.07-.4.1-.8.1-1.2z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0-15v2m0 16v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M2 12h2m16 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  cpu: "M5 5h14v14H5zm4 4h6v6H9zM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3",
  chart: "M3 3v18h18M8 17V9m5 8V5m5 12v-6",
  gauge: "M12 15l4-6M5 19a9 9 0 1 1 14 0",
  brain:
    "M9 3a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3c1 1 2 1 3 1V4c-1 0-2 0-3-1zm6 0a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3c-1 1-2 1-3 1",
  archive: "M3 4h18v4H3zm2 4v12h14V8m-9 4h4",
  globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm-10-10h20M12 2c3 3 3 15 0 20-3-5-3-17 0-20z",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-6v-4m0-4h.01",
  plus: "M12 5v14M5 12h14",
  arrowUp: "M12 19V5m-7 7 7-7 7 7",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  toolbox: "M4 7h16v13H4zm4 0V4h8v3M4 12h16",
  x: "M18 6 6 18M6 6l12 12",
  check: "M20 6 9 17l-5-5",
  zap: "M13 2 3 14h7l-1 8 10-12h-7z",
  shield: "M12 22s8-3 8-10V5l-8-3-8 3v7c0 7 8 10 8 10z",
  branch: "M6 3v12m0 0a3 3 0 1 0 3 3M6 15a3 3 0 1 1-3 3m12-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 0a9 9 0 0 1-9 9",
  key: "M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 0 7.8 7.8 5.5 5.5 0 0 0-7.8-7.8zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4",
  chevronDown: "m6 9 6 6 6-6",
  chevronRight: "m9 18 6-6-6-6",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2m20 0v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6m20 0-3.5-7H5.5L2 12",
  refresh: "M23 4v6h-6M1 20v-6h6m-3.5-4A9 9 0 0 1 19 7l4 3M1 17l4 3a9 9 0 0 0 15.5-3",
  dots: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm7 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  panelRight: "M3 4h18v16H3zm12 0v16",
  copy: "M8 8h12v12H8zM4 16V4h12",
  clipboard:
    "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z",
  clipboardCheck:
    "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm0 11 2 2 4-4",
  sparkles:
    "M12 3l1.7 4.6L18.3 9.3 13.7 11 12 15.6 10.3 11 5.7 9.3l4.6-1.7zM18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8zM5.5 15l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z",
  bug: "M8.5 6.5a3.5 3.5 0 0 1 7 0M6 10.5h12V14a6 6 0 0 1-12 0zM9.5 5 7.5 3m7 2 2-2M3 13h3m12 0h3M4.5 8 7 9.5M19.5 8 17 9.5M4.5 18 7 16.5M19.5 18 17 16.5M12 20v2",
  pen: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7.5 18.5 3.5 19.5l1-4z",
  fileText: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  book: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM8 7h7M8 11h7",
};

export function Icon({
  name,
  size = 16,
  className,
  style,
  strokeWidth = 1.8,
}: {
  name: keyof typeof PATHS | string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  strokeWidth?: number;
}) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}
