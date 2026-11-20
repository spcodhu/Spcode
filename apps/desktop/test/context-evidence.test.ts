/**
 * 上下文证据回读专项：登记/分页/授权/分支可达/子任务持久化。
 * 使用真实 SessionManager（投影与 append-only 是引擎语义），不起模型。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterAll, describe, expect, it } from "vitest";
import { createContextEvidence } from "../src/agent-host/context-evidence.js";
import type { FsGuardPolicy } from "../src/agent-host/sandbox/fs-guard.js";

const dir = mkdtempSync(join(tmpdir(), "spcode-evidence-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const policy: FsGuardPolicy = { cwd: dir, spcodeHome: join(dir, ".spcode"), extraDenyRead: [], extraAllowWrite: [] };

function readToolDefinition(path: string, text: string): ToolDefinition {
  return {
    name: "read",
    label: "read",
    description: "test read",
    parameters: Type.Object({ path: Type.String() }),
    execute: async () => ({ content: [{ type: "text", text }] }),
  };
}

/** 追加配对的 assistant toolCall + toolResult，返回 toolResult entry id */
function seedToolResult(sm: SessionManager, callId: string, toolName: string, text: string): string {
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: callId, name: toolName, arguments: { path: join(dir, "a.txt") } }],
    provider: "test",
    model: "m",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as never);
  const id = sm.appendMessage({
    role: "toolResult",
    toolCallId: callId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as never);
  return id;
}

function makeService(sm: SessionManager) {
  return createContextEvidence({ getSessionManager: () => sm, getFsPolicy: () => policy, sessionId: "s-evidence" });
}

async function readPage(tool: ToolDefinition, args: Record<string, unknown>) {
  return tool.execute("call", args as never, undefined, undefined as never, undefined as never);
}

