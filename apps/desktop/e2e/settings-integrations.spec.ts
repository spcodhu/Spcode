/**
 * 设置页集成 E2E：沙盒真实状态、远程控制配对与端口持久化、网络代理掩码。
 *
 * 这些断言需要主进程 / 宿主进程 / 真实 settings.json 协同，无法用单测替代；
 * 纯展示与纯计算的分区（开机启动、上下文压缩阈值、i18n 文案）已由 test/ 覆盖。
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers";

test("沙盒分区：宿主真实状态、开关与域名白名单持久化", async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await window.getByTitle("设置", { exact: true }).click();
  await window.getByRole("button", { name: "通用" }).click();
  const section = window.getByTestId("sandbox-settings");
  await expect(section).toBeVisible();

  // 真实运行状态条：要么已生效，要么已关闭/不可用（附原因），不能是空的
  const statusLine = section.getByTestId("sandbox-status");
  await expect(statusLine).toBeVisible();
  // 首次查询会惰性拉起宿主并初始化沙盒（1–2s），给足超时
  await expect(statusLine).toHaveAttribute("data-state", /active|disabled|unavailable/, { timeout: 20000 });
  await expect(statusLine).toContainText(/内核边界已生效|已关闭|沙盒不可用/);
  // 开关默认开时状态不能自相矛盾地报「已关闭」
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

  // 逃生舱与本地端口开关默认开；白名单编辑器可见
  await expect(section.getByRole("switch", { name: "允许沙盒外重试" })).toHaveAttribute("aria-checked", "true");
  await expect(section.getByRole("switch", { name: "允许监听本地端口" })).toHaveAttribute("aria-checked", "true");
  await expect(section.getByTestId("sandbox-excluded-commands")).toBeVisible();
  await expect(window.getByTestId("permission-rules")).toBeVisible();

  // 域名白名单：追加并失焦保存，重开设置页验证持久化
  const domains = section.getByTestId("sandbox-allowed-domains");
  await domains.click();
  await domains.fill("github.com\nexample.e2e-test.com");
  await domains.blur();
  await window.getByTitle("关闭设置").click();
  await window.getByTitle("设置", { exact: true }).click();
  await window.getByRole("button", { name: "通用" }).click();
  await expect(window.getByTestId("sandbox-settings").getByTestId("sandbox-allowed-domains")).toHaveValue(
    /example\.e2e-test\.com/,
  );

  await app.close();
});

test("远程控制：配对码生成、监听端口首次固定并跨重启复用", async () => {
  const spcodeHome = mkdtempSync(join(tmpdir(), "spcode-e2e-remote-port-"));
  let app = await launchApp({ spcodeHome });
  let window = await app.firstWindow();

  await window.getByRole("button", { name: /新建聊天/ }).click();
  await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });
  await window.getByTitle("设置", { exact: true }).click();
  await window.getByRole("button", { name: "远程控制" }).click();
  await expect(window.getByRole("heading", { name: "远程控制" })).toBeVisible();

  // 两种网络环境各有独立折叠流程与地址；公网流程不要求先加入局域网
  const lanGuide = window.getByTestId("remote-guide-lan");
  const publicGuide = window.getByTestId("remote-guide-public");
  await lanGuide.locator("summary").click();
  await expect(window.getByTestId("remote-guide-lan-address")).toContainText("http://");
  await publicGuide.locator("summary").click();
  await expect(window.getByTestId("remote-guide-public-address")).toContainText("https://spcod-relay.hlt.cab/");
  await publicGuide.locator("summary").click();
  await expect(publicGuide).not.toHaveAttribute("open", "");

  // 默认关闭：简介可见，开关可点
  const toggle = window.getByRole("switch", { name: "启用远程控制" });
  await expect(toggle).toBeVisible();
  await expect(window.getByTestId("remote-intro")).toBeVisible();

  // 开启：监听地址、配对区与固定端口出现
  await toggle.click();
  await expect(window.getByTestId("remote-urls")).toBeVisible({ timeout: 10000 });
  await expect(window.getByTestId("remote-pairing")).toBeVisible();
  await expect(window.getByTestId("remote-guide-lan-address")).toContainText(/http:\/\/\d+/);
  await expect(window.getByTestId("remote-guide-lan-address")).not.toContainText("relay+");
  await expect(window.getByTestId("remote-port")).toBeVisible({ timeout: 10000 });
  const firstPort = await window.getByTestId("remote-port").textContent();
  expect(firstPort).toMatch(/\d+/);

  // 生成配对码：QR 与 8 位 OTP；完整配对码可展开且不重新生成
  await window.getByRole("button", { name: /配对码/ }).click();
  await expect(window.getByTestId("remote-qr")).toBeVisible({ timeout: 10000 });
  await expect(window.getByTestId("remote-otp")).toHaveText(/^\d{8}$/);
  await window.getByTestId("remote-payload-toggle").click();
  await expect(window.getByTestId("remote-payload")).toHaveValue(/^spcode-remote:\/\/pair\?v=4&/);
  await expect(window.getByTestId("remote-copy-payload")).toBeVisible();

  // 关闭：回到简介态
  await toggle.click();
  await expect(window.getByTestId("remote-intro")).toBeVisible({ timeout: 10000 });
  await app.close();

  // 重启后端口复用
  app = await launchApp({ spcodeHome });
  window = await app.firstWindow();
  await expect(window.getByTestId("brand")).toBeVisible({ timeout: 15000 });
  await window.getByTitle("设置", { exact: true }).click();
  await window.getByRole("button", { name: "远程控制" }).click();
  // 上一段结尾关掉了总开关，重启后需重新开启才会渲染监听端口
  await window.getByRole("switch", { name: "启用远程控制" }).click();
  await expect(window.getByTestId("remote-port")).toBeVisible({ timeout: 10000 });
  await expect(window.getByTestId("remote-port")).toHaveText(firstPort!);

  await app.close();
});

test("远程控制：中继/推送开关、Tailscale 灰态、隐私与飞书通道", async () => {
  const app = await launchApp();
  const window = await app.firstWindow();

  await window.getByRole("button", { name: /新建聊天/ }).click();
  await expect(window.getByPlaceholder(/说点什么/)).toBeVisible({ timeout: 15000 });
  await window.getByTitle("设置", { exact: true }).click();
  await window.getByRole("button", { name: "远程控制" }).click();

  // 隐私说明区始终可见（未开启远程也能读）
  await expect(window.getByTestId("remote-privacy")).toBeVisible();

  // 开启远程控制：中继分区出现；自托管地址输入仅在自托管模式渲染
  await window.getByRole("switch", { name: "启用远程控制" }).click();
  await expect(window.getByTestId("remote-relay")).toBeVisible({ timeout: 10000 });
  await window.getByRole("button", { name: "自托管", exact: true }).click();
  await expect(window.getByTestId("remote-relay-input")).toHaveAttribute("placeholder", "wss://relay.example.com");
  await expect(window.getByTestId("remote-relay-badge")).toHaveText("未启用");
  await expect(window.getByRole("switch", { name: "Web Push 通知" })).toBeVisible();
  // e2e 环境无 tailscaled → 灰态
  await expect(window.getByTestId("remote-tailscale")).toContainText("未检测到 tailscaled");

  // 填 relay 地址并保存 → 触发重连，徽章离开「未启用」
  await window.getByTestId("remote-relay-input").fill("wss://relay.example.com");
  await window.getByRole("button", { name: "保存" }).click();
  await expect(window.getByTestId("remote-relay-badge")).toHaveText(/连接中|已连接/, { timeout: 8000 });

  // 推送开关可切换（验证 IPC 链路不报错）
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

  // 飞书通道独立于远程总开关：开启后出现明文隐私提示与凭证区
  const feishuSwitch = window.getByRole("switch", { name: "启用飞书机器人通道" });
  await expect(feishuSwitch).toHaveAttribute("aria-checked", "false");
  await feishuSwitch.click();
  await expect(feishuSwitch).toHaveAttribute("aria-checked", "true");
  await expect(window.getByTestId("remote-feishu-privacy-warning")).toBeVisible();
  await expect(window.getByTestId("remote-feishu-appid")).toBeVisible();
  await expect(window.getByTestId("remote-feishu-appsecret")).toBeVisible();
  await expect(window.getByTestId("remote-feishu-allowlist")).toBeVisible();
  await window.getByTestId("remote-feishu-guide-toggle").click();
  await expect(window.getByTestId("remote-feishu-guide")).toBeVisible();
  await window.getByTestId("remote-feishu-guide-toggle").click();
  await expect(window.getByTestId("remote-feishu-guide")).not.toBeVisible();
  await feishuSwitch.click();
  await expect(feishuSwitch).toHaveAttribute("aria-checked", "false");
  await expect(window.getByTestId("remote-feishu-privacy-warning")).not.toBeVisible();

  await app.close();
});

test("网络代理：保存落盘、重开后掩码且不回写真实密码", async () => {
  const spcodeHome = mkdtempSync(join(tmpdir(), "spcode-proxy-e2e-"));
  const app = await launchApp({ spcodeHome });
  const window = await app.firstWindow();

  await window.getByTitle("设置", { exact: true }).click();
  const section = window.getByTestId("settings-proxy");
  await expect(section).toBeVisible();
  await section.getByRole("switch", { name: "启用网络代理" }).click();
  await window.getByTestId("settings-proxy-host").fill("127.0.0.1");
  await window.getByTestId("settings-proxy-port").fill("18080");
  await window.getByTestId("settings-proxy-username").fill("e2e-user");
  await window.getByTestId("settings-proxy-password").fill("e2e-secret");
  await window.getByTestId("settings-proxy-save").click();

  await expect
    .poll(() => {
      const saved = JSON.parse(readFileSync(join(spcodeHome, "settings.json"), "utf8")) as {
        proxy?: { enabled?: boolean; host?: string; port?: number; password?: string };
      };
      return saved.proxy;
    })
    .toEqual(expect.objectContaining({ enabled: true, host: "127.0.0.1", port: 18080, password: "e2e-secret" }));

  // 重开后密码只回掩码；再次保存不会把掩码写成真实密码
  await window.getByTitle("关闭设置").click();
  await window.getByTitle("设置", { exact: true }).click();
  await expect(window.getByTestId("settings-proxy-password")).toHaveValue("••••••••");
  await window.getByTestId("settings-proxy").getByRole("switch", { name: "启用网络代理" }).click();
  await window.getByTestId("settings-proxy-save").click();
  await expect
    .poll(() => {
      const saved = JSON.parse(readFileSync(join(spcodeHome, "settings.json"), "utf8")) as {
        proxy: { enabled: boolean; password: string };
      };
      return saved.proxy;
    })
    .toEqual(expect.objectContaining({ enabled: false, password: "e2e-secret" }));

  await app.close();
});
