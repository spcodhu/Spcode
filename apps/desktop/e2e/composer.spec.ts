/**
 * 输入框（Composer）E2E：草稿保存 / Markdown 输入模式 / 高度自适应边距。
 * 断言锚 data-testid / placeholder / role，不锚展示文案（AGENTS.md 纪律）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

test.describe("输入框：草稿保存", () => {
  test("发送后草稿清空；草稿会话输入后切走再点加号自动带出", async () => {
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
  });

  test("草稿跨重启恢复（落盘持久化）", async () => {
    const spcodeHome = mkdtempSync(join(tmpdir(), "spcode-e2e-drafts-"));
    const app = await launchApp({ spcodeHome });
    const window = await app.firstWindow();
    await expect(window.getByTestId("brand")).toBeVisible({ timeout: 15000 });

    await window.getByRole("button", { name: /新建聊天/ }).click();
    const composer = window.getByPlaceholder(/说点什么|Markdown/);
    await expect(composer).toBeVisible({ timeout: 15000 });
    await composer.fill("重启后还在的草稿");
    // 等防抖落盘（500ms）余量
    await window.waitForTimeout(1200);
    await app.close();

    // 同一 SPCODE_HOME 重启 → 草稿从 composer-drafts.json 恢复
    const app2 = await launchApp({ spcodeHome });
    const window2 = await app2.firstWindow();
    await expect(window2.getByTestId("brand")).toBeVisible({ timeout: 15000 });
    await window2.getByRole("button", { name: /新建聊天/ }).click();
    await expect(window2.getByPlaceholder(/说点什么|Markdown/)).toHaveValue("重启后还在的草稿");
    await app2.close();
  });
});

test.describe("输入框：Markdown 模式", () => {
  test("MD 切换 → 等宽字体与占位文案 → 预览渲染 → 切回保留模式", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();

    await window.getByRole("button", { name: /新建聊天/ }).click();
    const composer = window.getByPlaceholder(/说点什么/);
    await expect(composer).toBeVisible({ timeout: 15000 });

    // 切到 MD 模式：占位文案变化，出现预览按钮
    await window.getByTestId("md-mode-toggle").click();
    const mdComposer = window.getByPlaceholder(/Markdown/);
    await expect(mdComposer).toBeVisible();
    await expect(window.getByTestId("md-preview-toggle")).toBeVisible();

    // 输入 markdown，切预览 → 渲染出标题
    await mdComposer.fill("# 大标题");
    await window.getByTestId("md-preview-toggle").click();
    await expect(window.getByRole("heading", { name: "大标题" })).toBeVisible();

    // 切回编辑 → 原文还在
    await window.getByTestId("md-preview-toggle").click();
    await expect(window.getByPlaceholder(/Markdown/)).toHaveValue("# 大标题");

    // MD 模式按会话记住：侧栏「新对话」dup 复用同一草稿会话，模式与文本都还在
    await window.getByRole("button", { name: "新对话" }).click();
    await expect(window.getByPlaceholder(/Markdown/)).toHaveValue("# 大标题");

    await app.close();
  });
});

test.describe("输入框：高度自适应", () => {
  test("多行输入时滚动在外层容器（顶部 padding 常驻）", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();

    await window.getByRole("button", { name: /新建聊天/ }).click();
    const composer = window.getByPlaceholder(/说点什么/);
    await expect(composer).toBeVisible({ timeout: 15000 });

    // 输入 20 行：容器触发滚动（scrollHeight > clientHeight），padding-top 仍是 14px
    await composer.fill(Array.from({ length: 20 }, (_, i) => `第${i + 1}行`).join("\n"));
    const metrics = await composer.evaluate((el) => {
      const container = el.parentElement!;
      const cs = getComputedStyle(container);
      return {
        containerScrollable: container.scrollHeight > container.clientHeight,
        paddingTop: cs.paddingTop,
        textareaOverflow: getComputedStyle(el).overflowY,
      };
    });
    expect(metrics.containerScrollable).toBe(true);
    expect(metrics.paddingTop).toBe("14px"); // pt-3.5
    expect(metrics.textareaOverflow).toBe("hidden"); // textarea 自身不滚动

    await app.close();
  });
});
