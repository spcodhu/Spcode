/**
 * Markdown 内容的插件需求检测（纯函数，jsdom/Node 均可测）。
 * 检测宁可宽松（多加载一个 chunk），不能漏（漏了公式/流程图就退化成原文）。
 */

/** 内容是否含公式语法（块 $$ / 行内 $x$ / \( \) / \[ \]） */
export function hasMathSyntax(text: string): boolean {
  if (text.includes("$$")) return true;
  if (text.includes("\\(") || text.includes("\\[")) return true;
  return /(^|[^\\$])\$[^\n$]+\$/.test(text);
}

/** 内容是否含 mermaid 代码块（```mermaid / ```mmd） */
export function hasMermaidSyntax(text: string): boolean {
  return /```(?:mermaid|mmd)\b/i.test(text);
}
