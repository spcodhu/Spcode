/**
 * 输入框（Composer）E2E：草稿保存 / 长文本（Markdown）输入模式 / 高度自适应与列表对齐。
 * 断言锚 data-testid / placeholder / role，不锚展示文案（AGENTS.md 纪律）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

test.describe("输入框（Composer）", () => {
  test("草稿：发送后清空、切走带回、跨重启恢复", async () => {
    // 合并后本用例含三段启动（其中两段跨重启），放宽整体超时；断言自身 timeout 未改动
    test.setTimeout(180_000);

    // ---- 发送后草稿清空；草稿会话输入后切走再点加号自动带出 ----
    const app = await launchApp();
    const window = await app.firstWindow();
    await expect(window.getByTestId("brand")).toBeVisible({ timeout: 15000 });

    // 1) 发送一条消息（无模型也会 materialize 落盘）→ 输入框清空
    await window.getByRole("button", { name: /新建聊天/ }).click();
    const composer = window.getByPlaceholder(/说点什么|Markdown/);
    await expect(composer).toBeVisible({ timeout: 15000 });
    await composer.fill("你好");
    await composer.press("Enter");
    await expect(window.getByText("你好").first()).toBeVisible();
    await expect(composer).toHaveValue("");

    // 2) 侧栏「新对话」开草稿会话，输入文字但不发送
    await window.getByRole("button", { name: "新对话" }).click();
    await composer.fill("草稿乙");
    await expect(composer).toHaveValue("草稿乙");

    // 3) 切到上一个会话（侧栏会话行；草稿会话被 prune，草稿数据应保留）
    await window.locator("aside").getByTitle("你好", { exact: true }).click();
    await expect(window.locator("aside").getByTitle("你好", { exact: true })).toBeVisible();

    // 4) 再点「新对话」→ 草稿经稳定 key（draft:chat:）自动带出
    await window.getByRole("button", { name: "新对话" }).click();
    await expect(window.getByPlaceholder(/说点什么|Markdown/)).toHaveValue("草稿乙");

    await app.close();

    // ---- 草稿跨重启恢复（落盘持久化） ----
    const spcodeHome = mkdtempSync(join(tmpdir(), "spcode-e2e-drafts-"));
    const app2 = await launchApp({ spcodeHome });
    const window2 = await app2.firstWindow();
    await expect(window2.getByTestId("brand")).toBeVisible({ timeout: 15000 });

    await window2.getByRole("button", { name: /新建聊天/ }).click();
    const composer2 = window2.getByPlaceholder(/说点什么|Markdown/);
    await expect(composer2).toBeVisible({ timeout: 15000 });
    await composer2.fill("重启后还在的草稿");
    // 等防抖落盘（500ms）余量
    await window2.waitForTimeout(1200);
    await app2.close();

    // 同一 SPCODE_HOME 重启 → 草稿从 composer-drafts.json 恢复
    const app3 = await launchApp({ spcodeHome });
    const window3 = await app3.firstWindow();
    await expect(window3.getByTestId("brand")).toBeVisible({ timeout: 15000 });
    await window3.getByRole("button", { name: /新建聊天/ }).click();
    await expect(window3.getByPlaceholder(/说点什么|Markdown/)).toHaveValue("重启后还在的草稿");
    await app3.close();
  });

  test("长文本模式：工具栏、三态切换、Markdown/流程图渲染、按会话记住", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();
    await window.getByRole("button", { name: /新建聊天/ }).click();
    await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });

    // 切到长文本输入：文档式编辑区出现，三态控件与工具栏同时浮出
    await window.getByTestId("md-mode-toggle").click();
    await expect(window.getByTestId("md-tool-bold")).toBeVisible();
    await expect(window.getByTestId("md-tool-heading")).toBeVisible();
    await expect(window.getByTestId("md-tool-table")).toBeVisible();
    await expect(window.getByTestId("md-tool-mermaid")).toBeVisible();
    await expect(window.getByTestId("md-tool-math")).toBeVisible();
    await expect(window.getByTestId("md-view-split")).toBeVisible();

    const editor = window.getByTestId("md-editor");
    await expect(editor).toBeVisible();
    await expect(window.getByTestId("md-view-preview")).toBeVisible();

    // 编辑区立即变高（min 180px）
    const height = await editor.evaluate((el) => el.parentElement!.clientHeight);
    expect(height).toBeGreaterThanOrEqual(180);

    // 工具栏动作：点加粗插入 ** 包裹，再打字
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
      const sel = document.getSelection();
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

    // 流程图块：工具栏插入流程图模板（```mermaid graph TD ...```）
    await window.getByTestId("md-editor").click();
    // 光标移到文档末尾，保证流程图模板作为独立块插入
    await window.getByTestId("md-editor").evaluate((el) => {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    await window.getByTestId("md-tool-mermaid").click();

    // 预览：mermaid chunk 按需加载后渲染出 SVG 图
    await window.getByTestId("md-view-preview").click();
    await expect(window.locator(".md-body svg").first()).toBeVisible({ timeout: 20000 });

    // 回到编辑：模式按会话记住的检查需要编辑区可见
    await window.getByTestId("md-view-edit").click();

    // 模式与内容按会话记住（「新对话」dup 复用同一草稿）
    await window.getByRole("button", { name: "新对话" }).click();
    await expect(window.getByTestId("md-editor")).toContainText("重点");

    await app.close();
  });

  test("输入区高度自适应与列表对齐", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();

    await window.getByRole("button", { name: /新建聊天/ }).click();
    const composer = window.getByPlaceholder(/说点什么/);
    await expect(composer).toBeVisible({ timeout: 15000 });

    // 行高 24px：默认 min-height 44px ≈ 一行半、接近两行（旧实现空框只有 1 行 24px）
    const height = await composer.evaluate((el) => el.clientHeight);
    expect(height).toBeGreaterThanOrEqual(42);
    expect(height).toBeLessThanOrEqual(50);

    // 输入 20 行：field-sizing 让 textarea 自身变高到上限（200px）后内部滚动，外层不滚
    await composer.fill(Array.from({ length: 20 }, (_, i) => `第${i + 1}行`).join("\n"));
    const metrics = await composer.evaluate((el) => {
      const container = el.parentElement!;
      const cs = getComputedStyle(container);
      return {
        textareaScrollable: el.scrollHeight > el.clientHeight,
        containerScrollable: container.scrollHeight > container.clientHeight,
        paddingTop: cs.paddingTop,
        textareaOverflow: getComputedStyle(el).overflowY,
        textareaHeight: el.clientHeight,
      };
    });
    expect(metrics.textareaScrollable).toBe(true); // 内部滚动（滚动条出现在 textarea 自身）
    expect(metrics.containerScrollable).toBe(false); // 外层不滚，padding 不会被滚走
    expect(metrics.paddingTop).toBe("14px"); // pt-3.5 常驻
    expect(metrics.textareaOverflow).toBe("auto");
    expect(metrics.textareaHeight).toBeLessThanOrEqual(201); // max-h-[200px]

    // 普通输入：多行滚动后继续输入不跳回顶部
    const box = window.getByPlaceholder(/说点什么/);
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

    // 输入区无内层焦点框，手动列表与 Markdown 列表正文对齐
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
});
