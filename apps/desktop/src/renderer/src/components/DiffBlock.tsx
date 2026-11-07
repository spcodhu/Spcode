/**
 * 统一 diff 渲染块（评审 R3-F1）：
 * - renderPatch：pi edit 工具返回的标准 unified patch（details.patch）按行着色；
 * - renderReplace：权限卡里 edit 参数的 oldText→newText 精确替换视图（edit 的语义就是精确替换，
 *   不需要跑 LCS——红块是将被删掉的原样文本，绿块是替换后的新文本）。
 */
import { useTranslation } from "react-i18next";

export { DiffPatch } from "@spcode/ui";

/** 权限卡用：edit 参数的 oldText → newText 精确替换块 */
export function DiffReplace({
  oldText,
  newText,
  maxLines = 60,
}: {
  oldText: string;
  newText: string;
  maxLines?: number;
}) {
  const { t } = useTranslation("chat");
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const tooLong = oldLines.length + newLines.length > maxLines;
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-bg-root/60">
      <pre className="mono max-h-64 overflow-y-auto px-3 py-2 text-[12px] leading-5">
        {oldLines.slice(0, maxLines).map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态 diff 行不重排
          <div key={`d${i}`} className="text-danger bg-danger/10">
            {`- ${l}`}
          </div>
        ))}
        {newLines.slice(0, maxLines).map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态 diff 行不重排
          <div key={`a${i}`} className="text-success bg-success/10">
            {`+ ${l}`}
          </div>
        ))}
        {tooLong && <div className="text-text-tertiary">{t("diff.replaceTruncated")}</div>}
      </pre>
    </div>
  );
}
