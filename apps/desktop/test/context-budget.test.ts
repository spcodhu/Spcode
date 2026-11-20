/**
 * 上下文分项预算专项：本地估算与 provider 总量分离、unknown 非 0、
 * 输出预留独立、最终请求投影统计。使用真实 SessionManager 与 SettingsManager。
 */
import { type AgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { estimateContextBreakdown, installContextBudgetObserver } from "../src/agent-host/context-budget.js";

function fakeSession(sm: SessionManager, contextWindow = 200_000): AgentSession {
  const agent = { transformContext: undefined as unknown };
  return {
    agent,
    sessionManager: sm,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 40000 },
    }),
    model: { provider: "test", id: "m", contextWindow },
  } as unknown as AgentSession;
}

describe("上下文分项预算", () => {
  it("无请求快照时按投影估算；输出预留来自配置且独立标注", () => {
    const sm = SessionManager.inMemory();
    sm.appendMessage({ role: "user", content: "你好", timestamp: 1 } as never);
    const session = fakeSession(sm);
    const details = estimateContextBreakdown(session);
    expect(details.basis).toBe("session-projection");
    expect(details.outputReserve).toMatchObject({ tokens: 16384, status: "configured", source: "compaction-settings" });
    expect(details.parts.recentMessages.status).toBe("estimated");
    // 没有成功 assistant usage → provider 总量未知，绝不显示 0
    expect(details.providerInput.tokens).toBeNull();
    expect(details.providerInput.status).toBe("unknown");
  });

  it("安装观察器后统计最终请求投影，basis=last-request", async () => {
    const sm = SessionManager.inMemory();
    sm.appendMessage({ role: "user", content: "请求", timestamp: 1 } as never);
    const session = fakeSession(sm);
    installContextBudgetObserver(session.agent);
    const messages = [{ role: "system", content: "sys", sections: { memory: "记忆块" }, timestamp: 0 }] as never[];
    await session.agent.transformContext!(messages, undefined);
    const details = estimateContextBreakdown(session);
    expect(details.basis).toBe("last-request");
    expect(details.parts.systemHost.status).toBe("estimated");
    expect(details.parts.rulesMemory.status).toBe("estimated");
  });

  it("固定开销占满窗口时给出 fixed-overhead 警告", () => {
    const sm = SessionManager.inMemory();
    const session = fakeSession(sm, 1000);
    installContextBudgetObserver(session.agent);
    const big = "x".repeat(8000);
    void session.agent.transformContext!(
      [{ role: "system", content: big, sections: {}, timestamp: 0 }] as never[],
      undefined,
    );
    const details = estimateContextBreakdown(session);
    expect(details.warning).toBe("fixed-overhead");
  });
});
