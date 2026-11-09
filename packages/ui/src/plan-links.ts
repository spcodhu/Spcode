export type PlanMarkdownPart =
  | { kind: "text"; key: string; text: string }
  | { kind: "plan"; key: string; path: string; label: string }
  | { kind: "file"; key: string; path: string; label: string }
  | { kind: "image"; key: string; path: string; label: string };

export type PlanMarkdownGroup = {
  kind: "block" | "inline";
  key: string;
  parts: PlanMarkdownPart[];
};

const LINK_PATTERN = /\[([^\]]+)]\(([^)]+)\)/g;
const EXTENSIONLESS_FILENAMES = new Set([
  "readme",
  "license",
  "makefile",
  "dockerfile",
  "containerfile",
  "changelog",
  "contributing",
  "codeowners",
]);

/** Markdown 目标可以是 <path>，也可以带可选的 "title"；这里只取真正的路径部分。 */
function unwrapDestination(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("<")) {
    const end = value.indexOf(">");
    if (end < 0) return "";
    const rest = value.slice(end + 1).trim();
    if (rest && !/^(?:"[^"]*"|'[^']*')$/.test(rest)) return "";
    return value.slice(1, end).trim();
  }
  const titled = value.match(/^(.*?)(?:\s+(?:"[^"]*"|'[^']*'))$/);
  return (titled?.[1] ?? value).trim();
}

function safeDecode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** 模型常给 path:12、path:12:34 或 path#L12-L20；预览先定位到整个文件。 */
function stripLineReference(path: string): string {
  return path.replace(/#L\d+(?:-L?\d+)?$/i, "").replace(/:\d+(?::\d+)?$/, "");
}

function isWindowsAbsolute(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** file: 既接受 file:src/a.ts，也接受标准 file:///abs/a.ts；非本机 host 一律拒绝。 */
function parseFileScheme(value: string): string | null {
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== "localhost") return null;
      let path = safeDecode(url.pathname);
      if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1);
      return path || null;
    } catch {
      return null;
    }
  }
  if (/^file:/i.test(value)) return safeDecode(value.slice("file:".length).trim()) || null;
  return null;
}

/**
 * 无前缀的链接只有在明显像本地文件时才接管：带扩展名或常见无扩展文件名。
 * 这样 README.md、./src/a.ts、/abs/a.ts 可预览，而 https、mailto、#anchor、/docs 路由不受影响。
 */
function looksLikePlainFilePath(value: string): boolean {
  if (!value || value.startsWith("#") || value.startsWith("//") || /^www\./i.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !isWindowsAbsolute(value)) return false;
  const path = stripLineReference(value);
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return /\.[a-z0-9]{1,12}$/i.test(name) || EXTENSIONLESS_FILENAMES.has(name);
}

function classifyDestination(raw: string): { kind: "plan" | "file"; path: string } | null {
  const destination = unwrapDestination(raw);
  if (!destination || /[\r\n\0]/.test(destination)) return null;
  if (destination.startsWith("plan:")) {
    const path = destination.slice("plan:".length).trim();
    return path.toLowerCase().endsWith(".md") ? { kind: "plan", path } : null;
  }
  if (/^file:/i.test(destination)) {
    const path = parseFileScheme(destination);
    return path ? { kind: "file", path: stripLineReference(path) } : null;
  }
  if (!looksLikePlainFilePath(destination)) return null;
  return { kind: "file", path: safeDecode(stripLineReference(destination)) };
}

/**
 * 把 fenced code block 与行内代码替换成等长空格（保留换行和 UTF-16 下标），
 * 链接只在这份掩码文本上识别，避免把源码/文档示例中的 Markdown 链接拆出代码块。
 */
function maskMarkdownCode(text: string): string {
  const masked = text.split("");
  const hide = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      if (masked[i] !== "\n" && masked[i] !== "\r") masked[i] = " ";
    }
  };

  let fence: { char: string; size: number } | null = null;
  for (let start = 0; start < text.length; ) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline + 1;
    const line = text.slice(start, newline < 0 ? text.length : newline);
    const marker = line.match(/^[ \t]*(`{3,}|~{3,})/)?.[1];
    if (fence) {
      hide(start, end);
      const closing = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/)?.[1];
      if (closing && closing.charAt(0) === fence.char && closing.length >= fence.size) fence = null;
    } else if (marker) {
      hide(start, end);
      fence = { char: marker.charAt(0), size: marker.length };
    }
    start = end;
  }

  // fenced 区域已变成空格，剩余反引号只可能是行内代码；相同长度的反引号串配对。
  let i = 0;
  while (i < masked.length) {
    if (masked[i] !== "`") {
      i++;
      continue;
    }
    let size = 1;
    while (masked[i + size] === "`") size++;
    let close = -1;
    let j = i + size;
    while (j < masked.length) {
      if (masked[j] !== "`") {
        j++;
        continue;
      }
      let length = 1;
      while (masked[j + length] === "`") length++;
      if (length === size) {
        close = j;
        break;
      }
      j += length;
    }
    if (close < 0) {
      i += size;
      continue;
    }
    hide(i, close + size);
    i = close + size;
  }
  return masked.join("");
}

