/**
 * Markdown 编辑器（contentEditable）的 DOM ↔ 文本序列化（纯逻辑，jsdom 可测）。
 *
 * 内容模型约定（编辑器内只允许三种节点，换行统一 <br>）：
 * - 文本节点：raw markdown
 * - <br>：换行（Shift+Enter / 粘贴规范化都走它；Enter 被拦为发送，不产生 <div>）
 * - <img data-name>：内嵌图片（附件 base64 直显），对应文本模型里的 ![name] 占位
 *
 * 约定让 serializeEditor 与 draftToEditorHtml 互为往返（round-trip 稳定），
 * 组件据此区分「用户打字」与「外部变更」，避免受控重置打飞光标。
 */

import type { ImageAttachment } from "@spcode/shared";

/** 编辑器 DOM → markdown 文本（img → ![name]，br → \n，其它元素递归子节点兜底） */
export function serializeEditor(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node): void => {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      out += node.textContent ?? "";
      return;
    }
    if (node instanceof HTMLImageElement) {
      out += `![${node.dataset.name || node.getAttribute("alt") || "image"}]`;
      return;
    }
    if (node instanceof HTMLBRElement) {
      out += "\n";
      return;
    }
    node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return out;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** markdown 文本 + 附件 → 编辑器 HTML（![name] 有附件则内嵌 img，无附件保留占位原文） */
export function draftToEditorHtml(text: string, attachments: ImageAttachment[]): string {
  const esc = escHtml(text);
  const withImgs = esc.replace(/!\[([^\]]*)\]/g, (m, rawName: string) => {
    const att = attachments.find((a) => a.name === rawName);
    if (!att) return m;
    const name = escHtml(att.name);
    return `<img src="data:${att.mimeType};base64,${att.data}" data-name="${name}" alt="${name}" class="md-inline-img" />`;
  });
  return withImgs.replace(/\n/g, "<br>");
}

/** 预览渲染前把 ![name] 占位解析成内联 data URL（无附件的占位保留原文） */
export function resolveImageRefs(text: string, attachments: ImageAttachment[]): string {
  if (attachments.length === 0) return text;
  return text.replace(/!\[([^\]]*)\]/g, (m, name: string) => {
    const att = attachments.find((a) => a.name === name);
    return att ? `![${name}](data:${att.mimeType};base64,${att.data})` : m;
  });
}

/** 收集文本里引用的图片名（用于清理已被用户从编辑器删除的附件） */
export function collectImageNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/!\[([^\]]*)\]/g)) {
    if (m[1]) names.add(m[1]);
  }
  return names;
}

// ---------------------------------------------------------------------------
// 工具栏动作辅助（纯文本逻辑，jsdom 可测）
// ---------------------------------------------------------------------------

/**
 * 计算光标所在行的行首字符偏移（用于「引用/列表/标题」等行前缀类动作）。
 * caret 是文本内的字符偏移；返回最后一个换行符之后的位置（行首）。
 * 导出供单测。
 */
export function lineStartOffset(text: string, caret: number): number {
  const pos = Math.max(0, Math.min(caret, text.length));
  const idx = text.lastIndexOf("\n", pos - 1);
  return idx + 1;
}

/**
 * 标题级别循环：无前缀 → `## ` → `### ` → `#### ` → 去掉前缀。
 * 返回新的行文本与光标相对偏移（相对行首）。导出供单测。
 */
export function cycleHeading(line: string): string {
  const m = /^(#{1,6})\s/.exec(line);
  if (!m) return `## ${line}`;
  const level = m[1]?.length ?? 0;
  if (level >= 4) return line.slice(m[0].length);
  return `${"#".repeat(level + 1)} ${line.slice(m[0].length)}`;
}

/** 标题级别升降（A+ / A-）：无前缀时 A+ 加 ##，有前缀时增减一级（1-6 夹紧）。导出供单测。 */
export function shiftHeading(line: string, delta: 1 | -1): string {
  const m = /^(#{1,6})\s/.exec(line);
  if (!m) return delta > 0 ? `## ${line}` : line;
  const level = Math.min(6, Math.max(1, (m[1]?.length ?? 0) + delta));
  return `${"#".repeat(level)} ${line.slice(m[0].length)}`;
}
