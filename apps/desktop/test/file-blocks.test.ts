/** 文件附件拼接（file-blocks.ts）单测：语言映射、围栏升级、拼接格式 */
import { describe, expect, it } from "vitest";
import { buildFileBlocks, langOf } from "../src/renderer/src/file-blocks.js";

describe("langOf", () => {
  it("常见扩展名映射为代码块语言", () => {
    expect(langOf("a.ts")).toBe("ts");
    expect(langOf("b.PY".toLowerCase())).toBe("py");
    expect(langOf("c.md")).toBe("md");
    expect(langOf("d.sh")).toBe("bash");
  });

  it("纯文本/未知扩展名不标语言", () => {
    expect(langOf("a.txt")).toBe("");
    expect(langOf("a.log")).toBe("");
    expect(langOf("a.unknownext")).toBe("");
    expect(langOf("noext")).toBe("");
  });
});

describe("buildFileBlocks", () => {
  it("空列表 → 空字符串", () => {
    expect(buildFileBlocks([])).toBe("");
  });

  it("拼接为 <file> 块并标注语言", () => {
    const out = buildFileBlocks([{ name: "a.ts", size: 10, text: "const x = 1;" }]);
    expect(out).toBe('\n\n<file name="a.ts">\n```ts\nconst x = 1;\n```\n</file>');
  });

  it("去掉内容尾部空白；多个文件顺序拼接", () => {
    const out = buildFileBlocks([
      { name: "a.md", size: 5, text: "# 标题\n\n\n" },
      { name: "b.txt", size: 3, text: "hi" },
    ]);
    expect(out).toBe(
      '\n\n<file name="a.md">\n```md\n# 标题\n```\n</file>\n\n<file name="b.txt">\n```\nhi\n```\n</file>',
    );
  });

  it("内容含三反引号时升级为四反引号围栏", () => {
    const out = buildFileBlocks([{ name: "a.md", size: 1, text: "```js\ncode\n```" }]);
    expect(out).toContain("````md\n```js\ncode\n```\n````");
  });
});
