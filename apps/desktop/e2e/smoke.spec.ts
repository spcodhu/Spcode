import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

test.describe("Spcode 冒烟 E2E", () => {
  test("启动 → 首页 → 新建聊天 → 输入框就绪", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();

    // 首页品牌区
    await expect(window.getByTestId("brand")).toBeVisible({ timeout: 15000 });

    // 新建聊天（注意：侧边栏提示文本也含"新建聊天"，必须按 role 选按钮）
    await window.getByRole("button", { name: /新建聊天/ }).click();

    // 输入框出现，空会话视图出现（锚定 data-testid，不绑展示文案——评审 N4）
    await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });
    await expect(window.getByTestId("empty-state")).toBeVisible();

    // 沙盒状态不再占用输入框工具栏（开关在设置页；chip 已移除）
    await expect(window.getByTestId("sandbox-status-chip")).toHaveCount(0);

    await app.close();
  });

  test("设置页：导航开合与各页面", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();

    await window.getByRole("button", { name: /新建聊天/ }).click();
    await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });

    // 打开设置（底部齿轮）
    await window.getByTitle("设置", { exact: true }).click();
    await expect(window.getByRole("button", { name: "用量" })).toBeVisible();
    await expect(window.getByRole("button", { name: "配额" })).toBeVisible();
    await expect(window.getByRole("button", { name: "记忆" })).toBeVisible();

    // 默认落在通用页（评审 R3-C11：原默认「用量」是调试残留）
    await expect(window.getByRole("heading", { name: "通用" })).toBeVisible();

    // 切到用量页：趋势曲线与活跃热点图（新鲜安装无数据也要渲染骨架）
    await window.getByRole("button", { name: "用量" }).click();
    await expect(window.getByTestId("usage-trend")).toBeVisible();
    await expect(window.getByTestId("usage-heatmap")).toBeVisible();
    await expect(window.getByTestId("usage-streak-longest")).toBeVisible();

    // 曲线图区间切换：点「最近 30 天」后图表仍在
    await window.getByRole("button", { name: "最近 30 天" }).click();
    await expect(window.getByTestId("usage-trend-chart")).toBeVisible();

    // 切到配额页
    await window.getByRole("button", { name: "配额" }).click();
    await expect(window.getByText("上下文用量环")).toBeVisible();

    // 切到模型页
    await window.getByRole("button", { name: "模型", exact: true }).click();
    await expect(window.getByText(/配置模型提供商和可用模型/)).toBeVisible();

    // 关闭设置
    await window.getByTitle("关闭设置").click();
    await expect(window.getByRole("button", { name: "用量" })).not.toBeVisible();

    await app.close();
  });

  test("设置页：沙盒分区——开关与列表编辑器", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();

    await window.getByTitle("设置", { exact: true }).click();
    // 沙盒区块在「通用」页
    await window.getByRole("button", { name: "通用" }).click();
    const section = window.getByTestId("sandbox-settings");
    await expect(section).toBeVisible();

    // 真实运行状态条：要么已生效，要么已关闭/不可用（附原因），不能是空的
    const statusLine = section.getByTestId("sandbox-status");
    await expect(statusLine).toBeVisible();
    // 首次查询会惰性拉起宿主并初始化沙盒（1–2s），给足超时
    await expect(statusLine).toHaveAttribute("data-state", /active|disabled|unavailable/, { timeout: 20000 });
    await expect(statusLine).toContainText(/内核边界已生效|已关闭|沙盒不可用/);
    // 开关默认开时状态不能自相矛盾地报「已关闭」（曾因未下发设置给 SandboxService 而谎报）
    await expect(statusLine).not.toContainText("已关闭");
    await expect(section.getByTestId("sandbox-behavior-table")).toBeVisible();

    // 总开关默认开；关闭时出现红色风险警告，重开后消失
    const toggle = section.getByRole("switch", { name: "启用命令沙盒" });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(section.getByTestId("sandbox-disabled-warning")).not.toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(section.getByTestId("sandbox-disabled-warning")).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(section.getByTestId("sandbox-disabled-warning")).not.toBeVisible();

    // 新增控件：逃生舱开关 / 本地端口开关默认开；沙盒外白名单编辑器可见
    await expect(section.getByRole("switch", { name: "允许沙盒外重试" })).toHaveAttribute("aria-checked", "true");
    await expect(section.getByRole("switch", { name: "允许监听本地端口" })).toHaveAttribute("aria-checked", "true");
    await expect(section.getByTestId("sandbox-excluded-commands")).toBeVisible();
    // 免审批规则管理区（权限模式分区，默认空）
    await expect(window.getByTestId("permission-rules")).toBeVisible();

    // 域名白名单编辑器：追加一条并失焦保存
    const domains = section.getByTestId("sandbox-allowed-domains");
    await domains.click();
    await domains.fill("github.com\nexample.e2e-test.com");
    await domains.blur();

    // 重开设置页验证持久化（settings.json 已写入临时 SPCODE_HOME）
    await window.getByTitle("关闭设置").click();
    await window.getByTitle("设置", { exact: true }).click();
    await window.getByRole("button", { name: "通用" }).click();
    const domains2 = window.getByTestId("sandbox-settings").getByTestId("sandbox-allowed-domains");
    await expect(domains2).toHaveValue(/example\.e2e-test\.com/);

    await app.close();
  });

  test("设置页：上下文压缩分区——开关与阈值输入", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();

    await window.getByTitle("设置", { exact: true }).click();
    await window.getByRole("button", { name: "通用" }).click();
    const section = window.getByTestId("compaction-settings");
    await expect(section).toBeVisible();

    // 自动压缩开关默认开
    const toggle = section.getByRole("switch", { name: "自动压缩" });
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    // 阈值输入：默认值、修改为合法值失焦保存
    const reserve = section.getByRole("spinbutton").first();
    await expect(reserve).toHaveValue("16384");
    await reserve.fill("20480");
    await reserve.blur();

    // 重开设置页验证持久化（settings.json 已写入临时 SPCODE_HOME）
    await window.getByTitle("关闭设置").click();
    await window.getByTitle("设置", { exact: true }).click();
    await window.getByRole("button", { name: "通用" }).click();
    await expect(window.getByTestId("compaction-settings").getByRole("spinbutton").first()).toHaveValue("20480");

    await app.close();
  });

  test("设置页：远程控制分区——开关与配对码生成", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();

    await window.getByRole("button", { name: /新建聊天/ }).click();
    await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });

    // 打开设置 → 远程控制分区
    await window.getByTitle("设置", { exact: true }).click();
    await window.getByRole("button", { name: "远程控制" }).click();
    await expect(window.getByRole("heading", { name: "远程控制" })).toBeVisible();

    // 默认关闭：功能简介可见，开关可点（锚定 role/aria-label 与 data-testid）
    const toggle = window.getByRole("switch", { name: "启用远程控制" });
    await expect(toggle).toBeVisible();
    await expect(window.getByTestId("remote-intro")).toBeVisible();

    // 开启：监听地址与配对区出现
    await toggle.click();
    await expect(window.getByTestId("remote-urls")).toBeVisible({ timeout: 10000 });
    await expect(window.getByTestId("remote-pairing")).toBeVisible();

    // 生成配对码：出现 QR 与 8 位 OTP（开启时可能已自动生成，按钮文案两种都匹配）
    await window.getByRole("button", { name: /配对码/ }).click();
    await expect(window.getByTestId("remote-qr")).toBeVisible({ timeout: 10000 });
    await expect(window.getByTestId("remote-otp")).toHaveText(/^\d{8}$/);

    // 关闭：回到简介态
    await toggle.click();
    await expect(window.getByTestId("remote-intro")).toBeVisible({ timeout: 10000 });

    await app.close();
  });

  test("设置页：远程控制分区——relay/推送开关/Tailscale 灰态/隐私说明展开", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();

    await window.getByRole("button", { name: /新建聊天/ }).click();
    await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });

    await window.getByTitle("设置", { exact: true }).click();
    await window.getByRole("button", { name: "远程控制" }).click();

    // 隐私说明区始终可见（未开启远程也能读）
    await expect(window.getByTestId("remote-privacy")).toBeVisible();

    // 开启远程控制：M2/M3 新分区出现（锚 data-testid / role，不绑展示文案——评审 N4）
    await window.getByRole("switch", { name: "启用远程控制" }).click();
    await expect(window.getByTestId("remote-relay")).toBeVisible({ timeout: 10000 });
    await expect(window.getByTestId("remote-relay-input")).toHaveAttribute("placeholder", "wss://relay.example.com");
    // 未配置 relayUrl → 徽章"未启用"
    await expect(window.getByTestId("remote-relay-badge")).toHaveText("未启用");
    await expect(window.getByRole("switch", { name: "Web Push 通知" })).toBeVisible();
    // e2e 环境无 tailscaled → 灰态
    await expect(window.getByTestId("remote-tailscale")).toContainText("未检测到 tailscaled");

    // 填 relay 地址并保存 → 触发重连，徽章离开"未启用"
    await window.getByTestId("remote-relay-input").fill("wss://relay.example.com");
    await window.getByRole("button", { name: "保存" }).click();
    await expect(window.getByTestId("remote-relay-badge")).toHaveText(/连接中|已连接/, { timeout: 8000 });

    // 推送开关可切换（开 → 关，验证 IPC 链路不报错）
    const pushSwitch = window.getByRole("switch", { name: "Web Push 通知" });
    await pushSwitch.click();
    await expect(pushSwitch).toHaveAttribute("aria-checked", "true");
    await pushSwitch.click();
    await expect(pushSwitch).toHaveAttribute("aria-checked", "false");

    // 隐私说明展开：附录 B 全文，含飞书通道条款
    await window.getByTestId("remote-privacy-toggle").click();
    await expect(window.getByTestId("remote-privacy")).toContainText("端到端加密");
    await expect(window.getByTestId("remote-privacy")).toContainText("中继服务器只存储和转发");
    await expect(window.getByTestId("remote-privacy")).toContainText("飞书机器人通道");

    await app.close();
  });

  test("设置页：远程控制分区——飞书机器人分区开关与隐私提示", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();

    await window.getByRole("button", { name: /新建聊天/ }).click();
    await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });

    await window.getByTitle("设置", { exact: true }).click();
    await window.getByRole("button", { name: "远程控制" }).click();

    // 飞书分区独立于远程控制总开关，未开启远程也可见（锚 data-testid / role，不绑文案——评审 N4）
    await expect(window.getByTestId("remote-feishu")).toBeVisible();
    const feishuSwitch = window.getByRole("switch", { name: "启用飞书机器人通道" });
    await expect(feishuSwitch).toBeVisible();
    await expect(feishuSwitch).toHaveAttribute("aria-checked", "false");

    // 开启：明文隐私提示（warning 色块）、凭证输入框与授权用户列表出现
    await feishuSwitch.click();
    await expect(feishuSwitch).toHaveAttribute("aria-checked", "true");
    await expect(window.getByTestId("remote-feishu-privacy-warning")).toBeVisible();
    await expect(window.getByTestId("remote-feishu-appid")).toBeVisible();
    await expect(window.getByTestId("remote-feishu-appsecret")).toBeVisible();
    await expect(window.getByTestId("remote-feishu-allowlist")).toBeVisible();

    // 接入教程展开/收起
    await window.getByTestId("remote-feishu-guide-toggle").click();
    await expect(window.getByTestId("remote-feishu-guide")).toBeVisible();
    await window.getByTestId("remote-feishu-guide-toggle").click();
    await expect(window.getByTestId("remote-feishu-guide")).not.toBeVisible();

    // 关闭：提示与凭证区收起
    await feishuSwitch.click();
    await expect(feishuSwitch).toHaveAttribute("aria-checked", "false");
    await expect(window.getByTestId("remote-feishu-privacy-warning")).not.toBeVisible();

    await app.close();
  });

  test("快捷键 Cmd+, 开设置，ESC 与点击外部关闭", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();

    await window.getByRole("button", { name: /新建聊天/ }).click();
    await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });

    // Cmd+, 打开设置（macOS）
    await window.keyboard.press("Meta+Comma");
    await expect(window.getByRole("button", { name: "用量" })).toBeVisible({ timeout: 5000 });

    // ESC 关闭
    await window.keyboard.press("Escape");
    await expect(window.getByRole("button", { name: "用量" })).not.toBeVisible();

    // 再开，点面板外部任意位置关闭
    await window.keyboard.press("Meta+Comma");
    await expect(window.getByRole("button", { name: "用量" })).toBeVisible({ timeout: 5000 });
    // 点左上角空白处（遮罩层）
    await window.mouse.click(30, 30);
    await expect(window.getByRole("button", { name: "用量" })).not.toBeVisible();

    await app.close();
  });

  test("无模型时发消息不会导致崩溃", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();

    await window.getByRole("button", { name: /新建聊天/ }).click();
    const composer = window.getByPlaceholder(/说点什么/);
    await expect(composer).toBeVisible({ timeout: 15000 });

    await composer.fill("你好");
    await composer.press("Enter");

    // 用户消息上屏；界面不崩（输入框仍在）
    await expect(window.getByText("你好").first()).toBeVisible();
    await expect(composer).toBeVisible();

    await app.close();
  });

  test("会话搜索：Cmd+K 与侧栏按钮开合，输入出结果区", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();
    await expect(window.getByTestId("brand")).toBeVisible({ timeout: 15000 });

    // Cmd+K 打开
    await window.keyboard.press("Meta+KeyK");
    const input = window.getByPlaceholder(/搜索会话标题与正文/);
    await expect(input).toBeVisible({ timeout: 5000 });

    // 输入查询出现结果区（无匹配时显示空态）
    await input.fill("不存在的关键词xyz");
    await expect(window.getByText("没有匹配的会话")).toBeVisible({ timeout: 5000 });

    // Esc 关闭
    await window.keyboard.press("Escape");
    await expect(input).not.toBeVisible();

    // 侧栏搜索按钮打开
    await window.getByTitle("搜索会话（Cmd+K）").click();
    await expect(window.getByPlaceholder(/搜索会话标题与正文/)).toBeVisible({ timeout: 5000 });
    await window.keyboard.press("Escape");

    await app.close();
  });

  test("定时任务：面板开合 + 创建/删除任务闭环", async () => {
    const app = await launchApp();
    const window = await app.firstWindow();
    await expect(window.getByTestId("brand")).toBeVisible({ timeout: 15000 });

    // 唯一任务名：与历史残留/并行运行隔离
    const taskName = `E2E任务${Date.now() % 100000}`;

    // 侧栏时钟按钮打开面板
    await window.getByTitle("定时任务").click();
    await expect(window.getByRole("button", { name: /新建任务/ })).toBeVisible({ timeout: 5000 });

    // 打开表单并填写
    await window.getByRole("button", { name: /新建任务/ }).click();
    await window.getByPlaceholder("如：每日晨报").fill(taskName);
    await window.getByPlaceholder(/汇总我昨天的用量/).fill("说一句你好");

    // 默认每天 09:00，直接创建
    await window.getByRole("button", { name: "创建任务" }).click();

    // 列表出现任务行（作用域锁定到本任务，避免同名残留干扰）
    const row = window.locator("div.rounded-xl", { hasText: taskName }).first();
    await expect(row).toBeVisible({ timeout: 5000 });
    await expect(row.getByText(/每天 09:00/)).toBeVisible();

    // 删除（两段确认）清理现场
    await row.getByTitle("删除", { exact: true }).click();
    await row.getByText("确认删除？").click();
    await expect(window.getByText(taskName)).not.toBeVisible();

    await app.close();
  });
});
