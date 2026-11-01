import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { addCustomModel, createModelOverlayStore } from "../src/agent-host/model-overlay.js";
import { extractUsage } from "../src/agent-host/session-controller.js";
import { catalogPricing, priceUsageRecord } from "../src/agent-host/usage-pricing.js";
import { UsageLedger } from "../src/main/usage-ledger.js";

const dirs: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "spcode-custom-pricing-"));
  dirs.push(dir);
  const agentDir = join(dir, "agent");
  const overlay = createModelOverlayStore(agentDir);
  addCustomModel(overlay, {
    provider: "kimi-coding",
    modelId: "k3.1-pro",
    displayName: "Kimi K3.1 Pro",
    contextWindow: 262144,
    reasoning: true,
    vision: false,
  });
  return { dir, agentDir, overlay };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("自定义模型真实 usage 计价链路", () => {
  it("目录零成本 + 四项自定义单价 → 新 usage 非零并入会话账本", async () => {
    const { dir, agentDir, overlay } = setup();
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: overlay.managedPath,
      allowModelNetwork: false,
    });
    const model = runtime.getModel("kimi-coding", "k3.1-pro")!;
    expect(model).toBeTruthy();
    expect(catalogPricing(overlay, model).priceKnown).toBe(false);

    const record = extractUsage(
      {
        type: "message_end",
        message: {
          role: "assistant",
          timestamp: 123,
          usage: {
            input: 1_000_000,
            output: 100_000,
            cacheRead: 500_000,
            cacheWrite: 50_000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      } as never,
      "session-custom",
      { provider: "kimi-coding", modelId: "k3.1-pro" },
    )!;
    const priced = priceUsageRecord(record, runtime, overlay, {
      "kimi-coding/k3.1-pro": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 },
    });

    expect(priced.costBasis).toBe("custom");
    expect(priced.costInput).toBe(2);
    expect(priced.costOutput).toBe(1);
    expect(priced.costCacheRead).toBeCloseTo(0.1);
    expect(priced.costCacheWrite).toBeCloseTo(0.1);
    expect(priced.costTotal).toBeCloseTo(3.2);

    const ledger = new UsageLedger(dir);
    ledger.append(priced);
    const snapshot = ledger.sessionUsage("session-custom");
    expect(snapshot.usage.costTotal).toBeCloseTo(3.2);
    expect(snapshot.usage.unpricedCount).toBe(0);
  }, 30000);

  it("未配置单价的自定义模型仍标记未定价，不伪装成免费", async () => {
    const { agentDir, overlay } = setup();
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: overlay.managedPath,
      allowModelNetwork: false,
    });
    const record = extractUsage(
      {
        type: "message_end",
        message: {
          role: "assistant",
          usage: {
            input: 100,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      } as never,
      "session-unpriced",
      { provider: "kimi-coding", modelId: "k3.1-pro" },
    )!;
    const priced = priceUsageRecord(record, runtime, overlay, {});
    expect(priced.costBasis).toBe("unpriced");
    expect(priced.costTotal).toBe(0);
  }, 30000);
});
