/**
 * pi-ai 瞬态错误重试回归：直接验证实际依赖，而不是在应用侧复制一份规则。
 * 背景：Kimi OpenAI 兼容流可能以 finish_reason=server_interrupted 终止，工具调用尚未发出。
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError, retryAssistantCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

function assistant(stopReason: "stop" | "error", errorMessage?: string): AssistantMessage {
  return { role: "assistant", content: [], stopReason, ...(errorMessage ? { errorMessage } : {}) } as AssistantMessage;
}

describe("pi-ai server_interrupted 自动重试", () => {
  it("把 Kimi server_interrupted 识别为瞬态错误，同时不误放鉴权/内容审核/额度错误", () => {
    expect(isRetryableAssistantError(assistant("error", "Provider finish_reason: server_interrupted"))).toBe(true);
    expect(isRetryableAssistantError(assistant("error", "Provider finish_reason: network_error"))).toBe(true);
    for (const error of [
      "Provider finish_reason: content_filter",
      "401 Unauthorized",
      "insufficient_quota",
      "quota exceeded for this billing period",
    ]) {
      expect(isRetryableAssistantError(assistant("error", error))).toBe(false);
    }
  });

  it("第一次 server_interrupted 后真实执行第二次调用，成功时返回第二次结果", async () => {
    const produce = vi
      .fn<() => Promise<AssistantMessage>>()
      .mockResolvedValueOnce(assistant("error", "Provider finish_reason: server_interrupted"))
      .mockResolvedValueOnce(assistant("stop"));
    const onRetryScheduled = vi.fn();

    const result = await retryAssistantCall(
      produce,
      { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 },
      undefined,
      { onRetryScheduled },
    );

    expect(result.stopReason).toBe("stop");
    expect(produce).toHaveBeenCalledTimes(2);
    expect(onRetryScheduled).toHaveBeenCalledWith(1, 1, 1, "Provider finish_reason: server_interrupted");
  });
});
