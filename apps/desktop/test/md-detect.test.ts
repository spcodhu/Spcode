/**
 * Markdown 插件按需加载的内容检测（md-detect.ts）单测。
 * 检测决定是否动态 import katex / mermaid chunk——宽松无害（多拉一个 chunk），
 * 漏检会让公式/流程图退化成原文，所以正反用例都要钉。
 */
import { describe, expect, it } from "vitest";
import { hasMathSyntax, hasMermaidSyntax } from "../src/renderer/src/md-detect.js";

describe("hasMathSyntax", () => {
  it("识别块公式与行内公式", () => {
    expect(hasMathSyntax("$$\nE = mc^2\n$$")).toBe(true);
    expect(hasMathSyntax("质能方程 $E = mc^2$ 很简洁")).toBe(true);
    expect(hasMathSyntax("行首 $x$")).toBe(true);
    expect(hasMathSyntax("（\\(a+b\\)）")).toBe(true);
    expect(hasMathSyntax("\\[a^2+b^2\\]")).toBe(true);
  });

  it("普通文本不误判（单个 $ 不成对）", () => {
    expect(hasMathSyntax("这个方案花了 $5 元")).toBe(false); // 单个 $ 不成对
    expect(hasMathSyntax("普通中文，无公式")).toBe(false);
    expect(hasMathSyntax("")).toBe(false);
  });

  it("成对 $ 一律当成公式（与 remark-math 同语义，宽松无害）", () => {
    // remark-math 也会把这段解析成行内公式，检测必须同款判定（否则会漏渲染）
    expect(hasMathSyntax("价格是 $5，另一个 $8")).toBe(true);
  });
});

describe("hasMermaidSyntax", () => {
  it("识别 mermaid 代码块（含别名 mmd 与大小写）", () => {
    expect(hasMermaidSyntax("```mermaid\ngraph TD\n  A --> B\n```")).toBe(true);
    expect(hasMermaidSyntax("```mmd\nflowchart LR\n```")).toBe(true);
    expect(hasMermaidSyntax("```Mermaid\ngraph TD\n```")).toBe(true);
  });

  it("普通代码块与文本不误判", () => {
    expect(hasMermaidSyntax("```ts\nconst a = 1;\n```")).toBe(false);
    expect(hasMermaidSyntax("mermaid 是一个画图工具")).toBe(false);
    expect(hasMermaidSyntax("")).toBe(false);
  });
});