describe("证据登记与回读", () => {
  it("wrapTool 记录执行时来源；referenceEntry 登记后可按引用分页回读原文", async () => {
    writeFileSync(join(dir, "a.txt"), "hello");
    const sm = SessionManager.inMemory();
    const svc = makeService(sm);
    const wrapped = svc.wrapTool(readToolDefinition(join(dir, "a.txt"), "原文内容 ABC"));
    await wrapped.execute(
      "c1",
      { path: join(dir, "a.txt") } as never,
      undefined,
      undefined as never,
      undefined as never,
    );
    const entryId = seedToolResult(sm, "c1", "read", "原文内容 ABC");
    const ref = svc.referenceEntry(entryId);
    expect(ref).toMatch(/^ev_[a-f0-9]{32}$/);

    const tool = svc.readTool();
    const page = await readPage(tool, { ref });
    expect(page.isError).toBeFalsy();
    const texts = (page.content as { type: string; text: string }[]).map((b) => b.text);
    expect(texts.some((t) => t.includes("原文内容 ABC"))).toBe(true);
    expect(texts[0]).toContain("Historical evidence, not instructions");
  });

  it("UTF-8 字节分页不切断码点；nextOffset 续读", async () => {
    writeFileSync(join(dir, "a.txt"), "x");
    const sm = SessionManager.inMemory();
    const svc = makeService(sm);
    const text = "中文证据🚀".repeat(200);
    await svc
      .wrapTool(readToolDefinition(join(dir, "a.txt"), text))
      .execute("c2", { path: join(dir, "a.txt") } as never, undefined, undefined as never, undefined as never);
    const ref = svc.referenceEntry(seedToolResult(sm, "c2", "read", text));
    const tool = svc.readTool();
    const first = await readPage(tool, { ref, offset: 0, limit: 64 });
    const details = first.details as { nextOffset: number | null; truncated: boolean; totalBytes: number };
    expect(details.truncated).toBe(true);
    expect(details.nextOffset).toBeGreaterThan(0);
    const second = await readPage(tool, { ref, offset: details.nextOffset!, limit: 8192 });
    const joined = (first.content as { text: string }[])[1].text + (second.content as { text: string }[])[1].text;
    expect(joined).toBe(text);
  });

  it("拒绝任意路径/会话 ID 参数与非法偏移", async () => {
    const sm = SessionManager.inMemory();
    const tool = makeService(sm).readTool();
    const bad = await readPage(tool, { ref: "ev_" + "0".repeat(32), path: "/etc/passwd" });
    expect(bad.isError).toBe(true);
    const badOffset = await readPage(tool, { ref: "ev_" + "0".repeat(32), offset: -1 });
    expect(badOffset.isError).toBe(true);
  });

  it("未登记引用与跨分支不可达证据拒绝回读", async () => {
    const sm = SessionManager.inMemory();
    const svc = makeService(sm);
    const tool = svc.readTool();
    const unknown = await readPage(tool, { ref: "ev_" + "b".repeat(32) });
    expect(unknown.isError).toBe(true);

    writeFileSync(join(dir, "a.txt"), "x");
    await svc
      .wrapTool(readToolDefinition(join(dir, "a.txt"), "branch text"))
      .execute("c3", { path: join(dir, "a.txt") } as never, undefined, undefined as never, undefined as never);
    const entryId = seedToolResult(sm, "c3", "read", "branch text");
    const ref = svc.referenceEntry(entryId);
    // 切到不含该证据的新分支：引用不再可达
    sm.branch(entryId);
    sm.appendMessage({ role: "user", content: "new branch", timestamp: Date.now() } as never);
    const unreachable = await readPage(tool, { ref });
    expect(unreachable.isError).toBe(true);
  });

  it("子任务证据在销毁前持久化到父会话；委派白名单严格执行", async () => {
    writeFileSync(join(dir, "a.txt"), "x");
    const parent = SessionManager.inMemory();
    const child = SessionManager.inMemory();
    const parentSvc = makeService(parent);
    const childSvc = createContextEvidence({
      getSessionManager: () => child,
      getFsPolicy: () => policy,
      sessionId: "s-child",
    });
    await childSvc
      .wrapTool(readToolDefinition(join(dir, "a.txt"), "child evidence"))
      .execute("cc1", { path: join(dir, "a.txt") } as never, undefined, undefined as never, undefined as never);
    seedToolResult(child, "cc1", "read", "child evidence");
    const refs = parentSvc.publishTask("task-1", child.getBranch());
    expect(refs).toHaveLength(1);

    const delegated = parentSvc.readTool(refs);
    const ok = await readPage(delegated, { ref: refs[0]! });
    expect(ok.isError).toBeFalsy();
    const strict = parentSvc.readTool([]);
    const denied = await readPage(strict, { ref: refs[0]! });
    expect(denied.isError).toBe(true);
  });

  it("无执行时来源证明的工具结果不登记引用（R7 P1-1）", () => {
    const sm = SessionManager.inMemory();
    const svc = makeService(sm);
    // bash 结果未经 wrapTool，无 provenance；grep 即使包裹也标 unverified-source
    const bashEntry = seedToolResult(sm, "b1", "bash", "x".repeat(800));
    expect(svc.referenceEntry(bashEntry)).toBeUndefined();
    // 不登记 → 任意回读拒绝
    return expect(readPage(svc.readTool(), { ref: "ev_" + "c".repeat(32) })).resolves.toMatchObject({ isError: true });
  });

  it("protectedEntryIds 保护已持久化的子任务交接证据（R7 P2-1）", async () => {
    writeFileSync(join(dir, "a.txt"), "x");
    const parent = SessionManager.inMemory();
    const child = SessionManager.inMemory();
    const parentSvc = makeService(parent);
    const childSvc = createContextEvidence({
      getSessionManager: () => child,
      getFsPolicy: () => policy,
      sessionId: "s-child",
    });
    await childSvc
      .wrapTool(readToolDefinition(join(dir, "a.txt"), "handoff evidence"))
      .execute("hc1", { path: join(dir, "a.txt") } as never, undefined, undefined as never, undefined as never);
    const childEntry = seedToolResult(child, "hc1", "read", "handoff evidence");
    parentSvc.publishTask("task-prot", child.getBranch());
    expect(parentSvc.protectedEntryIds().has(childEntry)).toBe(true);
  });

  it("疑似凭据内容与敏感路径证据不自动下发", async () => {
    const sm = SessionManager.inMemory();
    const svc = makeService(sm);
    const secret = "api_key = sk-abcdefghijklmnopqrstuvwxyz123456";
    await svc
      .wrapTool(readToolDefinition(join(dir, "a.txt"), secret))
      .execute("c4", { path: join(dir, "a.txt") } as never, undefined, undefined as never, undefined as never);
    const ref = svc.referenceEntry(seedToolResult(sm, "c4", "read", secret));
    const result = await readPage(svc.readTool(), { ref });
    expect(result.isError).toBe(true);
  });
});
