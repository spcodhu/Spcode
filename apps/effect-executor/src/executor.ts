import type { EffectProvider, EffectRequestInput, EffectResult } from "@spcode/shared/effect";

export interface EffectExecutorPorts {
  claim(): Promise<{ effectId: string; fence: number; request: EffectRequestInput } | null>;
  complete(effectId: string, fence: number, result: EffectResult): Promise<void>;
}

/** 无模型、无持久 Agent Loop 的确定性 Effect 执行器。 */
export class EffectExecutor {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ports: EffectExecutorPorts,
    private readonly providers: Map<string, EffectProvider>,
  ) {}

  start(pollMs = 250): void {
    this.timer = setInterval(() => void this.tick(), pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<boolean> {
    if (this.running) return false;
    const claimed = await this.ports.claim();
    if (!claimed) return false;
    this.running = true;
    try {
      const provider = this.providers.get(claimed.request.type);
      if (!provider) {
        await this.ports.complete(claimed.effectId, claimed.fence, {
          status: "FAILED",
          evidence: { reason: `未知 Provider：${claimed.request.type}` },
        });
        return true;
      }
      const result = await provider.execute({ ...claimed.request, effectId: claimed.effectId, fence: claimed.fence });
      await this.ports.complete(claimed.effectId, claimed.fence, result);
      return true;
    } catch (error) {
      await this.ports.complete(claimed.effectId, claimed.fence, {
        status: "UNKNOWN",
        evidence: { error: error instanceof Error ? error.message : String(error) },
      });
      return true;
    } finally {
      this.running = false;
    }
  }
}
