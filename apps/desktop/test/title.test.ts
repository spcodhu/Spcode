/**
 * 兜底标题生成器单测：generateFallbackTitle 的清洗与空结果处理。
 * 运行时不依赖真实模型——completeSimple 用桩替代。
 */

import type { Context, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { setLocale } from "@spcode/shared/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateFallbackTitle } from "../src/agent-host/session-controller.js";
import { createRenameSessionTool } from "../src/agent-host/tools/rename.js";

afterEach(() => setLocale("zh-CN"));

function stubRuntime(text: string): ModelRuntime {
  return {
    completeSimple: async () => ({
      content: [{ type: "text", text }],
    }),
  } as unknown as ModelRuntime;
}

const fakeModel = { provider: "test", id: "m" } as unknown as Model<never>;

describe("generateFallbackTitle", () => {
  it("uses the UI locale rather than input language, and snapshots it for an in-flight title", async () => {
    const english = "Investigate authentication module regression";
    const completeSimple = vi.fn(async (_model: unknown, _context: Context) => {
      setLocale("zh-CN");
      return { content: [{ type: "text", text: english }] };
    });
    setLocale("en");
    const { title } = await generateFallbackTitle(
      { completeSimple } as unknown as ModelRuntime,
      fakeModel,
      "检查登录模块",
    );
    expect(title).toBe(english); // longer than the old 20/30-character Chinese limits
    const context = completeSimple.mock.calls[0]![1] as { systemPrompt: string; messages: { content: string }[] };
    expect(context.systemPrompt).toContain("English (en)");
    expect(context.messages[0]!.content).toContain("检查登录模块");
    expect(context.messages[0]!.content).toContain("current UI language, not the input language");

    const chineseCall = vi.fn(async (_model: unknown, _context: Context) => ({
      content: [{ type: "text", text: "登录模块排查" }],
    }));
    await generateFallbackTitle({ completeSimple: chineseCall } as unknown as ModelRuntime, fakeModel, "Debug login");
    expect((chineseCall.mock.calls[0]![1] as { systemPrompt: string }).systemPrompt).toContain(
      "Simplified Chinese (zh-CN)",
    );
  });

  it("RenameSession retains generated text and exposes a localized presentation descriptor", async () => {
    setLocale("en");
    const title = "Investigate authentication module regression";
    const renamed = vi.fn();
    const result = await createRenameSessionTool(renamed).execute("t", { title }, undefined as never);
    expect(renamed).toHaveBeenCalledWith(title);
    expect(result.details).toEqual({ title, presentation: { key: "agent:tool.sessionRenamed", params: { title } } });
    expect(result.content[0]).toMatchObject({ text: `Session renamed to "${title}".` });
  });

  it("剥掉引号与结尾标点，输出净标题", async () => {
    const { title } = await generateFallbackTitle(
      stubRuntime("「小米 17 Pro 无故关机排查」。"),
      fakeModel,
      "我的小米 17 Pro 手机无故一直在关机是什么原因？",
    );
    expect(title).toBe("小米 17 Pro 无故关机排查");
  });

  it("压平换行与多余空白", async () => {
    const { title } = await generateFallbackTitle(
      stubRuntime("大模型应急运维\n\n  工程师职责"),
      fakeModel,
      "大模型应急运维工程师的任务主要是什么？",
    );
    expect(title).toBe("大模型应急运维 工程师职责");
  });

  it("超长输出截断到 20 字", async () => {
    const { title } = await generateFallbackTitle(
      stubRuntime("这是一个非常非常非常长的标题它不应该超过二十个字所以必须被截断"),
      fakeModel,
      "随便问点啥",
    );
    expect(title!.length).toBeLessThanOrEqual(20);
  });

  it("空输出 / 纯标点输出返回 null", async () => {
    expect((await generateFallbackTitle(stubRuntime("   "), fakeModel, "x")).title).toBeNull();
    expect((await generateFallbackTitle(stubRuntime("。。。"), fakeModel, "x")).title).toBeNull();
  });

  it("非 text 块被忽略", async () => {
    const rt = {
      completeSimple: async () => ({
        content: [
          { type: "thinking", thinking: "嗯" },
          { type: "text", text: "Java 后端转型" },
        ],
      }),
    } as unknown as ModelRuntime;
    expect((await generateFallbackTitle(rt, fakeModel, "Java 后端转大模型怎么走")).title).toBe("Java 后端转型");
  });
});