/**
 * 把计划链接和模型给出的本地文件链接拆成独立入口，其它 Markdown 原样渲染。
 * 这里只做识别，不读取文件；桌面端仍须经过主进程的工作区路径守卫。
 */
export function splitPlanLinks(text: string, options?: { includeImages?: boolean }): PlanMarkdownPart[] {
  const parts: PlanMarkdownPart[] = [];
  const linkText = maskMarkdownCode(text);
  let cursor = 0;
  for (const match of linkText.matchAll(LINK_PATTERN)) {
    const index = match.index ?? 0;
    const isImage = text[index - 1] === "!";
    // 普通消息仍交给 Streamdown 处理图片；只有工作区预览显式要求时才拆出本地图片，
    // 由桌面端经主进程路径守卫加载，避免 file:/相对路径被安全白名单显示为 Image blocked。
    if (isImage && !options?.includeImages) continue;
    const link = classifyDestination(match[2] ?? "");
    if (!link) continue;
    const start = isImage ? index - 1 : index;
    if (start > cursor) parts.push({ kind: "text", key: `text-${cursor}`, text: text.slice(cursor, start) });
    parts.push({
      kind: isImage ? "image" : link.kind,
      key: `${isImage ? "image" : link.kind}-${start}`,
      path: link.path,
      label: match[1] || link.path,
    });
    cursor = index + match[0].length;
  }
  if (parts.length === 0) return [{ kind: "text", key: "text-0", text }];
  if (cursor < text.length) parts.push({ kind: "text", key: `text-${cursor}`, text: text.slice(cursor) });
  return parts;
}

const PARAGRAPH_BOUNDARY = /(\n[\t ]*\n[\t \n]*)/;
const BLOCK_MARKDOWN = /^[ \t]*(?:#{1,6}[ \t]+|>|```|~~~|[-+*][ \t]+|\d+[.)][ \t]+|(?:-{3,}|\*{3,}|_{3,})[ \t]*$)/m;

/** 空行是块级分组的硬边界；保留分隔文本，重组后不改变原始 Markdown。 */
function splitParagraphText(part: Extract<PlanMarkdownPart, { kind: "text" }>): PlanMarkdownPart[] {
  return part.text
    .split(PARAGRAPH_BOUNDARY)
    .filter((text) => text.length > 0)
    .map((text, index) => ({ kind: "text", key: `${part.key}-p${index}`, text }));
}

function isParagraphBoundary(text: string): boolean {
  return /^\n[\t ]*\n[\t \n]*$/.test(text);
}

/**
 * 文件链接拆分时不能把同一段正文也拆成竖排块。这里按原始空行重新分组：
 * 含文件链接的普通段落使用 inline，标题/列表/代码块等仍走完整 Streamdown 块渲染。
 * 没有文件链接时直接返回原 parts，避免影响普通 Markdown 的解析与渲染。
 */
export function groupPlanMarkdownParts(parts: PlanMarkdownPart[]): PlanMarkdownGroup[] {
  if (!parts.some((part) => part.kind === "file" || part.kind === "plan")) {
    return [{ kind: "block", key: parts[0]?.key ?? "empty", parts }];
  }

  const fragments = parts.flatMap((part) => (part.kind === "text" ? splitParagraphText(part) : [part]));
  const groups: PlanMarkdownGroup[] = [];
  let blockParts: PlanMarkdownPart[] = [];
  let inlineParts: PlanMarkdownPart[] = [];
  let inlineHasLink = false;

  const flushBlock = () => {
    if (blockParts.length > 0) groups.push({ kind: "block", key: blockParts[0]!.key, parts: blockParts });
    blockParts = [];
  };
  const appendBlock = (part: PlanMarkdownPart) => {
    const last = blockParts[blockParts.length - 1];
    if (part.kind === "text" && last?.kind === "text") last.text += part.text;
    else blockParts.push(part);
  };
  const flushInline = () => {
    if (inlineHasLink) {
      flushBlock();
      groups.push({ kind: "inline", key: inlineParts[0]!.key, parts: inlineParts });
    } else {
      for (const part of inlineParts) appendBlock(part);
    }
    inlineParts = [];
    inlineHasLink = false;
  };

  for (const part of fragments) {
    if (part.kind === "file" || part.kind === "plan") {
      inlineParts.push(part);
      inlineHasLink = true;
    } else if (part.kind === "text" && !isParagraphBoundary(part.text) && !BLOCK_MARKDOWN.test(part.text)) {
      inlineParts.push(part);
    } else {
      flushInline();
      appendBlock(part);
    }
  }
  flushInline();
  flushBlock();
  return groups;
}
