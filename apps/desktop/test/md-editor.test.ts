/**
 * Markdown 编辑器序列化（md-editor.ts）单测（jsdom 环境）：
 * DOM ↔ 文本互为往返是组件区分「用户打字」与「外部变更」的基础，必须稳定。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import {
  collectImageNames,
  draftToEditorHtml,
  resolveImageRefs,
  serializeEditor,
} from "../src/renderer/src/md-editor.js";

const IMG = { name: "pasted-1.png", mimeType: "image/png", data: "aGVsbG8=" };

function dom(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

describe("serializeEditor", () => {
  it("纯文本与换行", () => {
    expect(serializeEditor(dom("hello"))).toBe("hello");
    expect(serializeEditor(dom("a<br>b"))).toBe("a\nb");
    expect(serializeEditor(dom("a<br><br>b"))).toBe("a\n\nb");
  });

  it("img[data-name] → ![name] 占位", () => {
    const html = `前面<img src="data:image/png;base64,aGVsbG8=" data-name="pasted-1.png" class="md-inline-img">后面`;
    expect(serializeEditor(dom(html))).toBe("前面![pasted-1.png]后面");
  });

  it("文本转义字符被正确还原（&lt; → <）", () => {
    expect(serializeEditor(dom("a &lt; b &amp; c"))).toBe("a < b & c");
  });
});

describe("draftToEditorHtml", () => {
  it("文本转义 + 换行 → <br>", () => {
    expect(draftToEditorHtml("a<b\ncc", [])).toBe("a&lt;b<br>cc");
  });

  it("有附件的 ![name] → 内嵌 img；无附件保留占位原文", () => {
    const html = draftToEditorHtml("看 ![pasted-1.png] 和 ![missing.png]", [IMG]);
    expect(html).toContain('<img src="data:image/png;base64,aGVsbG8="');
    expect(html).toContain('data-name="pasted-1.png"');
    expect(html).toContain("![missing.png]");
  });

  it("round-trip 稳定：serialize(draftToEditorHtml(text)) === text", () => {
    const cases = [
      "",
      "单行",
      "多行\n第二行\n\n空行后",
      "含 <tag> 与 & 符号",
      "图片 ![pasted-1.png] 在行中\n![pasted-1.png] 换行再来一张",
      "尾部换行\n",
    ];
    for (const text of cases) {
      expect(serializeEditor(dom(draftToEditorHtml(text, [IMG])))).toBe(text);
    }
  });
});

describe("resolveImageRefs", () => {
  it("占位解析为内联 data URL；无附件原样返回", () => {
    expect(resolveImageRefs("![pasted-1.png]", [IMG])).toBe("![pasted-1.png](data:image/png;base64,aGVsbG8=)");
    expect(resolveImageRefs("![none.png]", [IMG])).toBe("![none.png]");
    expect(resolveImageRefs("![pasted-1.png]", [])).toBe("![pasted-1.png]");
  });
});

describe("collectImageNames", () => {
  it("收集全部引用名（供清理已删除图片的附件）", () => {
    expect([...collectImageNames("![a.png] x ![b.png]")].sort()).toEqual(["a.png", "b.png"]);
    expect(collectImageNames("普通 [链接] 文本").size).toBe(0);
  });
});
