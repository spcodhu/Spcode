/** 手机端轻量 SVG 图标：与桌面一致的描边风格，避免 Unicode 图标参差。 */
export function Icon({
  name,
  size = 20,
  className,
  strokeWidth = 1.8,
  testId,
}: {
  name: "settings" | "back" | "send" | "stop";
  size?: number;
  className?: string;
  strokeWidth?: number;
  testId?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={name === "stop" ? "currentColor" : "none"}
      stroke={name === "stop" ? "none" : "currentColor"}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      data-testid={testId}
      aria-hidden="true"
    >
      {name === "settings" ? (
        <>
          <path d="M20 7h-9M14 17H5" />
          <circle cx="7" cy="7" r="3" />
          <circle cx="17" cy="17" r="3" />
        </>
      ) : name === "back" ? (
        <path d="m15 18-6-6 6-6" />
      ) : name === "send" ? (
        <path d="M12 19V5m-7 7 7-7 7 7" />
      ) : (
        <rect x="6" y="6" width="12" height="12" rx="2" />
      )}
    </svg>
  );
}
