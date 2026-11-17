export type PlanMarkdownPart =
  | { kind: "text"; key: string; text: string }
  | { kind: "plan"; key: string; path: string; label: string }
  | { kind: "file"; key: string; path: string; label: string }
  | { kind: "image"; key: string; path: string; label: string };

/** 正文里的本地目标（计划文件 / 会话文件 / 本地位图），渲染层据此决定点击行为。 */
export interface LocalMediaToken {
  kind: "plan" | "file" | "image";
  path: string;
  label: string;
}

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

/**
 * 行内占位符前缀。
 *
 * 为什么需要占位符：本地链接（`file:` / `plan:` / 相对路径）在 Streamdown 的
 * raw → sanitize → harden 管线里会被整段降级（harden 把 `file:` 列为永久拒绝协议，
 * 相对路径在渲染进程里也加载不出位图）。旧做法是把链接从正文里切出来单独渲染，
 * 代价是链接脱离了原本的 Markdown 结构——列表项里的链接会被顶到列表外面，
 * 留下一个「空头」项目符号，链接与后面的标点各占一行。
 *
 * 现在改为：把链接替换成行内代码占位符（`代码` 在 sanitize 里只剩纯文本，
 * 不受协议白名单影响），再交给 Markdown 的 inlineCode 渲染器还原成文件入口。
 * 这样入口始终留在原来的行内位置（列表项、表格单元格、引用块都成立）。
 */
const TOKEN_PREFIX = "spcode-media:";

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

interface LocalLinkHit {
  /** 链接起点（图片语法含前面那个 `!`） */
  start: number;
  /** 链接终点（右括号之后） */
  end: number;
  token: LocalMediaToken;
}

function collectLocalLinks(text: string, includeImages: boolean): LocalLinkHit[] {
  const hits: LocalLinkHit[] = [];
  const linkText = maskMarkdownCode(text);
  for (const match of linkText.matchAll(LINK_PATTERN)) {
    const index = match.index ?? 0;
    const isImage = text[index - 1] === "!";
    // 普通消息仍交给渲染器处理图片；只有工作区预览显式要求时才接管本地图片，
    // 避免 file:/相对路径被安全白名单显示为 Image blocked。
    if (isImage && !includeImages) continue;
    const link = classifyDestination(match[2] ?? "");
    if (!link) continue;
    hits.push({
      start: isImage ? index - 1 : index,
      end: index + match[0].length,
      token: { kind: isImage ? "image" : link.kind, path: link.path, label: match[1] || link.path },
    });
  }
  return hits;
}

/**
 * 把计划链接和模型给出的本地文件链接拆成独立入口，其它 Markdown 原样渲染。
 * 这里只做识别，不读取文件；桌面端仍须经过主进程的工作区路径守卫。
 * 供「会话文件列表」这类需要先知道有哪些文件的地方使用，正文渲染不走这条路径。
 */
export function splitPlanLinks(text: string, options?: { includeImages?: boolean }): PlanMarkdownPart[] {
  const parts: PlanMarkdownPart[] = [];
  let cursor = 0;
  for (const hit of collectLocalLinks(text, options?.includeImages === true)) {
    if (hit.start > cursor) parts.push({ kind: "text", key: `text-${cursor}`, text: text.slice(cursor, hit.start) });
    parts.push({
      kind: hit.token.kind,
      key: `${hit.token.kind}-${hit.start}`,
      path: hit.token.path,
      label: hit.token.label,
    });
    cursor = hit.end;
  }
  if (parts.length === 0) return [{ kind: "text", key: "text-0", text }];
  if (cursor < text.length) parts.push({ kind: "text", key: `text-${cursor}`, text: text.slice(cursor) });
  return parts;
}

/**
 * 把本地链接替换成行内代码占位符，让渲染器在原地还原成文件入口。
 * 返回的文本只有链接位置被替换，其余 Markdown 逐字不变。
 */
export function encodeLocalMedia(text: string, options?: { includeImages?: boolean }): string {
  const hits = collectLocalLinks(text, options?.includeImages === true);
  if (hits.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const hit of hits) {
    out += text.slice(cursor, hit.start);
    // 占位符本身也是反引号包裹：紧邻反引号时补一个空格，避免两个 code span 被合并
    if (out.endsWith("`")) out += " ";
    out += `\`${TOKEN_PREFIX}${encodeURIComponent(JSON.stringify(hit.token))}\``;
    cursor = hit.end;
    if (text[cursor] === "`") out += " ";
  }
  return out + text.slice(cursor);
}

/** 解码 inlineCode 里的占位符；普通行内代码一律返回 null，交给默认渲染。 */
export function decodeLocalMediaToken(raw: string): LocalMediaToken | null {
  const value = raw.trim();
  if (!value.startsWith(TOKEN_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value.slice(TOKEN_PREFIX.length)));
    if (!parsed || typeof parsed !== "object") return null;
    const { kind, path, label } = parsed as Partial<LocalMediaToken>;
    if (kind !== "plan" && kind !== "file" && kind !== "image") return null;
    if (typeof path !== "string" || !path) return null;
    return { kind, path, label: typeof label === "string" && label ? label : path };
  } catch {
    return null;
  }
}
