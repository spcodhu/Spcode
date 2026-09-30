# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.ts >> Spcode 冒烟 E2E >> 启动 → 首页 → 新建聊天 → 输入框就绪
- Location: e2e/smoke.spec.ts:8:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('开始对话吧')
Expected: visible
Error: strict mode violation: getByText('开始对话吧') resolved to 4 elements:
    1) <div class="mt-1.5 max-h-80 overflow-y-auto whitespace-pre-wrap border-l-2 border-thinking/25 pl-3 text-[13px] leading-6 text-text-tertiary">Interesting: the e2e smoke test references "开始对话吧…</div> aka getByText('Interesting: the e2e smoke')
    2) <span class="min-w-0 flex-1 truncate text-left text-text-tertiary">cd /Users/spcodhu/Code/agent/spcodhu-harness && g…</span> aka getByRole('button', { name: '✓ bash cd /Users/spcodhu/Code/agent/spcodhu-harness && grep -rn "开始对话吧\\|新聊天\\b"' })
    3) <div class="mt-1.5 max-h-80 overflow-y-auto whitespace-pre-wrap border-l-2 border-thinking/25 pl-3 text-[13px] leading-6 text-text-tertiary">Confirmed: e2e smoke references "开始对话吧" which no …</div> aka getByText('Confirmed: e2e smoke')
    4) <div class="mt-1.5 max-h-80 overflow-y-auto whitespace-pre-wrap border-l-2 border-thinking/25 pl-3 text-[13px] leading-6 text-text-tertiary">out/ exists and build works. Now run just the fir…</div> aka getByText('out/ exists and build works.')

Call log:
  - Expect "toBeVisible" getByText('开始对话吧') with timeout 5000ms
  - waiting for getByText('开始对话吧')

