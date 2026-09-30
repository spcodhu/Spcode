/**
 * ModelRuntime 冒烟测试：验证 pi 引擎在我们的数据目录下能正常初始化。
 * 不需要 API Key —— 只验证引擎装配、供应商目录、模型目录可加载。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";

let dir: string;

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("ModelRuntime", () => {
  it("能在 spcode agentDir 下创建并列出内置供应商", async () => {
    dir = mkdtempSync(join(tmpdir(), "spcode-test-"));
    const rt = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    });
    const providers = rt.getProviders();
    expect(providers.length).toBeGreaterThan(10);
    const ids = providers.map((p) => p.id);
    // 调研结论里的关键厂商都在目录里
    expect(ids).toContain("openai");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("deepseek");
    expect(ids).toContain("google");
  }, 30000);

  it("模型目录包含国产厂商模型", async () => {
    const rt = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    });
    const all = rt.getModels();
    expect(all.length).toBeGreaterThan(50);
    const providers = new Set(all.map((m) => m.provider));
    expect(providers.has("deepseek")).toBe(true);
  }, 30000);
});
