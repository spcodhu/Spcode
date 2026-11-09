import { describe, expect, it } from "vitest";
import { groupPlanMarkdownParts, splitPlanLinks } from "../src/renderer/src/plan-links.js";

describe("Plan / 本地文件 Markdown 链接拆分", () => {
  it("只把 plan: 文件链接变成计划入口，前后正文保持原文", () => {
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

  it("普通网页、锚点、路由和图片链接不特殊处理", () => {
    for (const text of [
      "[网站](https://example.com/a.md)",
      "[协议相对](//example.com/a.md)",
      "[邮箱](mailto:a@b.md)",
      "[章节](#readme)",
      "[路由](/docs)",
      "![截图](./images/a.png)",
      "[文件](plan:/tmp/a.txt)",
      "普通正文",
    ]) {
      expect(splitPlanLinks(text)).toEqual([{ kind: "text", key: "text-0", text }]);
    }
  });

  it("识别 file: 相对路径与标准 file:// URI，并去掉行号", () => {
    expect(splitPlanLinks("[源码](file:src/a.ts:12)")[0]).toMatchObject({
      kind: "file",
      path: "src/a.ts",
      label: "源码",
    });
    expect(splitPlanLinks("[绝对](file:///tmp/my%20file.ts)")[0]).toMatchObject({
      kind: "file",
      path: "/tmp/my file.ts",
    });
    expect(splitPlanLinks("[无扩展](file:/tmp/Makefile)")[0]).toMatchObject({ kind: "file", path: "/tmp/Makefile" });
  });

  it("识别模型常见的项目相对路径、绝对路径和行号锚点", () => {
    const cases: Array<[string, string]> = [
      ["[说明](README.md)", "README.md"],
      ["[源码](./src/a.ts:12:3)", "./src/a.ts"],
      ["[文档](docs/guide.md#L10-L20)", "docs/guide.md"],
      ["[绝对](/tmp/a.md)", "/tmp/a.md"],
      ["[构建](Makefile)", "Makefile"],
      ['[标题](<src/my file.ts> "源码")', "src/my file.ts"],
    ];
    for (const [text, path] of cases) {
      expect(splitPlanLinks(text)[0], text).toMatchObject({ kind: "file", path });
    }
  });

  it("非本机 file host 不接管，混合计划与普通文件链接保持顺序", () => {
    expect(splitPlanLinks("[远程](file://evil.example/share/a.ts)")).toEqual([
      { kind: "text", key: "text-0", text: "[远程](file://evil.example/share/a.ts)" },
    ]);
    const parts = splitPlanLinks("先看 [计划](plan:/tmp/p.md)，再看 [实现](src/a.ts)。");
    expect(parts.map((p) => p.kind)).toEqual(["text", "plan", "text", "file", "text"]);
  });

  it("跳过行内代码和 fenced code block 中的链接示例，不破坏源码预览", () => {
    const text = [
      "`[行内示例](src/inline.ts)`",
      "```md",
      "[代码块示例](src/fenced.ts)",
      "```",
      "[真实文件](README.md)",
    ].join("\n");
    const parts = splitPlanLinks(text);
    expect(parts.filter((p) => p.kind === "file")).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      kind: "text",
      text: "`[行内示例](src/inline.ts)`\n```md\n[代码块示例](src/fenced.ts)\n```\n",
    });
    expect(parts[1]).toMatchObject({ kind: "file", path: "README.md" });
  });

  it("工作区预览按需拆出本地图片，并保留远程图片与代码示例原样", () => {
    const parts = splitPlanLinks("前文\n![架构](images/arch.png)\n![远程](https://example.com/a.png)", {
      includeImages: true,
    });
    expect(parts).toEqual([
      { kind: "text", key: "text-0", text: "前文\n" },
      { kind: "image", key: "image-3", path: "images/arch.png", label: "架构" },
      { kind: "text", key: "text-25", text: "\n![远程](https://example.com/a.png)" },
    ]);
    expect(splitPlanLinks("```md\n![示例](images/a.png)\n```", { includeImages: true })[0]).toMatchObject({
      kind: "text",
    });
  });

  it("未闭合代码块中的链接同样不接管", () => {
    const text = "```ts\nconst example = '[示例](src/a.ts)';";
    expect(splitPlanLinks(text)).toEqual([{ kind: "text", key: "text-0", text }]);
  });

  it("连续文件链接、顿号和末尾句号保留在同一个行内分组", () => {
    const parts = splitPlanLinks("主要改动：\n\n[a](a.ts)、[b](b.ts)、[c](c.ts)。\n\n后续说明");
    const groups = groupPlanMarkdownParts(parts);
    expect(groups.map((group) => group.kind)).toEqual(["block", "inline", "block"]);
    expect(groups[0]?.parts).toEqual([expect.objectContaining({ kind: "text", text: "主要改动：\n\n" })]);
    expect(groups[1]?.parts.map((part) => part.kind)).toEqual(["file", "text", "file", "text", "file", "text"]);
    expect(groups[1]?.parts.at(-1)).toMatchObject({ kind: "text", text: "。" });
    expect(groups[2]?.parts).toEqual([expect.objectContaining({ kind: "text", text: "\n\n后续说明" })]);
  });

  it("文件链接前后的普通句子保持在同一段，无文件链接时不重排 Markdown", () => {
    const groups = groupPlanMarkdownParts(
      splitPlanLinks("文件已处理：[README](README.md)，也可以看[notes](notes.txt)。"),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("inline");
    expect(groups[0]?.parts.map((part) => part.kind)).toEqual(["text", "file", "text", "file", "text"]);

    const plain = splitPlanLinks("# 标题\n\n- 列表一\n- 列表二\n\n```ts\nconst a = 1;\n```");
    expect(groupPlanMarkdownParts(plain)).toEqual([{ kind: "block", key: plain[0]!.key, parts: plain }]);
  });
});
