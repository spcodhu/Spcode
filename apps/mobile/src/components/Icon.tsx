/** 手机端轻量 SVG 图标：自绘调节杆，替代风格不统一的 Unicode 齿轮。 */
export function Icon({
  name,
  size = 20,
  className,
  strokeWidth = 1.8,
  testId,
}: {
  name: "settings";
  size?: number;
  className?: string;
  strokeWidth?: number;
  testId?: string;
}) {
  if (name !== "settings") return null;
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
      data-testid={testId}
      aria-hidden="true"
    >
      <path d="M20 7h-9M14 17H5" />
      <circle cx="7" cy="7" r="3" />
      <circle cx="17" cy="17" r="3" />
    </svg>
  );
}
