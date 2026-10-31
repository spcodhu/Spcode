export type PlanMarkdownPart =
  | { kind: "text"; key: string; text: string }
  | { kind: "plan"; key: string; path: string; label: string };

/** 把 WritePlan 约定的 [PLAN.md](plan:/absolute/path) 拆成独立文件入口，其它 Markdown 原样渲染。 */
export function splitPlanLinks(text: string): PlanMarkdownPart[] {
  const parts: PlanMarkdownPart[] = [];
  const pattern = /\[([^\]]+)]\((plan:[^)]+)\)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const raw = match[2] ?? "";
    const path = raw.slice("plan:".length).trim();
    if (!path?.toLowerCase().endsWith(".md") || /[\r\n]/.test(path)) continue;
    if (index > cursor) parts.push({ kind: "text", key: `text-${cursor}`, text: text.slice(cursor, index) });
    parts.push({ kind: "plan", key: `plan-${index}`, path, label: match[1] || "PLAN.md" });
    cursor = index + match[0].length;
  }
  if (parts.length === 0) return [{ kind: "text", key: "text-0", text }];
  if (cursor < text.length) parts.push({ kind: "text", key: `text-${cursor}`, text: text.slice(cursor) });
  return parts;
}
