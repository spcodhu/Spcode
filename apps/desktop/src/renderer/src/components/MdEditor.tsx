/**
 * Markdown 编辑器：contentEditable 实现的「文档式」输入区。
 *
 * - 文本是 raw markdown，图片内嵌 <img> 直显（附件 base64），即「图片显示在对应位置」
 * - 非受控 DOM + 序列化同步：打字只上行（DOM→store），外部变更（发送清空/草稿恢复/
 *   prefill/切会话）才下行（store→DOM），比对一致就不重设 innerHTML，光标不跳
 * - Enter 发送 / Shift+Enter 换行（insertText "\n"，浏览器生成 <br> 且光标正确跟随）
 * - 粘贴：图片内嵌光标处；text/html 经 turndown 转 markdown 插入；纯文本规范化插入
 */

import type { ImageAttachment } from "@spcode/shared";
import { i18n } from "@spcode/shared/i18n";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { useTranslation } from "react-i18next";
import TurndownService from "turndown";
import {
  collectImageNames,
  cycleHeading,
  draftToEditorHtml,
  lineStartOffset,
  serializeEditor,
  shiftHeading,
} from "../md-editor";

/** 工具栏动作（image 由 Composer 走附件通道，不进编辑器动作表） */
export type MdAction =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "heading"
  | "heading-up"
  | "heading-down"
  | "quote"
  | "ol"
  | "ul"
  | "code"
  | "code-block"
  | "link"
  | "table"
  | "mermaid"
  | "math"
  | "undo"
  | "redo";

export interface MdEditorHandle {
  /** 在光标处内嵌图片（无选区时追加到末尾），并把附件并入 attachments */
  insertImages(atts: ImageAttachment[]): void;
  /** 在光标处插入 markdown 文本（\n 规范化为 <br>） */
  insertMarkdown(md: string): void;
  /** 工具栏动作：包裹/行前缀/块插入/撤销重做 */
  applyAction(action: MdAction): void;
  focus(): void;
  /** 外部 prefill 重建内容后聚焦，并把选区折叠到文档末尾 */
  focusAtEnd(): void;
}

/** 富文本粘贴 → Markdown（模块级单例） */
let turndown: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (!turndown) turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  return turndown;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 把浏览器选区收敛到编辑器内（无选区/选区在外部时移到内容末尾） */
function ensureSelectionInside(root: HTMLElement): void {
  root.focus();
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && root.contains(sel.anchorNode)) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

export const MdEditor = forwardRef<
  MdEditorHandle,
  {
    /** store 草稿 key：变化时强制重建内容（切会话） */
    draftKey: string;
    text: string;
    attachments: ImageAttachment[];
    placeholder: string;
    onSync: (text: string, attachments: ImageAttachment[]) => void;
    onSend: () => void;
  }
