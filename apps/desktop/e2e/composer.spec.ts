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

test.describe("输入框：长文本模式", () => {
  test("切换长文本输入 → 文档式编辑区 → 预览渲染 → 模式按会话记住", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();

    await window.getByRole("button", { name: /新建聊天/ }).click();
    await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });

    // 右上角浮牌切换到长文本：文档式编辑区出现，三态控件同时浮出
    await window.getByTestId("md-mode-toggle").click();
    const editor = window.getByTestId("md-editor");
    await expect(editor).toBeVisible();
    await expect(window.getByTestId("md-view-preview")).toBeVisible();

    // 编辑区立即变高（min 180px）
    const height = await editor.evaluate((el) => el.parentElement!.clientHeight);
    expect(height).toBeGreaterThanOrEqual(180);

    // contenteditable 输入 markdown，Shift+Enter 换行
    await editor.click();
    await editor.pressSequentially("# 大标题");
    await window.keyboard.press("Shift+Enter");
    await editor.pressSequentially("第二行");
    await expect(editor).toContainText("大标题");
    await expect(editor).toContainText("第二行");

    // 预览：渲染出标题
    await window.getByTestId("md-view-preview").click();
    await expect(window.getByRole("heading", { name: "大标题" })).toBeVisible();

    // 切回编辑：原文（含换行）还在
    await window.getByTestId("md-view-edit").click();
    await expect(window.getByTestId("md-editor")).toContainText("大标题");
    await expect(window.getByTestId("md-editor")).toContainText("第二行");

    // 模式与内容按会话记住（「新对话」dup 复用同一草稿）
    await window.getByRole("button", { name: "新对话" }).click();
    await expect(window.getByTestId("md-editor")).toContainText("大标题");

    await app.close();
  });
});

test.describe("输入框：高度自适应", () => {
  test("空输入框默认就接近两行高，不再贴着工具栏", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();

    await window.getByRole("button", { name: /新建聊天/ }).click();
    const composer = window.getByPlaceholder(/说点什么/);
    await expect(composer).toBeVisible({ timeout: 15000 });

    // 行高 24px：默认 min-height 44px ≈ 一行半、接近两行（旧实现空框只有 1 行 24px）
    const height = await composer.evaluate((el) => el.clientHeight);
    expect(height).toBeGreaterThanOrEqual(42);
    expect(height).toBeLessThanOrEqual(50);

    await app.close();
  });

  test("多行输入：高度随内容增长、超出上限后 textarea 自身滚动，外层 padding 不随滚动消失", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();

    await window.getByRole("button", { name: /新建聊天/ }).click();
    const composer = window.getByPlaceholder(/说点什么/);
    await expect(composer).toBeVisible({ timeout: 15000 });

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

    await app.close();
  });
});
