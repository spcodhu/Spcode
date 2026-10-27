import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

/**
 * Composer 输入区回归：
 * 1) 普通输入框多行出现内部滚动后，继续输入不得跳回顶部（field-sizing 修复的回归钉）
 * 2) 长文本（Markdown）模式：工具栏动作、编辑/分屏/预览三态、公式与流程图真渲染
 */

test.describe("Composer 输入区", () => {
  test("普通输入：多行滚动后继续输入不跳回顶部", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();
    await window.getByRole("button", { name: /新建聊天/ }).click();
    const box = window.getByPlaceholder(/说点什么/);
    await expect(box).toBeVisible({ timeout: 15000 });

    // 20 行内容 → 超过 max-h 出现内部滚动
    const lines = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行内容`).join("\n");
    await box.fill(lines);
    await box.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const before = await box.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(0);

    // 光标置于末尾后继续输入（真实用户场景：在最后一行打字）
    await box.evaluate((el: HTMLTextAreaElement) => {
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
    });
    await window.keyboard.type("继续输入");
    await window.waitForTimeout(100);

    const after = await box.evaluate((el) => el.scrollTop);
    // 修复前：高度重算把 scrollTop 夹回 0（每敲一个字跳回顶部）
    expect(after).toBeGreaterThan(0);

    await app.close();
  });

  test("长文本模式：工具栏、三态切换、Markdown 渲染", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();
    await window.getByRole("button", { name: /新建聊天/ }).click();
    await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });

    // 切到长文本输入：工具栏出现
    await window.getByTestId("md-mode-toggle").click();
    await expect(window.getByTestId("md-tool-bold")).toBeVisible();
    await expect(window.getByTestId("md-tool-heading")).toBeVisible();
    await expect(window.getByTestId("md-tool-table")).toBeVisible();
    await expect(window.getByTestId("md-tool-mermaid")).toBeVisible();
    await expect(window.getByTestId("md-tool-math")).toBeVisible();
    await expect(window.getByTestId("md-view-split")).toBeVisible();

    // 工具栏动作：点加粗插入 ** 包裹，再打字
    const editor = window.getByTestId("md-editor");
    await editor.click();
    await window.getByTestId("md-tool-bold").click();
    await window.keyboard.type("重点");
    await expect(editor).toContainText("**重点**");

    // 光标移到文档末尾（避免后续块内容落进未闭合的加粗语境）
    await editor.evaluate((el) => {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });

    // 插入表格模板与公式块（前后自动补空行）
    await window.getByTestId("md-tool-table").click();
    await window.getByTestId("md-tool-math").click();
    // 光标落在公式块中间空行：写入具体公式（空公式渲染为不可见的空 span）
    await window.keyboard.type("E = mc^2");

    // 分屏：左右两栏都在，预览侧渲染出表格（工具栏插入的模板）
    await window.getByTestId("md-view-split").click();
    await expect(window.getByTestId("md-editor")).toBeVisible();
    await expect(window.locator(".md-body")).toBeVisible();
    await expect(window.locator(".md-body table")).toBeVisible();

    // 预览：编辑器隐藏，公式经 KaTeX 渲染
    await window.getByTestId("md-view-preview").click();
    await expect(window.getByTestId("md-editor")).toHaveCount(0);
    await expect(window.locator(".md-body .katex").first()).toBeVisible({ timeout: 15000 });
    await window.screenshot({ path: "/tmp/md-preview.png" });

    // 回到编辑并截图存档（工具栏视觉核对用）
    await window.getByTestId("md-view-edit").click();
    await window.screenshot({ path: "/tmp/md-edit.png" });

    await app.close();
  });

  test("输入区无内层焦点框，手动列表与 Markdown 列表正文对齐", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();
    await window.getByRole("button", { name: /新建聊天/ }).click();

    const plain = window.getByTestId("composer-input");
    await plain.focus();
    await expect(plain).toHaveCSS("outline-style", "none");

    await window.getByTestId("md-mode-toggle").click();
    const editor = window.getByTestId("md-editor");
    await editor.focus();
    await expect(editor).toHaveCSS("outline-style", "none");
    const setEditorText = async (text: string) => {
      await editor.evaluate((el, value) => {
        el.innerHTML = value.replace(/\n/g, "<br>");
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      }, text);
    };
    await setEditorText("1、第一条\n2、第二条");

    const manualXs = await editor.evaluate((el) => {
      const xs: number[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const marker of ["第一条", "第二条"]) {
          const offset = (node.textContent ?? "").indexOf(marker);
          if (offset < 0) continue;
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + marker.length);
          xs.push(range.getBoundingClientRect().x);
        }
      }
      return xs;
    });
    expect(manualXs).toHaveLength(2);
    expect(Math.abs(manualXs[0]! - manualXs[1]!)).toBeLessThanOrEqual(1);

    await setEditorText(
      "1. 第一条内容\n2. 第二条内容\n10. 第十条是一条用来验证长条目折行后仍然与正文起点保持一致的列表内容，继续补充足够多的文字以确保它一定超过预览区域的一行宽度",
    );
    await window.getByTestId("md-view-preview").click();
    const items = window.locator(".md-body ol > li");
    await expect(items).toHaveCount(3);
    const listMetrics = await items.evaluateAll((lis) =>
      lis.map((li) => {
        const range = document.createRange();
        range.selectNodeContents(li);
        return {
          x: li.getBoundingClientRect().x,
          lineXs: [...range.getClientRects()].map((r) => Math.round(r.x)),
        };
      }),
    );
    expect(Math.abs(listMetrics[0]!.x - listMetrics[1]!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(listMetrics[1]!.x - listMetrics[2]!.x)).toBeLessThanOrEqual(1);
    expect(listMetrics[2]!.lineXs.length).toBeGreaterThan(1);
    expect(Math.max(...listMetrics[2]!.lineXs) - Math.min(...listMetrics[2]!.lineXs)).toBeLessThanOrEqual(1);

    await app.close();
  });

  test("流程图块：mermaid 插件按需加载后渲染出 SVG", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();
    await window.getByRole("button", { name: /新建聊天/ }).click();
    await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });

    await window.getByTestId("md-mode-toggle").click();
    // 工具栏插入流程图模板（```mermaid graph TD ...```）
    await window.getByTestId("md-editor").click();
    await window.getByTestId("md-tool-mermaid").click();

    // 预览：mermaid chunk 按需加载后渲染出 SVG 图
    await window.getByTestId("md-view-preview").click();
    await expect(window.locator(".md-body svg").first()).toBeVisible({ timeout: 20000 });

    await app.close();
  });
});