>(function MdEditor({ draftKey, text, attachments, placeholder, onSync, onSend }, ref) {
  const { t } = useTranslation("chat");
  const rootRef = useRef<HTMLDivElement>(null);
  // onSync/附件的最新引用（onInput 等事件回调闭包用，避免每次渲染重绑监听）
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;

  /** DOM → store：序列化 + 空态归一 + 清理已删除图片的附件 */
  const syncFromDom = () => {
    const root = rootRef.current;
    if (!root) return;
    let next = serializeEditor(root);
    if (!next.trim() && !root.querySelector("img")) {
      // 空态归一：浏览器残留的 <br> 占位清掉，恢复 :empty 占位符
      if (root.innerHTML !== "") root.innerHTML = "";
      next = "";
    }
    const names = collectImageNames(next);
    const kept = attachmentsRef.current.filter((a) => names.has(a.name));
    onSyncRef.current(next, kept);
  };

  /**
   * 在光标处插入纯文本（多行可靠）：转义后拼 <br> 走 insertHTML——
   * execCommand("insertText") 对多行字符串会吞掉换行（实测），且 insertHTML 能进原生 undo 栈。
   * backChars：插入后光标从末尾回退的字符数（用于把光标放进包裹标记/代码块中间）。
   */
  const insertPlain = (text: string, backChars = 0) => {
    const root = rootRef.current;
    if (!root) return;
    ensureSelectionInside(root);
    document.execCommand("insertHTML", false, text.split("\n").map(escHtml).join("<br>"));
    const sel = window.getSelection();
    for (let i = 0; i < backChars; i++) sel?.modify("move", "backward", "character");
    syncFromDom();
  };

  /** 对称包裹选区（无选区则插入一对标记并把光标放到中间） */
  const wrapSelection = (before: string, after = before) => {
    const root = rootRef.current;
    if (!root) return;
    ensureSelectionInside(root);
    const selected = window.getSelection()?.toString() ?? "";
    insertPlain(`${before}${selected}${after}`, selected ? 0 : after.length);
  };

  /** 当前 caret 所在文本节点与行范围（caret 在非文本容器时返回 null，由调用方兜底） */
  const caretLine = (root: HTMLElement) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer)) return null;
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return null;
    const text = node as Text;
    const data = text.data;
    const start = lineStartOffset(data, range.startOffset);
    const nextNl = data.indexOf("\n", start);
    const end = nextNl < 0 ? data.length : nextNl;
    return { text, start, end, caret: range.startOffset };
  };

  /** 把光标设到文本节点的指定偏移（collapsed） */
  const setCaret = (node: Text, offset: number) => {
    const range = document.createRange();
    range.setStart(node, Math.max(0, Math.min(offset, node.data.length)));
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  /** 行前缀类动作（引用/有序/无序）：toggle 前缀，光标保持相对行位置 */
  const toggleLinePrefix = (prefix: string) => {
    const root = rootRef.current;
    if (!root) return;
    ensureSelectionInside(root);
    const info = caretLine(root);
    if (!info) {
      // 兜底：非文本容器（光标在 <br>/root 层）→ 直接插入前缀
      insertPlain(prefix);
      syncFromDom();
      return;
    }
    const { text, start, end, caret } = info;
    const line = text.data.slice(start, end);
    const has = line.startsWith(prefix);
    if (has) text.deleteData(start, prefix.length);
    else text.insertData(start, prefix);
    const delta = has ? -prefix.length : prefix.length;
    setCaret(text, caret + delta);
    syncFromDom();
  };

  /** 整行变换（标题类）：替换行文本，光标落到行尾 */
  const transformLine = (fn: (line: string) => string) => {
    const root = rootRef.current;
    if (!root) return;
    ensureSelectionInside(root);
    const info = caretLine(root);
    if (!info) {
      insertPlain(fn(""));
      syncFromDom();
      return;
    }
    const { text, start, end } = info;
    const next = fn(text.data.slice(start, end));
    text.deleteData(start, end - start);
    text.insertData(start, next);
    setCaret(text, start + next.length);
    syncFromDom();
  };

  /**
   * 块插入：前后各补一个空行（markdown 块语法要求空行分隔，否则表格/公式会被并进上一段），
   * caretBack 让光标回退到模板内的空位。
   */
  const insertBlock = (template: string, caretBack = 0) => {
    insertPlain(`\n\n${template}\n\n`, caretBack);
  };

  /** 工具栏动作主入口（包裹 / 行前缀 / 块插入 / 撤销重做） */
  const applyAction = (action: MdAction) => {
    const root = rootRef.current;
    if (!root) return;
    root.focus();
    switch (action) {
      case "bold":
        return wrapSelection("**");
      case "italic":
        return wrapSelection("*");
      case "underline":
        return wrapSelection("<u>", "</u>");
      case "strike":
        return wrapSelection("~~");
      case "code":
        return wrapSelection("`");
      case "math": {
        // 智能公式：有选中 → 行内 $x$；无选中 → 块公式 $$…$$（光标落中间空行）
        ensureSelectionInside(root);
        const selected = window.getSelection()?.toString() ?? "";
        if (selected) insertPlain(`$${selected}$`);
        else insertBlock("$$\n\n$$", 4);
        return;
      }
      case "heading":
        return transformLine(cycleHeading);
      case "heading-up":
        return transformLine((l) => shiftHeading(l, 1));
      case "heading-down":
        return transformLine((l) => shiftHeading(l, -1));
      case "quote":
        return toggleLinePrefix("> ");
      case "ol":
        return toggleLinePrefix("1. ");
      case "ul":
        return toggleLinePrefix("- ");
      case "link": {
        ensureSelectionInside(root);
        const selected = window.getSelection()?.toString() ?? "";
        insertPlain(selected ? `[${selected}](url)` : t("editor.linkTemplate"));
        return;
      }
      case "code-block":
        return insertBlock("```\n\n```", 5);
      case "table":
        return insertBlock(t("editor.tableTemplate"));
      case "mermaid":
        return insertBlock(t("editor.mermaidTemplate"));
      case "undo":
        document.execCommand("undo");
        return syncFromDom();
      case "redo":
        document.execCommand("redo");
        return syncFromDom();
    }
  };

  /** store → DOM：仅外部变更时重设（打字期间 serialize(DOM) 必然等于 text） */
  // biome-ignore lint/correctness/useExhaustiveDependencies: draftKey 仅作会话切换信号驱动重设，effect 体内不直接引用
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (serializeEditor(root) === text) return;
    root.innerHTML = draftToEditorHtml(text, attachmentsRef.current);
  }, [text, draftKey]);

  // 挂载时灌入草稿（首帧 effect 已覆盖；这里处理 StrictMode 重挂载：DOM 重建后 effect 不一定再跑）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅挂载时执行，取挂载时刻的 text 即可
  useEffect(() => {
    const root = rootRef.current;
    if (root && text && !root.innerHTML) {
      root.innerHTML = draftToEditorHtml(text, attachmentsRef.current);
    }
  }, []);

  /** 在光标处内嵌图片（无选区时追加到末尾），并把附件并入附件列表 */
  const insertAttachments = (atts: ImageAttachment[]) => {
    const root = rootRef.current;
    if (!root || atts.length === 0) return;
    ensureSelectionInside(root);
    for (const att of atts) {
      const name = escHtml(att.name);
      document.execCommand(
        "insertHTML",
        false,
        `<img src="data:${att.mimeType};base64,${att.data}" data-name="${name}" alt="${name}" class="md-inline-img" />`,
      );
    }
    onSyncRef.current(serializeEditor(root), [...attachmentsRef.current, ...atts]);
  };

  useImperativeHandle(ref, () => ({
    insertImages: insertAttachments,
    insertMarkdown(md) {
      const root = rootRef.current;
      if (!root || !md) return;
      ensureSelectionInside(root);
      // 手动规范化（转义 + \n→<br>），不依赖浏览器 insertHTML 对纯文本的差异化处理
      document.execCommand("insertHTML", false, md.split("\n").map(escHtml).join("<br>"));
      syncFromDom();
    },
    applyAction(action) {
      applyAction(action);
    },
    focus() {
      rootRef.current?.focus();
    },
    focusAtEnd() {
      const root = rootRef.current;
      if (!root) return;
      root.focus();
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
  }));

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imgFiles = items
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f && f.size <= 10 * 1024 * 1024);
    if (imgFiles.length > 0) {
      e.preventDefault();
      void Promise.all(imgFiles.map((f, i) => fileToAttachment(f, i))).then(insertAttachments);
      return;
    }
    const html = e.clipboardData?.getData("text/html") ?? "";
    if (html.trim()) {
      e.preventDefault();
      const md = getTurndown().turndown(html);
      if (md.trim()) {
        ensureSelectionInside(rootRef.current!);
        document.execCommand("insertHTML", false, md.split("\n").map(escHtml).join("<br>"));
        syncFromDom();
      }
      return;
    }
    const plain = e.clipboardData?.getData("text/plain") ?? "";
    if (plain) {
      e.preventDefault();
      ensureSelectionInside(rootRef.current!);
      document.execCommand("insertHTML", false, plain.split("\n").map(escHtml).join("<br>"));
      syncFromDom();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter") return;
    if (e.nativeEvent.isComposing) return; // IME 组词中的 Enter 是上屏，不触发发送/换行
    e.preventDefault();
    if (e.shiftKey) {
      // insertText "\n"：浏览器生成 <br> 且光标正确跟随（insertHTML "<br>" 在末尾时光标不上移）
      document.execCommand("insertText", false, "\n");
      syncFromDom();
    } else {
      onSendRef.current();
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: contentEditable 富文本编辑器无语义等价元素，已标 role="textbox" + aria-multiline
    <div
      ref={rootRef}
      data-testid="md-editor"
      contentEditable
      role="textbox"
      aria-multiline="true"
      aria-label={t("editor.label")}
      tabIndex={0}
      data-placeholder={placeholder}
      onInput={syncFromDom}
      onPaste={handlePaste}
      onKeyDown={handleKeyDown}
      className="md-editor mono text-[14px] leading-6"
    />
  );
});

/** 剪贴板图片 File → ImageAttachment（独立命名：占位与附件同名）。Composer 的 plain 模式粘贴也复用。 */
export function fileToAttachment(file: File, index = 0): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const comma = url.indexOf(",");
      if (comma < 0) return reject(new Error(i18n.t("chat:editor.imageReadError")));
      const ext = file.type.split("/")[1]?.toLowerCase() || "png";
      resolve({ name: `pasted-${Date.now()}-${index + 1}.${ext}`, mimeType: file.type, data: url.slice(comma + 1) });
    };
    reader.onerror = () => reject(reader.error ?? new Error(i18n.t("chat:editor.imageReadError")));
    reader.readAsDataURL(file);
  });
}
