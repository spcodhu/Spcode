/**
 * 飞书通道单测（一）：白名单拦截 / 绑定流程（验证码生命周期 + 持久化）/ 指令解析全分支。
 * SDK 不打真实网络——注入 FakeFeishuApi（FeishuApi 窄接口）。
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HostCommand } from "@spcode/shared";
import { setLocale } from "@spcode/shared/i18n";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cardText, flush, makeChannel, makeEntry, startAndBind } from "./helpers/feishu-harness.js";

const cleanup: string[] = [];
beforeEach(() => setLocale("zh-CN"));
afterEach(() => {
  setLocale("zh-CN");
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 白名单与绑定
// ---------------------------------------------------------------------------

describe("白名单拦截", () => {
  it("非白名单消息：第一次回复未授权提示，第二次静默忽略", async () => {
    const h = makeChannel();
    cleanup.push(h.baseDir);
    await h.channel.start({ appId: "cli_test", appSecret: "secret" });

    h.api.emitMessage({ openId: "ou_stranger", text: "帮我写代码", chatType: "p2p" });
    await flush();
    expect(h.api.texts).toHaveLength(1);
    expect(h.api.texts[0]!.text).toContain("未授权");
    expect(h.bridgeCalls).toHaveLength(0);

    h.api.emitMessage({ openId: "ou_stranger", text: "再试一次", chatType: "p2p" });
    await flush();
    expect(h.api.texts).toHaveLength(1); // 不再回复
    expect(h.bridgeCalls).toHaveLength(0);
    await h.channel.stop();
  });

  it("群消息一律忽略（即使是白名单用户）", async () => {
    const h = makeChannel();
    cleanup.push(h.baseDir);
    const openId = await startAndBind(h);
    h.api.texts.length = 0;

    h.api.emitMessage({ openId, text: "/help", chatType: "group" });
    await flush();
    expect(h.api.texts).toHaveLength(0);
    await h.channel.stop();
  });
});

describe("绑定流程", () => {
  it("验证码 6 位；/bind 正确 → 入白名单 + 落盘 + 回复成功；单次有效", async () => {
    const h = makeChannel();
    cleanup.push(h.baseDir);
    await h.channel.start({ appId: "cli_test", appSecret: "secret" });

    const code = h.channel.pendingBindCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(h.channel.pendingBindCode()).toBe(code); // 未过期前稳定

    h.api.emitMessage({ openId: "ou_a", text: `/bind ${code}`, chatType: "p2p" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("绑定成功");
    expect(h.channel.allowlistEntries().map((u) => u.openId)).toEqual(["ou_a"]);

    // 落盘 feishu.json（含 appId 引用，不含 appSecret）
    const file = join(h.baseDir, "remote", "feishu.json");
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, "utf-8");
    const saved = JSON.parse(raw) as { appId: string; allowlist: { openId: string }[] };
    expect(saved.appId).toBe("cli_test");
    expect(saved.allowlist.map((u) => u.openId)).toEqual(["ou_a"]);
    expect(raw).not.toContain("secret");

    // 单次有效：第二个用户用同码失败
    h.api.emitMessage({ openId: "ou_b", text: `/bind ${code}`, chatType: "p2p" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("错误或已过期");
    expect(h.channel.allowlistEntries()).toHaveLength(1);
    await h.channel.stop();
  });

  it("错误验证码与过期验证码都被拒绝", async () => {
    const h = makeChannel();
    cleanup.push(h.baseDir);
    await h.channel.start({ appId: "cli_test", appSecret: "secret" });

    h.api.emitMessage({ openId: "ou_a", text: "/bind 000000", chatType: "p2p" });
    await flush();
    expect(h.channel.allowlistEntries()).toHaveLength(0);

    const code = h.channel.pendingBindCode();
    h.clock.now += 6 * 60_000; // 超过 5 分钟有效期
    h.api.emitMessage({ openId: "ou_a", text: `/bind ${code}`, chatType: "p2p" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("错误或已过期");
    expect(h.channel.allowlistEntries()).toHaveLength(0);
    await h.channel.stop();
  });

  it("白名单跨重启持久化；换 appId 后旧白名单失效", async () => {
    const h = makeChannel();
    cleanup.push(h.baseDir);
    await startAndBind(h, "ou_persist");
    await h.channel.stop();

    // 同 appId 重建（模拟重启）：白名单从 feishu.json 恢复，直接可用
    const h2 = makeChannel({ baseDir: h.baseDir });
    await h2.channel.start({ appId: "cli_test", appSecret: "secret" });
    expect(h2.channel.allowlistEntries().map((u) => u.openId)).toEqual(["ou_persist"]);
    h2.api.emitMessage({ openId: "ou_persist", text: "/help", chatType: "p2p" });
    await flush();
    expect(h2.api.texts.at(-1)!.text).toContain("/new");
    await h2.channel.stop();

    // 换 appId：open_id 按应用隔离，旧白名单不再生效
    const h3 = makeChannel({ baseDir: h.baseDir });
    await h3.channel.start({ appId: "cli_other", appSecret: "secret" });
    expect(h3.channel.allowlistEntries()).toHaveLength(0);
    h3.api.emitMessage({ openId: "ou_persist", text: "/help", chatType: "p2p" });
    await flush();
    expect(h3.api.texts.at(-1)!.text).toContain("未授权");
    await h3.channel.stop();
  });

  it("unbind 解绑后落盘且消息恢复未授权拦截", async () => {
    const h = makeChannel();
    cleanup.push(h.baseDir);
    const openId = await startAndBind(h, "ou_unbind");
    expect(h.channel.unbind(openId)).toBe(true);
    expect(h.channel.unbind("ou_nobody")).toBe(false);
    expect(h.channel.allowlistEntries()).toHaveLength(0);

    h.api.texts.length = 0;
    h.api.emitMessage({ openId, text: "/help", chatType: "p2p" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("未授权");
    await h.channel.stop();
  });
});

// ---------------------------------------------------------------------------
// 斜杠指令
// ---------------------------------------------------------------------------

describe("斜杠指令", () => {
  it("English UI keeps command words, user input, and task/session names unchanged", async () => {
    const h = makeChannel({ sessions: [makeEntry("s1", "用户原文标题")] });
    cleanup.push(h.baseDir);
    const openId = await startAndBind(h);
    setLocale("en");
    h.api.texts.length = 0;
    h.api.emitMessage({ openId, text: "/help" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("Available commands:");
    expect(h.api.texts.at(-1)!.text).toContain("/new -p");
    h.api.emitMessage({ openId, text: "/use s1" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toBe('Switched to session "用户原文标题".');
    h.api.emitMessage({ openId, text: "中文原始提问 approve" });
    await flush();
    expect(h.bridgeCalls.at(-1)).toMatchObject({ payload: { text: "中文原始提问 approve" } });
    h.api.emitMessage({ openId, text: "/schedules" });
    await flush();
    const schedule = cardText(h.api.cards.at(-1)!.card);
    expect(schedule).toContain("Scheduled tasks");
    expect(schedule).toContain("晨报");
    expect(schedule).toContain("Daily at");
    expect(schedule).toContain("Monday");
    expect(schedule).not.toContain("每天");
    await h.channel.stop();
  });

  it("/help 与未知指令", async () => {
    const h = makeChannel();
    cleanup.push(h.baseDir);
    const openId = await startAndBind(h);
    h.api.texts.length = 0;

    h.api.emitMessage({ openId, text: "/help", chatType: "p2p" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("/new");

    h.api.emitMessage({ openId, text: "/foobar", chatType: "p2p" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("未知指令");
    await h.channel.stop();
  });

  it("/new <prompt> → session.create（聊天模式）并设为当前会话；后续文本走 session.prompt", async () => {
    const h = makeChannel();
    cleanup.push(h.baseDir);
    const openId = await startAndBind(h);
    h.api.texts.length = 0;

    h.api.emitMessage({ openId, text: "/new 帮我写一个脚本", chatType: "p2p" });
    await flush();
    const createCmd = h.bridgeCalls.find((c) => c.type === "session.create");
    expect(createCmd).toBeTruthy();
    const sessionId = (createCmd as Extract<HostCommand, { type: "session.create" }>).payload.sessionId;
    expect(h.api.texts.at(-1)!.text).toContain("已创建会话");

    h.api.emitMessage({ openId, text: "再加一个参数", chatType: "p2p" });
    await flush();
    const prompts = h.bridgeCalls.filter((c) => c.type === "session.prompt");
    expect(prompts.at(-1)).toMatchObject({ payload: { sessionId, text: "再加一个参数" } });
    await h.channel.stop();
  });

  it("/new -p <cwd> <prompt> → 项目模式；缺参数报错", async () => {
    const h = makeChannel();
    cleanup.push(h.baseDir);
    const openId = await startAndBind(h);
    h.api.texts.length = 0;

    h.api.emitMessage({ openId, text: "/new -p", chatType: "p2p" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("用法");

    h.api.emitMessage({ openId, text: "/new -p /tmp/proj 修个 bug", chatType: "p2p" });
    await flush();
    const createCmd = h.bridgeCalls.find((c) => c.type === "session.create") as Extract<
      HostCommand,
      { type: "session.create" }
    >;
    expect(createCmd.payload.mode).toBe("project");
    expect(createCmd.payload.cwd).toBe("/tmp/proj");
    const entry = [...h.registry.entries.values()].at(-1)!;
    expect(entry.mode).toBe("project");
    expect(entry.cwd).toBe("/tmp/proj");
    await h.channel.stop();
  });

  it("无当前会话时发普通文本 → 提示用 /new", async () => {
    const h = makeChannel();
    cleanup.push(h.baseDir);
    const openId = await startAndBind(h);
    h.api.texts.length = 0;

    h.api.emitMessage({ openId, text: "你好", chatType: "p2p" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("/new");
    expect(h.bridgeCalls).toHaveLength(0);
    await h.channel.stop();
  });

  it("/sessions → 编号卡片；/use 编号与前缀切换；无效输入报错", async () => {
    const h = makeChannel({
      sessions: [makeEntry("aaaa1111-rest", "会话甲"), makeEntry("bbbb2222-rest", "会话乙")],
    });
    cleanup.push(h.baseDir);
    const openId = await startAndBind(h);
    h.api.texts.length = 0;

    h.api.emitMessage({ openId, text: "/sessions", chatType: "p2p" });
    await flush();
    expect(h.api.cards).toHaveLength(1);
    const text = cardText(h.api.cards[0]!.card);
    expect(text).toContain("会话甲");
    expect(text).toContain("会话乙");

    // /use 2 → 会话乙；普通文本路由到当前会话
    h.api.emitMessage({ openId, text: "/use 2", chatType: "p2p" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("会话乙");
    h.api.emitMessage({ openId, text: "继续", chatType: "p2p" });
    await flush();
    expect(h.bridgeCalls.find((c) => c.type === "session.prompt")).toMatchObject({
      payload: { sessionId: "bbbb2222-rest", text: "继续" },
    });

    // /use 前缀 → 会话甲
    h.api.emitMessage({ openId, text: "/use aaaa", chatType: "p2p" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("会话甲");

    // 无效编号 / 不存在前缀
    h.api.emitMessage({ openId, text: "/use 9", chatType: "p2p" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("编号 9 无效");
    h.api.emitMessage({ openId, text: "/use zzzz", chatType: "p2p" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("找不到会话");
    await h.channel.stop();
  });

  it("/abort 中断当前会话；无上下文时报错", async () => {
    const h = makeChannel({ sessions: [makeEntry("s1", "会话甲")] });
    cleanup.push(h.baseDir);
    const openId = await startAndBind(h);
    h.api.texts.length = 0;

    h.api.emitMessage({ openId, text: "/abort", chatType: "p2p" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("没有当前会话");

    h.api.emitMessage({ openId, text: "/use s1", chatType: "p2p" });
    await flush();
    h.api.emitMessage({ openId, text: "/abort", chatType: "p2p" });
    await flush();
    expect(h.bridgeCalls.find((c) => c.type === "session.abort")).toMatchObject({ payload: { sessionId: "s1" } });
    expect(h.api.texts.at(-1)!.text).toContain("中断");
    await h.channel.stop();
  });

  it("/schedules 卡片；/run 精确与前缀匹配、歧义与未找到", async () => {
    const h = makeChannel();
    cleanup.push(h.baseDir);
    const openId = await startAndBind(h);
    h.api.cards.length = 0;
    h.api.texts.length = 0;

    h.api.emitMessage({ openId, text: "/schedules", chatType: "p2p" });
    await flush();
    expect(h.api.cards).toHaveLength(1);
    const text = cardText(h.api.cards[0]!.card);
    expect(text).toContain("晨报");
    expect(text).toContain("晨间清理");

    // 精确匹配 → runNow 收到任务 id，新会话设为当前
    h.api.emitMessage({ openId, text: "/run 晨报", chatType: "p2p" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("已触发");
    expect(h.scheduler.runNowCalls).toEqual(["t1"]);

    // 前缀歧义（晨报 / 晨间清理 都以「晨」开头）
    h.api.emitMessage({ openId, text: "/run 晨", chatType: "p2p" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("匹配到多个任务");

    // 未找到
    h.api.emitMessage({ openId, text: "/run 不存在的任务", chatType: "p2p" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("找不到任务");
    await h.channel.stop();
  });

  it("已绑定用户再 /bind → 提示无需重复绑定", async () => {
    const h = makeChannel();
    cleanup.push(h.baseDir);
    const openId = await startAndBind(h);
    h.api.texts.length = 0;
    h.api.emitMessage({ openId, text: "/bind 123456", chatType: "p2p" });
    await flush();
    expect(h.api.texts.at(-1)!.text).toContain("无需重复绑定");
    await h.channel.stop();
  });
});
