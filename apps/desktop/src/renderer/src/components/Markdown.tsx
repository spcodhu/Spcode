/** 桌面 Markdown 适配：共享渲染器 + 本机 Plan 文件动作。 */
import { Markdown as SharedMarkdown } from "@spcode/ui";
import { useStore } from "../store";
import { resolveThemeBase } from "../theme";
import { PlanFileLink } from "./PlanFileLink";

export function Markdown({ text }: { text: string }) {
  const themeBase = useStore((s) => resolveThemeBase(s.settings));
  return (
    <SharedMarkdown
      text={text}
      themeBase={themeBase}
      renderPlanLink={({ key, path, label }) => <PlanFileLink key={key} path={path} label={label} />}
    />
  );
}
