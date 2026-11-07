import { useMemo } from "react";
import { useTranslation } from "react-i18next";

function patchLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-text-tertiary";
  if (line.startsWith("@@")) return "text-accent/80";
  if (line.startsWith("+")) return "text-success bg-success/10";
  if (line.startsWith("-")) return "text-danger bg-danger/10";
  return "text-text-tertiary";
}

/** 双端共用的 unified patch 渲染块。 */
export function DiffPatch({ patch, maxChars = 6000 }: { patch: string; maxChars?: number }) {
  const { t } = useTranslation("chat");
  const lines = useMemo(() => patch.slice(0, maxChars).split("\n"), [patch, maxChars]);
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-bg-root/60">
      <pre className="mono px-3 py-2 text-[12px] leading-5">
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff 行是静态快照，永不重排
          <div key={i} className={patchLineClass(line)}>
            {line || " "}
          </div>
        ))}
        {patch.length > maxChars && <div className="text-text-tertiary">{t("diff.truncated")}</div>}
      </pre>
    </div>
  );
}
