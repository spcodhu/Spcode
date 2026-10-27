import { describe, expect, it } from "vitest";
import { splitPlanLinks } from "../src/renderer/src/plan-links.js";

describe("Plan Markdown 链接拆分", () => {
  it("只把 plan: 文件链接变成入口，前后正文保持原文", () => {
    const parts = splitPlanLinks("调研完成。\n[PLAN.md](plan:/home/u/.spcode/plans/s1.md)\n请查阅。");
    expect(parts.slice(0, 2)).toEqual([
      { kind: "text", key: "text-0", text: "调研完成。\n" },
      { kind: "plan", key: "plan-6", path: "/home/u/.spcode/plans/s1.md", label: "PLAN.md" },
    ]);
    expect(parts[2]).toMatchObject({ kind: "text", text: "\n请查阅。" });
  });

  it("支持同一段总结中的多个计划入口", () => {
    const parts = splitPlanLinks("[一](plan:/tmp/a.md) 与 [二](plan:/tmp/b.md)");
    expect(parts.filter((p) => p.kind === "plan").map((p) => p.kind === "plan" && p.path)).toEqual([
      "/tmp/a.md",
      "/tmp/b.md",
    ]);
  });

  it("普通链接、非 Markdown 文件和无 plan 前缀链接不特殊处理", () => {
    for (const text of ["[文档](/tmp/a.md)", "[文件](plan:/tmp/a.txt)", "[网站](https://example.com)", "普通正文"]) {
      expect(splitPlanLinks(text)).toEqual([{ kind: "text", key: "text-0", text }]);
    }
  });
});