```

# Test source

```ts
  1   | import { test, expect, _electron as electron } from "@playwright/test";
  2   | import { dirname, join } from "node:path";
  3   | import { fileURLToPath } from "node:url";
  4   | 
  5   | const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  6   | 
  7   | test.describe("Spcode 冒烟 E2E", () => {
  8   |   test("启动 → 首页 → 新建聊天 → 输入框就绪", async () => {
  9   |     const app = await electron.launch({ args: [".", "--no-sandbox"], cwd: appDir });
  10  |     const window = await app.firstWindow();
  11  | 
  12  |     // 首页品牌区
  13  |     await expect(window.getByText("Spcode").first()).toBeVisible({ timeout: 15000 });
  14  | 
  15  |     // 新建聊天（注意：侧边栏提示文本也含"新建聊天"，必须按 role 选按钮）
  16  |     await window.getByRole("button", { name: /新建聊天/ }).click();
  17  | 
  18  |     // 输入框出现，空会话提示出现
  19  |     await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });
> 20  |     await expect(window.getByText("开始对话吧")).toBeVisible();
      |                                             ^ Error: expect(locator).toBeVisible() failed
  21  | 
  22  |     await app.close();
  23  |   });
  24  | 
  25  |   test("设置页：导航开合与各页面", async () => {
  26  |     const app = await electron.launch({ args: [".", "--no-sandbox"], cwd: appDir });
  27  |     const window = await app.firstWindow();
  28  | 
  29  |     await window.getByRole("button", { name: /新建聊天/ }).click();
  30  |     await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });
  31  | 
  32  |     // 打开设置（底部齿轮）
  33  |     await window.getByTitle("设置", { exact: true }).click();
  34  |     await expect(window.getByRole("button", { name: "用量" })).toBeVisible();
  35  |     await expect(window.getByRole("button", { name: "配额" })).toBeVisible();
  36  |     await expect(window.getByRole("button", { name: "记忆" })).toBeVisible();
  37  | 
  38  |     // 默认落在用量页
  39  |     await expect(window.getByRole("heading", { name: "用量" })).toBeVisible();
  40  | 
  41  |     // 切到配额页
  42  |     await window.getByRole("button", { name: "配额" }).click();
  43  |     await expect(window.getByText("上下文用量环")).toBeVisible();
  44  | 
  45  |     // 切到模型页
  46  |     await window.getByRole("button", { name: "模型", exact: true }).click();
  47  |     await expect(window.getByText(/配置模型提供商和可用模型/)).toBeVisible();
  48  | 
  49  |     // 关闭设置
  50  |     await window.getByTitle("关闭设置").click();
  51  |     await expect(window.getByRole("button", { name: "用量" })).not.toBeVisible();
  52  | 
  53  |     await app.close();
  54  |   });
  55  | 
  56  |   test("快捷键 Cmd+, 开设置，ESC 与点击外部关闭", async () => {
  57  |     const app = await electron.launch({ args: [".", "--no-sandbox"], cwd: appDir });
  58  |     const window = await app.firstWindow();
  59  | 
  60  |     await window.getByRole("button", { name: /新建聊天/ }).click();
  61  |     await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });
  62  | 
  63  |     // Cmd+, 打开设置（macOS）
  64  |     await window.keyboard.press("Meta+Comma");
  65  |     await expect(window.getByRole("button", { name: "用量" })).toBeVisible({ timeout: 5000 });
  66  | 
  67  |     // ESC 关闭
  68  |     await window.keyboard.press("Escape");
  69  |     await expect(window.getByRole("button", { name: "用量" })).not.toBeVisible();
  70  | 
  71  |     // 再开，点面板外部任意位置关闭
  72  |     await window.keyboard.press("Meta+Comma");
  73  |     await expect(window.getByRole("button", { name: "用量" })).toBeVisible({ timeout: 5000 });
  74  |     // 点左上角空白处（遮罩层）
  75  |     await window.mouse.click(30, 30);
  76  |     await expect(window.getByRole("button", { name: "用量" })).not.toBeVisible();
  77  | 
  78  |     await app.close();
  79  |   });
  80  | 
  81  |   test("无模型时发消息不会导致崩溃", async () => {
  82  |     const app = await electron.launch({ args: [".", "--no-sandbox"], cwd: appDir });
  83  |     const window = await app.firstWindow();
  84  | 
  85  |     await window.getByRole("button", { name: /新建聊天/ }).click();
  86  |     const composer = window.getByPlaceholder(/说点什么/);
  87  |     await expect(composer).toBeVisible({ timeout: 15000 });
  88  | 
  89  |     await composer.fill("你好");
  90  |     await composer.press("Enter");
  91  | 
  92  |     // 用户消息上屏；界面不崩（输入框仍在）
  93  |     await expect(window.getByText("你好").first()).toBeVisible();
  94  |     await expect(composer).toBeVisible();
  95  | 
  96  |     await app.close();
  97  |   });
  98  | 
  99  |   test("会话搜索：Cmd+K 与侧栏按钮开合，输入出结果区", async () => {
  100 |     const app = await electron.launch({ args: [".", "--no-sandbox"], cwd: appDir });
  101 |     const window = await app.firstWindow();
  102 |     await expect(window.getByText("Spcode").first()).toBeVisible({ timeout: 15000 });
  103 | 
  104 |     // Cmd+K 打开
  105 |     await window.keyboard.press("Meta+KeyK");
  106 |     const input = window.getByPlaceholder(/搜索会话标题与正文/);
  107 |     await expect(input).toBeVisible({ timeout: 5000 });
  108 | 
  109 |     // 输入查询出现结果区（无匹配时显示空态）
  110 |     await input.fill("不存在的关键词xyz");
  111 |     await expect(window.getByText("没有匹配的会话")).toBeVisible({ timeout: 5000 });
  112 | 
  113 |     // Esc 关闭
  114 |     await window.keyboard.press("Escape");
  115 |     await expect(input).not.toBeVisible();
  116 | 
  117 |     // 侧栏搜索按钮打开
  118 |     await window.getByTitle("搜索会话（Cmd+K）").click();
  119 |     await expect(window.getByPlaceholder(/搜索会话标题与正文/)).toBeVisible({ timeout: 5000 });
  120 |     await window.keyboard.press("Escape");
```